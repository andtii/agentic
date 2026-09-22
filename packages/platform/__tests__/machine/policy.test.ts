/**
 * The folders the web may use on a machine (#355, #480): `Machine.setPolicy` (owner, elevated) stores the desired set
 * and sends `policy.request`; the daemon's `policy.response` is read with `policyResult`; every `hello` / `env` that
 * reports something else re-sends it once — never to a locked machine, never in a loop; the Pair page's preset rides
 * `claimPairing` into `pair`; `browseMachine` lists folders; turning `bypassPermissions` on and `revoke` need elevation;
 * `rename` is audited. A daemon that predates the feature is 409.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentDescriptor, EnvironmentId, MachineId, MachinePolicy, Principal, WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import { AuditActor, auditKey } from '../../src/audit/index';
import { DEFAULT_ENV_TIMEOUT_MS, defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { checkPolicyRoots, shouldReconcile, SYSTEM_SETUP } from '../../src/machine/policy';
import { Inbox, inboxKey } from '../../src/notify/index';
import { PairingDirectory } from '../../src/pairing/index';
import { elevatedPrincipal, statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { workspaceKey } from '../../src/auth/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const elevated = elevatedPrincipal('u1', Date.UTC(2026, 8, 21, 12, 10, 0));
const M1 = 'machine_1' as MachineId;
const E1 = 'env_1' as EnvironmentId;
const K1 = machineKey(WS, M1);
const daemonPrincipal: Principal = { kind: 'machine', workspaceId: WS, machineId: M1 };
const TICK = 60_000;

class FakeSockets implements MachineSocketPort {
    readonly sent: string[] = [];
    connected = true;
    send(_key: string, text: string): boolean {
        if (!this.connected) return false;
        this.sent.push(text);
        return true;
    }
    close(): void {
        this.connected = false;
    }
    frames(t: string): Record<string, unknown>[] {
        return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.t === t);
    }
}

const Router = defineActor({
    type: 'routing',
    state: () => ({}),
    methods: () => ({ async slotFreed() {}, async machineOnline() {}, async machineOffline() {}, async sessionOpened() {}, async sessionClosed() {}, async promptRefused() {} })
});

let app: TestActorApp;
let sockets: FakeSockets;
let scheduler: ManualScheduler;
let Machine: ReturnType<typeof defineMachineActor>;

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 21, 12, 0, 0));
    sockets = new FakeSockets();
    scheduler = manualScheduler();
    Machine = defineMachineActor({ socket: sockets, inbox: () => Inbox, routing: () => Router });
    app = testActorApp([Machine, Workspace, AuditActor, Inbox, Router, PairingDirectory], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
    await app.start();
});

afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const machine = (principal: Principal = owner) => app.as(principal).actor(Machine, K1);
const daemon = () => machine(daemonPrincipal);
const environment = (id: EnvironmentId, bypass = false): EnvironmentDescriptor => ({ id, machineId: M1, name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus: 'ok' }, cwdRoots: ['C:\\Users\\me\\src'], concurrency: { max: 2, active: 0 }, isolation: 'config-dir', ...(bypass ? { allowBypassPermissions: true } : {}) });
const LOCAL: MachinePolicy = { webManaged: true, allowedRoots: ['C:\\Users\\me'], source: 'local' };
const WEB = (requested: readonly string[], allowedRoots: readonly string[], extra: Partial<MachinePolicy> = {}): MachinePolicy => ({ webManaged: allowedRoots.length > 0, allowedRoots, source: 'web', requested, ...extra });
/** A `hello` from a daemon that answers `policy`. */
const hello = (policy: MachinePolicy | undefined, extra: Record<string, unknown> = {}) =>
    daemon().socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '0.2.0', os: 'windows', environments: [environment(E1)], capabilities: [], resume: {}, build: { version: '0.2.0', commit: 'abc1234', protocol: 1, channel: 'stable', platform: 'win32-x64' }, features: ['update', 'policy'], ...(policy ? { policy } : {}), ...extra }));
