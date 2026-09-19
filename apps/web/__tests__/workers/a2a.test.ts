/**
 * The A2A server as a plugin inside workerd (#245): the Worker's own mount
 * (`src/a2a/mount.ts`, wired as `entry.cloudflare.ts` wires it) behind the
 * production OAuth server — a real grant over HTTP (register → consent →
 * token) — and the production Registry, router and session factory, with
 * only the model mocked (`worker.ts`). The pool sets no `APP_ORIGIN`, so the
 * OAuth server and the mount answer on `http://localhost`.
 *
 * Off by default → 404; on and exposing the agent → its card, and a blocking
 * `SendMessage` runs a platform task to its answer; off again → 404.
 */
import { SELF } from 'cloudflare:test';
import type { AgentId, WorkspaceId } from '@agentic/core';
import { AgentActor, Workspace, agentKey, codeChallengeS256, createCodeVerifier, workspaceKey } from '@agentic/platform';
import { overHttp, registryOverHttp, setAnthropicKey, signIn } from './http';

const LOCAL = 'http://localhost';
const REDIRECT = 'http://localhost:7777/cb';
const A2A = 'agentic.a2a.server';

/** DCR → consent as the signed-in owner → code → access token, over HTTP. */
async function accessToken(cookie: string): Promise<string> {
    const reg = await SELF.fetch(`${LOCAL}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'a2a-client', redirect_uris: [REDIRECT] }) });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = createCodeVerifier();
    const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: await codeChallengeS256(verifier), code_challenge_method: 'S256', state: 's' });
    const page = await SELF.fetch(`${LOCAL}/oauth/authorize?${params}`, { headers: { cookie } });
    const txn = /name="txn" value="([^"]+)"/.exec(await page.text())![1]!;
    const decided = await SELF.fetch(`${LOCAL}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ txn, decision: 'allow' }).toString() });
    const code = new URL(decided.headers.get('location')!).searchParams.get('code')!;
    const token = await SELF.fetch(`${LOCAL}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }).toString() });
    expect(token.status).toBe(200);
    return ((await token.json()) as { access_token: string }).access_token;
}

describe('worker: the A2A server as a plugin', () => {
    it('is 404 while off; exposed, it cards the agent and runs a message as a platform task', async () => {
        const userId = 'gh_7245';
        const WS = userId as WorkspaceId;
        const cookie = await signIn(userId);
        await setAnthropicKey(WS, cookie);
        const { agentId } = await overHttp(Workspace, workspaceKey(WS), cookie).createAgent({ name: 'Helper' });
        await overHttp(AgentActor, agentKey(WS, agentId as AgentId), cookie).update({ name: 'Helper', description: 'Answers questions.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        const token = await accessToken(cookie);
        const auth = { authorization: `Bearer ${token}` };
        const cardUrl = `${LOCAL}/_agentic/a2a/${agentId}/.well-known/agent-card.json`;

        expect((await SELF.fetch(cardUrl)).status).toBe(401);
        expect((await SELF.fetch(cardUrl, { headers: auth })).status).toBe(404);

        const registry = registryOverHttp(WS, cookie);
        await registry.configure(A2A, { exposedAgents: [agentId] });
        await registry.enable(A2A);
        const card = await SELF.fetch(cardUrl, { headers: auth });
        expect(card.status).toBe(200);
        expect(await card.json()).toMatchObject({ name: 'Helper', supportedInterfaces: [{ url: `${LOCAL}/_agentic/a2a/${agentId}` }] });

        const sent = await SELF.fetch(`${LOCAL}/_agentic/a2a/${agentId}`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } } })
        });
        const { result } = (await sent.json()) as { result: { task: { status: { state: string }; artifacts?: { parts: { text?: string }[] }[] } } };
        expect(result.task.status.state).toBe('TASK_STATE_COMPLETED');
        expect(result.task.artifacts?.flatMap((a) => a.parts.map((p) => p.text ?? '')).join('')).toBe('echo: hi');

        await registry.disable(A2A);
        expect((await SELF.fetch(cardUrl, { headers: auth })).status).toBe(404);
    });
});
