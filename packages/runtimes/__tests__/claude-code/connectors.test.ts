// @vitest-environment node
/** MCP connectors on a daemon-hosted Claude Code session (#280): credentials by `tool.call`, tools served beside the platform's, the policy, the prompt, close. */
import { defineTool, type AnyTool } from '@sigx/ai';
import type { AgentEvent, AgentTurn, Policy, PolicyRequest } from '@sigx/ai-agent';
import { CONNECTOR_CALL_TOOL, CONNECTOR_CREDENTIALS_TOOL, CONNECTOR_TOOLS_TOOL, type EnvironmentId, type PlatformConnectorTools, type LocalEnvironment, type OpenSpec, type OpenSpecConnector, type SessionId } from '@agentic/core';
import { z } from 'zod';
import { sessionPolicyOf } from '../../src/policy/index';
import { claudeCodeDriver, withUnavailableConnectors, type DaemonConnectorOpenInput, type DaemonConnectorOpener } from '../../src/claude-code/index';
import { fakeListen, fakeQuery, messageStart, messageStop, RESULT, textBlocks, type TurnScript } from './fake-query';

const env: LocalEnvironment = { id: 'environment_a' as EnvironmentId, name: 'work', runtime: 'claude-code', cwdRoots: ['C:\\src'], concurrency: 2 };
const http: OpenSpecConnector = { id: 'acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', auth: { bearer: 'acme-token', headers: { 'X-Team': 'acme-team' } } };
const stdio: OpenSpecConnector = { id: 'files', transport: 'stdio', command: 'files-mcp', args: ['--ro'], auth: { env: { FILES_KEY: 'files-key' } } };
const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ agentId: 'agent_ada', cwd: 'C:\\src\\app', system: 'You are Ada.', tools: ['memory_search'], ...over });

const hello: TurnScript = () => [messageStart(), ...textBlocks('Hi'), ...messageStop(), RESULT()];

async function drain(turn: AgentTurn): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const e of turn) events.push(e);
    await turn.result;
    return events;
}

/** A connector with one tool per name, namespaced as `@agentic/mcp`'s openers do. */
function fakeOpener(tools: Record<string, { readonly readOnly?: boolean; readonly destructive?: boolean }> = { echo: {} }) {
    const opened: DaemonConnectorOpenInput[] = [];
    const calls: { name: string; input: unknown }[] = [];
    const closed: string[] = [];
    const opener: DaemonConnectorOpener = async (input) => {
        opened.push(input);
        return {
            tools: Object.entries(tools).map(([name, hints]) =>
                defineTool({
                    name: `${input.id}__${name}`,
                    description: `${name} on ${input.id}`,
                    input: z.object({ text: z.string().optional() }),
                    annotations: hints,
                    execute: async (args) => {
                        calls.push({ name: `${input.id}__${name}`, input: args });
                        return `${name}:${args.text ?? ''}`;
                    }
                }) as AnyTool
            ),
            close: async () => {
                closed.push(input.id);
            }
        };
    };
    return { opener, opened, calls, closed };
}

/** The platform's answer to the daemon's credentials call, recorded. */
function platform(values: Record<string, unknown> = { acme: { bearer: 'tok-VALUE-1', headers: { 'X-Team': 'team-VALUE-2' } }, files: { env: { FILES_KEY: 'key-VALUE-3' } } }) {
    const asked: unknown[] = [];
    const callTool = async (tool: string, input: unknown) => {
        if (tool !== CONNECTOR_CREDENTIALS_TOOL) return { ok: true };
        asked.push(input);
        const id = (input as { connectorId: string }).connectorId;
        const answer = values[id];
        if (answer instanceof Error) throw answer;
        return answer ?? {};
    };
    return { callTool, asked };
}

/** `listen` that keeps the adapter's MCP handler, so a test calls a served tool the way the CLI would. */
function capturingListen() {
    let handler: ((r: Request) => Promise<Response>) | undefined;
    const listen: typeof fakeListen = async (h, o) => {
        handler = h;
        return fakeListen(h, o);
    };
    const rpc = async (method: string, params: unknown): Promise<unknown> => {
        const res = await handler!(
            new Request('http://127.0.0.1:1/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer tok' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
            })
        );
        const text = await res.text();
        const json = text.startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? text);
        return (JSON.parse(json) as { result?: unknown; error?: unknown }).result;
    };
    return { listen, rpc };
}

