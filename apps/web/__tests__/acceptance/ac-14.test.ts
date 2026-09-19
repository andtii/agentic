// @vitest-environment node
/**
 * AC-14 — A compatible remote A2A agent is connected. Its declared
 * capabilities and supported task/message operations are available
 * through the adapter.
 *
 * The app's registry on the in-process host (`host.ts`) with one extra
 * runtime: `a2a`, whose session factory is `a2aAgent` from `@agentic/a2a`
 * over an in-process A2A server (`createA2aHandler`, the same one the
 * platform exposes). A platform Session opens on it: the capabilities the
 * card declares are what the session records — cancel supported, resume
 * declared unsupported, the adapter's own limits listed — a message turn
 * streams through the session log to its answer, and `cancel` on a turn
 * in flight reaches the remote task (`CancelTask`). Deeper:
 * `packages/a2a/__tests__/client.test.ts` and `conformance.test.ts` (the
 * `agentConformance` subset through the adapter).
 *
 * The Routing actor opens local sessions for `anthropic-api` only, so a
 * remote A2A agent is not yet a runtime a task can be routed to — that is
 * the `a2a` plugin kind's follow-up (PLG-01, architecture §12); this
 * scenario opens the Session directly, exactly as the router would.
 *
 * The other direction (#245): the platform's OWN agents over the A2A server
 * the Worker mounts (`src/a2a/mount.ts`), gated by the `agentic.a2a.server`
 * plugin — 404 while it is off, a card only for the agents its config
 * exposes — with a real OAuth grant (register → consent → token) and the
 * task running as an ordinary platform task (the runtime gate applies).
 * Node environment: the consent step carries the session cookie, a header
 * the DOM's `Request` drops.
 */
import type { AgentId, SessionId, WorkspaceId } from '@agentic/core';
import { A2A_SERVER_PLUGIN_ID, A2A_UNSUPPORTED, a2aAgent, agentCard, capabilitiesFrom, type AgentCard } from '@agentic/a2a';
import { codeChallengeS256, createCodeVerifier, registryKey, sealSession, sessionCookie } from '@agentic/platform';
import { allowAll, type AgentEvent } from '@sigx/ai-agent';
import type { MockStep } from '@sigx/ai-agent/testing';
import { AGENT, fakeServer, type FakeServer } from '../../../../packages/a2a/__tests__/fake';
import { createA2aMount } from '../../src/a2a/mount';
import { createOAuthRoutes, type WebOAuthServer } from '../../src/auth/oauth-server';
import { startHost, until, type AcceptanceHost } from './host';

let server: FakeServer;
let h: AcceptanceHost;

const textOf = (events: readonly AgentEvent[]): string => events.map((e) => (e.type === 'part-delta' ? (e as { delta: string }).delta : '')).join('');

