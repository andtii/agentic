/**
 * Gmail on a local `anthropic-api` session (#533; AGT-02, AGT-09, AST-09, EXE-10): the app's own opener
 * (`connectorOpener` of `src/plugins/catalogue.ts`) behind the real `anthropicApiRuntime`, session factory, router,
 * Registry and ConnectorAccounts actor — only the model (`mockModel`) and Google (a `fetch`) are fakes.
 *
 * An agent granted `gmail` gets `gmail__search-messages` and the other Gmail tools. A read runs under a `read: allow`
 * rule; sending is a `network` action, so a `network: ask` rule stops it for approval before Google sees it. The
 * account's tokens never reach the model, the record or the audit.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ApprovalRule, type TaskId, type WorkspaceId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, anthropicApiPlugin } from '@agentic/runtimes';
import {
    AgentActor,
    AuditActor,
    ConnectorAccounts,
    TaskActor,
    Workspace,
    agentKey,
    anthropicApiRuntime,
    auditKey,
    createSessionFactory,
    defineRegistry,
    defineRoutingActor,
    defineSessionActor,
    generateWorkspaceKek,
    importWorkspaceKek,
    registryKey,
    routingKey,
    taskKey,
    type RuntimeCatalogue
} from '@agentic/platform';
import type { ModelRequest } from '@sigx/ai';
import { mockModel, type MockModel } from '@sigx/ai/testing';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { ensureEngineSecret, workspaceConnectorEngine, type ConnectorRegistry } from '../src/connectors/engine';
import { connectorOpener } from '../src/plugins/catalogue';

const WS = 'u_mail' as WorkspaceId;
const owner = userPrincipal('u_mail');
const KEK = generateWorkspaceKek();
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Google: a code for tokens, the profile, a search and a send — every request recorded. */
function fakeGoogle() {
    const seen: string[] = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const http = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname}`);
        if (url.href === 'https://oauth2.googleapis.com/token') return json({ access_token: 'at-live', refresh_token: 'rt-live', expires_in: 3600, token_type: 'Bearer' });
        if (!url.href.startsWith(GMAIL) || request.headers.get('authorization') !== 'Bearer at-live') return json({ error: { message: 'Invalid Credentials' } }, 401);
        const path = url.pathname.replace('/gmail/v1/users/me', '');
        if (path === '/profile') return json({ emailAddress: 'owner@example.com' });
        if (path === '/messages' && request.method === 'GET') return json({ messages: [{ id: 'm1', threadId: 't1' }] });
        if (path === '/messages/send') return json({ id: 'm9', threadId: 't9', labelIds: ['SENT'] });
        return json({ error: { message: 'not found' } }, 404);
    };
    return { http, seen };
}

const hasTool = (req: ModelRequest, name: string) => !!req.tools?.some((t) => t.name === name);
const toolResults = (req: ModelRequest) => req.messages.filter((m) => m.role === 'tool');

let app: TestActorApp;
let model: MockModel;
let google: ReturnType<typeof fakeGoogle>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

/** Calls `tool` once when the session has it, then answers. */
const scripted = (tool: string, input: Record<string, unknown>) =>
    mockModel({ modelId: 'claude-test', respond: (req) => (hasTool(req, tool) && toolResults(req).length === 0 ? { toolCalls: [{ name: tool, input, id: 'c1' }] } : { text: 'done' }) });

async function start(tool: string, input: Record<string, unknown>): Promise<void> {
    google = fakeGoogle();
    model = scripted(tool, input);
    const runtimes: RuntimeCatalogue = { [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime({ routing: () => Routing, sessions: () => Session, model, connectors: connectorOpener({ http: google.http }) }) };
    Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }) });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, registry: () => Registry, runtimes });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, Registry, AuditActor, ConnectorAccounts]);
    await app.start();
}
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
afterEach(() => app?.stop());

const registry = () => app.as(owner).actor(Registry, registryKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** What the plugin page and the sign-in routes do: the OAuth client, Gmail on, one connected account on the record. */
async function connectGmail(): Promise<string> {
    await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
    await registry().enable('gmail');
    await registry().setSecret('gmail-client-id', 'cid.apps.googleusercontent.com');
    await registry().setSecret('gmail-client-secret', 'client-shh');
    const reg = registry() as unknown as ConnectorRegistry;
    const engine = workspaceConnectorEngine({
        workspaceId: WS,
        principal: owner,
        pluginId: 'gmail',
        secret: (name) => reg.openSecret(name, 'gmail'),
        engineSecret: await ensureEngineSecret(reg, 'gmail'),
        redirectUri: 'https://agentic.example/_agentic/connectors/callback',
        http: google.http
    });
    const begun = await engine.auth.begin({ connector: 'gmail', method: 'oauth', owner: WS, returnTo: '/plugins/gmail' });
    if (begun.type !== 'redirect') throw new Error('expected a redirect');
    const { account } = await engine.auth.complete({ params: { state: new URL(begun.url).searchParams.get('state')!, code: 'code-1' } });
    await registry().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: account.id });
    return account.id;
}

async function agent(rules: readonly ApprovalRule[] = []): Promise<AgentId> {
    const id = 'mailer' as AgentId;
    await app
        .as(owner)
        .actor(AgentActor, agentKey(WS, id))
        .update({ name: 'Mailer', instructions: 'Be brief.', tools: [{ name: 'task_report' }], connectors: [{ id: 'gmail' }], approvalPolicy: [...rules], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
    return id;
}

async function run(id: string, assignee: AgentId): Promise<void> {
    await task(id).create({ objective: 'check mail', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {} }, { owner: assignee });
    await app.as(owner).actor(Routing, routingKey(WS)).run(id as TaskId);
}

const RULES: ApprovalRule[] = [
    { id: 'category:read', match: { categories: ['read'] }, outcome: 'allow' },
    { id: 'category:network', match: { categories: ['network'] }, outcome: 'ask' }
];

describe('Gmail on a local anthropic-api session (#533)', () => {
    describe('a read', () => {
        beforeEach(() => start('gmail__search-messages', { query: 'is:unread' }));

        it('the agent granted gmail gets every Gmail tool; a search runs under `read: allow` and its result reaches the model, the tokens do not', async () => {
            await connectGmail();
            await run('t1', await agent(RULES));
            await until(async () => (await task('t1').get()).status === 'completed', 'the task to complete');

            const first = model.requests[0]!;
            for (const name of ['gmail__search-messages', 'gmail__get-message', 'gmail__get-thread', 'gmail__send-email', 'gmail__reply-to-message', 'gmail__create-draft', 'gmail__modify-labels', 'gmail__trash-message']) expect(hasTool(first, name), name).toBe(true);
            // Options and triggers are not tools.
            expect(hasTool(first, 'gmail__list-labels')).toBe(false);
            expect(hasTool(first, 'gmail__new-email')).toBe(false);

            expect(google.seen).toContain('GET /gmail/v1/users/me/messages');
            const result = JSON.stringify(toolResults(model.requests[1]!));
            expect(result).toContain('m1');
            const everything = JSON.stringify([model.requests, await registry().connectors(), await app.as(owner).actor(AuditActor, auditKey(WS)).list({})]);
            for (const token of ['at-live', 'rt-live', 'client-shh']) expect(everything).not.toContain(token);
            // The open was recorded on the connector, as an MCP one's is.
            expect((await registry().getConnector('gmail'))?.status.state).toBe('ok');
        });
    });

    describe('sending', () => {
        beforeEach(() => start('gmail__send-email', { to: ['ada@example.com'], subject: 'Hi', body: 'Hello', format: 'text' }));

        it('is a network action: a `network: ask` rule stops it for approval before Google sees it', async () => {
            await connectGmail();
            await run('t1', await agent(RULES));
            const sessionId = await (async () => {
                await until(async () => (await task('t1').get()).sessionId !== undefined, 'the session');
                return (await task('t1').get()).sessionId!;
            })();
            const session = app.as(owner).actor(Session, actorKey(WS, 'session', sessionId));
            await until(async () => (await session.get()).status === 'awaiting', 'the approval request');
            expect(google.seen.some((s) => s.includes('/messages/send'))).toBe(false);
        });
    });

    describe('with network:gmail.googleapis.com revoked (#642)', () => {
        beforeEach(() => start('gmail__search-messages', { query: 'is:unread' }));

        it('a Gmail tool call fails with a clear permission error, and Google never sees it', async () => {
            await connectGmail();
            await registry().revoke('gmail', ['network:gmail.googleapis.com']);
            const before = google.seen.length;
            await run('t1', await agent(RULES));
            await until(async () => (await task('t1').get()).status === 'completed', 'the task to complete');

            // The tool is still offered — the grant fences the host, not the tool list.
            expect(hasTool(model.requests[0]!, 'gmail__search-messages')).toBe(true);
            const result = JSON.stringify(toolResults(model.requests[1]!));
            expect(result).toContain('Permission denied: network:gmail.googleapis.com is not granted to this connector');
            expect(result).not.toContain('is:unread');
            expect(google.seen.slice(before).some((s) => s.includes('/gmail/'))).toBe(false);
        });
    });

    it('an agent whose workspace has not connected Gmail runs without it and is told where to connect it', async () => {
        await start('gmail__search-messages', {});
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await registry().enable('gmail');
        await registry().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail' });
        await run('t1', await agent());
        await until(async () => (await task('t1').get()).status === 'completed', 'the task to complete');
        expect(hasTool(model.requests[0]!, 'gmail__search-messages')).toBe(false);
        expect(model.requests[0]!.system).toContain('- gmail: it is not connected yet (/plugins/gmail)');
    });
});
