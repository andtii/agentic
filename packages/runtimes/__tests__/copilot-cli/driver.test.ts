// @vitest-environment node
/** `copilotCliDriver`: one isolated runtime per profile, the spec as a Copilot session, the policy on every ask (#319). */
import { allowAll, denyAll, type AgentEvent, type Policy } from '@sigx/ai-agent';
import type { EnvironmentId, LocalEnvironment, OpenSpec, PluginContext, SessionId } from '@agentic/core';
import {
    COPILOT_CLI_DOCTOR_CODES,
    COPILOT_PLATFORM_MEMORY_NOTE,
    copilotAccountEnv,
    copilotCliDriver,
    copilotCliQuota,
    permissionRequestOf,
    quotaFromCopilot,
    type CopilotClientInit
} from '../../src/copilot-cli/index';
import { PLATFORM_MEMORY_HEADING } from '../../src/harness/index';
import { fakeClient, type CopilotScript, type FakeClient, type FakeClientOptions } from './fake-client';
import businessQuota from './fixtures/get-quota-business.json';

const envA: LocalEnvironment = { id: 'environment_a' as EnvironmentId, name: 'work', runtime: 'copilot-cli', profileDir: 'C:\\profiles\\work', cwdRoots: ['C:\\src'], concurrency: 2 };
const envB: LocalEnvironment = { id: 'environment_b' as EnvironmentId, name: 'oss', runtime: 'copilot-cli', profileDir: 'C:\\profiles\\oss', cwdRoots: ['C:\\src'], concurrency: 1 };
const envC: LocalEnvironment = { id: 'environment_c' as EnvironmentId, name: 'personal', runtime: 'copilot-cli', profileDir: 'D:\\profiles\\personal', cwdRoots: ['D:\\home'], concurrency: 1 };

const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ agentId: 'agent_1' as never, cwd: 'C:\\src\\app', system: '# Ada\n\n## Memory\n\n- fact', tools: [], ...over });
const ctx = (policy?: Policy) => ({ sessionId: 'session_1' as SessionId, callTool: vi.fn(async () => ({ ok: true })), ...(policy ? { policy } : {}) });

function harness(options: FakeClientOptions = {}, parentEnv: Record<string, string | undefined> = {}) {
    const clients: FakeClient[] = [];
    const driver = copilotCliDriver({
        createClient: (init: CopilotClientInit) => {
            const c = fakeClient(init, options);
            clients.push(c);
            return c;
        },
        parentEnv,
        abortGraceMs: 50
    });
    return { driver, clients };
}

async function collect(turn: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of turn) out.push(e);
    return out;
}

