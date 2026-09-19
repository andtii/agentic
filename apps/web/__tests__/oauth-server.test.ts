/**
 * The apps/web binding of the OAuth 2.1 server and the MCP mount (#50):
 * routes over the real actors (`OAuthClients` / `OAuthGrants` through
 * `actorOAuthStore`), the consent screen keyed by the `__Host-session`
 * cookie, and `createActorPlatformPort` reading the workspace through the
 * platform actors under the external principal.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatFileUri, type ChatFile, type ChatFileBody, type ChatFileStore, type ChatId, type WorkspaceId } from '@agentic/core';
import {
    AgentActor,
    Chat,
    Memory,
    OAuthClients,
    OAuthGrants,
    PairingDirectory,
    TaskActor,
    Workspace,
    agentChatKey,
    codeChallengeS256,
    createCodeVerifier,
    defineChatActor,
    defineMachineActor,
    defineRoutingActor,
    defineScheduleActor,
    defineSessionActor,
    sealSession,
    sessionCookie,
    workspaceKey
} from '@agentic/platform';
import type { AnyActorDefinition } from '@sigx/actors';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { createOAuthRoutes, MCP_PATH, type WebOAuthServer } from '../src/auth/oauth-server';

const SECRET = 'a-session-secret-of-at-least-32-characters!';
const ORIGIN = 'https://app.test';
const REDIRECT = 'http://localhost:7777/cb';
const WS = 'gh_1' as WorkspaceId;

/** The chat file store the MCP mount must share with the Chat actor (#209). */
function memoryFiles(): ChatFileStore {
    const bodies = new Map<string, ChatFileBody>();
    const k = (ws: string, chatId: string, fileId: string) => `${ws}/${chatId}/${fileId}`;
    return {
        async put(workspaceId, file, body) {
            bodies.set(k(workspaceId, file.chatId, file.id), { file, bytes: body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer) });
        },
        get: async (workspaceId, chatId, fileId) => bodies.get(k(workspaceId, chatId, fileId)) ?? null,
        markPosted: async () => {},
        deleteChat: async () => {},
        sweepOrphans: async () => 0
    };
}

function registry(files: ChatFileStore): readonly AnyActorDefinition[] {
    const Session = defineSessionActor({ factory: () => null });
    const Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    const Machine = defineMachineActor({ socket: { send: () => false, close: () => {} }, sessions: () => Session, routing: () => Routing });
    const Schedule = defineScheduleActor({ trigger: { fired: async () => {} } });
    return [Workspace, AgentActor, defineChatActor({ files }), TaskActor, Session, Machine, Routing, Schedule, Memory, PairingDirectory, OAuthClients, OAuthGrants];
}

let app: TestActorApp;
let web: WebOAuthServer;
let cookie: string;
let files: ChatFileStore;
beforeEach(async () => {
    files = memoryFiles();
    const actors = registry(files);
    app = testActorApp(actors);
    await app.start();
    web = createOAuthRoutes({ SESSION_SECRET: SECRET, APP_ORIGIN: ORIGIN }, { actors, files });
    cookie = sessionCookie(await sealSession({ userId: 'gh_1', workspaceId: WS }, SECRET)).split(';')[0]!;
});
afterEach(() => app.stop());

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });

/** DCR → consent as gh_1 → code → access token, through the mounted routes. */
async function accessToken(grant?: readonly string[]): Promise<string> {
    const reg = await web.routes['POST /oauth/register'](new Request(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'cc', redirect_uris: [REDIRECT] }) }));
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = createCodeVerifier();
    const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: await codeChallengeS256(verifier), code_challenge_method: 'S256', state: 's' });
    const anonymous = await web.routes['GET /oauth/authorize'](new Request(`${ORIGIN}/oauth/authorize?${params}`));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toMatch(/^\/auth\/login\?returnTo=%2Foauth%2Fauthorize/);
    const page = await web.routes['GET /oauth/authorize'](new Request(`${ORIGIN}/oauth/authorize?${params}`, { headers: { cookie } }));
    expect(page.status).toBe(200);
    const txn = /name="txn" value="([^"]+)"/.exec(await page.text())![1]!;
    const body = new URLSearchParams({ txn, decision: 'allow' });
    for (const s of grant ?? []) body.append('scope', s);
    const decided = await web.routes['POST /oauth/authorize'](new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: body.toString() }));
    expect(decided.status).toBe(302);
    const code = new URL(decided.headers.get('location')!).searchParams.get('code')!;
    const token = await web.routes['POST /oauth/token'](new Request(`${ORIGIN}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT })));
    expect(token.status).toBe(200);
    return ((await token.json()) as { access_token: string }).access_token;
}

let nextId = 1;
async function rpc(token: string | null, method: string, params: unknown = {}): Promise<{ status: number; body: { result?: Record<string, unknown>; error?: { code: number; message: string } } }> {
    const res = await web.mcp(
        new Request(`${ORIGIN}${MCP_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
        })
    );
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as never) : {} };
}