const env = (policy: MachinePolicy, environments = [environment(E1)]) => daemon().socketMessage(JSON.stringify({ v: 1, t: 'env', environments, policy }));
const answer = (requestId: string, body: Record<string, unknown>) => daemon().socketMessage(JSON.stringify({ v: 1, t: 'policy.response', requestId, ...body }));
const requests = () => sockets.frames('policy.request') as { requestId: string; op: string; policy?: { allowedRoots: string[] }; path?: string }[];
const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS)).list();
const audit = async (kind: 'machine.policy-set' | 'auth.elevated' | 'machine.renamed') => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: [kind] })).events;
const tick = async () => {
    vi.setSystemTime(Date.now() + TICK);
    scheduler.advance(TICK);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
/** The daemon's socket drops and it dials again a second later: what a restart looks like from here. */
const reconnect = async (policy: MachinePolicy | undefined, extra: Record<string, unknown> = {}) => {
    sockets.connected = false;
    await daemon().socketClosed();
    sockets.connected = true;
    vi.setSystemTime(Date.now() + 1000);
    await hello(policy, extra);
};

describe('Machine.setPolicy (#480)', () => {
    it('is owner-only and elevated; validated before anything leaves; audited and pushed to the Inbox at once; the daemon answers into policyResult', async () => {
        await hello(LOCAL);
        expect(await statusOf(machine(owner).setPolicy({ allowedRoots: ['~'] }))).toBe(403);
        expect(await statusOf(machine(daemonPrincipal).setPolicy({ allowedRoots: ['~'] }))).toBe(403);
        expect(await statusOf(machine({ kind: 'agent', workspaceId: WS, agentId: 'a' as never, sessionId: 's' as never }).setPolicy({ allowedRoots: ['~'] }))).toBe(403);
        // A plain owner is told to confirm before anything about the input: 403, not 400.
        expect(await statusOf(machine(owner).setPolicy({ allowedRoots: ['src'] }))).toBe(403);
        expect(await statusOf(machine(owner).browseMachine('   '))).toBe(403);
        expect(await statusOf(machine(elevated).setPolicy({ allowedRoots: ['src'] }))).toBe(400);
        expect(await statusOf(machine(elevated).setPolicy({ allowedRoots: ['\\\\nas\\share'] }))).toBe(400);
        expect(await statusOf(machine(elevated).setPolicy({ allowedRoots: Array.from({ length: 33 }, (_, i) => `C:\\r${i}`) }))).toBe(400);
        expect(await statusOf(machine(elevated).setPolicy({} as never))).toBe(400);
        expect(requests()).toEqual([]);

        const { requestId } = await machine(elevated).setPolicy({ allowedRoots: ['~', 'C:/src/', 'C:/src'] });
        expect(requests()).toEqual([{ v: 1, t: 'policy.request', requestId, op: 'set', policy: { allowedRoots: ['~', 'C:/src/'] } }]);
        expect((await machine().get()).policyDesired).toEqual({ allowedRoots: ['~', 'C:/src/'], setAt: Date.now(), by: 'user:u1', converged: false });
        expect(await machine().policyResult(requestId)).toMatchObject({ requestId, op: { op: 'set' }, status: 'pending', by: 'user:u1' });
        expect(await audit('machine.policy-set')).toMatchObject([{ by: 'user:u1', data: { machineId: M1, allowedRoots: ['~', 'C:/src/'], previous: ['C:\\Users\\me'], source: 'web' } }]);
        expect(await audit('auth.elevated')).toMatchObject([{ data: { userId: 'u1', until: elevated.kind === 'user' ? elevated.elevatedUntil : 0 } }]);
        expect((await inbox()).filter((n) => n.kind === 'machine-security')).toMatchObject([{ title: 'Folders the web may use on machine_1 changed', ref: { kind: 'machine', machineId: M1 } }]);

        // The daemon applies it: the env frame carries the policy, the response lands, the desired set reads converged.
        const applied = WEB(['~', 'C:/src/'], ['C:\\Users\\me', 'C:\\src']);
        await env(applied);
        await answer(requestId, { result: { policy: applied } });
        expect(await machine().policyResult(requestId)).toMatchObject({ status: 'done', result: { policy: applied } });
        expect((await machine().get()).policy).toEqual(applied);
        expect((await machine().get()).policyDesired?.converged).toBe(true);
        // One elevation window, one audit row — however many changes.
        await machine(elevated).setPolicy({ allowedRoots: ['~'] });
        expect(await audit('auth.elevated')).toHaveLength(1);
        expect(await audit('machine.policy-set')).toHaveLength(2);
    });

    it('a refusal is stored unchanged; a daemon without the feature is 409; offline 503; the deadline fails a pending one timeout', async () => {
        await hello(LOCAL);
        const { requestId } = await machine(elevated).setPolicy({ allowedRoots: ['C:\\nope'] });
        await answer(requestId, { error: { code: 'not-found', message: 'C:\\nope does not exist' } });
        expect(await machine().policyResult(requestId)).toMatchObject({ status: 'error', error: { code: 'not-found' } });
        expect(await statusOf(machine().policyResult('policy_nope'))).toBe(404);

        const { requestId: slow } = await machine(elevated).setPolicy({ allowedRoots: ['~'] });
        for (let t = 0; t < DEFAULT_ENV_TIMEOUT_MS + TICK; t += TICK) await tick();
        expect(await machine().policyResult(slow)).toMatchObject({ status: 'error', error: { code: 'timeout' } });

        sockets.connected = false;
        await daemon().socketClosed();
        expect(await statusOf(machine(elevated).setPolicy({ allowedRoots: ['~'] }))).toBe(503);
        sockets.connected = true;
        vi.setSystemTime(Date.now() + 1000);
        await hello(LOCAL, { features: ['update'] });
        expect(await statusOf(machine(elevated).setPolicy({ allowedRoots: ['~'] }))).toBe(409);
    });

    it('browseMachine is elevated and answers into policyResult; revoke needs elevation; rename is audited', async () => {
        await hello(LOCAL);
        expect(await statusOf(machine(owner).browseMachine())).toBe(403);
        expect(await statusOf(machine(elevated).browseMachine('   '))).toBe(400);
        const roots = await machine(elevated).browseMachine();
        const inside = await machine(elevated).browseMachine('C:\\Users\\me');
        expect(requests().map((r) => [r.op, r.path])).toEqual([['browse', undefined], ['browse', 'C:\\Users\\me']]);
        const listing = { path: '', entries: [{ name: '~', path: 'C:\\Users\\me' }, { name: 'C:', path: 'C:\\' }], truncated: false };
        await answer(roots.requestId, { result: { listing } });
        expect(await machine().policyResult(roots.requestId)).toMatchObject({ status: 'done', result: { listing } });
        expect(await machine().policyResult(inside.requestId)).toMatchObject({ status: 'pending' });

        await machine(owner).rename('alien01');
        expect(await audit('machine.renamed')).toMatchObject([{ data: { machineId: M1, from: '', to: 'alien01' } }]);
        await machine(owner).rename('alien01');
        expect(await audit('machine.renamed')).toHaveLength(1);

        expect(await statusOf(machine(owner).revoke())).toBe(403);
        expect((await machine().get()).revoked).toBe(false);
        await machine(elevated).revoke();
        expect((await machine().get()).revoked).toBe(true);
        // A pending browse fails with the revoke.
        expect(await machine().policyResult(inside.requestId)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
    });

    it('putEnvironment: turning bypassPermissions on needs elevation; keeping it or turning it off does not', async () => {
        await hello(LOCAL);
        const base = { id: E1, name: 'work', runtime: 'claude-code', cwdRoots: ['C:\\Users\\me\\src'] };
        expect(await statusOf(machine(owner).putEnvironment({ ...base, allowBypassPermissions: true }))).toBe(403);
        expect(await statusOf(machine(owner).putEnvironment({ ...base, allowBypassPermissions: false }))).toBeUndefined();
        expect(await statusOf(machine(owner).putEnvironment({ ...base }))).toBeUndefined();
        await machine(elevated).putEnvironment({ ...base, allowBypassPermissions: true });
        // Reported on: an owner keeps it without elevation.
        await env(LOCAL, [environment(E1, true)]);
        expect(await statusOf(machine(owner).putEnvironment({ ...base, allowBypassPermissions: true }))).toBeUndefined();
        // A new environment with it on: elevated only.
        expect(await statusOf(machine(owner).putEnvironment({ name: 'new', runtime: 'claude-code', cwdRoots: ['C:\\Users\\me\\x'], allowBypassPermissions: true }))).toBe(403);
        expect(sockets.frames('env.request')).toHaveLength(4);
    });
});

describe('the reconcile (#480)', () => {
    it('sends the desired set once per connect when the machine reports something else, and again only on a change', async () => {
        await hello(undefined, { features: ['update', 'policy'] });
        await machine(elevated).setPolicy({ allowedRoots: ['~'] });
        const first = requests();
        expect(first).toHaveLength(1);
        // The daemon never answered (a restart): the socket went, the owner's request failed with it, and the next hello reports a
        // local policy → one automatic request.
        await reconnect(LOCAL);
        expect(await machine().policyResult(first[0]!.requestId)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
        const auto = requests();
        expect(auto).toHaveLength(2);
        expect(auto[1]).toMatchObject({ op: 'set', policy: { allowedRoots: ['~'] } });
        expect(await machine().policyResult(auto[1]!.requestId)).toMatchObject({ by: SYSTEM_SETUP, status: 'pending' });
        // While it is in flight, two env frames arrive (the daemon's own after apply, and the watcher's): nothing more goes out.
        await env(LOCAL);
        await env(LOCAL);
        expect(requests()).toHaveLength(2);
        // It converges: the env frame with the applied policy, the answer — and no further request.
        const applied = WEB(['~'], ['C:\\Users\\me']);
        await env(applied);
        await answer(auto[1]!.requestId, { result: { policy: applied } });
        expect(requests()).toHaveLength(2);
        expect((await machine().get()).policyDesired).toMatchObject({ converged: true, lastAuto: { converged: true } });
        await env(applied);
        await reconnect(applied);
        expect(requests()).toHaveLength(2);
        // A local drift after convergence (`policy off` on the machine): exactly one more request.
        await env({ webManaged: false, allowedRoots: [], source: 'local' });
        expect(requests()).toHaveLength(3);
        await env({ webManaged: false, allowedRoots: [], source: 'local' });
        expect(requests()).toHaveLength(3);
    });

    it('a refused automatic request holds until the owner changes the set or the daemon reconnects; a locked machine is left alone', async () => {
        await hello(LOCAL);
        await machine(elevated).setPolicy({ allowedRoots: ['~'] });
        const [first] = requests();
        await answer(first!.requestId, { error: { code: 'protected', message: 'no' } });
        // The owner's own request was refused; the reconcile sees a non-converged report and tries once itself.
        await env(LOCAL);
        expect(requests()).toHaveLength(2);
        await answer(requests()[1]!.requestId, { error: { code: 'protected', message: 'no' } });
        expect((await machine().get()).policyDesired?.lastAuto).toEqual({ at: Date.now(), converged: false });
        // Refused: env frames change nothing; a reconnect gets one more; a new desired set gets one more.
        await env(LOCAL);
        await env(LOCAL);
        expect(requests()).toHaveLength(2);
        await reconnect(LOCAL);
        expect(requests()).toHaveLength(3);
        await answer(requests()[2]!.requestId, { error: { code: 'io', message: 'no' } });
        await env(LOCAL);
        expect(requests()).toHaveLength(3);
        await machine(elevated).setPolicy({ allowedRoots: ['~', 'C:\\src'] });
        expect(requests()).toHaveLength(4);
        await answer(requests()[3]!.requestId, { error: { code: 'not-found', message: 'no' } });
        await env(LOCAL);
        expect(requests()).toHaveLength(5);

        // Locked on the machine: nothing goes out, however far apart.
        await answer(requests()[4]!.requestId, { error: { code: 'policy-locked', message: 'locked' } });
        await env({ ...LOCAL, locked: true });
        await reconnect({ ...LOCAL, locked: true });
        expect(requests()).toHaveLength(5);
        expect((await machine().get()).policy?.locked).toBe(true);
        // Unlocked: the next hello reconciles once.
        await reconnect(LOCAL);
        expect(requests()).toHaveLength(6);
    });

    it('a daemon without the policy feature, or with no desired set, is never asked', async () => {
        await hello(LOCAL, { features: ['update'] });
        await reconnect(LOCAL);
        await env(LOCAL);
        expect(requests()).toEqual([]);
    });
});

describe('the Pair page preset (#480)', () => {
    it('rides claimPairing into pair as the desired set, applied by the first hello; an absent or empty preset stores nothing', async () => {
        const ws = app.as(owner).actor(Workspace, workspaceKey(WS));
        await expect(ws.registerMachinePending({ name: 'box', allowedRoots: ['src'] })).rejects.toMatchObject({ status: 400 });
        const { machineId, pairingCode } = await ws.registerMachinePending({ name: 'box', allowedRoots: ['~', 'D:\\code'] });
        const key = machineKey(WS, machineId);
        const asDaemon = app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, key);
        await asDaemon.pair(pairingCode, { name: 'box' });
        expect((await app.as(owner).actor(Machine, key).get()).policyDesired).toMatchObject({ allowedRoots: ['~', 'D:\\code'], by: 'user:u1', converged: false });
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId, daemonVersion: '0.2.0', os: 'windows', environments: [], capabilities: [], resume: {}, features: ['policy'], policy: { webManaged: false, allowedRoots: [] } }));
        expect(requests()).toMatchObject([{ op: 'set', policy: { allowedRoots: ['~', 'D:\\code'] } }]);
        expect(await app.as(owner).actor(Machine, key).policyResult(requests()[0]!.requestId)).toMatchObject({ by: SYSTEM_SETUP });

        const plain = await ws.registerMachinePending({ name: 'other' });
        const plainKey = machineKey(WS, plain.machineId);
        await app.as({ kind: 'machine', workspaceId: WS, machineId: plain.machineId }).actor(Machine, plainKey).pair(plain.pairingCode, { name: 'other' });
        expect((await app.as(owner).actor(Machine, plainKey).get()).policyDesired).toBeUndefined();
        const empty = await ws.registerMachinePending({ name: 'empty', allowedRoots: [] });
        const emptyKey = machineKey(WS, empty.machineId);
        await app.as({ kind: 'machine', workspaceId: WS, machineId: empty.machineId }).actor(Machine, emptyKey).pair(empty.pairingCode, { name: 'empty' });
        expect((await app.as(owner).actor(Machine, emptyKey).get()).policyDesired).toBeUndefined();
    });
});

