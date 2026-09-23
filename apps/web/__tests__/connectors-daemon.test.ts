/**
 * Gmail on a DAEMON-hosted session (#534; AGT-02, AST-09, EXE-10, PLG-07): the app's own opener (`connectorOpener` of
 * `src/plugins/catalogue.ts`) behind the real tool-call port, router, Machine, Session, Registry and ConnectorAccounts
 * actors — only the machine (the in-memory daemon, and the Claude Code driver over a fake CLI) and Google are fakes.
 *
 * A session on a machine gets Gmail's tools as declarations over `tool.call`, and every call runs on the Worker, as the
 * session, through the same engine a local session uses: refresh and `needsReauth` behave the same. No token, OAuth
 * client or engine secret reaches a daemon frame, the spec, or the Machine's and router's records.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CONNECTOR_CALL_TOOL,
    CONNECTOR_TOOLS_TOOL,
    type AgentId,
    type ApprovalRule,
    type EnvironmentId,
    type LocalEnvironment,
    type MachineId,
    type OpenSpec,
    type SessionId,
    type TaskId,
    type WorkspaceId
} from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { claudeCodePlugin, sessionPolicyOf } from '@agentic/runtimes';
import { claudeCodeDriver } from '@agentic/runtimes/claude-code';
import {
    AgentActor,
    AuditActor,
    ConnectorAccounts,
    PairingDirectory,
    TaskActor,
    Workspace,
    agentKey,
    createSessionFactory,
    createToolCallPort,
    defineMachineActor,
    defineRegistry,
    defineRoutingActor,
    defineSessionActor,
    generateWorkspaceKek,
    importWorkspaceKek,
    machineKey,
    mintAgentPrincipal,
    registryKey,
    routingKey,
    taskKey,
    workspaceKey,
    type CommandSink,
    type MachineSocketPort,
    type RuntimeCatalogue,
    type ToolCallPort
} from '@agentic/platform';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { fakeListen, fakeQuery, messageStart, messageStop, RESULT, textBlocks, type TurnScript } from '../../../packages/runtimes/__tests__/claude-code/fake-query';
import { ensureEngineSecret, workspaceConnectorEngine, type ConnectorRegistry } from '../src/connectors/engine';
import { connectorOpener } from '../src/plugins/catalogue';

const WS = 'u_mail' as WorkspaceId;
const owner = userPrincipal('u_mail');
const KEK = generateWorkspaceKek();
const E1 = 'env_1' as EnvironmentId;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CLIENT_SECRET = 'client-shh-4b7a';
/** The in-memory environment's runtime, as a runtime plugin the Registry lists — its sessions run on a machine. */
const IN_MEMORY_PLUGIN = { ...claudeCodePlugin, id: 'in-memory', name: 'In-memory' };
const SEARCH = { connectorId: 'gmail', tool: 'gmail__search-messages', input: { query: 'is:unread' } };

/**
 * Google: the first access token is inside conduit's refresh skew, so the first call refreshes — `revoked` makes that
 * refresh `invalid_grant`. Past the sign-in's profile read, Gmail answers only the refreshed token. Every request recorded.
 */