describe('apps/web OAuth server + MCP mount', () => {
    it('mounts the discovery, registration, consent, token and revocation routes at the documented paths', async () => {
        expect(Object.keys(web.routes).sort()).toEqual(
            ['GET /.well-known/oauth-authorization-server', 'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/_agentic/mcp', 'POST /oauth/register', 'GET /oauth/authorize', 'POST /oauth/authorize', 'POST /oauth/token', 'POST /oauth/revoke'].sort()
        );
        const meta = (await (await web.routes['GET /.well-known/oauth-authorization-server'](new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
        expect(meta.issuer).toBe(ORIGIN);
        expect(meta.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
        const resource = (await (await web.routes['GET /.well-known/oauth-protected-resource/_agentic/mcp'](new Request(`${ORIGIN}/.well-known/oauth-protected-resource/_agentic/mcp`))).json()) as Record<string, unknown>;
        expect(resource).toMatchObject({ resource: `${ORIGIN}/_agentic/mcp`, authorization_servers: [ORIGIN] });
        expect(web.resource).toBe(`${ORIGIN}/_agentic/mcp`);
        expect(() => createOAuthRoutes({ SESSION_SECRET: 'short', APP_ORIGIN: ORIGIN })).toThrow(/SESSION_SECRET/);
    });

    it('the MCP mount challenges without a token and serves the tool surface with one; clients and grants live on the actors', async () => {
        const challenge = await rpc(null, 'initialize');
        expect(challenge.status).toBe(401);
        const token = await accessToken();
        expect(app.saves.some((s) => s.type === 'OAuthClients')).toBe(true);
        expect(app.saves.some((s) => s.type === 'OAuthGrants')).toBe(true);

        const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        expect(init.status).toBe(200);
        expect(init.body.result).toMatchObject({ serverInfo: { name: 'agentic' }, capabilities: { tools: {} } });
        const list = await rpc(token, 'tools/list');
        const tools = (list.body.result as { tools: { name: string; annotations?: unknown }[] }).tools;
        expect(tools.map((t) => t.name)).toContain('sessions_open');
        expect(tools.find((t) => t.name === 'machines_list')!.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });

        // The port reads the workspace through the actors: an agent created by the user shows up for the external client.
        const ws = app.as(userPrincipal('gh_1')).actor(Workspace, workspaceKey(WS));
        const { agentId } = await ws.createAgent({ name: 'Ada' });
        const agents = await rpc(token, 'tools/call', { name: 'agents_list', arguments: {} });
        // (`Workspace.createAgent` indexes the id; the Agent actor's config carries the name once `update` runs — not this test's concern.)
        expect(JSON.parse((agents.body.result as { content: { text: string }[] }).content[0]!.text)).toEqual([{ agentId, name: expect.any(String), runtime: 'anthropic-api' }]);
        const machines = await rpc(token, 'tools/call', { name: 'machines_list', arguments: {} });
        expect(JSON.parse((machines.body.result as { content: { text: string }[] }).content[0]!.text)).toEqual([]);

        // Explicit machine selection: a machine nobody paired reports no environment → refused, nothing created.
        const opened = await rpc(token, 'tools/call', { name: 'sessions_open', arguments: { agentId, machineId: 'm_ghost', environmentId: 'env_x' } });
        expect(opened.body.result).toMatchObject({ isError: true });
        expect((opened.body.result as { content: { text: string }[] }).content[0]!.text).toContain('not reported by machine m_ghost');
    });

    it('a grant narrowed on the consent form gates the tool families on the mount', async () => {
        const token = await accessToken(['agents']);
        const agents = await rpc(token, 'tools/call', { name: 'agents_list', arguments: {} });
        expect(agents.body.result).not.toMatchObject({ isError: true });
        const machines = await rpc(token, 'tools/call', { name: 'machines_list', arguments: {} });
        expect(machines.body.result).toMatchObject({ isError: true });
        expect((machines.body.result as { content: { text: string }[] }).content[0]!.text).toContain('"machines" scope');

        // Revoked → the mount challenges again.
        const revoked = await web.routes['POST /oauth/revoke'](new Request(`${ORIGIN}/oauth/revoke`, form({ token })));
        expect(revoked.status).toBe(200);
        expect((await rpc(token, 'tools/list')).status).toBe(401);
    });

    it('usage_limits under the usage scope alone lists each account with the snapshot its machine reported (#272)', async () => {
        const ws = app.as(userPrincipal('gh_1')).actor(Workspace, workspaceKey(WS));
        const { machineId, pairingCode } = await ws.registerMachinePending({ name: 'laptop' });
        const Machine = registry(files).find((d) => (d as { type?: string }).type === 'machine')!;
        const daemon = app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine as never, `${WS}:machine:${machineId}`) as unknown as { pair(code: string, info: object): Promise<unknown>; socketMessage(raw: string): Promise<unknown> };
        await daemon.pair(pairingCode, { name: 'laptop', os: 'windows', daemonVersion: '0.1.0' });
        const env = { id: 'env_work', machineId, name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus: 'ok', identity: 'me@example.com' }, cwdRoots: ['/work'], concurrency: { max: 1, active: 0 }, isolation: 'config-dir' };
        await daemon.socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId, daemonVersion: '0.1.0', os: 'windows', environments: [env], capabilities: [], resume: {} }));
        const snapshot = { sourceId: 'agentic.quota.claude-code', runtime: 'claude-code', environmentId: 'env_work', plan: 'max', availability: 'reported', windows: [{ id: 'five_hour', label: 'Current session', period: 'session', utilization: 0.19, unit: 'percent', resetsAt: '2026-09-19T11:10:00.000Z', status: 'ok' }], observedAt: Date.now() - 1_000, via: 'probe' };
        await daemon.socketMessage(JSON.stringify({ v: 1, t: 'quota', environmentId: 'env_work', snapshot }));

        const token = await accessToken(['usage']);
        const res = await rpc(token, 'tools/call', { name: 'usage_limits', arguments: {} });
        expect(res.body.result).not.toMatchObject({ isError: true });
        const { accounts } = JSON.parse((res.body.result as { content: { text: string }[] }).content[0]!.text) as { accounts: { machineName: string; environmentId: string; account: object; snapshot: { windows: { resetsAt: string }[] }; ageMs: number }[] };
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({ machineName: 'laptop', environmentId: 'env_work', account: { label: 'work', identity: 'me@example.com' } });
        expect(accounts[0]!.snapshot.windows[0]!.resetsAt).toBe('2026-09-19T11:10:00.000Z');
        expect(accounts[0]!.ageMs).toBeGreaterThanOrEqual(1_000);
        // Without `usage` the family is refused.
        const other = await rpc(await accessToken(['machines']), 'tools/call', { name: 'usage_limits', arguments: {} });
        expect((other.body.result as { content: { text: string }[] }).content[0]!.text).toContain('"usage" scope');
    });

    it('chats_file_get reads a posted attachment through Chat.fileAccess and the store the actors share (#209)', async () => {
        const chatId = 'c1' as ChatId;
        const file: ChatFile = { id: 'f_notes', chatId, name: 'notes.txt', mediaType: 'text/plain', bytes: 5, at: 1 };
        const chat = app.as(userPrincipal('gh_1')).actor(Chat, agentChatKey(WS, chatId));
        await files.put(WS, file, new TextEncoder().encode('hello'));
        await chat.registerUpload(file);
        await chat.post([{ type: 'text', text: 'see' }, { type: 'file', mediaType: 'text/plain', name: 'notes.txt', url: chatFileUri(chatId, file.id) }]);
        // Another upload of the user's, never posted: pending uploads are the uploader's alone.
        const pending: ChatFile = { ...file, id: 'f_pending' };
        await files.put(WS, pending, new TextEncoder().encode('draft'));
        await chat.registerUpload(pending);

        const token = await accessToken(['chats']);
        const got = await rpc(token, 'tools/call', { name: 'chats_file_get', arguments: { chatId, fileId: file.id } });
        expect(got.body.result).not.toMatchObject({ isError: true });
        expect((got.body.result as { content: { type: string; text?: string }[] }).content[1]).toEqual({ type: 'text', text: 'hello' });
        expect(got.body.result!.structuredContent).toMatchObject({ kind: 'text', uri: 'agentic-file:c1/f_notes', file: { name: 'notes.txt' } });
        for (const fileId of ['f_pending', 'f_nope']) {
            const refused = await rpc(token, 'tools/call', { name: 'chats_file_get', arguments: { chatId, fileId } });
            expect(refused.body.result).toMatchObject({ isError: true });
            expect((refused.body.result as { content: { text: string }[] }).content[0]!.text).toContain('not found');
        }
    });
});