describe('AC-14: a remote A2A agent through the adapter', () => {
    beforeEach(async () => {
        // The remote: a scripted agent behind the A2A server; turn 1 answers, turn 2 holds a slow tool open.
        const steps = (turn: number): readonly MockStep[] => (turn === 0 ? [{ text: 'Hello from A2A!' }] : [{ tool: { name: 'slow', delayMs: 60_000 } }]);
        server = fakeServer({ steps });
        h = await startHost({
            factory: () => async (runtime, c) => {
                if (runtime !== 'a2a') return null;
                const agent = a2aAgent(server.cardUrl, { fetch: server.fetch });
                await agent.connect();
                const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
                return { session, agentId: agent.id, capabilities: agent.capabilities };
            }
        });
    });
    afterEach(async () => {
        await h.stop();
        for (const s of server.sessions.values()) await s.close().catch(() => {});
    });

    it('declares its capabilities from the card, answers a message through a platform session, and cancels a task in flight', async () => {
        const me = h.user('ac14_user');
        const agentId = await me.agent('Remote helper', { execution: { runtime: 'a2a', offlinePolicy: 'fail' } });
        const config = await me.agentActor(agentId).snapshotForSession();

        // What the card declares is what the adapter reports — and it says what it does not do (PLG-09).
        const adapter = a2aAgent(server.cardUrl, { fetch: server.fetch });
        const card = await adapter.connect();
        expect(card).toEqual(agentCard(AGENT, server.endpoint));
        expect(adapter.capabilities).toEqual(capabilitiesFrom(card));
        expect(adapter.capabilities).toMatchObject({ cancel: true, resume: false, steer: false, tools: 'none', promptParts: 'text+image' });
        expect(adapter.a2a).toMatchObject({ streaming: true, agentic: true, unsupported: A2A_UNSUPPORTED });
        expect(adapter.a2a?.skills.map((s) => s.id)).toEqual(['chat']);

        // A platform session on the remote runtime records those capabilities and streams a turn to its answer.
        const sessionId = 'session_a2a' as SessionId;
        const session = me.session(sessionId);
        const opened = await session.open({ agentId: agentId as AgentId, runtime: 'a2a', config });
        expect(opened.status).toBe('idle');
        expect(opened.capabilities).toEqual(adapter.capabilities);
        expect(await session.prompt('Say hello', 'turn-1')).toMatchObject({ kind: 'ack' });
        await until(async () => (await session.events()).some((e) => e.type === 'turn-end'), 'the first turn to end');
        const first = await session.events();
        expect(textOf(first)).toBe('Hello from A2A!');
        expect(first.find((e) => e.type === 'turn-end')).toMatchObject({ type: 'turn-end', stopReason: 'end_turn' });
        expect((await session.transcript())?.messages.at(-1)).toMatchObject({ role: 'assistant' });
        // The server saw one context (session) with one task (turn) so far.
        expect(server.sessions.size).toBe(1);

        // A turn in flight is cancelled through the session — `CancelTask` on the remote — and the log says so.
        expect(await session.prompt('Do the slow thing', 'turn-2')).toMatchObject({ kind: 'ack' });
        await until(async () => (await session.events()).some((e) => e.type === 'tool-update' && (e as { status: string }).status === 'in_progress'), 'the slow tool to start');
        expect((await session.get()).status).toBe('running');
        expect(await session.cancel()).toMatchObject({ kind: 'ack' });
        await until(async () => (await session.events()).filter((e) => e.type === 'turn-end').length === 2, 'the second turn to end');
        const events = await session.events();
        expect(events.filter((e) => e.type === 'turn-end').at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'cancelled' });
        expect(events.filter((e) => e.type === 'tool-update').at(-1)).toMatchObject({ status: 'cancelled' });
        const [live] = server.sessions.values();
        const remote: AgentEvent[] = [];
        for await (const e of live!.subscribe({ epoch: 0, seq: 0 })) {
            remote.push(e);
            if (e.type === 'turn-end' && e.stopReason === 'cancelled') break;
        }
        expect(remote.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'cancelled' });
        expect(['idle', 'running']).toContain((await session.get()).status);
        expect(await session.close()).toMatchObject({ kind: 'ack' });
        expect((await session.get()).status).toBe('closed');
    });
});

