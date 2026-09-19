// @vitest-environment node
/** `codexCliDriver` and `codexCli` (#320): environment → isolated app-server, OpenSpec → thread, approvals through the policy, tools over MCP, limits streamed, auth and doctor. */
import { allowAll, denyAll, type AgentEvent, type AgentTurn, type Policy } from '@sigx/ai-agent';
import { createJsonRpcPeer } from '@sigx/ai-agent/harness';
import { environmentVerdict, type EnvironmentId, type LocalEnvironment, type OpenSpec, type SessionId } from '@agentic/core';
import { buildSystemPrompt } from '../../src/anthropic/index';
import { CODEX_CLI_DOCTOR_CODES, CODEX_PLATFORM_MEMORY_NOTE, codexAccountEnv, codexCliDriver, initializeCodex, type CodexCliDriverOptions, type CodexPeer } from '../../src/codex-cli/index';
import { PLATFORM_MEMORY_HEADING } from '../../src/harness/index';
import { frozenConfig, memoryEntry } from '../anthropic/helpers';
import teamLimits from './fixtures/rate-limits-team.json';
import { ENV, FakeAppServer, fakeConnect, type TurnScript } from './fake-app-server';

const envB: LocalEnvironment = { id: 'environment_b' as EnvironmentId, name: 'personal', runtime: 'codex-cli', profileDir: 'D:\\profiles\\personal', cwdRoots: ['D:\\home'], concurrency: 1 };
const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ agentId: 'agent_ada', cwd: 'C:\\work\\repo', system: 'You are Ada.', tools: [], ...over });
const ctx = (policy: Policy = allowAll, calls: { name: string; input: unknown }[] = []) => ({
    sessionId: 'session_1' as SessionId,
    callTool: async (name: string, input: unknown) => {
        calls.push({ name, input });
        return { hits: [] };
    },
    policy
});

async function drain(turn: AgentTurn): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const e of turn) events.push(e);
    await turn.result;
    return events;
}

function driverWith(script?: TurnScript, over: Partial<CodexCliDriverOptions> = {}) {
    const fake = fakeConnect(script);
    const driver = codexCliDriver({ connect: fake.connect, parentEnv: {}, ...over });
    return { fake, driver };
}

