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
import type { AgentId, ChatFile, ChatFileStore, ChatId, EnvironmentDescriptor, EnvironmentId, MachineId, ProjectId, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { createOAuthServer, memoryOAuthStore, type OAuthUser } from '@agentic/platform';
import { CHAT_FILE_BYTES_UNAVAILABLE, PLATFORM_MCP_UNSUPPORTED, createPlatformMcpHandler, platformTools, scopeOfTool, type CreateTaskInput, type DelegateTaskInput, type ExternalPrincipal, type OpenSessionInput, type PlatformPort, type TaskSummary } from '@agentic/mcp';

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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const chatFile = (id: string, name: string, mediaType: string, bytes: number): ChatFile => ({ id, chatId: 'chat_1' as ChatId, name, mediaType, bytes, at: 1 });
/** Files of `chat_1`: `f_secret` exists but this client may not see it; `f_gone` is visible but its bytes are not in the store. */
const FILES: Record<string, { file: ChatFile; visible: boolean; bytes?: Uint8Array }> = {
    f_text: { file: chatFile('f_text', 'notes.md', 'text/markdown', 13), visible: true, bytes: new TextEncoder().encode('# hello 👋\n') },
    f_img: { file: chatFile('f_img', 'shot.png', 'image/png', PNG.length), visible: true, bytes: PNG },
    f_pdf: { file: chatFile('f_pdf', 'spec.pdf', 'application/pdf', 2048), visible: true, bytes: new Uint8Array(2048) },
    f_secret: { file: chatFile('f_secret', 'secret.txt', 'text/plain', 6), visible: false, bytes: new TextEncoder().encode('secret') },
    f_gone: { file: chatFile('f_gone', 'gone.txt', 'text/plain', 4), visible: true }
};

/** A `ChatFileStore` over `FILES` (plus `extra` bytes) that records its reads. */
function fakeStore(extra: Record<string, Uint8Array> = {}) {
    const reads: string[] = [];
    const store: ChatFileStore = {
        put: async () => {},
        get: async (workspaceId, chatId, fileId) => {
            reads.push(`${workspaceId}/${chatId}/${fileId}`);
            const bytes = extra[fileId] ?? FILES[fileId]?.bytes;
            const file = FILES[fileId]?.file ?? chatFile(fileId, `${fileId}.txt`, 'text/plain', bytes?.length ?? 0);
            return bytes ? { file, bytes } : null;
        },
        markPosted: async () => {},
        deleteChat: async () => {},
        sweepOrphans: async () => 0
    };
    return { store, reads };
}

/** The fake platform: one online machine, sessions open on it only, a short event log per session. */
function fakePlatform() {
    const opened: (OpenSessionInput & { principal: ExternalPrincipal })[] = [];
    const fileAccess: { chatId: string; fileId: string; principal: ExternalPrincipal }[] = [];
    const prompts: { sessionId: string; text: string }[] = [];
    const delegated: DelegateTaskInput[] = [];
    /** Each chat's project (#334), as `chats_set_project` leaves it; `project_agentic` is the only registered project. */
    const chatProjects: Record<string, string | null> = {};
    const projectSets: { chatId: string; projectId: string | null; principal: ExternalPrincipal }[] = [];
    /** Each chat's machine (#414), as `chats_set_machine` leaves it; `m_laptop` is the only paired machine. */
    const chatMachines: Record<string, string | null> = {};
    const created: CreateTaskInput[] = [];
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
            create: async (input) => {
                created.push(input);
                return { taskId: 'task_2' as TaskId, status: 'queued', assignee: input.agentId, owner: input.agentId, objective: input.objective, children: [] };
            },
            delegate: async (input) => {
                delegated.push(input);
                return { taskId: `${input.taskId}.${input.callId ?? 'auto'}` as TaskId, status: 'queued', assignee: input.agentId, owner: 'agent_ada' as AgentId, objective: input.objective, parentId: input.taskId, children: [] };
            },
            get: async (taskId) => ({ taskId, status: 'active', assignee: 'agent_ada' as AgentId, owner: 'agent_ada' as AgentId, objective: 'x', children: [] }),
            tree: async (taskId) => ({ taskId, status: 'active', assignee: 'agent_ada' as AgentId, objective: 'x', depth: 0, children: [] }),
            cancel: async (taskId) => ({ taskId, stopped: true, notStopped: [] })
        },
        chats: {
            post: async () => ({ messageId: 'msg_1' }),
            history: async (chatId) => ({
                entries: [
                    {
                        kind: 'message',
                        seq: 1,
                        author: { kind: 'user', userId: 'gh_1' },
                        parts: [
                            { type: 'text', text: 'see attached' },
                            { type: 'image', mediaType: 'image/png', url: `agentic-file:${chatId}/f_img` },
                            { type: 'file', mediaType: 'application/pdf', name: 'spec.pdf', url: `agentic-file:${chatId}/f_pdf` }
                        ]
                    }
                ],
                next: null
            }),
            fileAccess: async (chatId, fileId) => {
                fileAccess.push({ chatId, fileId, principal });
                const row = chatId === 'chat_1' ? FILES[fileId] : undefined;
                return row?.visible ? row.file : null;
            }
        },
        memory: {
            search: async () => [],
            remember: async (_scope, entry) => ({ ...entry, id: 'mem_1', provenance: { ...entry.provenance, at: 1 } })
        },
        schedules: { create: async (input) => ({ scheduleId: 'sch_1' as never, title: input.title, kind: input.kind, enabled: true, next: null }) },
        projects: {
            list: async () => [{ id: 'project_agentic' as ProjectId, name: 'Agentic', description: 'The agent platform', environments: [ENV.id] }],
            setChatProject: async (chatId, projectId) => {
                if (projectId !== null && projectId !== 'project_agentic') throw new Error(`Chat.setProject: no project ${projectId} in this workspace`);
                projectSets.push({ chatId, projectId, principal });
                chatProjects[chatId] = projectId;
            },
            setChatMachine: async (chatId, machineId) => {
                if (machineId !== null && machineId !== ENV.machineId) throw new Error(`Chat.setMachine: no paired machine ${machineId} in this workspace`);
                chatMachines[chatId] = machineId;
            }
        },
        usage: {
            limits: async (query) => ({
                accounts: [
                    {
                        machineId: ENV.machineId,
                        machineName: 'laptop',
                        online: true,
                        environmentId: ENV.id,
                        runtime: 'claude-code',
                        account: { label: ENV.account.label },
                        snapshot: {
                            sourceId: 'agentic.quota.claude-code',
                            runtime: 'claude-code',
                            environmentId: ENV.id,
                            availability: 'reported',
                            windows: [{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.76, unit: 'percent', resetsAt: '2026-09-22T18:00:00.000Z', status: 'ok' }],
                            observedAt: 1,
                            via: 'probe'
                        },
                        ageMs: 60_000
                    }
                ].filter((a) => (query.machineId === undefined || a.machineId === query.machineId) && (query.runtime === undefined || a.runtime === query.runtime)) as never
            })
        }
    });
    return { port, opened, prompts, delegated, created, fileAccess, chatProjects, projectSets, chatMachines };
}