describe('claudeCodeDriver: MCP connectors (#280)', () => {
    it('fetches each connector’s credentials over tool.call, opens it and serves its tools beside the platform tools', async () => {
        const { opener, opened, calls } = fakeOpener();
        const { callTool, asked } = platform();
        const { listen, rpc } = capturingListen();
        const fake = fakeQuery(hello);
        const driver = claudeCodeDriver({ query: fake.query, listen, parentEnv: {}, connectors: opener });

        const { session, capabilities } = await driver.open(env, spec({ connectors: [http, stdio], tools: ['memory_search', 'acme__echo'] }), { sessionId: 'session_1' as SessionId, callTool });
        expect(asked).toEqual([{ connectorId: 'acme' }, { connectorId: 'files' }]);
        expect(opened).toEqual([
            { id: 'acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', bearer: 'tok-VALUE-1', headers: { 'X-Team': 'team-VALUE-2' } },
            // No cwd named: the stdio server runs in the session's folder.
            { id: 'files', transport: 'stdio', command: 'files-mcp', args: ['--ro'], cwd: 'C:\\src\\app', env: { FILES_KEY: 'key-VALUE-3' } }
        ]);
        expect(capabilities.supported).toEqual(expect.arrayContaining(['tool:memory_search', 'tool:acme__echo', 'tool:files__echo']));
        // A connector tool the agent is granted is not reported as a platform tool the daemon cannot serve.
        expect(capabilities.unsupported.map((u) => u.op)).not.toContain('tool:acme__echo');

        await drain(session.prompt('Hello'));
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } });
        const listed = (await rpc('tools/list', {})) as { tools: { name: string }[] };
        expect(listed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['memory_search', 'acme__echo', 'files__echo']));
        await rpc('tools/call', { name: 'files__echo', arguments: { text: 'hi' } });
        expect(calls).toEqual([{ name: 'files__echo', input: { text: 'hi' } }]);
        // No credential value reaches the CLI: not its options, not its environment, not the system prompt.
        expect(JSON.stringify(fake.calls[0], (_k, v: unknown) => (typeof v === 'function' ? undefined : v))).not.toMatch(/VALUE-/);
        await session.close();
        await driver.dispose();
    });

    it('asks nothing for a connector without secrets, and closes every connector with the session', async () => {
        const { opener, closed } = fakeOpener();
        const { callTool, asked } = platform();
        const driver = claudeCodeDriver({ query: fakeQuery(hello).query, listen: fakeListen, parentEnv: {}, connectors: opener });
        const bare: OpenSpecConnector = { id: 'open', transport: 'streamable-http', url: 'https://open.test/mcp' };
        const { session } = await driver.open(env, spec({ connectors: [bare, http] }), { sessionId: 'session_1' as SessionId, callTool });
        expect(asked).toEqual([{ connectorId: 'acme' }]);
        expect(closed).toEqual([]);
        await session.close();
        expect(closed.sort()).toEqual(['acme', 'open']);
        await driver.dispose();
    });

    it('leaves out what it cannot open — named with why in the prompt and the report, credentials scrubbed — and still opens the session', async () => {
        const failing: DaemonConnectorOpener = async (input) => {
            if (input.id === 'acme') throw new Error(`401 from server for token ${input.bearer}`);
            return { tools: [], close: async () => {} };
        };
        const { callTool } = platform({ acme: { bearer: 'tok-VALUE-1' }, files: new Error('its secret "files-key" is not set (/plugins/files)') });
        const fake = fakeQuery(hello);
        const driver = claudeCodeDriver({ query: fake.query, listen: fakeListen, parentEnv: {}, connectors: failing });
        const outside: OpenSpecConnector = { id: 'outside', transport: 'stdio', command: 'x', cwd: 'C:\\Windows' };
        const nourl: OpenSpecConnector = { id: 'nourl', transport: 'streamable-http' };
        const { session, capabilities } = await driver.open(env, spec({ connectors: [http, stdio, outside, nourl] }), { sessionId: 'session_1' as SessionId, callTool });
        await drain(session.prompt('Hello'));

        const append = (fake.calls[0]!.systemPrompt as { append: string }).append;
        expect(append).toContain('## Connectors not available');
        expect(append).toContain('- acme: it could not be opened: 401 from server for token ***');
        expect(append).toContain('- files: it could not be opened: its secret "files-key" is not set (/plugins/files)');
        expect(append).toContain('- outside: its folder C:\\Windows is outside the folders of environment "work"');
        expect(append).toContain('- nourl: it has no URL');
        expect(append).not.toContain('VALUE-');
        expect(capabilities.unsupported).toContainEqual({ op: 'connector:acme', reason: 'it could not be opened: 401 from server for token ***' });
        await driver.dispose();
    });

    it('without an opener, names every connector as unavailable on this machine', async () => {
        const fake = fakeQuery(hello);
        const driver = claudeCodeDriver({ query: fake.query, listen: fakeListen, parentEnv: {} });
        const { session } = await driver.open(env, spec({ connectors: [http] }), { sessionId: 'session_1' as SessionId, callTool: platform().callTool });
        await drain(session.prompt('Hello'));
        expect((fake.calls[0]!.systemPrompt as { append: string }).append).toContain('- acme: this machine cannot open MCP connectors');
        await driver.dispose();
    });

    it('presents a connector tool to the policy as source mcp with its category from the hints', async () => {
        const { opener } = fakeOpener({ drop: { destructive: true }, look: { readOnly: true }, send: {} });
        const seen: PolicyRequest[] = [];
        const policy: Policy = (request) => {
            seen.push(request);
            return { kind: 'allow' } as never;
        };
        const script: TurnScript = async function* (_u, _t, ctx) {
            yield messageStart();
            for (const tool of ['drop', 'look', 'send']) await ctx.ask(`mcp__sigx-tools__acme__${tool}`, {});
            await ctx.ask('mcp__sigx-tools__memory_search', { query: 'x' });
            yield* textBlocks('done');
            yield* messageStop();
            yield RESULT();
        };
        const driver = claudeCodeDriver({ query: fakeQuery(script).query, listen: fakeListen, parentEnv: {}, connectors: opener });
        const { session } = await driver.open(env, spec({ connectors: [http] }), { sessionId: 'session_1' as SessionId, callTool: platform().callTool, policy });
        await drain(session.prompt('go'));
        const byTool = new Map(seen.filter((r) => r.kind === 'permission').map((r) => [r.toolName, r]));
        expect(byTool.get('acme__drop')).toMatchObject({ source: 'mcp', category: 'destructive' });
        expect(byTool.get('acme__look')).toMatchObject({ source: 'mcp', category: 'read' });
        expect(byTool.get('acme__send')).toMatchObject({ source: 'mcp', category: 'network' });
        expect(byTool.get('memory_search')?.source).not.toBe('mcp');
        await driver.dispose();
    });
});

