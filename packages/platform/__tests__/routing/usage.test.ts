/**
 * `usage_limits` for agents (#272): `createActorToolPorts({ machines }).usage`
 * reads the workspace's paired machines under the agent principal and answers
 * every environment with its latest quota snapshot and age; `usageLimitsOf`
 * narrows by machine and runtime. Without `machines` there is no port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, EnvironmentId, MachineId, QuotaSnapshot, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { grantedPlatformTools, usageLimitsTool } from '@agentic/runtimes';
import { mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, usageLimitsOf, type MachineView } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createActorToolPorts, type AgentPrincipal } from '../../src/routing/index';
import { defineSessionActor } from '../../src/session/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const principal = mintAgentPrincipal({ workspaceId: WS, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId, taskId: 'task_1' as TaskId }) as AgentPrincipal;
const E1 = 'env_work' as EnvironmentId;
const E2 = 'env_api' as EnvironmentId;
const NOW = Date.UTC(2026, 8, 19, 12);

const snapshot = (environmentId: EnvironmentId, observedAt: number): QuotaSnapshot => ({
    sourceId: 'agentic.quota.claude-code',
    runtime: 'claude-code',
    environmentId,
    availability: 'reported',
    windows: [{ id: 'five_hour', label: 'Current session', period: 'session', utilization: 0.19, unit: 'percent', resetsAt: '2026-09-19T13:10:00.000Z', status: 'ok' }],
    observedAt,
    via: 'probe'
});

describe('usageLimitsOf', () => {
    const view = (machineId: string, environments: MachineView['environments'], quota?: MachineView['quota'], extra: Partial<MachineView> = {}): MachineView =>
        ({ machineId: machineId as MachineId, name: machineId, online: true, revoked: false, environments, ...(quota ? { quota } : {}), ...extra }) as MachineView;
    const env = (machineId: string, id: EnvironmentId, runtime = 'claude-code') => ({ ...inMemoryEnvironment(machineId as MachineId, id), runtime, account: { label: id, authStatus: 'ok' as const, identity: 'me@example.com' } });

    it('answers every environment with its snapshot and age, null without one; narrows by machine and runtime', () => {
        const machines = [view('m1', [env('m1', E1), env('m1', E2, 'other')], { [E1]: snapshot(E1, NOW - 5_000) }), view('m2', [env('m2', 'env_m2' as EnvironmentId)], undefined, { online: false })];
        const all = usageLimitsOf(machines, {}, NOW).accounts;
        expect(all.map((a) => [a.machineId, a.environmentId, a.online, a.snapshot?.availability ?? null, a.ageMs])).toEqual([
            ['m1', E1, true, 'reported', 5_000],
            ['m1', E2, true, null, null],
            ['m2', 'env_m2', false, null, null]
        ]);
        expect(all[0]!.account).toEqual({ label: E1, identity: 'me@example.com' });
        expect(usageLimitsOf(machines, { machineId: 'm2' as MachineId }, NOW).accounts.map((a) => a.environmentId)).toEqual(['env_m2']);
        expect(usageLimitsOf(machines, { runtime: 'other' }, NOW).accounts.map((a) => a.environmentId)).toEqual([E2]);
        // A revoked machine is never online.
        expect(usageLimitsOf([view('m3', [env('m3', 'env_m3' as EnvironmentId)], undefined, { revoked: true })], {}, NOW).accounts[0]!.online).toBe(false);
    });
});

describe('createActorToolPorts().usage', () => {
    let app: TestActorApp;
    let Machine: ReturnType<typeof defineMachineActor>;

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const Session = defineSessionActor({ factory: () => null });
        Machine = defineMachineActor({ socket: { send: () => false, close: () => {} }, sessions: () => Session });
        app = testActorApp([Machine, Session, Workspace, PairingDirectory]);
        await app.start();
    });
    afterEach(async () => {
        await app.stop();
        vi.useRealTimers();
    });

    async function pairedWithQuota() {
        const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'laptop' });
        const daemon = app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
        await daemon.pair(pairingCode, { name: 'laptop', os: 'windows', daemonVersion: '0.1.0' });
        await daemon.socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId, daemonVersion: '0.1.0', os: 'windows', environments: [inMemoryEnvironment(machineId, E1)], capabilities: [], resume: {} }));
        await daemon.socketMessage(JSON.stringify({ v: 1, t: 'quota', environmentId: E1, snapshot: snapshot(E1, NOW - 60_000) }));
        return machineId;
    }

    it('reads the paired machines under the agent principal and answers the accounts', async () => {
        const machineId = await pairedWithQuota();
        const ports = createActorToolPorts({ principal, machines: () => Machine });
        const { accounts } = await ports.usage!.limits({}, { callId: 'c1', signal: new AbortController().signal });
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({ machineId, machineName: 'laptop', online: true, environmentId: E1, ageMs: 60_000 });
        expect(accounts[0]!.snapshot?.windows[0]?.resetsAt).toBe('2026-09-19T13:10:00.000Z');
        expect((await ports.usage!.limits({ machineId: 'm_other' as MachineId }, { callId: 'c2', signal: new AbortController().signal })).accounts).toEqual([]);
    });

    it('is on the roster only when granted, and without machines the tool says it is unavailable', async () => {
        await pairedWithQuota();
        const ports = createActorToolPorts({ principal, machines: () => Machine });
        expect(grantedPlatformTools(ports, [{ name: 'memory_search' }]).map((t) => t.name)).not.toContain('usage_limits');
        const [tool] = grantedPlatformTools(ports, [{ name: 'usage_limits' }]);
        const out = (await tool!.run({ runtime: 'in-memory' }, { toolCallId: 'c3', signal: new AbortController().signal })) as { accounts: unknown[] };
        expect(out.accounts).toHaveLength(1);

        const bare = createActorToolPorts({ principal });
        expect(bare.usage).toBeUndefined();
        await expect(usageLimitsTool(bare.usage).run({}, { toolCallId: 'c4', signal: new AbortController().signal })).rejects.toThrow(/not available on this host/);
    });
});
