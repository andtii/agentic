/**
 * An agent's MCP connectors reach its local sessions (#240, architecture §9;
 * AGT-02, AST-09, PLG-04): `Routing.run` asks the Registry about them in the
 * same `gate()` hop as the runtime, the session opens each ready one through
 * the app's opener (`openMcpConnector` over an in-process server here) with
 * its credential opened from the Registry, and the tools join the roster as
 * `<id>__<tool>` under the agent's grants and category rules. A connector
 * that is off, missing, secretless or unreachable never fails the session.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ApprovalRule, type TaskId, type ToolGrant, type WorkspaceId } from '@agentic/core';
import { mcpConnectorSetup, openMcpConnector, type FetchLike } from '@agentic/mcp';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, anthropicApiPlugin } from '@agentic/runtimes';
import type { ModelRequest } from '@sigx/ai';
import { mockModel, type MockModel } from '@sigx/ai/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek } from '../../src/auth/index';
import { defineRegistry, registryKey, type ConnectorStatus, type GateConnector } from '../../src/registry/index';
import { anthropicApiRuntime, connectorCategory, createSessionFactory, openSessionConnectors, defineRoutingActor, routingKey, type ConnectorOpenInput, type ConnectorOpener, type RuntimeCatalogue } from '../../src/routing/index';
import { defineSessionActor } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const TOKEN = 'tok-acme-9f2c-SECRET';
const URL_ = 'https://mcp.acme.test/mcp';

interface FakeTool {
    readonly name: string;
    readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}

/** A Streamable HTTP MCP server in a `fetch`: JSON responses, bearer checked, every `tools/call` recorded. */
function fakeServer(tools: readonly FakeTool[], options: { token?: string; down?: boolean } = {}) {
    const calls: { name: string; args: unknown }[] = [];
    let closed = 0;
    const fetch: FetchLike = async (input, init) => {
        const request = new Request(String(input), init);
        if (options.down) throw new TypeError(`fetch failed: connect ECONNREFUSED (auth ${request.headers.get('authorization') ?? 'none'})`);
        if (request.method === 'DELETE') {
            closed++;
            return new Response(null, { status: 200 });
        }
        if (options.token !== undefined && request.headers.get('authorization') !== `Bearer ${options.token}`) return new Response('unauthorized', { status: 401 });
        const message = JSON.parse(await request.text()) as { id?: number; method: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
        if (message.id === undefined) return new Response(null, { status: 202 });
        let result: unknown;
        if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'acme', version: '1' } };
        else if (message.method === 'tools/list') result = { tools: tools.map((t) => ({ name: t.name, description: `the ${t.name} tool`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, ...(t.annotations ? { annotations: t.annotations } : {}) })) };
        else if (message.method === 'tools/call') {
            calls.push({ name: message.params!.name!, args: message.params!.arguments });
            result = { content: [{ type: 'text', text: `echoed ${JSON.stringify(message.params!.arguments)}` }] };
        } else return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } }), { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
    };
    return { fetch, calls, closed: () => closed };
}

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const hasTool = (req: ModelRequest, name: string) => !!req.tools?.some((t) => t.name === name);
const hasToolResult = (req: ModelRequest) => req.messages.some((m) => m.role === 'tool');

let app: TestActorApp;
let model: MockModel;
let server: ReturnType<typeof fakeServer>;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin] });

/** Calls `acme__echo` once when the session has it, then answers. */
const scripted = (tool = 'acme__echo') =>
    mockModel({ modelId: 'claude-test', respond: (req) => (hasTool(req, tool) && !hasToolResult(req) ? { toolCalls: [{ name: tool, input: { text: 'hi' }, id: 'c1' }] } : { text: 'done' }) });