describe('claudeCodeDriver: platform-run connectors (#534)', () => {
    const declared: PlatformConnectorTools = {
        connectors: [
            {
                id: 'gmail',
                tools: [
                    { name: 'gmail__search-messages', description: 'Search messages', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnly: true } },
                    { name: 'gmail__trash-message', description: 'Trash a message', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { destructive: true } },
                    { name: 'gmail__send-email', description: 'Send an email', inputSchema: { type: 'object', properties: {} } }
                ]
            }
        ],
        unavailable: [{ id: 'calendar', reason: 'it could not be opened: its account is not connected' }]
    };

    /** The platform: declarations at open, a result per call — every call recorded as the daemon sends it. */
    function conduitPlatform(answer: unknown = declared) {
        const calls: { tool: string; input: unknown }[] = [];
        const callTool = async (tool: string, input: unknown) => {
            calls.push({ tool, input });
            if (tool === CONNECTOR_TOOLS_TOOL) {
                if (answer instanceof Error) throw answer;
                return answer;
            }
            if (tool === CONNECTOR_CALL_TOOL) return { messages: [{ id: 'm1' }] };
            return { ok: true };
        };
        return { callTool, calls };
    }

    it('asks the platform for the declarations once, serves them beside the platform tools, and sends every call back over tool.call', async () => {
        const { callTool, calls } = conduitPlatform();
        const { listen, rpc } = capturingListen();
        const fake = fakeQuery(hello);
        const driver = claudeCodeDriver({ query: fake.query, listen, parentEnv: {} });
        const { session, capabilities } = await driver.open(env, spec(), { sessionId: 'session_1' as SessionId, callTool });
        expect(calls).toEqual([{ tool: CONNECTOR_TOOLS_TOOL, input: {} }]);
        expect(capabilities.supported).toEqual(expect.arrayContaining(['tool:memory_search', 'tool:gmail__search-messages', 'tool:gmail__send-email']));
        expect(capabilities.unsupported).toContainEqual({ op: 'connector:calendar', reason: 'it could not be opened: its account is not connected' });

        await drain(session.prompt('Hello'));
        expect((fake.calls[0]!.systemPrompt as { append: string }).append).toContain('- calendar: it could not be opened: its account is not connected');
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } });
        const listed = (await rpc('tools/list', {})) as { tools: { name: string; inputSchema: unknown }[] };
        expect(listed.tools.find((t) => t.name === 'gmail__search-messages')?.inputSchema).toMatchObject({ required: ['query'] });
        const result = await rpc('tools/call', { name: 'gmail__search-messages', arguments: { query: 'is:unread' } });
        expect(JSON.stringify(result)).toContain('m1');
        expect(calls.at(-1)).toEqual({ tool: CONNECTOR_CALL_TOOL, input: { connectorId: 'gmail', tool: 'gmail__search-messages', input: { query: 'is:unread' } } });
        await session.close();
        await driver.dispose();
    });

    it('presents them to the policy as MCP tools with their category, so a denied send never reaches the platform', async () => {
        const { callTool, calls } = conduitPlatform();
        const seen: PolicyRequest[] = [];
        // The agent's own rules, compiled as the daemon compiles them: reads and trashing allowed, anything else (sending) denied.
        const rules = sessionPolicyOf({
            rules: [
                { id: 'read', match: { categories: ['read', 'destructive'] }, outcome: 'allow' },
                { id: 'network', match: { categories: ['network'] }, outcome: 'deny' }
            ],
            grants: []
        });
        const policy: Policy = (request, context) => {
            seen.push(request);
            return rules(request, context);
        };
        const answers: string[] = [];
        const script: TurnScript = async function* (_u, _t, ctx) {
            yield messageStart();
            for (const tool of ['gmail__trash-message', 'gmail__search-messages', 'gmail__send-email']) answers.push((await ctx.ask(`mcp__sigx-tools__${tool}`, {})).behavior);
            yield* textBlocks('done');
            yield* messageStop();
            yield RESULT();
        };
        const driver = claudeCodeDriver({ query: fakeQuery(script).query, listen: fakeListen, parentEnv: {} });
        const { session } = await driver.open(env, spec(), { sessionId: 'session_1' as SessionId, callTool, policy });
        await drain(session.prompt('go'));
        const byTool = new Map(seen.filter((r) => r.kind === 'permission').map((r) => [r.toolName, r]));
        expect(byTool.get('gmail__trash-message')).toMatchObject({ source: 'mcp', category: 'destructive' });
        expect(byTool.get('gmail__search-messages')).toMatchObject({ source: 'mcp', category: 'read' });
        expect(byTool.get('gmail__send-email')).toMatchObject({ source: 'mcp', category: 'network' });
        expect(answers).toEqual(['allow', 'allow', 'deny']);
        expect(calls.filter((c) => c.tool === CONNECTOR_CALL_TOOL)).toEqual([]);
        await driver.dispose();
    });

    it('a platform that predates the call, or a tool name a platform tool already has: the session opens without them', async () => {
        const old = conduitPlatform(Object.assign(new Error('no platform tool named "connector_tools"'), { code: 'unsupported' }));
        const driver = claudeCodeDriver({ query: fakeQuery(hello).query, listen: fakeListen, parentEnv: {} });
        const first = await driver.open(env, spec(), { sessionId: 'session_1' as SessionId, callTool: old.callTool });
        expect(first.capabilities.supported.filter((op) => op.startsWith('tool:gmail'))).toEqual([]);
        expect(first.capabilities.unsupported.filter((u) => u.op.startsWith('connector:'))).toEqual([]);
        await first.session.close();

        const shadow = conduitPlatform({
            connectors: [
                { id: 'mem', tools: [{ name: 'memory_search', description: 'x', inputSchema: { type: 'object' } }] },
                // Not an object schema: not a declaration the daemon serves.
                { id: 'odd', tools: [{ name: 'odd__x', description: 'x', inputSchema: { type: 'string' } }] }
            ],
            unavailable: []
        });
        const second = await driver.open(env, spec(), { sessionId: 'session_2' as SessionId, callTool: shadow.callTool });
        expect(second.capabilities.unsupported).toContainEqual({ op: 'connector:mem', reason: 'its tool "memory_search" has the name of a tool this session already has' });
        expect(second.capabilities.supported).not.toContain('tool:odd__x');
        await second.session.close();
        await driver.dispose();
    });
});

describe('withUnavailableConnectors', () => {
    it('adds to the platform’s own section, before what follows it', () => {
        const system = 'Intro\n\n## Connectors not available\n\nThese connectors are configured for you but their tools are not in this session; if the user needs one, say which and why.\n\n- a: off\n\n## Platform memory\n\nfacts';
        expect(withUnavailableConnectors(system, [{ id: 'b', reason: 'down' }])).toBe(
            'Intro\n\n## Connectors not available\n\nThese connectors are configured for you but their tools are not in this session; if the user needs one, say which and why.\n\n- a: off\n- b: down\n\n## Platform memory\n\nfacts'
        );
    });

    it('starts the section at the end when there is none, and leaves the prompt alone when nothing is missing', () => {
        expect(withUnavailableConnectors('Intro', [{ id: 'b', reason: 'down' }])).toMatch(/^Intro\n\n## Connectors not available\n\n.+\n\n- b: down$/);
        expect(withUnavailableConnectors('Intro', [])).toBe('Intro');
    });
});