function fakeGoogle() {
    const seen: string[] = [];
    const state = { revoked: false };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const http = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname}`);
        if (url.href === 'https://oauth2.googleapis.com/token') {
            const form = new URLSearchParams(await request.text());
            if (form.get('grant_type') === 'authorization_code') return json({ access_token: 'at-first-91c2', refresh_token: 'rt-live-5e0f', expires_in: 30, token_type: 'Bearer' });
            if (state.revoked) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
            return json({ access_token: 'at-live-77d3', expires_in: 3600, token_type: 'Bearer' });
        }
        const path = url.pathname.replace('/gmail/v1/users/me', '');
        const auth = request.headers.get('authorization');
        // The sign-in reads the profile with the first token; everything after needs the refreshed one.
        if (path === '/profile' && auth === 'Bearer at-first-91c2') return json({ emailAddress: 'owner@example.com' });
        if (!url.href.startsWith(GMAIL) || auth !== 'Bearer at-live-77d3') return json({ error: { message: 'Invalid Credentials' } }, 401);
        if (path === '/messages' && request.method === 'GET') return json({ messages: [{ id: 'm1', threadId: 't1' }] });
        if (path === '/messages/send') return json({ id: 'm9', threadId: 't9', labelIds: ['SENT'] });
        return json({ error: { message: 'not found' } }, 404);
    };
    return { http, seen, state };
}

/** A fake socket layer bridged to `InMemoryDaemon` seats (the routing tests'). */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent: string[] = [];
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        this.sent.push(text);
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let google: ReturnType<typeof fakeGoogle>;
let sockets: FakeSockets;
let port: ToolCallPort;
/** Every frame the daemon sent the platform, as sent. */
let fromDaemon: string[];
const daemons: InMemoryDaemon[] = [];
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let Machine: ReturnType<typeof defineMachineActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [IN_MEMORY_PLUGIN, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });
const runtimes: RuntimeCatalogue = { 'in-memory': { host: 'daemon' } };
const registry = () => app.as(owner).actor(Registry, registryKey(WS));

beforeEach(async () => {
    google = fakeGoogle();
    sockets = new FakeSockets();
    fromDaemon = [];
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes });
    // As `platformActors` wires it: the tool-call port runs a daemon session's conduit connectors through the app's opener.
    port = createToolCallPort({ routing: () => Routing, sessions: () => Session, registry: () => Registry, connectors: connectorOpener({ http: google.http }) });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: port });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Registry, AuditActor, ConnectorAccounts]);
    await app.start();
});
afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

/** What the plugin page and the sign-in routes do: the OAuth client, Gmail on, one connected account on the record. */
async function connectGmail(): Promise<void> {
    await registry().enable('gmail');
    await registry().setSecret('client-id', 'cid.apps.googleusercontent.com');
    await registry().setSecret('client-secret', CLIENT_SECRET);
    const reg = registry() as unknown as ConnectorRegistry;
    const engine = workspaceConnectorEngine({
        workspaceId: WS,
        principal: owner,
        secret: (name) => reg.openSecret(name, 'gmail'),
        engineSecret: await ensureEngineSecret(reg, 'gmail'),
        redirectUri: 'https://agentic.example/_agentic/connectors/callback',
        http: google.http
    });
    const begun = await engine.auth.begin({ connector: 'gmail', method: 'oauth', owner: WS, returnTo: '/plugins/gmail' });
    if (begun.type !== 'redirect') throw new Error('expected a redirect');
    const { account } = await engine.auth.complete({ params: { state: new URL(begun.url).searchParams.get('state')!, code: 'code-1' } });
    await registry().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: account.id });
}

/** Every value no daemon may ever see: the tokens, the OAuth client secret, the workspace's engine secret. */
async function credentials(): Promise<string[]> {
    return ['at-first-91c2', 'at-live-77d3', 'rt-live-5e0f', CLIENT_SECRET, await registry().openSecret('connector-engine-secret', 'gmail')];
}

/** A paired machine whose in-memory daemon calls `tool` once per prompt; every frame it sends is recorded. */
async function pairAndConnect(tool?: { name: string; input: unknown }): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'box' });
    await app.as(owner).actor(Machine, machineKey(WS, machineId)).pair(pairingCode, { name: 'box' });
    const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000, ...(tool ? { tool } : {}) }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const asDaemon = app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, key);
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    void (async () => {
        try {
            for (;;) {
                const raw = (await seat.next()) as string;
                fromDaemon.push(raw);
                await asDaemon.socketMessage(raw);
            }
        } catch {
            // dropped
        }
    })();
    await until(async () => (await app.as(owner).actor(Machine, key).get()).online, 'the machine online');
    return machineId;
}

async function runTask(rules: readonly ApprovalRule[] = []): Promise<{ agentId: AgentId; open: { sessionId: SessionId; spec: OpenSpec } }> {
    const agentId = 'mailer' as AgentId;
    await app
        .as(owner)
        .actor(AgentActor, agentKey(WS, agentId))
        .update({ name: 'Mailer', instructions: 'Be brief.', tools: [{ name: 'task_report' }], connectors: [{ id: 'gmail' }], approvalPolicy: [...rules], execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } }, 'create');
    await app.as(owner).actor(TaskActor, taskKey(WS, 't1' as TaskId)).create({ objective: 'check mail', origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
    await app.as(owner).actor(Routing, routingKey(WS)).run('t1' as TaskId);
    await until(() => sockets.sent.some((t) => (JSON.parse(t) as { t: string }).t === 'session.open'), 'session.open');
    const open = sockets.sent.map((t) => JSON.parse(t) as { t: string; sessionId: SessionId; spec: OpenSpec }).find((f) => f.t === 'session.open')!;
    return { agentId, open };
}

const results = () => sockets.sent.map((t) => JSON.parse(t) as { t: string; output?: unknown; error?: { code: string; message: string } }).filter((f) => f.t === 'tool.result');

describe('Gmail on a daemon-hosted session (#534)', () => {
    it('a call from the machine runs on the Worker as the session: the result goes back in the tool.result, no credential in any frame, the spec or a record', async () => {
        await connectGmail();
        const machineId = await pairAndConnect({ name: CONNECTOR_CALL_TOOL, input: SEARCH });
        const { open } = await runTask();
        // Nothing of Gmail rides the spec: not a connector entry, not an account, not a secret name.
        expect(open.spec.connectors).toBeUndefined();
        expect(open.spec.system).not.toContain('gmail:');

        await until(() => results().length > 0, 'tool.result');
        expect(results()[0]).toMatchObject({ output: [{ id: 'm1', threadId: 't1' }] });
        // It ran through the engine: the stale token refreshed, then Gmail searched with the fresh one.
        expect(google.seen).toContain('GET /gmail/v1/users/me/messages');
        expect(fromDaemon.some((t) => t.includes(CONNECTOR_CALL_TOOL))).toBe(true);

        const everything = JSON.stringify([sockets.sent, fromDaemon, await app.as(owner).actor(Machine, machineKey(WS, machineId)).get(), await app.as(owner).actor(Routing, routingKey(WS)).get()]);
        for (const value of await credentials()) expect(everything).not.toContain(value);
    });

    it('an account whose refresh Google refuses: the call is a needs_reauth tool error asking for a reconnect, and the account says so', async () => {
        await connectGmail();
        google.state.revoked = true;
        await pairAndConnect({ name: CONNECTOR_CALL_TOOL, input: SEARCH });
        await runTask();
        await until(() => results().length > 0, 'tool.result');
        expect(results()[0]!.error).toMatchObject({ code: 'needs_reauth' });
        expect(results()[0]!.error!.message).toContain('reconnect');
        expect(google.seen).not.toContain('GET /gmail/v1/users/me/messages');
        expect(await app.as(owner).actor(ConnectorAccounts, `${WS}:connector-accounts`).accounts()).toEqual([expect.objectContaining({ status: 'needsReauth' })]);
    });

    it('a connector the session is not given is refused', async () => {
        await connectGmail();
        await registry().putConnector({ id: 'mail2', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_other' });
        await pairAndConnect({ name: CONNECTOR_CALL_TOOL, input: { ...SEARCH, connectorId: 'mail2', tool: 'mail2__search-messages' } });
        await runTask();
        await until(() => results().length > 0, 'tool.result');
        expect(results()[0]!.error).toMatchObject({ code: 'forbidden' });
        expect(google.seen).not.toContain('GET /gmail/v1/users/me/messages');
    });

    it('a Claude Code session granted gmail lists gmail__search-messages and calls it; the agent’s rules decide, and a denied send never reaches Google', async () => {
        await connectGmail();
        const machineId = await pairAndConnect();
        const rules: ApprovalRule[] = [
            { id: 'category:read', match: { categories: ['read'] }, outcome: 'allow' },
            { id: 'category:network', match: { categories: ['network'] }, outcome: 'deny' }
        ];
        const { agentId, open } = await runTask(rules);

        // The daemon's side: the real Claude Code driver over a fake CLI, its `callTool` the Machine's `tool.call` → port →
        // `tool.result` round trip, every frame serialized as it would be on the socket.
        const frames: string[] = [];
        const principal = mintAgentPrincipal({ workspaceId: WS, agentId, sessionId: open.sessionId });
        let calls = 0;
        const callTool = async (tool: string, input: unknown): Promise<unknown> => {
            const call = JSON.stringify({ t: 'tool.call', callId: `call_${++calls}`, sessionId: open.sessionId, tool, input });
            frames.push(call);
            const parsed = JSON.parse(call) as { callId: string; tool: string; input: unknown };
            try {
                const output = await port.call({ callId: parsed.callId, sessionId: open.sessionId, tool: parsed.tool, input: parsed.input }, principal);
                frames.push(JSON.stringify({ t: 'tool.result', callId: parsed.callId, output }));
                return JSON.parse(JSON.stringify(output ?? null)) as unknown;
            } catch (e) {
                frames.push(JSON.stringify({ t: 'tool.result', callId: parsed.callId, error: { message: (e as Error).message } }));
                throw e;
            }
        };
        let handler: ((r: Request) => Promise<Response>) | undefined;
        const listen: typeof fakeListen = async (h, o) => {
            handler = h;
            return fakeListen(h, o);
        };
        const rpc = async (method: string, params: unknown): Promise<unknown> => {
            const res = await handler!(new Request('http://127.0.0.1:1/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer tok' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
            const text = await res.text();
            const json = text.startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? text);
            return (JSON.parse(json) as { result?: unknown }).result;
        };
        const answers: string[] = [];
        const script: TurnScript = async function* (_u, _t, ctx) {
            yield messageStart();
            for (const tool of ['gmail__search-messages', 'gmail__send-email']) answers.push((await ctx.ask(`mcp__sigx-tools__${tool}`, {})).behavior);
            yield* textBlocks('done');
            yield* messageStop();
            yield RESULT();
        };
        const fake = fakeQuery(script);
        const driver = claudeCodeDriver({ query: fake.query, listen, parentEnv: {} });
        const cwd = open.spec.cwd || 'C:\\work';
        const env: LocalEnvironment = { id: E1, name: 'work', runtime: 'claude-code', cwdRoots: [cwd], concurrency: 1 };
        const { session, capabilities } = await driver.open(env, { ...open.spec, cwd }, { sessionId: open.sessionId, callTool, policy: sessionPolicyOf(open.spec.policy!) });
        expect(JSON.parse(frames[0]!)).toMatchObject({ tool: CONNECTOR_TOOLS_TOOL, input: {} });
        expect(capabilities.supported).toEqual(expect.arrayContaining(['tool:gmail__search-messages', 'tool:gmail__send-email']));

        for await (const _e of session.prompt('check mail')) void _e;
        // The agent's own rules, compiled on the machine: a read is allowed, sending (a network action) denied.
        expect(answers).toEqual(['allow', 'deny']);
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } });
        const listed = (await rpc('tools/list', {})) as { tools: { name: string }[] };
        expect(listed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['gmail__search-messages', 'gmail__get-message', 'gmail__send-email']));
        const result = await rpc('tools/call', { name: 'gmail__search-messages', arguments: { query: 'is:unread' } });
        expect(JSON.stringify(result)).toContain('m1');
        expect(google.seen).toContain('GET /gmail/v1/users/me/messages');
        expect(google.seen.some((s) => s.includes('/messages/send'))).toBe(false);

        const everything = JSON.stringify([frames, open, fake.calls.map((c) => JSON.stringify(c, (_k, v: unknown) => (typeof v === 'function' ? undefined : v))), await app.as(owner).actor(Machine, machineKey(WS, machineId)).get()]);
        for (const value of await credentials()) expect(everything).not.toContain(value);
        await session.close();
        await driver.dispose();
    });
});