async function start(tools: readonly FakeTool[] = [{ name: 'echo' }], options: { token?: string; down?: boolean; tool?: string } = {}): Promise<void> {
    server = fakeServer(tools, { token: TOKEN, ...options });
    model = scripted(options.tool);
    const opener: ConnectorOpener = (input) => (input.kind === 'mcp' ? openMcpConnector({ ...input, fetch: server.fetch, timeoutMs: 2_000 }) : Promise.reject(new Error(`unexpected ${input.kind}`)));
    const runtimes: RuntimeCatalogue = { [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime({ routing: () => Routing, sessions: () => Session, model, connectors: opener }) };
    Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }) });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, registry: () => Registry, runtimes });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, Registry, AuditActor]);
    await app.start();
}
afterEach(() => app?.stop());

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const registry = () => app.as(owner).actor(Registry, registryKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const audit = () => app.as(owner).actor(AuditActor, auditKey(WS)).list({}).then((page) => page.events);
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

/** The acme connector, as the "Add MCP connector" dialog (#241) will store it. */
async function addAcme(options: { secret?: boolean } = {}): Promise<void> {
    const { manifest, connector } = mcpConnectorSetup({ id: 'acme', name: 'Acme', transport: 'streamable-http', url: URL_, secret: 'acme.token' });
    await registry().register(manifest, { enabled: true, grant: 'declared' });
    await registry().putConnector(connector);
    if (options.secret !== false) await registry().setSecret('acme.token', TOKEN);
}

async function agent(options: { tools?: readonly ToolGrant[]; rules?: readonly ApprovalRule[] } = {}): Promise<AgentId> {
    const id = 'atlas' as AgentId;
    await app
        .as(owner)
        .actor(AgentActor, agentKey(WS, id))
        .update({ name: 'Atlas', instructions: 'Be brief.', tools: [{ name: 'task_report' }, ...(options.tools ?? [])], connectors: [{ id: 'acme' }], approvalPolicy: [...(options.rules ?? [])], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
    return id;
}

async function run(id: string, assignee: AgentId): Promise<TaskView> {
    await task(id).create({ objective: 'use acme', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {} }, { owner: assignee });
    return routing().run(id as TaskId);
}

describe('a ready connector on a local session', () => {
    beforeEach(() => start());

    it('its tools join the roster as <id>__<tool> and are callable; the credential is opened from the Registry and kept nowhere', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addAcme();
        const a = await agent();
        await run('t1', a);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(hasTool(model.requests[0]!, 'acme__echo')).toBe(true);
        expect(server.calls).toEqual([{ name: 'echo', args: { text: 'hi' } }]);
        // What the open found is recorded once; the connector is closed when the session is.
        const c = await registry().getConnector('acme');
        expect(c).toMatchObject({ status: { state: 'ok' }, tools: ['acme__echo'] });
        const opened = (await audit()).filter((e) => e.kind === 'secret.opened');
        expect(opened.map((e) => e.data)).toContainEqual({ name: 'acme.token', pluginId: 'acme' });
        // The token is in no record: the session, the Registry's export, the audit log.
        const info = await session((await task('t1').get()).sessionId!).get();
        for (const record of [info, await registry().exportRows(), await audit(), await registry().connectors()]) expect(JSON.stringify(record)).not.toContain(TOKEN);
    });

    it('a grant of `ask` goes through the approval flow before the server sees the call', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addAcme();
        const a = await agent({ tools: [{ name: 'acme__echo', mode: 'ask' }] });
        await run('t1', a);
        const sessionId = (await task('t1').get()).sessionId!;
        await until(async () => (await session(sessionId).get()).status === 'awaiting', 'the approval request');
        expect(server.calls).toEqual([]);
        const [requestId] = (await session(sessionId).get()).openRequests;
        await session(sessionId).respond(requestId!, { type: 'permission', outcome: 'allow', scope: 'once' });
        await settled('t1');
        expect(server.calls).toHaveLength(1);
    });

    it('a grant of `deny` refuses the call; the server never sees it', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addAcme();
        const a = await agent({ tools: [{ name: 'acme__echo', mode: 'deny' }] });
        await run('t1', a);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(server.calls).toEqual([]);
    });

    it('turning the connector plugin off removes its tools from the NEXT session, and the agent is told why', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addAcme();
        const a = await agent();
        await run('t1', a);
        await settled('t1');
        const before = model.requests.length;
        await registry().disable('acme');
        await run('t2', a);
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        const later = model.requests.slice(before);
        expect(later.length).toBeGreaterThan(0);
        expect(later.every((r) => !hasTool(r, 'acme__echo'))).toBe(true);
        expect(later[0]!.system).toContain('## Connectors not available');
        expect(later[0]!.system).toContain('- acme: its plugin is turned off (/plugins/acme)');
        expect(server.calls).toHaveLength(1);
    });

    it('a connector whose secret is not set is left out and named; the session runs', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addAcme({ secret: false });
        const a = await agent();
        await run('t1', a);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(hasTool(model.requests[0]!, 'acme__echo')).toBe(false);
        expect(model.requests[0]!.system).toContain('- acme: its secret "acme.token" is not set (/plugins/acme)');
        // Recorded, so the plugin page shows why the connector does nothing.
        const c = await registry().getConnector('acme');
        expect(c?.status).toMatchObject({ state: 'error', error: expect.stringContaining('secret not set') });
    });
});