describe('AC-14: the platform’s agents over the mounted A2A server (#245)', () => {
    const SECRET = 'an-acceptance-secret-of-at-least-32-characters';
    const ORIGIN = 'https://agentic.test';
    const REDIRECT = 'http://localhost:7777/cb';
    const USER = 'gh_a2a';
    const env = { SESSION_SECRET: SECRET, APP_ORIGIN: ORIGIN };

    let web: WebOAuthServer;
    let mount: ReturnType<typeof createA2aMount>;
    beforeEach(async () => {
        h = await startHost();
        web = createOAuthRoutes(env, { actors: h.actors });
        mount = createA2aMount({ actors: h.actors, pollMs: 5 });
    });
    afterEach(() => h.stop());

    /** DCR → consent as the workspace owner → code → access token, through the real OAuth routes. */
    async function accessToken(scopes?: readonly string[]): Promise<string> {
        const cookie = sessionCookie(await sealSession({ userId: USER, workspaceId: USER as WorkspaceId }, SECRET)).split(';')[0]!;
        const reg = await web.routes['POST /oauth/register'](new Request(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'a2a-client', redirect_uris: [REDIRECT] }) }));
        const { client_id } = (await reg.json()) as { client_id: string };
        const verifier = createCodeVerifier();
        const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: await codeChallengeS256(verifier), code_challenge_method: 'S256', state: 's' });
        const page = await web.routes['GET /oauth/authorize'](new Request(`${ORIGIN}/oauth/authorize?${params}`, { headers: { cookie } }));
        const txn = /name="txn" value="([^"]+)"/.exec(await page.text())![1]!;
        const body = new URLSearchParams({ txn, decision: 'allow' });
        for (const s of scopes ?? []) body.append('scope', s);
        const decided = await web.routes['POST /oauth/authorize'](new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: body.toString() }));
        const code = new URL(decided.headers.get('location')!).searchParams.get('code')!;
        const token = await web.routes['POST /oauth/token'](
            new Request(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }).toString() })
        );
        return ((await token.json()) as { access_token: string }).access_token;
    }

    /** The Worker's view: whatever the mount does not answer is not A2A's. */
    const a2aFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input instanceof Request ? input : String(input), init);
        const route = mount(request, env);
        return route ? route(request) : new Response('not the A2A mount', { status: 418 });
    };
    const get = (path: string, token?: string) => a2aFetch(`${ORIGIN}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    const send = (path: string, token: string, text: string) =>
        a2aFetch(`${ORIGIN}${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text }] } } })
        });

    it('is 404 while the plugin is off, cards only the exposed agents, and runs a task as a platform task', async () => {
        const me = h.user(USER);
        const registry = h.as(me.principal).actor(h.Registry, registryKey(me.ws)) as unknown as {
            enable(id: string): Promise<unknown>;
            disable(id: string): Promise<unknown>;
            configure(id: string, config: Record<string, unknown>): Promise<unknown>;
        };
        const helper = await me.agent('Helper', { description: 'Answers questions.' });
        const hidden = await me.agent('Hidden');
        const token = await accessToken();

        // Mounted on its own paths only; no token → the OAuth challenge.
        expect(mount(new Request(`${ORIGIN}/agents`), env)).toBeUndefined();
        const anonymous = await get('/.well-known/agent-card.json');
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get('www-authenticate')).toMatch(/resource_metadata=/);

        // Off by default: nothing is there, for any path — not even a hint of the agents.
        expect((await get('/.well-known/agent-card.json', token)).status).toBe(404);
        expect((await get(`/_agentic/a2a/${helper}/.well-known/agent-card.json`, token)).status).toBe(404);
        expect((await send(`/_agentic/a2a/${helper}`, token, 'hi')).status).toBe(404);

        // On, with nothing exposed yet: still no card.
        await registry.enable(A2A_SERVER_PLUGIN_ID);
        expect((await get(`/_agentic/a2a/${helper}/.well-known/agent-card.json`, token)).status).toBe(404);

        // Exposed by name: that agent has a card (also the default one), the other none and takes no task.
        await registry.configure(A2A_SERVER_PLUGIN_ID, { exposedAgents: ['helper'] });
        const cardRes = await get(`/_agentic/a2a/${helper}/.well-known/agent-card.json`, token);
        expect(cardRes.status).toBe(200);
        const card = (await cardRes.json()) as AgentCard;
        expect(card).toMatchObject({ name: 'Helper', description: 'Answers questions.', supportedInterfaces: [{ url: `${ORIGIN}/_agentic/a2a/${helper}`, protocolBinding: 'JSONRPC' }], defaultInputModes: ['text/plain'] });
        expect(((await (await get('/.well-known/agent-card.json', token)).json()) as AgentCard).name).toBe('Helper');
        expect((await get(`/_agentic/a2a/${hidden}/.well-known/agent-card.json`, token)).status).toBe(404);
        expect((await send(`/_agentic/a2a/${hidden}`, token, 'hi')).status).toBe(404);

        // A grant without the task scopes is refused once the server is on.
        const narrow = await accessToken(['agents']);
        const refused = await get(`/_agentic/a2a/${helper}/.well-known/agent-card.json`, narrow);
        expect(refused.status).toBe(403);
        expect(refused.headers.get('www-authenticate')).toMatch(/insufficient_scope/);

        // A remote client through the adapter: the message is an ordinary task of the agent, answered by its runtime.
        const remote = a2aAgent(`${ORIGIN}/_agentic/a2a/${helper}/.well-known/agent-card.json`, { fetch: a2aFetch, auth: token });
        await remote.connect();
        const session = await remote.session({ policy: allowAll });
        const first: AgentEvent[] = [];
        for await (const e of session.prompt('Say hello')) first.push(e);
        expect(textOf(first)).toBe('echo: Say hello');
        expect(first.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'end_turn' });
        // The same context carries the conversation: the follow-up task has the first exchange as its context.
        const second: AgentEvent[] = [];
        for await (const e of session.prompt('And again')) second.push(e);
        expect(textOf(second)).toContain('echo: And again');
        expect(textOf(second)).toContain('Client: Say hello');
        await session.close();

        // The router's gate applies: the agent's runtime turned off → a FAILED A2A task naming why, not a hang.
        await registry.disable('anthropic-api');
        const failed = (await (await send(`/_agentic/a2a/${helper}`, token, 'hi')).json()) as { result: { task: { status: { state: string; message?: unknown } } } };
        expect(failed.result.task.status.state).toBe('TASK_STATE_FAILED');
        expect(JSON.stringify(failed.result.task.status.message)).toContain('plugin-disabled');
        await registry.enable('anthropic-api');

        // Off again: gone.
        await registry.disable(A2A_SERVER_PLUGIN_ID);
        expect((await get(`/_agentic/a2a/${helper}/.well-known/agent-card.json`, token)).status).toBe(404);
    });
});