describe('codexCliDriver', () => {
    it('is the codex-cli runtime and keeps one agent per environment', () => {
        const { driver } = driverWith();
        expect(driver.runtime).toBe('codex-cli');
        expect(driver.agentFor(ENV)).toBe(driver.agentFor(ENV));
        expect(driver.agentFor(ENV)).not.toBe(driver.agentFor(envB));
        expect(driver.agentFor(ENV).id).toBe('codex-cli:environment_work');
    });

    it('refuses an environment of another runtime and a cwd outside its roots', async () => {
        const { driver } = driverWith();
        await expect(driver.open({ ...ENV, runtime: 'claude-code' }, spec(), ctx())).rejects.toThrow(/runs "claude-code"/);
        await expect(driver.open(ENV, spec({ cwd: 'D:\\elsewhere' }), ctx())).rejects.toThrow('[codex-cli] cwd D:\\elsewhere is outside the cwdRoots of environment "work"');
    });

    it('maps the spec onto a thread: cwd, model, sandbox, approvals, developer instructions with platform memory, tools over MCP', async () => {
        const { driver, fake } = driverWith();
        const system = buildSystemPrompt({ config: frozenConfig(), tools: ['memory_search'], memories: [memoryEntry] });
        const { session, capabilities } = await driver.open(ENV, spec({ system, model: 'gpt-5.5', tools: ['memory_search', 'jira_search'] }), ctx());
        const start = fake.servers[0]!.requests.find((r) => r.method === 'thread/start')!.params as Record<string, unknown>;
        expect(start).toMatchObject({ cwd: 'C:\\work\\repo', model: 'gpt-5.5', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
        expect(start.developerInstructions).toContain(`${PLATFORM_MEMORY_HEADING}\n\n${CODEX_PLATFORM_MEMORY_NOTE}`);
        expect(start.developerInstructions).toContain(memoryEntry.text);
        const mcp = (start.config as { mcp_servers: { agentic: { url: string; http_headers: Record<string, string> } } }).mcp_servers.agentic;
        expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(mcp.http_headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
        expect(capabilities).toMatchObject({ runtime: 'codex-cli', resume: 'local', cancel: true, steer: true, permissions: 'harness-filtered', tools: 'mcp' });
        expect(capabilities.supported).toContain('tool:memory_search');
        expect(capabilities.unsupported).toContainEqual({ op: 'tool:jira_search', reason: 'not a platform tool the daemon can serve' });
        await session.close();
        await driver.dispose();
    });

    it('a thread without tools gets no MCP server', async () => {
        const { driver, fake } = driverWith();
        const { session } = await driver.open(ENV, spec(), ctx());
        expect((fake.servers[0]!.requests.find((r) => r.method === 'thread/start')!.params as { config: unknown }).config).toBeNull();
        await session.close();
        await driver.dispose();
    });

    it('streams text and usage, and ends the turn on turn/completed', async () => {
        const { driver } = driverWith();
        const { session } = await driver.open(ENV, spec(), ctx());
        const events = await drain(session.prompt('Hello'));
        expect(events.filter((e) => e.type === 'part-delta').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello from Codex.');
        const end = events.at(-1)!;
        expect(end).toMatchObject({ type: 'turn-end', stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } });
        await session.close();
        await driver.dispose();
    });

    it('bridges a platform tool Codex calls over MCP to the platform, after the policy allows it', async () => {
        const calls: { name: string; input: unknown }[] = [];
        const { driver } = driverWith(async (s) => {
            const r = await s.mcp('memory_search', { query: 'tea' });
            s.text(r.ok ? 'found' : 'failed');
        });
        const { session } = await driver.open(ENV, spec({ tools: ['memory_search'] }), ctx(allowAll, calls));
        const events = await drain(session.prompt('Search'));
        expect(calls).toEqual([{ name: 'memory_search', input: { query: 'tea' } }]);
        const call = events.find((e) => e.type === 'tool-call')!;
        expect(call).toMatchObject({ name: 'memory_search', input: { query: 'tea' } });
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'allow', by: 'policy' });
        expect(events).toContainEqual(expect.objectContaining({ type: 'tool-update', callId: (call as { callId: string }).callId, status: 'completed' }));
        await session.close();
        await driver.dispose();
    });

    it('a platform tool the policy denies never runs: the call is denied and Codex gets an error', async () => {
        const calls: { name: string; input: unknown }[] = [];
        let seen: { ok: boolean; text: string } | undefined;
        const { driver } = driverWith(async (s) => {
            seen = await s.mcp('memory_search', { query: 'tea' });
        });
        const { session } = await driver.open(ENV, spec({ tools: ['memory_search'] }), ctx(denyAll, calls));
        const events = await drain(session.prompt('Search'));
        expect(calls).toEqual([]);
        expect(seen?.ok).toBe(false);
        expect(events.filter((e) => e.type === 'tool-update' && e.status !== 'in_progress').map((e) => (e as { status: string }).status)).toEqual(['denied']);
        await session.close();
        await driver.dispose();
    });

    it('routes a command approval through the policy: allow → accept, deny → decline (the call is denied)', async () => {
        const decisions: (string | undefined)[] = [];
        const script: TurnScript = async (s) => {
            decisions.push(await s.command('npm test', { ask: true }));
        };
        const allowed = driverWith(script);
        const a = await allowed.driver.open(ENV, spec(), ctx(allowAll));
        const aEvents = await drain(a.session.prompt('Test it'));
        expect(aEvents.find((e) => e.type === 'tool-call')).toMatchObject({ name: 'shell', category: 'execute', input: { command: 'npm test' } });
        expect(aEvents.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'allow' });
        expect(aEvents).toContainEqual(expect.objectContaining({ type: 'tool-update', status: 'completed', output: { exitCode: 0, output: 'ok\n' } }));

        const denied = driverWith(script);
        const d = await denied.driver.open(ENV, spec(), ctx(denyAll));
        const dEvents = await drain(d.session.prompt('Test it'));
        expect(dEvents).toContainEqual(expect.objectContaining({ type: 'tool-update', status: 'denied' }));
        expect(decisions).toEqual(['accept', 'decline']);
        for (const { session } of [a, d]) await session.close();
        await allowed.driver.dispose();
        await denied.driver.dispose();
    });

    it('a session grant is acceptForSession for Codex', async () => {
        let decision: string | undefined;
        const { driver } = driverWith(async (s) => {
            decision = await s.command('git status', { ask: true });
        });
        const { session } = await driver.open(ENV, spec(), { ...ctx(), policy: Object.assign(() => ({ type: 'permission', outcome: 'allow', scope: 'session' }) as const, { id: 'grant-all' }) });
        await drain(session.prompt('Status'));
        expect(decision).toBe('acceptForSession');
        await session.close();
        await driver.dispose();
    });

    it("re-emits Codex's rate-limit updates as ext codex-cli/rate-limits on the session", async () => {
        const { driver, fake } = driverWith(async (s) => {
            s.server.emit('account/rateLimits/updated', { rateLimits: teamLimits.rateLimits });
            s.text('ok');
        });
        const { session } = await driver.open(ENV, spec(), ctx());
        const seen: AgentEvent[] = [];
        const sub = (async () => {
            for await (const e of session.subscribe()) seen.push(e);
        })();
        await drain(session.prompt('Hi'));
        expect(seen).toContainEqual(expect.objectContaining({ type: 'ext', ns: 'codex-cli', name: 'rate-limits', data: teamLimits.rateLimits }));
        expect(fake.servers).toHaveLength(1);
        await session.close();
        await sub;
        await driver.dispose();
    });

    it('a turn whose app-server dies ends with process_exited', async () => {
        const { driver } = driverWith(async (s) => {
            s.server.exit('codex crashed');
            await new Promise(() => undefined);
        });
        const { session } = await driver.open(ENV, spec(), ctx());
        const events = await drain(session.prompt('Hi'));
        expect(events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'error', error: { code: 'process_exited', message: 'codex crashed' } });
        await session.close();
        await driver.dispose();
    });

    it('resumes the thread the spec names, in a new epoch', async () => {
        const { driver, fake } = driverWith();
        const first = await driver.open(ENV, spec(), ctx());
        await drain(first.session.prompt('Hi'));
        const ref = first.session.ref;
        await first.session.close();
        const again = await driver.open(ENV, spec({ resume: ref }), ctx());
        const events = await drain(again.session.prompt('Again'));
        expect(fake.servers[0]!.requests.find((r) => r.method === 'thread/resume')!.params).toMatchObject({ threadId: ref.id });
        expect(again.session.id).toBe(ref.id);
        expect(events[0]!.epoch).toBe(2);
        await again.session.close();
        await driver.dispose();
    });

    it('dispose closes the app-server', async () => {
        const { driver, fake } = driverWith();
        const { session } = await driver.open(ENV, spec(), ctx());
        await drain(session.prompt('Hi'));
        await driver.dispose();
        expect(fake.servers[0]!.closedCount).toBe(1);
    });
});