describe('the pure half', () => {
    it('checkPolicyRoots: ~ forms and absolute paths on the machine’s OS, never a network path, at most 32, no repeats', () => {
        expect(checkPolicyRoots({ allowedRoots: [' ~ ', '~/src', 'C:\\Dev', 'C:\\Dev', 'D:/x/../y'] }, 'windows')).toEqual(['~', '~/src', 'C:\\Dev', 'D:/x/../y']);
        expect(checkPolicyRoots({ allowedRoots: ['/home/me', '~'] }, 'linux')).toEqual(['/home/me', '~']);
        // The OS unknown (at pairing): a lexical check of either family, and a Windows-looking root deduped the Windows way.
        expect(checkPolicyRoots({ allowedRoots: ['/home/me', 'C:\\Dev', '~\\x', 'c:/dev', '/home/me/'] }, undefined)).toEqual(['/home/me', 'C:\\Dev', '~\\x']);
        for (const bad of [{ allowedRoots: ['src'] }, { allowedRoots: ['/home/me'] }, { allowedRoots: ['\\\\nas\\share'] }, { allowedRoots: ['//nas/share'] }, { allowedRoots: [''] }, { allowedRoots: [1] }, {}, null, { allowedRoots: ['~x'] }]) {
            expect(() => checkPolicyRoots(bad, 'windows'), JSON.stringify(bad)).toThrow();
        }
        expect(() => checkPolicyRoots({ allowedRoots: ['/x'] }, 'linux')).not.toThrow();
        expect(() => checkPolicyRoots({ allowedRoots: ['C:\\x'] }, 'linux')).toThrow();
    });

    it('shouldReconcile: the loop guard, case by case', () => {
        const desired = { allowedRoots: ['~'], setAt: 100, by: 'user:u1' };
        const base = { trigger: 'hello' as const, features: ['policy'], desired, reported: LOCAL, os: 'windows' as const, pending: false, connectedAt: 200 };
        expect(shouldReconcile(base)).toBe(true);
        expect(shouldReconcile({ ...base, features: ['update'] })).toBe(false);
        expect(shouldReconcile({ ...base, features: undefined })).toBe(false);
        expect(shouldReconcile({ ...base, desired: undefined })).toBe(false);
        expect(shouldReconcile({ ...base, reported: { ...LOCAL, locked: true } })).toBe(false);
        expect(shouldReconcile({ ...base, pending: true })).toBe(false);
        expect(shouldReconcile({ ...base, reported: WEB(['~'], ['C:\\Users\\me']) })).toBe(false);
        expect(shouldReconcile({ ...base, reported: undefined })).toBe(true);
        // After a refused attempt: only a newer desired set, or a fresh connection (hello only).
        const refused = { ...desired, lastAuto: { at: 300, converged: false } };
        expect(shouldReconcile({ ...base, desired: refused, trigger: 'env' })).toBe(false);
        expect(shouldReconcile({ ...base, desired: refused, trigger: 'hello', connectedAt: 250 })).toBe(false);
        expect(shouldReconcile({ ...base, desired: refused, trigger: 'hello', connectedAt: 350 })).toBe(true);
        expect(shouldReconcile({ ...base, desired: { ...refused, setAt: 400 }, trigger: 'env' })).toBe(true);
        // After a converged attempt, a drift is a genuine one: send.
        expect(shouldReconcile({ ...base, desired: { ...desired, lastAuto: { at: 300, converged: true } }, trigger: 'env' })).toBe(true);
    });
});
