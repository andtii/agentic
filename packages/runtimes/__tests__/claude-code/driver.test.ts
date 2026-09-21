// @vitest-environment node
/** `claudeCodeDriver`: environment → isolated agent, OpenSpec → session options, bridged platform tools, capability report. */
import type { Options, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { allowAll, type AgentEvent, type AgentTurn } from '@sigx/ai-agent';
import type { EnvironmentId, LocalEnvironment, OpenSpec, SessionId } from '@agentic/core';
import { buildSystemPrompt } from '../../src/anthropic/index';
import { claudeCodeDriver, PLATFORM_MEMORY_HEADING, withoutCrossSessionTools, type ClaudeCodeDriverOptions } from '../../src/claude-code/index';
import { fakeListen, fakeQuery, messageStart, messageStop, RESULT, textBlocks, toolResult, toolUseBlocks, type TurnScript } from './fake-query';
import { frozenConfig, memoryEntry } from '../anthropic/helpers';

const envA: LocalEnvironment = { id: 'environment_a' as EnvironmentId, name: 'work', runtime: 'claude-code', profileDir: 'C:\\profiles\\work', cwdRoots: ['C:\\src'], concurrency: 2, accountLabel: 'Work' };
const envB: LocalEnvironment = { id: 'environment_b' as EnvironmentId, name: 'personal', runtime: 'claude-code', profileDir: 'D:\\profiles\\personal', cwdRoots: ['D:\\home'], concurrency: 1 };

const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ agentId: 'agent_ada', cwd: 'C:\\src\\app', system: 'You are Ada.', tools: [], ...over });
const ctx = () => ({
    sessionId: 'session_1' as SessionId,
    callTool: async () => ({ ok: true }),
    policy: allowAll
});

const hello: TurnScript = () => [messageStart(), ...textBlocks('Hi'), ...messageStop(), RESULT()];

async function drain(turn: AgentTurn): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const e of turn) events.push(e);
    await turn.result;
    return events;
}

function driverWith(script: TurnScript, over: Partial<ClaudeCodeDriverOptions> = {}) {
    const fake = fakeQuery(script);
    const driver = claudeCodeDriver({ query: fake.query, listen: fakeListen, parentEnv: {}, ...over });
    return { fake, driver };
}