/** The Worker, in process: OAuth routes + the MCP mount, sessions by a `session=<userId>` cookie. */
/** `files`: the chat file store (`null` = a host without one). */
function server(platform = fakePlatform(), files: ChatFileStore | null = fakeStore().store) {
    const store = memoryOAuthStore();
    const oauth = createOAuthServer({ secret: SECRET, issuer: ORIGIN, resource: MCP_URL, store });
    const mcp = createPlatformMcpHandler({ authenticate: (request) => oauth.verify(request), port: platform.port, resourceMetadataUrl: oauth.resourceMetadataUrl, version: '1.0.0', ...(files ? { files } : {}) });
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
                'chats_file_get',
                'chats_set_project',
                'chats_set_machine',
                'memory_search',
                'memory_remember',
                'schedules_create',
                'projects_list',
                'usage_limits'
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
        // A machine rides through to the port on both (#414): the router resolves the assignee's account there.
        await client.callTool({ name: 'tasks_delegate', arguments: { taskId: 'task_1', agentId: 'agent_ada', objective: 'again', callId: 'c2', machineId: 'm_laptop' } });
        expect(s.platform.delegated[1]).toEqual({ taskId: 'task_1', agentId: 'agent_ada', objective: 'again', callId: 'c2', machineId: 'm_laptop' });
        const made = await client.callTool({ name: 'tasks_create', arguments: { agentId: 'agent_ada', objective: 'run there', machineId: 'm_laptop' } });
        expect(made.isError).toBeFalsy();
        expect(s.platform.created).toEqual([{ agentId: 'agent_ada', objective: 'run there', machineId: 'm_laptop' }]);

        const doctor = await client.callTool({ name: 'environments_doctor', arguments: { machineId: 'm_laptop' } });
        expect(doctor.structuredContent).toMatchObject({ machineId: 'm_laptop', ok: true, unverified: [], environments: [{ environmentId: 'env_laptop', verdict: { ok: true } }] });
        const unknown = await client.callTool({ name: 'environments_doctor', arguments: { machineId: 'm_other' } });
        expect(unknown.isError).toBe(true);
        expect(PLATFORM_MCP_UNSUPPORTED.map((u) => u.op)).toEqual(['resources', 'prompts']);
        await client.close();
    });

    it('usage_limits lists every account with its windows and resetsAt, narrowed on request, under the usage scope (#272)', async () => {
        const principal: ExternalPrincipal = { kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['usage'] };
        const tools = platformTools(fakePlatform().port(principal), principal);
        const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
        const limits = tools.find((t) => t.name === 'usage_limits')!;
        expect(limits.annotations).toEqual({ readOnly: true, idempotent: true });
        expect(limits.description).toMatch(/resetsAt/);
        expect(limits.description).toMatch(/ageMs/);
        const all = (await limits.run({}, ctx)) as { accounts: { environmentId: string; snapshot: { windows: { resetsAt: string }[] } }[] };
        expect(all.accounts.map((a) => [a.environmentId, a.snapshot.windows[0]!.resetsAt])).toEqual([['env_laptop', '2026-09-22T18:00:00.000Z']]);
        expect(((await limits.run({ machineId: 'm_other' }, ctx)) as { accounts: unknown[] }).accounts).toEqual([]);
        expect(((await limits.run({ runtime: 'anthropic-api' }, ctx)) as { accounts: unknown[] }).accounts).toEqual([]);
        const without: ExternalPrincipal = { ...principal, scopes: ['machines'] };
        await expect(platformTools(fakePlatform().port(without), without).find((t) => t.name === 'usage_limits')!.run({}, ctx)).rejects.toThrow(/"usage" scope/);
        expect(scopeOfTool('usage_limits')).toBe('usage');
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

describe('platform MCP server: projects (#334)', () => {
    it('projects_list lists the catalogue under the projects scope; chats_set_project sets and clears a chat’s project under chats, and an unknown project is an error', async () => {
        const s = server();
        const { client } = await connect(s, ['projects', 'chats']);
        const listed = await client.callTool({ name: 'projects_list', arguments: {} });
        expect(listed.isError).toBeFalsy();
        expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toEqual([{ id: 'project_agentic', name: 'Agentic', description: 'The agent platform', environments: ['env_laptop'] }]);

        const set = await client.callTool({ name: 'chats_set_project', arguments: { chatId: 'chat_1', projectId: 'project_agentic' } });
        expect(set.isError).toBeFalsy();
        expect(set.structuredContent).toEqual({ chatId: 'chat_1', projectId: 'project_agentic' });
        expect(s.platform.chatProjects).toEqual({ chat_1: 'project_agentic' });
        const cleared = await client.callTool({ name: 'chats_set_project', arguments: { chatId: 'chat_1', projectId: null } });
        expect(cleared.isError).toBeFalsy();
        expect(s.platform.chatProjects).toEqual({ chat_1: null });
        expect(s.platform.projectSets.map((p) => [p.chatId, p.projectId, p.principal.clientId])).toEqual([
            ['chat_1', 'project_agentic', expect.stringMatching(/^oac_/)],
            ['chat_1', null, expect.stringMatching(/^oac_/)]
        ]);

        const unknown = await client.callTool({ name: 'chats_set_project', arguments: { chatId: 'chat_1', projectId: 'project_nope' } });
        expect(unknown.isError).toBe(true);
        expect((unknown.content as { text: string }[])[0]!.text).toContain('no project project_nope');
        expect(s.platform.projectSets).toHaveLength(2);
        // An empty id is bad input, refused before the port.
        const empty = await client.callTool({ name: 'chats_set_project', arguments: { chatId: 'chat_1', projectId: '' } });
        expect(empty.isError).toBe(true);
        expect(s.platform.projectSets).toHaveLength(2);

        const { tools } = await client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));
        expect(byName.get('projects_list')!.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
        expect(byName.get('chats_set_project')!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
        expect(byName.get('chats_set_project')!.inputSchema.required).toEqual(expect.arrayContaining(['chatId', 'projectId']));
        expect(client.getInstructions()).toContain('chats_set_project');
        await client.close();
    });

    it('chats_set_machine runs a chat on a paired machine or on none under chats; an unpaired machine is an error (#414)', async () => {
        const s = server();
        const { client } = await connect(s, ['chats']);
        const set = await client.callTool({ name: 'chats_set_machine', arguments: { chatId: 'chat_1', machineId: 'm_laptop' } });
        expect(set.isError).toBeFalsy();
        expect(set.structuredContent).toEqual({ chatId: 'chat_1', machineId: 'm_laptop' });
        expect(s.platform.chatMachines).toEqual({ chat_1: 'm_laptop' });
        const cleared = await client.callTool({ name: 'chats_set_machine', arguments: { chatId: 'chat_1', machineId: null } });
        expect(cleared.isError).toBeFalsy();
        expect(s.platform.chatMachines).toEqual({ chat_1: null });
        const unknown = await client.callTool({ name: 'chats_set_machine', arguments: { chatId: 'chat_1', machineId: 'm_other' } });
        expect(unknown.isError).toBe(true);
        expect((unknown.content as { text: string }[])[0]!.text).toContain('no paired machine m_other');
        const { tools } = await client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));
        expect(byName.get('chats_set_machine')!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
        expect(client.getInstructions()).toContain('chats_set_machine');
        await client.close();
    });

    it('is gated per family: projects_list needs "projects", chats_set_project needs "chats" — each refused before the port', async () => {
        const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
        const chatsOnly: ExternalPrincipal = { kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['chats'] };
        const platform = fakePlatform();
        const tools = platformTools(platform.port(chatsOnly), chatsOnly);
        await expect(tools.find((t) => t.name === 'projects_list')!.run({}, ctx)).rejects.toThrow(/"projects" scope/);
        await expect(tools.find((t) => t.name === 'chats_set_project')!.run({ chatId: 'chat_1', projectId: 'project_agentic' }, ctx)).resolves.toEqual({ chatId: 'chat_1', projectId: 'project_agentic' });

        const projectsOnly: ExternalPrincipal = { ...chatsOnly, scopes: ['projects'] };
        const narrowed = platformTools(platform.port(projectsOnly), projectsOnly);
        await expect(narrowed.find((t) => t.name === 'chats_set_project')!.run({ chatId: 'chat_1', projectId: null }, ctx)).rejects.toThrow(/"chats" scope/);
        await expect(narrowed.find((t) => t.name === 'projects_list')!.run({}, ctx)).resolves.toEqual([expect.objectContaining({ id: 'project_agentic' })]);
        expect(platform.projectSets).toHaveLength(1);

        expect(scopeOfTool('projects_list')).toBe('projects');
        expect(scopeOfTool('chats_set_project')).toBe('chats');
    });
});

describe('platform MCP server: chats_file_get (#209)', () => {
    type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
    const call = (client: Awaited<ReturnType<typeof connect>>['client'], fileId: string, chatId = 'chat_1') => client.callTool({ name: 'chats_file_get', arguments: { chatId, fileId } });

    it('a text file comes back as its text, with the record as structured content and a JSON summary first', async () => {
        const files = fakeStore();
        const s = server(fakePlatform(), files.store);
        const { client } = await connect(s, ['chats']);
        const res = await call(client, 'f_text');
        expect(res.isError).toBeFalsy();
        const content = res.content as Content;
        expect(content.map((c) => c.type)).toEqual(['text', 'text']);
        expect(content[1]!.text).toBe('# hello 👋\n');
        expect(JSON.parse(content[0]!.text!)).toEqual(res.structuredContent);
        expect(res.structuredContent).toEqual({ file: FILES.f_text!.file, uri: 'agentic-file:chat_1/f_text', kind: 'text' });
        // Access is asked of the chat as THIS client, then the bytes are read in its workspace.
        expect(s.platform.fileAccess).toEqual([{ chatId: 'chat_1', fileId: 'f_text', principal: expect.objectContaining({ kind: 'external', workspaceId: 'gh_1', scopes: ['chats'] }) }]);
        expect(files.reads).toEqual(['gh_1/chat_1/f_text']);
        await client.close();
    });

    it('a model image type comes back as an MCP image block (base64); another binary type as metadata only', async () => {
        const s = server();
        const { client } = await connect(s, ['chats']);
        const img = await call(client, 'f_img');
        expect(img.isError).toBeFalsy();
        const block = (img.content as Content)[1]!;
        expect(block).toEqual({ type: 'image', mimeType: 'image/png', data: btoa(String.fromCharCode(...PNG)) });
        expect(img.structuredContent).toEqual({ file: FILES.f_img!.file, uri: 'agentic-file:chat_1/f_img', kind: 'image' });

        const pdf = await call(client, 'f_pdf');
        expect(pdf.isError).toBeFalsy();
        expect((pdf.content as Content).map((c) => c.type)).toEqual(['text']);
        expect(pdf.structuredContent).toMatchObject({ file: FILES.f_pdf!.file, kind: 'metadata', note: expect.stringContaining('binary file') });
        await client.close();
    });

    it('a file the client may not see and a file that does not exist get the same not-found error, and no bytes are read', async () => {
        const files = fakeStore();
        const s = server(fakePlatform(), files.store);
        const { client } = await connect(s, ['chats']);
        const denied = await call(client, 'f_secret');
        const missing = await call(client, 'f_nope');
        const otherChat = await call(client, 'f_text', 'chat_2');
        for (const res of [denied, missing, otherChat]) {
            expect(res.isError).toBe(true);
            expect((res.content as Content)[0]!.text).toMatch(/^not found: file "f_\w+" does not exist in chat "chat_\d" or this client may not read it$/);
        }
        expect(files.reads).toEqual([]);
        // Visible, but the bytes are gone from the store: the record, flagged.
        const gone = await call(client, 'f_gone');
        expect(gone.isError).toBeFalsy();
        expect(gone.structuredContent).toMatchObject({ file: FILES.f_gone!.file, kind: 'metadata', note: 'file bytes are missing from the store' });
        await client.close();
    });

    it('is gated by the "chats" scope like chats_post, before the chat is asked', async () => {
        const s = server();
        const { client } = await connect(s, ['machines']);
        for (const res of [await call(client, 'f_text'), await client.callTool({ name: 'chats_post', arguments: { chatId: 'chat_1', text: 'hi' } })]) {
            expect(res.isError).toBe(true);
            expect((res.content as Content)[0]!.text).toContain('needs the "chats" scope');
        }
        expect(s.platform.fileAccess).toEqual([]);
        await client.close();
        // Ids that could not form an agentic-file: URI are refused as arguments.
        const c2 = await connect(server(), ['chats']);
        const bad = await c2.client.callTool({ name: 'chats_file_get', arguments: { chatId: 'chat_1', fileId: '../f_text' } });
        expect(bad.isError).toBe(true);
        await c2.client.close();
    });

    it('without a file store it returns the record and says the bytes are unavailable on this host', async () => {
        const s = server(fakePlatform(), null);
        const { client } = await connect(s, ['chats']);
        for (const fileId of ['f_text', 'f_img']) {
            const res = await call(client, fileId);
            expect(res.isError).toBeFalsy();
            expect(res.structuredContent).toMatchObject({ file: FILES[fileId]!.file, kind: 'metadata', note: CHAT_FILE_BYTES_UNAVAILABLE });
        }
        await client.close();
    });

    it('chats_history keeps chat-file parts as their agentic-file: URIs', async () => {
        const s = server();
        const { client } = await connect(s, ['chats']);
        const res = await client.callTool({ name: 'chats_history', arguments: { chatId: 'chat_1' } });
        expect(res.isError).toBeFalsy();
        const parts = (res.structuredContent as { entries: { parts: Record<string, unknown>[] }[] }).entries[0]!.parts;
        expect(parts.slice(1)).toEqual([
            { type: 'image', mediaType: 'image/png', url: 'agentic-file:chat_1/f_img' },
            { type: 'file', mediaType: 'application/pdf', name: 'spec.pdf', url: 'agentic-file:chat_1/f_pdf' }
        ]);
        expect(JSON.stringify(res.content)).not.toContain('"data"');
        await client.close();
    });

    it('in process: long text is cut on a character boundary and flagged; a port without fileAccess says files are unavailable', async () => {
        const principal: ExternalPrincipal = { kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['chats'] };
        const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
        const long = new TextEncoder().encode('é'.repeat(200 * 1024));
        const port = fakePlatform().port(principal);
        const withLong: PlatformPort = { ...port, chats: { ...port.chats, fileAccess: async (_chatId, fileId) => chatFile(fileId, 'long.txt', 'text/plain', long.length) } };
        const get = platformTools(withLong, principal, { files: fakeStore({ f_long: long }).store }).find((t) => t.name === 'chats_file_get')!;
        const out = (await get.run({ chatId: 'chat_1', fileId: 'f_long' }, ctx)) as { truncated?: boolean; note?: string; mcpContent: Content };
        expect(out.truncated).toBe(true);
        expect(out.note).toContain('truncated');
        const text = out.mcpContent[1]!.text!;
        expect(text.length).toBe(128 * 1024);
        expect(text).not.toContain('�');

        const { fileAccess: _omit, ...chats } = port.chats;
        const bare = platformTools({ ...port, chats }, principal).find((t) => t.name === 'chats_file_get')!;
        await expect(bare.run({ chatId: 'chat_1', fileId: 'f_text' }, ctx)).rejects.toThrow(/not available on this host/);
    });
});
