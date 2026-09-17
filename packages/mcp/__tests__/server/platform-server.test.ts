/**
 * The orchestration surface end to end, in process (#50): the official
 * `@modelcontextprotocol/sdk` client discovers the OAuth server from the
 * 401, registers itself (DCR), runs PKCE through the consent screen,
 * exchanges the code, then lists and calls tools on `/_agentic/mcp`. The
 * platform is a fake `PlatformPort` with one machine; the OAuth server is
 * the real one from `@agentic/platform` over its memory store.
 */
// @vitest-environment node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it } from 'vitest';
import type { AgentId, EnvironmentDescriptor, EnvironmentId, MachineId, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { createOAuthServer, memoryOAuthStore, type OAuthUser } from '@agentic/platform';
import { PLATFORM_MCP_UNSUPPORTED, createPlatformMcpHandler, platformTools, scopeOfTool, type DelegateTaskInput, type ExternalPrincipal, type OpenSessionInput, type PlatformPort, type TaskSummary } from '@agentic/mcp';

const ORIGIN = 'https://app.test';
const MCP_URL = `${ORIGIN}/_agentic/mcp`;
const SECRET = 'a-session-secret-of-at-least-32-characters!';
const REDIRECT = 'http://127.0.0.1:40123/callback';
const owner: OAuthUser = { userId: 'gh_1', workspaceId: 'gh_1' as WorkspaceId };

const ENV: EnvironmentDescriptor = {
    id: 'env_laptop' as EnvironmentId,
    machineId: 'm_laptop' as MachineId,
    name: 'laptop / claude-code',
    runtime: 'claude-code',
    account: { label: 'personal', authStatus: 'ok' },
    cwdRoots: ['C:/Dev'],
    concurrency: { max: 2, active: 0 },
    isolation: 'config-dir'
};

/** The fake platform: one online machine, sessions open on it only, a short event log per session. */
function fakePlatform() {
    const opened: (OpenSessionInput & { principal: ExternalPrincipal })[] = [];
    const prompts: { sessionId: string; text: string }[] = [];
    const delegated: DelegateTaskInput[] = [];
    const port = (principal: ExternalPrincipal): PlatformPort => ({
        machines: { list: async () => [{ machineId: ENV.machineId, name: 'laptop', online: true, os: 'windows', environments: [ENV] }] },
        environments: {
            list: async (machineId) => (machineId === undefined || machineId === ENV.machineId ? [ENV] : []),
            doctor: async (machineId, environmentId) => {
                if (machineId !== ENV.machineId) throw new Error(`machine ${machineId} is not paired`);
                if (environmentId !== undefined && environmentId !== ENV.id) throw new Error(`machine ${machineId} has no environment ${environmentId}`);
                return { machineId, online: true, ok: true, unverified: [], environments: [{ environmentId: ENV.id, name: ENV.name, runtime: ENV.runtime, verdict: { ok: true, findings: [], checkedAt: 1 } }] };
            }
        },
        agents: {
            list: async () => [{ agentId: 'agent_ada' as AgentId, name: 'Ada', runtime: 'claude-code', defaultEnvironmentId: ENV.id }],
            get: async (agentId) => ({ id: agentId, config: { name: 'Ada' } })
        },
        sessions: {
            async open(input) {
                if (input.machineId !== ENV.machineId || input.environmentId !== ENV.id) throw new Error(`environment ${input.environmentId} is not reported by machine ${input.machineId}`);
                opened.push({ ...input, principal });
                const task: TaskSummary = { taskId: 'task_1' as TaskId, status: 'active', assignee: input.agentId, owner: input.agentId, objective: input.objective ?? 'interactive session', environmentId: input.environmentId, sessionId: 'sess_1' as SessionId, children: [] };
                return task;
            },
            async prompt(sessionId, text) {
                prompts.push({ sessionId, text });
                return { commandId: 'turn_1', kind: 'ack', turnId: 'turn_1' };
            },
            respond: async (_s, requestId) => ({ commandId: `respond:${requestId}`, kind: 'ack' }),
            cancel: async () => ({ commandId: 'cancel_1', kind: 'ack' }),
            async tail(sessionId, from, limit) {
                const all = [
                    { type: 'session-start', sessionId, epoch: 1, seq: 1 },
                    { type: 'turn-start', sessionId, turnId: 'turn_1', epoch: 1, seq: 2 },
                    { type: 'text', sessionId, text: 'hello from the laptop', epoch: 1, seq: 3 },
                    { type: 'turn-end', sessionId, turnId: 'turn_1', stopReason: 'end_turn', epoch: 1, seq: 4 }
                ];
                const after = from ? all.filter((e) => e.epoch > from.epoch || (e.epoch === from.epoch && e.seq > from.seq)) : all;
                const events = after.slice(0, limit);
                const last = events.at(-1) ?? from ?? { epoch: 0, seq: 0 };
                return { sessionId, status: 'idle', events, next: { epoch: last.epoch, seq: last.seq }, truncated: after.length > events.length };
            }
        },
        tasks: {
            create: async (input) => ({ taskId: 'task_2' as TaskId, status: 'queued', assignee: input.agentId, owner: input.agentId, objective: input.objective, children: [] }),
            delegate: async (input) => {
                delegated.push(input);
                return { taskId: `${input.taskId}.${input.callId ?? 'auto'}` as TaskId, status: 'queued', assignee: input.agentId, owner: 'agent_ada' as AgentId, objective: input.objective, parentId: input.taskId, children: [] };
            },
            get: async (taskId) => ({ taskId, status: 'active', assignee: 'agent_ada' as AgentId, owner: 'agent_ada' as AgentId, objective: 'x', children: [] }),
            tree: async (taskId) => ({ taskId, status: 'active', assignee: 'agent_ada' as AgentId, objective: 'x', depth: 0, children: [] }),
            cancel: async (taskId) => ({ taskId, stopped: true, notStopped: [] })
        },
        chats: { post: async () => ({ messageId: 'msg_1' }), history: async () => ({ entries: [], next: null }) },
        memory: {
            search: async () => [],
            remember: async (_scope, entry) => ({ ...entry, id: 'mem_1', provenance: { ...entry.provenance, at: 1 } })
        },
        schedules: { create: async (input) => ({ scheduleId: 'sch_1' as never, title: input.title, kind: input.kind, enabled: true, next: null }) }
    });
    return { port, opened, prompts, delegated };
}

/** The Worker, in process: OAuth routes + the MCP mount, sessions by a `session=<userId>` cookie. */
function server(platform = fakePlatform()) {
    const store = memoryOAuthStore();
    const oauth = createOAuthServer({ secret: SECRET, issuer: ORIGIN, resource: MCP_URL, store });
    const mcp = createPlatformMcpHandler({ authenticate: (request) => oauth.verify(request), port: platform.port, resourceMetadataUrl: oauth.resourceMetadataUrl, version: '1.0.0' });
    const userOf = (request: Request): OAuthUser | null => (request.headers.get('cookie') === 'session=gh_1' ? owner : null);
    const requests: { method: string; path: string }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(request.url);
        requests.push({ method: request.method, path: url.pathname });
        if (url.pathname === '/.well-known/oauth-authorization-server') return oauth.metadata();
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return oauth.protectedResource();
        if (url.pathname === '/oauth/register') return oauth.register(request);
        if (url.pathname === '/oauth/authorize') return oauth.authorize(request, userOf(request));
        if (url.pathname === '/oauth/token') return oauth.token(request);
        if (url.pathname === '/oauth/revoke') return oauth.revoke(request);
        if (url.pathname === '/_agentic/mcp') return mcp(request);
        return new Response('not found', { status: 404 });
    };
    return { fetch, oauth, store, requests, platform };
}