describe('claudeCodeDriver', () => {
    it('is the claude-code runtime and keeps one agent per environment', () => {
        const { driver } = driverWith(hello);
        expect(driver.runtime).toBe('claude-code');
        expect(driver.agentFor(envA)).toBe(driver.agentFor(envA));
        expect(driver.agentFor(envA)).not.toBe(driver.agentFor(envB));
        expect(driver.agentFor(envA).id).toBe('claude-code:environment_a');
    });

    it('refuses an environment of another runtime', async () => {
        const { driver } = driverWith(hello);
        const other = { ...envA, runtime: 'anthropic-api' };
        expect(() => driver.agentFor(other)).toThrow(/runs "anthropic-api"/);
        await expect(driver.open(other, spec(), ctx())).rejects.toThrow(/runs "anthropic-api"/);
    });

    it('maps the spec onto the query: config dir, project setting sources, preset + platform system, cwd, limits, model', async () => {
        const { driver, fake } = driverWith(hello);
        const { session } = await driver.open(envA, spec({ model: 'claude-opus-5', maxTurns: 7, maxBudgetUsd: 2.5 }), ctx());
        await drain(session.prompt('Hello'));
        const opts = fake.calls[0]!;
        expect(opts.cwd).toBe('C:\\src\\app');
        expect(opts.settingSources).toEqual(['project']);
        expect(opts.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'You are Ada.' });
        expect(opts.model).toBe('claude-opus-5');
        expect(opts.maxTurns).toBe(7);
        expect(opts.maxBudgetUsd).toBe(2.5);
        expect(opts.env?.CLAUDE_CONFIG_DIR).toBe('C:\\profiles\\work');
        await session.close();
        await driver.dispose();
    });

    it('opens in the spec’s permission mode (#453); bypassPermissions only where the environment allows it', async () => {
        const { driver, fake } = driverWith(hello);
        const { session } = await driver.open(envA, spec({ permissionMode: 'plan' }), ctx());
        await drain(session.prompt('Hello'));
        expect(fake.calls[0]!.permissionMode).toBe('plan');
        await expect(driver.open(envA, spec({ permissionMode: 'bypassPermissions' }), ctx())).rejects.toThrow(/not allowed in environment environment_a/);
        const allowed = { ...envB, id: 'environment_c' as EnvironmentId, cwdRoots: envA.cwdRoots, allowBypassPermissions: true };
        const opened = await driver.open(allowed, spec({ permissionMode: 'bypassPermissions' }), ctx());
        await drain(opened.session.prompt('Hello'));
        expect(fake.calls[1]).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    });

    it('lists the account’s models from an unprompted query (#453), null when it cannot', async () => {
        const closed: boolean[] = [];
        const modelsQuery = () => ({ supportedModels: async () => [{ value: 'claude-fable-5-1', displayName: 'Fable', description: 'Most capable' }, { value: 'sonnet', displayName: 'Sonnet', description: '' }], close: () => void closed.push(true) });
        const { driver } = driverWith(hello, { modelsQuery: modelsQuery as never });
        expect(await driver.models!(envA)).toEqual([{ id: 'claude-fable-5-1', label: 'Fable', description: 'Most capable' }, { id: 'sonnet', label: 'Sonnet' }]);
        expect(closed).toEqual([true]);
        const failing = driverWith(hello, { modelsQuery: (() => ({ supportedModels: async () => { throw new Error('signed out'); }, close: () => {} })) as never }).driver;
        expect(await failing.models!(envA)).toBeNull();
    });

    it("takes Claude Code's cross-session tools out of every session: they reach the operator's own sessions, not chat members", async () => {
        const { driver, fake } = driverWith(hello);
        const { session } = await driver.open(envA, spec(), ctx());
        await drain(session.prompt('Hello'));
        expect(fake.calls[0]!.disallowedTools).toEqual(expect.arrayContaining(['ListAgents', 'SendMessage']));
        await session.close();
        await driver.dispose();
    });

    it('keeps whatever else the caller disallows beside them', () => {
        const seen: (string[] | undefined)[] = [];
        const query = withoutCrossSessionTools(((params: { options?: Options }) => {
            seen.push(params.options?.disallowedTools);
            return undefined as never;
        }) as never);
        query({ prompt: 'x', options: { disallowedTools: ['WebFetch', 'SendMessage'] } });
        expect(seen[0]).toEqual(['WebFetch', 'SendMessage', 'ListAgents']);
    });

    it('refuses a cwd outside the environment cwdRoots', async () => {
        const { driver } = driverWith(hello);
        await expect(driver.open(envA, spec({ cwd: 'C:\\Windows' }), ctx())).rejects.toThrow(/outside the cwdRoots/);
        await expect(driver.open(envA, spec({ cwd: 'C:\\src-other' }), ctx())).rejects.toThrow(/outside the cwdRoots/);
    });

    it('labels the platform memory block as platform-owned (MEM-10)', async () => {
        const system = buildSystemPrompt({
            config: frozenConfig(),
            tools: ['memory_search'],
            memories: [memoryEntry]
        });
        const { driver, fake } = driverWith(hello);
        const { session } = await driver.open(envA, spec({ system }), ctx());
        await drain(session.prompt('Hello'));
        const append = (fake.calls[0]!.systemPrompt as { append: string }).append;
        expect(append).toContain(PLATFORM_MEMORY_HEADING);
        expect(append).toContain('not Claude Code memory');
        expect(append).toContain(memoryEntry.text);
        expect(append).not.toMatch(/^## Memory$/m);
        await driver.dispose();
    });

    it('serves the named platform tools as client tools and states the ones it cannot serve', async () => {
        const script: TurnScript = async function* () {
            yield messageStart();
            yield* toolUseBlocks('toolu_m', 'mcp__sigx-tools__memory_search', { query: 'deploys' });
            yield* messageStop();
            yield toolResult('toolu_m', '{"memories":[]}');
            yield messageStart();
            yield* textBlocks('Nothing stored.');
            yield* messageStop();
            yield RESULT();
        };
        const { driver } = driverWith(script);
        const { session, capabilities } = await driver.open(envA, spec({ tools: ['memory_search', 'task_report', 'jira_search'] }), ctx());
        expect(capabilities.supported).toEqual(expect.arrayContaining(['tool:memory_search', 'tool:task_report']));
        expect(capabilities.unsupported).toContainEqual({ op: 'tool:jira_search', reason: 'not a platform tool the daemon can serve' });

        const events = await drain(session.prompt('What do you know about deploys?'));
        expect(events.find((e) => e.type === 'tool-call')).toMatchObject({ name: 'memory_search', input: { query: 'deploys' } });
        await driver.dispose();
    });

    it('reports capabilities from the adapter, with the runtime-memory boundary stated (AGT-09, MEM-10)', async () => {
        const { driver } = driverWith(hello);
        const { capabilities } = await driver.open(envA, spec(), ctx());
        expect(capabilities).toMatchObject({ runtime: 'claude-code', resume: 'local', cancel: true, steer: false, permissions: 'harness-filtered', tools: 'mcp' });
        expect(capabilities.supported).toEqual(expect.arrayContaining(['session.resume', 'session.fork', 'session.cancel', 'memory.platform']));
        const ops = capabilities.unsupported.map((u) => u.op);
        expect(ops).toEqual(expect.arrayContaining(['session.steer', 'memory.runtime', 'permissions.every-call']));
        for (const u of capabilities.unsupported) expect(u.reason.length).toBeGreaterThan(0);
        await driver.dispose();
    });
});