describe('codexCliDriver: auth and doctor', () => {
    it('inspect asks Codex who is signed in, on a short-lived app-server', async () => {
        const server = new FakeAppServer();
        const driver = codexCliDriver({ connect: async () => server.connection(), parentEnv: {} });
        const inspection = await driver.inspect(ENV);
        expect(inspection).toMatchObject({ authStatus: 'ok', identity: 'dev@example.com', isolation: 'config-dir', capabilities: { runtime: 'codex-cli' } });
        expect(server.requests.map((r) => r.method)).toEqual(['account/read']);
        expect(server.closedCount).toBe(1);
        expect(await driver.inspect({ ...ENV, profileDir: undefined, id: 'environment_default' as EnvironmentId })).toMatchObject({ isolation: 'none' });
    });

    it('no account where Codex needs one is missing; an API key is ok', async () => {
        const out = new FakeAppServer();
        out.account = { account: null, requiresOpenaiAuth: true };
        expect(await codexCliDriver({ connect: async () => out.connection() }).inspect(ENV)).toMatchObject({ authStatus: 'missing' });
        const key = new FakeAppServer();
        key.account = { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
        expect(await codexCliDriver({ connect: async () => key.connection() }).inspect(ENV)).toMatchObject({ authStatus: 'ok', identity: 'API key' });
    });

    it('doctor: two environments on one home are an error; a missing CLI is named without a path', async () => {
        const shared: LocalEnvironment = { ...envB, id: 'environment_c' as EnvironmentId, name: 'clash', profileDir: 'c:/PROFILES/work/' };
        const ok = codexCliDriver({ connect: async () => new FakeAppServer().connection(), parentEnv: {} });
        const report = await ok.doctor([ENV, shared, envB]);
        expect(report.ok).toBe(false);
        const clash = report.findings.find((f) => f.code === CODEX_CLI_DOCTOR_CODES.sharedHome)!;
        expect(clash.environmentIds).toEqual([ENV.id, shared.id]);
        expect(environmentVerdict(report, envB.id, 1).ok).toBe(true);

        const missing = codexCliDriver({ connect: async () => Promise.reject(Object.assign(new Error('spawn C:\\tools\\codex.exe ENOENT'), { code: 'ENOENT' })) });
        const r2 = await missing.doctor([ENV]);
        const finding = r2.findings.find((f) => f.code === CODEX_CLI_DOCTOR_CODES.cliMissing)!;
        expect(finding.level).toBe('error');
        expect(finding.message).not.toMatch(/C:\\/);
    });
});

describe('isolation: one CODEX_HOME per profile, no OPENAI_* from the daemon', () => {
    const parent = { PATH: 'C:\\bin', OPENAI_API_KEY: 'sk-daemon', OPENAI_BASE_URL: 'https://proxy', CODEX_HOME: 'C:\\Users\\me\\.codex' };
    const homes = ['C:\\profiles\\work', 'C:\\profiles\\personal', 'D:\\clients\\acme\\.codex'];

    it('three profiles get three homes and otherwise the same environment', () => {
        const envs = homes.map((profileDir) => codexAccountEnv({ profileDir }, parent));
        expect(envs.map((e) => e.CODEX_HOME)).toEqual(homes);
        for (const e of envs) {
            expect(e.OPENAI_API_KEY).toBeUndefined();
            expect('OPENAI_API_KEY' in e && 'OPENAI_BASE_URL' in e).toBe(true);
            expect({ ...e, CODEX_HOME: 'x' }).toEqual({ ...envs[0], CODEX_HOME: 'x' });
        }
        expect(codexAccountEnv({}, parent)).toEqual({ OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, CODEX_HOME: undefined });
    });

    it('every environment connects on its own app-server', async () => {
        const seen: string[] = [];
        const driver = codexCliDriver({
            connect: async (env) => {
                seen.push(env.id);
                return new FakeAppServer().connection();
            }
        });
        const envs = [ENV, envB];
        for (const env of envs) {
            const { session } = await driver.open(env, spec({ cwd: env.cwdRoots[0]! }), ctx());
            await drain(session.prompt('Hi'));
            await session.close();
        }
        expect(seen).toEqual([ENV.id, envB.id]);
        await driver.dispose();
    });
});

describe('initializeCodex over the wire', () => {
    it('handshakes with a server that omits "jsonrpc", then says initialized', async () => {
        const toServer = new TransformStream<Uint8Array, Uint8Array>();
        const toClient = new TransformStream<Uint8Array, Uint8Array>();
        const peer: CodexPeer = createJsonRpcPeer({ readable: toClient.readable, writable: toServer.writable, requireVersion: false, cancelMethod: null });
        const lines: Record<string, unknown>[] = [];
        const server = (async () => {
            const writer = toClient.writable.getWriter();
            const decoder = new TextDecoder();
            let buffer = '';
            for await (const chunk of toServer.readable as unknown as AsyncIterable<Uint8Array>) {
                buffer += decoder.decode(chunk, { stream: true });
                let nl: number;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const msg = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
                    buffer = buffer.slice(nl + 1);
                    lines.push(msg);
                    if (msg.method === 'initialize') await writer.write(new TextEncoder().encode(`${JSON.stringify({ id: msg.id, result: { userAgent: 'codex/0.155.1', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' } })}\n`));
                    if (msg.method === 'initialized') return writer.close();
                }
            }
        })();
        const info = await initializeCodex(peer);
        await server;
        expect(info.userAgent).toBe('codex/0.155.1');
        expect(lines.map((l) => l.method)).toEqual(['initialize', 'initialized']);
        expect(lines[0]!.params).toEqual({ clientInfo: { name: 'agentic', title: 'agentic', version: '0.1.0' }, capabilities: { experimentalApi: false } });
        await peer.close();
    });
});