/** What Claude Code's OAuth client does, minus the browser: remembers registration, tokens and the verifier; captures the redirect. */
function clientProvider(scope?: string) {
    let info: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier = '';
    const redirects: URL[] = [];
    const provider: OAuthClientProvider = {
        get redirectUrl() {
            return REDIRECT;
        },
        get clientMetadata() {
            return { client_name: 'Claude Code (test)', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) };
        },
        clientInformation: () => info,
        saveClientInformation: (i) => {
            info = i;
        },
        tokens: () => tokens,
        saveTokens: (t) => {
            tokens = t;
        },
        redirectToAuthorization: (url) => {
            redirects.push(url);
        },
        saveCodeVerifier: (v) => {
            verifier = v;
        },
        codeVerifier: () => verifier,
        state: () => 'st4te'
    };
    return { provider, redirects, get tokens() { return tokens; }, get info() { return info; } };
}

/**
 * Drive the consent screen as the signed-in user: GET renders the form, POST
 * allows with `grant` ticked (the SDK always asks for every scope the
 * resource advertises; the user narrows on the form). Returns the code.
 */
async function consent(fetch: (i: string | URL | Request, init?: RequestInit) => Promise<Response>, authorizationUrl: URL, grant?: readonly string[]): Promise<string> {
    const page = await fetch(authorizationUrl, { headers: { cookie: 'session=gh_1' } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!;
    const body = new URLSearchParams({ txn, decision: 'allow' });
    for (const s of grant ?? []) body.append('scope', s);
    const decided = await fetch(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { cookie: 'session=gh_1', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    expect(decided.status).toBe(302);
    const back = new URL(decided.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st4te');
    return back.searchParams.get('code')!;
}

/** Full flow: 401 → discovery → DCR → PKCE + consent → code exchange → connected client. */
async function connect(s: ReturnType<typeof server>, grant?: readonly string[]) {
    const p = clientProvider();
    const first = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: s.fetch, authProvider: p.provider });
    await expect(new Client({ name: 'test', version: '0.0.0' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(p.redirects).toHaveLength(1);
    expect(p.info?.client_id).toMatch(/^oac_/);
    const authorizationUrl = p.redirects[0]!;
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe(MCP_URL);
    const code = await consent(s.fetch, authorizationUrl, grant);
    await first.finishAuth(code);
    expect(p.tokens?.access_token).toMatch(/^oaac\./);
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: s.fetch, authProvider: p.provider });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport, provider: p };
}

describe('platform MCP server: OAuth 2.1 + DCR + PKCE with the official client', () => {
    it('an unauthenticated request is a 401 that names the protected-resource metadata', async () => {
        const s = server();
        const res = await s.fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/_agentic/mcp"`);
        const bad = await s.fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer oaac.nope.nope' }, body: '{}' });
        expect(bad.status).toBe(401);
        expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
        expect((await s.fetch(MCP_URL, { method: 'GET' })).status).toBe(405);
    });

    it('registers, authorizes with PKCE through consent, exchanges the code and lists annotated tools', async () => {
        const s = server();
        const { client } = await connect(s);
        expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['POST /_agentic/mcp', 'GET /.well-known/oauth-protected-resource/_agentic/mcp', 'GET /.well-known/oauth-authorization-server', 'POST /oauth/register', 'GET /oauth/authorize', 'POST /oauth/authorize', 'POST /oauth/token']));
        expect(client.getServerVersion()).toEqual({ name: 'agentic', version: '1.0.0' });
        expect(client.getInstructions()).toContain('sessions_open');

        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual(
            [
                'machines_list',
                'environments_list',
                'environments_doctor',
                'agents_list',
                'agents_get',
                'sessions_open',
                'sessions_prompt',
                'sessions_respond',
                'sessions_cancel',
                'sessions_tail',
                'tasks_create',
                'tasks_delegate',
                'tasks_get',
                'tasks_tree',
                'tasks_cancel',
                'chats_post',
                'chats_history',
                'memory_search',
                'memory_remember',
                'schedules_create'
            ].sort()
        );
        const byName = new Map(tools.map((t) => [t.name, t]));
        expect(byName.get('machines_list')!.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
        expect(byName.get('sessions_cancel')!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
        expect(byName.get('sessions_open')!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
        expect(byName.get('sessions_open')!.inputSchema.required).toEqual(expect.arrayContaining(['agentId', 'machineId', 'environmentId']));
        for (const t of tools) expect(scopeOfTool(t.name), t.name).not.toBeNull();

        const machines = await client.callTool({ name: 'machines_list', arguments: {} });
        expect(machines.isError).toBeFalsy();
        expect(JSON.parse((machines.content as { text: string }[])[0]!.text)).toEqual([expect.objectContaining({ machineId: 'm_laptop', online: true })]);
        await client.close();
    });

    it('a client granted only "machines" is refused on a sessions tool with an MCP error result naming the scope', async () => {
        const s = server();
        const { client, provider } = await connect(s, ['machines']);
        expect(provider.tokens?.scope).toBe('machines');
        const machines = await client.callTool({ name: 'machines_list', arguments: {} });
        expect(machines.isError).toBeFalsy();
        const refused = await client.callTool({ name: 'sessions_open', arguments: { agentId: 'agent_ada', machineId: 'm_laptop', environmentId: 'env_laptop' } });
        expect(refused.isError).toBe(true);
        const text = (refused.content as { text: string }[])[0]!.text;
        expect(text).toContain('forbidden');
        expect(text).toContain('"sessions"');
        expect(s.platform.opened).toHaveLength(0);
        const tail = await client.callTool({ name: 'sessions_tail', arguments: { sessionId: 'sess_1' } });
        expect(tail.isError).toBe(true);
        await client.close();
    });

    it('with the sessions scope it opens a session on an explicitly chosen machine, prompts it and tails the events', async () => {
        const s = server();
        const { client } = await connect(s, ['sessions', 'machines', 'environments']);
        const opened = await client.callTool({ name: 'sessions_open', arguments: { agentId: 'agent_ada', machineId: 'm_laptop', environmentId: 'env_laptop', cwd: 'C:/Dev/agentic', objective: 'say hello' } });
        expect(opened.isError).toBeFalsy();
        expect(opened.structuredContent).toMatchObject({ taskId: 'task_1', sessionId: 'sess_1', status: 'active' });
        expect(s.platform.opened[0]).toMatchObject({ machineId: 'm_laptop', environmentId: 'env_laptop', cwd: 'C:/Dev/agentic', principal: { kind: 'external', workspaceId: 'gh_1', scopes: ['machines', 'environments', 'sessions'] } });

        // Machine selection is explicit: a machine that does not report the environment is an error, never a silent switch (EXE-12).
        const wrong = await client.callTool({ name: 'sessions_open', arguments: { agentId: 'agent_ada', machineId: 'm_other', environmentId: 'env_laptop' } });
        expect(wrong.isError).toBe(true);
        expect((wrong.content as { text: string }[])[0]!.text).toContain('not reported by machine m_other');
        const missing = await client.callTool({ name: 'sessions_open', arguments: { agentId: 'agent_ada', environmentId: 'env_laptop' } });
        expect(missing.isError).toBe(true);
        expect(s.platform.opened).toHaveLength(1);

        const prompted = await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: 'sess_1', text: 'hello' } });
        expect(prompted.structuredContent).toMatchObject({ turnId: 'turn_1', kind: 'ack' });
        expect(s.platform.prompts).toEqual([{ sessionId: 'sess_1', text: 'hello' }]);

        const page1 = await client.callTool({ name: 'sessions_tail', arguments: { sessionId: 'sess_1', limit: 2 } });
        expect(page1.structuredContent).toMatchObject({ sessionId: 'sess_1', truncated: true, next: { epoch: 1, seq: 2 } });
        expect((page1.structuredContent as { events: { type: string }[] }).events.map((e) => e.type)).toEqual(['session-start', 'turn-start']);
        const page2 = await client.callTool({ name: 'sessions_tail', arguments: { sessionId: 'sess_1', from: { epoch: 1, seq: 2 } } });
        expect((page2.structuredContent as { events: { type: string }[] }).events.map((e) => e.type)).toEqual(['text', 'turn-end']);
        expect(page2.structuredContent).toMatchObject({ truncated: false, next: { epoch: 1, seq: 4 } });
        const page3 = await client.callTool({ name: 'sessions_tail', arguments: { sessionId: 'sess_1', from: { epoch: 1, seq: 4 } } });
        expect((page3.structuredContent as { events: unknown[] }).events).toEqual([]);

        // A tool without the scope is still refused even with a partial grant.
        const tasks = await client.callTool({ name: 'tasks_get', arguments: { taskId: 'task_1' } });
        expect(tasks.isError).toBe(true);
        await client.close();
    });

    it('a refreshed token keeps working; a revoked one is refused with the 401 challenge', async () => {
        const s = server();
        const { client, provider } = await connect(s, ['machines']);
        const before = provider.tokens!;
        const refreshed = await s.fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: before.refresh_token!, client_id: provider.info!.client_id }).toString() });
        expect(refreshed.status).toBe(200);
        const next = (await refreshed.json()) as OAuthTokens;
        provider.provider.saveTokens(next);
        const ok = await client.callTool({ name: 'machines_list', arguments: {} });
        expect(ok.isError).toBeFalsy();

        const revoked = await s.fetch(`${ORIGIN}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: next.refresh_token! }).toString() });
        expect(revoked.status).toBe(200);
        // The transport sees the 401 and tries to refresh; the token endpoint refuses (invalid_grant: revoked) and the SDK surfaces that.
        await expect(client.callTool({ name: 'machines_list', arguments: {} })).rejects.toThrow(/revoked/);
        await client.close().catch(() => {});
    });

    it('tasks_delegate creates a child under the parent (COL-03) and environments_doctor reports verdicts per machine; the gap list names what is left out', async () => {
        const s = server();
        const { client } = await connect(s, ['tasks', 'environments']);
        const res = await client.callTool({ name: 'tasks_delegate', arguments: { taskId: 'task_1', agentId: 'agent_ada', objective: 'review the diff', callId: 'c1', environmentId: 'env_laptop' } });
        expect(res.isError).toBeFalsy();
        expect(res.structuredContent).toMatchObject({ taskId: 'task_1.c1', parentId: 'task_1', status: 'queued', assignee: 'agent_ada' });
        expect(s.platform.delegated).toEqual([{ taskId: 'task_1', agentId: 'agent_ada', objective: 'review the diff', callId: 'c1', environmentId: 'env_laptop' }]);

        const doctor = await client.callTool({ name: 'environments_doctor', arguments: { machineId: 'm_laptop' } });
        expect(doctor.structuredContent).toMatchObject({ machineId: 'm_laptop', ok: true, unverified: [], environments: [{ environmentId: 'env_laptop', verdict: { ok: true } }] });
        const unknown = await client.callTool({ name: 'environments_doctor', arguments: { machineId: 'm_other' } });
        expect(unknown.isError).toBe(true);
        expect(PLATFORM_MCP_UNSUPPORTED.map((u) => u.op)).toEqual(['resources', 'prompts']);
        await client.close();
    });

    it('platformTools gates every family by its scope, before touching the port', async () => {
        const principal: ExternalPrincipal = { kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['agents'] };
        const tools = platformTools(fakePlatform().port(principal), principal);
        const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
        await expect(tools.find((t) => t.name === 'agents_list')!.run({}, ctx)).resolves.toEqual([expect.objectContaining({ agentId: 'agent_ada' })]);
        await expect(tools.find((t) => t.name === 'machines_list')!.run({}, ctx)).rejects.toThrow(/"machines" scope/);
        await expect(tools.find((t) => t.name === 'memory_remember')!.run({ scope: 'agent:agent_ada', kind: 'fact', text: 'x' }, ctx)).rejects.toThrow(/"memory" scope/);
        // Bad arguments are a validation error, not a port call.
        await expect(tools.find((t) => t.name === 'agents_get')!.run({}, ctx)).rejects.toThrow(/Invalid arguments/);
    });
});
