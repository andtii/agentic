import { actorKey, addUsage, canTransition, childTaskId, createId, environmentVerdict, hasScope, isTerminal, resolveActivation, sameWorkspace, toEnvironmentDescriptor, workspaceOfKey } from '../src/index';
import type { AgentId, CapabilityReport, EnvironmentId, LocalEnvironment, MachineId, Principal, TaskId, TaskStatus, WorkspaceId } from '../src/index';

const ws = 'ws_1' as WorkspaceId;
const a = 'agent_a' as AgentId;
const b = 'agent_b' as AgentId;

describe('ids', () => {
    it('createId is prefixed, url-safe and unique', () => {
        const ids = new Set(Array.from({ length: 500 }, () => createId('task')));
        expect(ids.size).toBe(500);
        for (const id of ids) expect(id).toMatch(/^task_[0-9A-Za-z]{16}$/);
    });
    it('actor keys are workspace-prefixed and parse back', () => {
        const key = actorKey(ws, 'chat', 'chat_1');
        expect(key).toBe('ws_1:chat:chat_1');
        expect(workspaceOfKey(key)).toBe(ws);
        expect(workspaceOfKey('nope')).toBeNull();
    });
});

describe('task state machine', () => {
    const all: TaskStatus[] = ['queued', 'active', 'waiting', 'completed', 'failed', 'cancelled'];
    it('terminal states go nowhere', () => {
        for (const from of ['completed', 'failed', 'cancelled'] as const) {
            expect(isTerminal(from)).toBe(true);
            for (const to of all) expect(canTransition(from, to)).toBe(false);
        }
    });
    it('queued and waiting cannot complete without becoming active', () => {
        expect(canTransition('queued', 'completed')).toBe(false);
        expect(canTransition('waiting', 'completed')).toBe(false);
        expect(canTransition('active', 'completed')).toBe(true);
        expect(canTransition('waiting', 'active')).toBe(true);
    });
    it('anything non-terminal can be cancelled', () => {
        for (const from of ['queued', 'active', 'waiting'] as const) expect(canTransition(from, 'cancelled')).toBe(true);
    });
    it('child ids are deterministic per parent and call', () => {
        const parent = 'task_p' as TaskId;
        expect(childTaskId(parent, 'call1')).toBe(childTaskId(parent, 'call1'));
        expect(childTaskId(parent, 'call1')).not.toBe(childTaskId(parent, 'call2'));
    });
});

describe('chat activation (CHT-06)', () => {
    it('mentions win, restricted to members', () => {
        expect(resolveActivation([b, 'agent_x' as AgentId], [a, b], a)).toEqual([b]);
    });
    it('falls back to the coordinator, then the sole agent, then nobody', () => {
        expect(resolveActivation([], [a, b], b)).toEqual([b]);
        expect(resolveActivation([], [a], null)).toEqual([a]);
        expect(resolveActivation([], [a, b], null)).toEqual([]);
        expect(resolveActivation([], [], null)).toEqual([]);
    });
});

describe('principals', () => {
    const user: Principal = { kind: 'user', userId: 'u', workspaceId: ws };
    it('sameWorkspace checks the key prefix', () => {
        expect(sameWorkspace(user, 'ws_1:agent:x')).toBe(true);
        expect(sameWorkspace(user, 'ws_2:agent:x')).toBe(false);
        expect(sameWorkspace(null, 'ws_1:agent:x')).toBe(false);
    });
    it('only external principals are scope-gated', () => {
        const ext: Principal = { kind: 'external', workspaceId: ws, clientId: 'c', scopes: ['machines'] };
        expect(hasScope(ext, 'machines')).toBe(true);
        expect(hasScope(ext, 'sessions')).toBe(false);
        expect(hasScope(user, 'sessions')).toBe(true);
    });
});

describe('usage', () => {
    it('adds well-known and extra keys', () => {
        const sum = addUsage({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 5 }, { inputTokens: 10, outputTokens: 20, custom: 1 });
        expect(sum).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadInputTokens: 5, custom: 1 });
    });
});