describe('category rules reach connector tools (source mcp, category from the MCP hints)', () => {
    it('a `network: ask` rule asks for a tool with no hints; a read-only one is allowed by `read: allow`', async () => {
        await start([{ name: 'echo' }, { name: 'look', annotations: { readOnlyHint: true } }]);
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addAcme();
        const rules: ApprovalRule[] = [
            { id: 'category:read', match: { categories: ['read'] }, outcome: 'allow' },
            { id: 'category:network', match: { categories: ['network'] }, outcome: 'ask' }
        ];
        const a = await agent({ rules });
        await run('t1', a);
        const sessionId = (await task('t1').get()).sessionId!;
        await until(async () => (await session(sessionId).get()).status === 'awaiting', 'the approval request');
        expect(server.calls).toEqual([]);
        expect(connectorCategory({ readOnly: true })).toBe('read');
        expect(connectorCategory({ destructive: true, readOnly: true })).toBe('destructive');
        expect(connectorCategory(undefined)).toBe('network');
    });
});

describe('a connector that cannot be reached', () => {
    it('never fails the session: the tools are left out, the error is recorded without the credential', async () => {
        await start([{ name: 'echo' }], { down: true });
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await addAcme();
        const a = await agent();
        await run('t1', a);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(hasTool(model.requests[0]!, 'acme__echo')).toBe(false);
        expect(model.requests[0]!.system).toContain('- acme: it could not be reached');
        const c = await registry().getConnector('acme');
        expect(c?.status.state).toBe('error');
        expect(c?.status.error).toBeTruthy();
        expect(JSON.stringify(c)).not.toContain(TOKEN);
        expect(model.requests[0]!.system).not.toContain(TOKEN);
    });

    it('a connector the agent names that nobody set up is named as missing', async () => {
        await start();
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        const a = await agent();
        await run('t1', a);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(model.requests[0]!.system).toContain('- acme: no such connector is set up in this workspace');
    });
});

describe('a conduit connector on a local session (#530)', () => {
    const gmail = (over: Partial<GateConnector> = {}): GateConnector => ({ id: 'gmail', state: 'ready', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1', tools: [], status: { state: 'unknown' }, ...over });
    const harness = () => {
        const inputs: ConnectorOpenInput[] = [];
        const secrets: string[] = [];
        const reports: { id: string; status: ConnectorStatus; tools?: readonly string[] }[] = [];
        let closed = 0;
        const opener: ConnectorOpener = async (input) => {
            inputs.push(input);
            return { tools: [], toolNames: ['gmail__search'], close: async () => void closed++ };
        };
        return {
            inputs,
            secrets,
            reports,
            closed: () => closed,
            open: (connectors: readonly GateConnector[], o: ConnectorOpener = opener) =>
                openSessionConnectors({
                    connectors,
                    opener: o,
                    secret: async (name) => (secrets.push(name), undefined),
                    report: async (id, status, tools) => void reports.push({ id, status, ...(tools ? { tools } : {}) })
                })
        };
    };

    it('a connected one goes to the opener as { kind: conduit, … } with ids only; no secret is opened', async () => {
        const h = harness();
        const opened = await h.open([gmail()]);
        expect(h.inputs).toEqual([{ kind: 'conduit', id: 'gmail', pluginId: 'gmail', connector: 'gmail', account: 'acct_1' }]);
        expect(h.secrets).toEqual([]);
        expect(opened.unavailable).toEqual([]);
        expect(h.reports).toEqual([{ id: 'gmail', status: { state: 'ok' }, tools: ['gmail__search'] }]);
        await opened.close();
        expect(h.closed()).toBe(1);
    });

    it('one not connected yet is left out, with the reason and where to connect it; the opener is not called', async () => {
        const h = harness();
        const opened = await h.open([gmail({ account: undefined })]);
        expect(h.inputs).toEqual([]);
        expect(opened.unavailable).toEqual([{ id: 'gmail', reason: 'it is not connected yet (/plugins/gmail)' }]);
    });

    it('an opener failure never fails the session: left out, recorded on the connector', async () => {
        const h = harness();
        const opened = await h.open([gmail()], async () => {
            throw new Error('needs reauth');
        });
        expect(opened.unavailable).toEqual([{ id: 'gmail', reason: 'it could not be opened: needs reauth' }]);
        expect(h.reports).toEqual([{ id: 'gmail', status: { state: 'error', error: 'needs reauth' } }]);
    });
});
