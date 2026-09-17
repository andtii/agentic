// @vitest-environment node
/**
 * The issue's acceptance criteria, end to end through the real pipeline:
 * `createServerApp`-shaped config (`stubServerApp`) + `@sigx/actors` host.
 *
 *  - unauthenticated request → 401; cross-workspace actor call → unauthorized
 *  - a revoked machine token is rejected at the next heartbeat
 *  - the principal reaches an actor's `authorize` unchanged across one
 *    `ctx.actor()` hop
 */
import { afterEach, describe, expect, it } from 'vitest';
import { actor, defineActor } from '@sigx/actors';
import { createHost, type Host } from '@sigx/actors/host';
import { isServerFnError } from '@sigx/server';
import { stubServerApp } from '@sigx/server/testing';
import { actorKey, sameWorkspace, type MachineId, type Principal, type WorkspaceId, type AgentId, type SessionId } from '@agentic/core';
import { asPrincipal, issueMachineToken, mintAgentPrincipal, sealSession, serverAuth, sessionCookie, type MachineTokenRecord } from '../../src/index';

const SECRET = 'test-session-secret-that-is-long-enough';
const NOW = 1_800_000_000_000;
const quiet = { sweepIntervalMs: 60_000, reminderTickMs: 60_000, callTimeoutMs: 0 };

const wsA = 'ws_a' as WorkspaceId;
const wsB = 'ws_b' as WorkspaceId;
const machineId = 'machine_1' as MachineId;

const records = new Map<string, MachineTokenRecord>();
let host: Host | null = null;
let restore: (() => void) | undefined;

afterEach(async () => {
    await host?.stop();
    host = null;
    restore?.();
    restore = undefined;
    records.clear();
});

const workspaceGuard = (principal: Principal | null, _rq: unknown, op: { resource?: { key: string } }) => sameWorkspace(principal, op.resource?.key ?? '');

/** What every platform actor looks like: the guard chain starts with `sameWorkspace`. */
const Inner = defineActor({
    type: 'AuthInner',
    authorize: workspaceGuard,
    state: () => ({ seen: [] as Principal[] }),
    methods: (ctx) => ({
        async whoCalled() {
            return ctx.principal as Principal | null;
        }
    })
});

const Outer = defineActor({
    type: 'AuthOuter',
    authorize: workspaceGuard,
    state: () => ({}),
    methods: (ctx) => ({
        async direct() {
            return ctx.principal as Principal | null;
        },
        async viaHop(innerKey: string) {
            return ctx.actor(Inner, innerKey).whoCalled();
        }
    })
});

/** A Machine-shaped actor: heartbeat requires the machine principal for THIS machine. */
const Machine = defineActor({
    type: 'AuthMachine',
    authorize: [workspaceGuard, (p: Principal | null, _rq, op) => p?.kind === 'machine' && op.resource?.key === actorKey(p.workspaceId, 'machine', p.machineId)],
    state: () => ({ beats: 0 }),
    methods: (ctx) => ({
        async heartbeat() {
            ctx.state.beats += 1;
            await ctx.save();
            return ctx.state.beats;
        }
    })
});

async function start() {
    restore = stubServerApp(serverAuth({ sessionSecret: SECRET, machines: async (ref) => records.get(ref.machineId) ?? null, now: () => NOW }));
    host = createHost({ actors: [Inner, Outer, Machine], defaults: quiet });
    await host.start();
}

const status = (error: unknown): number | undefined => (isServerFnError(error) ? error.status : undefined);
const asUser = async (workspaceId: WorkspaceId) => ({ context: new Request('https://app.test/', { headers: { cookie: sessionCookie(await sealSession({ userId: 'gh_1', workspaceId }, SECRET, { now: NOW })).split(';')[0]! } }) });
const asBearer = (token: string) => ({ context: new Request('https://app.test/', { headers: { authorization: `Bearer ${token}` } }) });

describe('acceptance: 401 / cross-workspace', () => {
    it('an unauthenticated request is 401, a cross-workspace call is 403, the owner gets through', async () => {
        await start();
        const key = actorKey(wsA, 'agent', 'a1');
        const anonymous = await actor(Outer, key).with({ context: new Request('https://app.test/') }).direct().catch((e: unknown) => e);
        expect(status(anonymous)).toBe(401);
        const detached = await actor(Outer, key).direct().catch((e: unknown) => e);
        expect(status(detached)).toBe(401);
        const cross = await actor(Outer, key).with(await asUser(wsB)).direct().catch((e: unknown) => e);
        expect(status(cross)).toBe(403);
        await expect(actor(Outer, key).with(await asUser(wsA)).direct()).resolves.toEqual({ kind: 'user', userId: 'gh_1', workspaceId: wsA });
    });
});

describe('acceptance: revoked machine token', () => {
    it('is rejected at the next heartbeat', async () => {
        await start();
        const issued = await issueMachineToken({ workspaceId: wsA, machineId });
        records.set(machineId, { tokenHash: issued.tokenHash });
        const key = actorKey(wsA, 'machine', machineId);
        await expect(actor(Machine, key).with(asBearer(issued.token)).heartbeat()).resolves.toBe(1);
        // revoke — what `Machine.revoke` writes
        records.set(machineId, { tokenHash: issued.tokenHash, revokedAt: NOW });
        const next = await actor(Machine, key).with(asBearer(issued.token)).heartbeat().catch((e: unknown) => e);
        expect(status(next)).toBe(401);
        // and a live token cannot reach another machine's actor
        records.set(machineId, { tokenHash: issued.tokenHash });
        const other = await actor(Machine, actorKey(wsA, 'machine', 'machine_2')).with(asBearer(issued.token)).heartbeat().catch((e: unknown) => e);
        expect(status(other)).toBe(403);
    });
});

describe('acceptance: principal across one ctx.actor() hop', () => {
    it('reaches the inner actor unchanged — the original caller, not the outer actor', async () => {
        await start();
        const user: Principal = { kind: 'user', userId: 'gh_1', workspaceId: wsA };
        const seen = await actor(Outer, actorKey(wsA, 'agent', 'a1')).with(await asUser(wsA)).viaHop(actorKey(wsA, 'chat', 'c1'));
        expect(seen).toEqual(user);
    });

    it('a minted agent principal (in-process, no request) hops the same way and is bound to its workspace', async () => {
        await start();
        const agent = mintAgentPrincipal({ workspaceId: wsA, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId });
        const seen = await actor(Outer, actorKey(wsA, 'agent', 'a1')).with({ context: asPrincipal(agent) }).viaHop(actorKey(wsA, 'chat', 'c1'));
        expect(seen).toEqual(agent);
        const cross = await actor(Outer, actorKey(wsB, 'agent', 'a1')).with({ context: asPrincipal(agent) }).direct().catch((e: unknown) => e);
        expect(status(cross)).toBe(403);
    });
});