describe('claudeCodeDriver isolation (EXE-04/05)', () => {
    /** A script that starts the CLI the way the SDK does: `spawnClaudeCodeProcess` with the query's env. */
    function spawning(spawned: SpawnOptions[]): { script: TurnScript; spawn: (o: SpawnOptions) => SpawnedProcess } {
        const script: TurnScript = (_u, _t, c) => {
            const o = c.options as Options;
            o.spawnClaudeCodeProcess?.({ command: 'claude', args: [], cwd: o.cwd, env: o.env ?? {}, signal: new AbortController().signal } as SpawnOptions);
            return [messageStart(), ...textBlocks('ok'), ...messageStop(), RESULT()];
        };
        const spawn = (o: SpawnOptions) => {
            spawned.push(o);
            return { killed: false, exitCode: null, kill: () => true, on: () => undefined, once: () => undefined, off: () => undefined } as unknown as SpawnedProcess;
        };
        return { script, spawn };
    }

    beforeEach(() => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', 'D:\\profiles\\personal');
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-daemon-parent');
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.invalid');
    });
    afterEach(() => vi.unstubAllEnvs());

    it("the child for profile A never carries profile B's config dir or the daemon's account variables", async () => {
        const spawned: SpawnOptions[] = [];
        const { script, spawn } = spawning(spawned);
        const driver = claudeCodeDriver({ query: fakeQuery(script).query, listen: fakeListen, spawn });

        const a = await driver.open(envA, spec(), ctx());
        await drain(a.session.prompt('one'));
        const b = await driver.open(envB, spec({ cwd: 'D:\\home\\x' }), ctx());
        await drain(b.session.prompt('two'));

        expect(spawned).toHaveLength(2);
        const [childA, childB] = spawned.map((s) => s.env as Record<string, string | undefined>);
        expect(childA!.CLAUDE_CONFIG_DIR).toBe('C:\\profiles\\work');
        expect(childB!.CLAUDE_CONFIG_DIR).toBe('D:\\profiles\\personal');
        for (const child of [childA!, childB!]) {
            expect(child).not.toHaveProperty('ANTHROPIC_API_KEY');
            expect(child).not.toHaveProperty('ANTHROPIC_BASE_URL');
        }
        expect(Object.values(childA!)).not.toContain('D:\\profiles\\personal');
        expect(Object.values(childB!)).not.toContain('C:\\profiles\\work');
        await driver.dispose();
    });

    it("an environment without a profileDir does not inherit the daemon's CLAUDE_CONFIG_DIR", async () => {
        const spawned: SpawnOptions[] = [];
        const { script, spawn } = spawning(spawned);
        const driver = claudeCodeDriver({ query: fakeQuery(script).query, listen: fakeListen, spawn });
        const { profileDir: _drop, ...rest } = envA;
        const bare: LocalEnvironment = rest;
        const { session } = await driver.open(bare, spec(), ctx());
        await drain(session.prompt('one'));
        expect(spawned[0]!.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        await driver.dispose();
    });
});

describe('claude-code plugin lists (#453)', () => {
    it('keep in step with the adapter: every adapter model and mode is offered', async () => {
        const { CLAUDE_CODE_MODELS, PERMISSION_MODES } = await import('@sigx/ai-agent-claude-code');
        const { CLAUDE_CODE_MODEL_IDS, CLAUDE_CODE_PERMISSION_MODES } = await import('../../src/plugins');
        expect(CLAUDE_CODE_MODEL_IDS).toEqual(expect.arrayContaining(CLAUDE_CODE_MODELS.map((m) => m.id)));
        expect(CLAUDE_CODE_PERMISSION_MODES).toEqual([...PERMISSION_MODES]);
    });
});