describe('copilotCliDriver.open', () => {
    it('opens a Copilot session in the spec folder with the platform prompt appended and repository instructions off', async () => {
        const { driver, clients } = harness();
        const { session, capabilities } = await driver.open(envA, spec({ model: 'gpt-5', tools: ['memory_search'] }), ctx());
        const config = clients[0]!.configs[0]!;
        expect(config.workingDirectory).toBe('C:\\src\\app');
        expect(config.model).toBe('gpt-5');
        expect(config.skipCustomInstructions).toBe(true);
        expect(config.enableConfigDiscovery).toBe(false);
        expect(config.systemMessage?.mode).toBe('append');
        expect(config.systemMessage?.content).toContain(`${PLATFORM_MEMORY_HEADING}\n\n${COPILOT_PLATFORM_MEMORY_NOTE}`);
        expect(config.tools?.map((t) => t.name)).toEqual(['memory_search']);
        expect(config.tools?.every((t) => t.skipPermission)).toBe(true);
        expect(capabilities).toMatchObject({ runtime: 'copilot-cli', resume: 'local', cancel: true, permissions: 'harness-filtered', tools: 'native' });
        expect(capabilities.supported).toContain('tool:memory_search');
        await session.close();
        await driver.dispose();
        expect(clients[0]!.stopped).toBe(1);
    });

    it('refuses a folder outside the environment and another runtime\'s environment', async () => {
        const { driver } = harness();
        await expect(driver.open(envA, spec({ cwd: 'C:\\Windows' }), ctx())).rejects.toThrow('outside the cwdRoots');
        await expect(driver.open({ ...envA, runtime: 'claude-code' }, spec(), ctx())).rejects.toThrow('not copilot-cli');
    });

    it('bridges a platform tool to the platform, after the policy allows it', async () => {
        const script: CopilotScript = async (api) => {
            await api.callTool('memory_search', { query: 'x' });
            api.idle();
        };
        const { driver } = harness({ script });
        const c = ctx(allowAll);
        const { session } = await driver.open(envA, spec({ tools: ['memory_search'] }), c);
        const events = await collect(session.prompt('find it'));
        expect(c.callTool).toHaveBeenCalledWith('memory_search', { query: 'x' });
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'allow', by: 'policy' });
        expect(events.filter((e) => e.type === 'tool-update').map((e) => (e as { status: string }).status)).toEqual(['in_progress', 'completed']);
        await session.close();
    });

    it('denies a platform tool the policy refuses, without calling the platform', async () => {
        const script: CopilotScript = async (api) => {
            await api.callTool('memory_search', { query: 'x' });
            api.idle();
        };
        const { driver } = harness({ script });
        const c = ctx(denyAll);
        const { session } = await driver.open(envA, spec({ tools: ['memory_search'] }), c);
        const events = await collect(session.prompt('find it'));
        expect(c.callTool).not.toHaveBeenCalled();
        expect(events.filter((e) => e.type === 'tool-update').at(-1)).toMatchObject({ status: 'denied' });
        await session.close();
    });

    it('puts Copilot\'s own permission requests to the policy and answers with its decision', async () => {
        const answers: unknown[] = [];
        const script: CopilotScript = async (api) => {
            answers.push(await api.ask({ kind: 'shell', toolCallId: 'call_sh', fullCommandText: 'rm -rf build', intention: 'Clean the build' }));
            api.idle();
        };
        const seen: unknown[] = [];
        const policy: Policy = (request) => {
            seen.push(request);
            return { type: 'permission', outcome: 'deny', scope: 'once', message: 'not here' };
        };
        const { driver } = harness({ script });
        const { session } = await driver.open(envA, spec(), ctx(policy));
        await collect(session.prompt('clean'));
        expect(seen[0]).toMatchObject({ kind: 'permission', toolName: 'shell', category: 'execute', source: 'native', input: { command: 'rm -rf build' }, callId: 'call_sh' });
        expect(answers).toEqual([{ kind: 'reject', feedback: 'not here' }]);
        await session.close();
    });

    it('resumes a session by its Copilot id, in a new epoch', async () => {
        const { driver, clients } = harness();
        const first = await driver.open(envA, spec(), ctx());
        await collect(first.session.prompt('hi'));
        const ref = first.session.ref;
        await first.session.close();
        const again = await driver.open(envA, spec({ resume: ref }), ctx());
        expect(clients[0]!.resumed).toEqual([ref.id]);
        const events = await collect(again.session.prompt('hi again'));
        expect(events[0]!.epoch).toBe(2);
        await again.session.close();
    });
});

describe('permissionRequestOf', () => {
    it('names each kind of Copilot request the way the platform policy rules on it', () => {
        expect(permissionRequestOf({ kind: 'write', fileName: 'a.ts' })).toMatchObject({ toolName: 'write', category: 'edit', permissionKey: 'write:a.ts' });
        expect(permissionRequestOf({ kind: 'read', path: 'a.ts' })).toMatchObject({ toolName: 'read', category: 'read', annotations: { readOnly: true } });
        expect(permissionRequestOf({ kind: 'url', url: 'https://x.dev' })).toMatchObject({ toolName: 'fetch', category: 'fetch' });
        expect(permissionRequestOf({ kind: 'mcp', serverName: 'github', toolName: 'list_issues', readOnly: true })).toMatchObject({ toolName: 'github__list_issues', source: 'mcp', category: 'read' });
        expect(permissionRequestOf({ kind: 'memory' })).toMatchObject({ toolName: 'memory', category: 'other', source: 'native' });
    });
});

describe('isolation (EXE-04/05)', () => {
    it('gives every profile its own COPILOT_HOME, and none of the parent\'s tokens', async () => {
        const parent = { PATH: 'C:\\bin', GH_TOKEN: 'ghp_parent', GITHUB_TOKEN: 'ghs_parent', COPILOT_HOME: 'C:\\Users\\me\\.copilot', GH_CONFIG_DIR: 'C:\\Users\\me\\gh' };
        const { driver, clients } = harness({}, parent);
        for (const env of [envA, envB, envC]) await driver.inspect(env);
        expect(clients.map((c) => c.init.baseDirectory)).toEqual(['C:\\profiles\\work', 'C:\\profiles\\oss', 'D:\\profiles\\personal']);
        for (const [i, env] of [envA, envB, envC].entries()) {
            const child = clients[i]!.init.env;
            expect(child.COPILOT_HOME).toBe(env.profileDir);
            expect(child.GH_TOKEN).toBeUndefined();
            expect(child.GITHUB_TOKEN).toBeUndefined();
        }
        await driver.dispose();
    });

    it('leaves the default home (and the user\'s own gh login) to an environment without a profile', () => {
        expect(copilotAccountEnv({}, { COPILOT_HOME: 'x', GH_TOKEN: 't' })).toEqual({ COPILOT_HOME: undefined });
    });

    it('starts one runtime per environment and reuses it', async () => {
        const { driver, clients } = harness();
        await driver.inspect(envA);
        await driver.inspect(envA);
        await driver.inspect(envB);
        expect(clients.map((c) => c.started)).toEqual([1, 1]);
    });
});