describe('runtime seam', () => {
    const env: LocalEnvironment = {
        id: 'environment_a' as EnvironmentId,
        name: 'work',
        runtime: 'claude-code',
        profileDir: 'C:/profiles/work',
        cwdRoots: ['C:/src'],
        concurrency: 2
    };
    const capabilities: CapabilityReport = {
        runtime: 'claude-code',
        supported: ['prompt'],
        unsupported: [],
        resume: 'local',
        cancel: true,
        steer: false,
        permissions: 'every-call',
        tools: 'mcp'
    };
    it('toEnvironmentDescriptor keeps local-only fields off the wire', () => {
        const d = toEnvironmentDescriptor(env, 'machine_1' as MachineId, { authStatus: 'ok', isolation: 'config-dir', capabilities }, 1);
        expect(d).toEqual({
            id: 'environment_a',
            machineId: 'machine_1',
            name: 'work',
            runtime: 'claude-code',
            account: { label: 'work', authStatus: 'ok' },
            cwdRoots: ['C:/src'],
            concurrency: { max: 2, active: 1 },
            isolation: 'config-dir'
        });
        expect(d).not.toHaveProperty('profileDir');
    });
    it('toEnvironmentDescriptor carries the doctor verdict only when one is given', () => {
        const inspection = { authStatus: 'ok' as const, isolation: 'config-dir' as const, capabilities };
        expect(toEnvironmentDescriptor(env, 'machine_1' as MachineId, inspection)).not.toHaveProperty('doctor');
        const verdict = { ok: false, findings: [{ level: 'error' as const, code: 'shared-config-dir', message: 'shared', environmentIds: [env.id] }], checkedAt: 5 };
        expect(toEnvironmentDescriptor(env, 'machine_1' as MachineId, inspection, 0, verdict).doctor).toEqual(verdict);
    });
    it('toEnvironmentDescriptor carries the account’s models as a copy and the bypass flag only when set (#450)', () => {
        const inspection = { authStatus: 'ok' as const, isolation: 'config-dir' as const, capabilities };
        const bare = toEnvironmentDescriptor(env, 'machine_1' as MachineId, inspection);
        expect(bare).not.toHaveProperty('models');
        expect(bare).not.toHaveProperty('allowBypassPermissions');
        expect(toEnvironmentDescriptor({ ...env, allowBypassPermissions: false }, 'machine_1' as MachineId, inspection)).not.toHaveProperty('allowBypassPermissions');
        const models = [{ id: 'claude-fable-5-1', label: 'Fable' }];
        const d = toEnvironmentDescriptor({ ...env, allowBypassPermissions: true }, 'machine_1' as MachineId, inspection, 0, undefined, models);
        expect(d).toMatchObject({ models, allowBypassPermissions: true });
        expect(d.models).not.toBe(models);
    });
    it('environmentVerdict keeps the findings naming the environment and fails on an error among them', () => {
        const a = 'environment_a' as EnvironmentId;
        const b = 'environment_b' as EnvironmentId;
        const report = {
            ok: false,
            findings: [
                { level: 'error' as const, code: 'shared-config-dir', message: 'a and b share', environmentIds: [a, b] },
                { level: 'info' as const, code: 'auth-ok', message: 'a ok', environmentIds: [a] },
                { level: 'error' as const, code: 'no-driver', message: 'unrelated' }
            ]
        };
        expect(environmentVerdict(report, a, 7)).toEqual({ ok: false, findings: [report.findings[0], report.findings[1]], checkedAt: 7 });
        expect(environmentVerdict({ ok: true, findings: [report.findings[1]] }, b, 7)).toEqual({ ok: true, findings: [], checkedAt: 7 });
    });
    it('toEnvironmentDescriptor uses the account label and identity when present', () => {
        const d = toEnvironmentDescriptor({ ...env, accountLabel: 'Work account' }, 'machine_1' as MachineId, {
            authStatus: 'expired',
            identity: 'me@example.com',
            isolation: 'config-dir',
            capabilities
        });
        expect(d.account).toEqual({ label: 'Work account', authStatus: 'expired', identity: 'me@example.com' });
        expect(d.concurrency.active).toBe(0);
    });
});