describe('inspect and doctor', () => {
    it('reports the account from the runtime\'s own auth status', async () => {
        const { driver } = harness({ auth: { isAuthenticated: true, authType: 'user', login: 'octocat' } });
        expect(await driver.inspect(envA)).toMatchObject({ authStatus: 'ok', identity: 'octocat', isolation: 'config-dir' });
        const signedOut = harness({ auth: { isAuthenticated: false } });
        expect(await signedOut.driver.inspect(envA)).toMatchObject({ authStatus: 'missing' });
    });

    it('fails two environments on one home and says who is not signed in — without paths', async () => {
        const { driver } = harness({ auth: { isAuthenticated: false } });
        const report = await driver.doctor([envA, { ...envB, profileDir: 'c:/profiles/WORK/' }]);
        expect(report.ok).toBe(false);
        expect(report.findings.find((f) => f.code === COPILOT_CLI_DOCTOR_CODES.sharedHome)?.environmentIds).toEqual([envA.id, envB.id]);
        expect(report.findings.filter((f) => f.code === COPILOT_CLI_DOCTOR_CODES.authMissing)).toHaveLength(2);
        for (const f of report.findings) expect(f.message).not.toMatch(/profiles/i);
    });

    it('reports a runtime that will not start as that environment\'s error', async () => {
        const { driver } = harness({ startError: Object.assign(new Error('spawn C:\\x\\copilot ENOENT'), { code: 'ENOENT' }) });
        const report = await driver.doctor([envA]);
        const finding = report.findings.find((f) => f.code === COPILOT_CLI_DOCTOR_CODES.runtimeUnavailable);
        expect(finding).toMatchObject({ level: 'error', environmentIds: [envA.id] });
        expect(finding?.message).toContain('ENOENT');
        expect(finding?.message).not.toContain('C:\\x');
    });
});

describe('copilotCliQuota', () => {
    const pctx: PluginContext = { now: () => 1_000, log: vi.fn() };

    it('maps a recorded getQuota answer: premium requests metered, chat and completions unlimited', () => {
        const snapshot = quotaFromCopilot(envA, businessQuota.quotaSnapshots, 1_000);
        expect(snapshot).toMatchObject({ sourceId: 'agentic.quota.copilot-cli', runtime: 'copilot-cli', availability: 'reported', via: 'probe' });
        expect(snapshot.windows).toEqual([
            { id: 'premium_interactions', label: 'Premium requests', period: 'month', utilization: 0.953, used: 1430, limit: 1500, unit: 'requests', resetsAt: '2026-10-01T00:00:00.000Z', status: 'warning' },
            { id: 'chat', label: 'Chat messages (unlimited)', period: 'month', utilization: null, used: 0, unit: 'requests', resetsAt: '2026-10-01T00:00:00.000Z', status: 'ok' },
            { id: 'completions', label: 'Code completions (unlimited)', period: 'month', utilization: null, used: 0, unit: 'requests', resetsAt: '2026-10-01T00:00:00.000Z', status: 'ok' }
        ]);
    });

    it('marks an exhausted allowance and leaves out a quota the account does not have', () => {
        const snapshot = quotaFromCopilot(envA, { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 300, remainingPercentage: 0 }, chat: { isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0, hasQuota: false } }, 1);
        expect(snapshot.windows.map((w) => [w.id, w.status])).toEqual([['premium_interactions', 'exhausted']]);
        expect(quotaFromCopilot(envA, {}, 1)).toMatchObject({ availability: 'not-reported', windows: [] });
    });

    it('probes through the environment\'s runtime; a signed-out account is not reported, and a failure is null', async () => {
        const { driver } = harness({ quota: businessQuota.quotaSnapshots });
        const source = copilotCliQuota({ client: (env) => driver.clientFor(env) });
        expect((await source.probe!(envA, pctx))?.windows).toHaveLength(3);
        expect(await source.probe!({ ...envA, runtime: 'claude-code' }, pctx)).toBeNull();

        const signedOut = harness({ auth: { isAuthenticated: false } });
        expect(await copilotCliQuota({ client: (env) => signedOut.driver.clientFor(env) }).probe!(envA, pctx)).toMatchObject({ availability: 'not-reported', reason: 'Not signed in to GitHub Copilot' });

        const broken = copilotCliQuota({ client: async () => Promise.reject(new Error('boom')) });
        expect(await broken.probe!(envA, pctx)).toBeNull();
        expect(pctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('boom'));
    });
});
