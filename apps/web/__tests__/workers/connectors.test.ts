/**
 * Connecting Gmail inside workerd (#533): the production sign-in routes and the production conduit opener over the
 * real `ActorHost` Durable Objects — the Registry (the OAuth client and the engine secret, sealed under the pool's
 * `WORKSPACE_KEK`) and the workspace's `ConnectorAccounts` (the account, sealed by conduit) — with only Google faked
 * (`./google.ts`).
 *
 * start → Google's consent (skipped: the test reads the state off the redirect) → callback stores the account
 * sealed and writes its id onto the connector record; the first tool call refreshes the short-lived access token;
 * a refresh Google refuses (`invalid_grant`) marks the account `needsReauth` and the call says to reconnect;
 * Disconnect revokes at Google and forgets the account.
 */
import { env, SELF } from 'cloudflare:test';
import type { WorkspaceId } from '@agentic/core';
import { CONNECTOR_ENGINE_SECRET } from '@agentic/connectors';
import { connectorAccountsKey, type ConnectorAccountsActor } from '@agentic/platform';
import { CONNECTOR_ENGINE_SECRET_NAME } from '../../src/connectors/paths';
import { overHttp, registryOverHttp, signIn } from './http';

const ORIGIN = 'https://agentic.test';
/** `wrangler.jsonc`'s `APP_ORIGIN`: the redirect URI is the deployment's public origin, not the request's host. */
const APP_ORIGIN = (env as { APP_ORIGIN?: string }).APP_ORIGIN ?? ORIGIN;
const ConnectorAccounts = { type: 'ConnectorAccounts' } as unknown as ConnectorAccountsActor;

const get = (path: string, cookie?: string): Promise<Response> => SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

async function googleLog(): Promise<string[]> {
    return ((await (await SELF.fetch(`${ORIGIN}/__test/google/log`)).json()) as { log: string[] }).log;
}

async function call(workspaceId: string, tool: string, input: Record<string, unknown>) {
    const res = await SELF.fetch(`${ORIGIN}/__test/connectors/call`, { method: 'POST', body: JSON.stringify({ workspaceId, pluginId: 'gmail', tool, input }) });
    return (await res.json()) as { output?: unknown; error?: { code: string; message: string }; toolNames?: string[] };
}

/** A workspace with Gmail on and its OAuth client saved, the way the plugin page does it. */
async function setUp(userId: string) {
    const WS = userId as WorkspaceId;
    const cookie = await signIn(userId);
    const registry = registryOverHttp(WS, cookie);
    await registry.enable('gmail');
    await registry.setSecret('client-id', 'cid.apps.googleusercontent.com');
    await registry.setSecret('client-secret', 'client-shh');
    return { WS, cookie, registry };
}

/** Connect → Google (skipped) → callback with `code`; returns the callback's redirect. */
async function connect(cookie: string, code: string): Promise<Response> {
    const start = await get('/_agentic/connectors/gmail/start', cookie);
    expect(start.status).toBe(302);
    const consent = new URL(start.headers.get('location')!);
    expect(consent.origin).toBe('https://accounts.google.com');
    expect(consent.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(consent.searchParams.get('redirect_uri')).toBe(`${APP_ORIGIN}/_agentic/connectors/callback`);
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    const state = consent.searchParams.get('state')!;
    return get(`/_agentic/connectors/callback?state=${encodeURIComponent(state)}&code=${code}`, cookie);
}

describe('worker: connecting Gmail (#533)', () => {
    it('the engine secret name is the one the connectors package declares', () => {
        expect(CONNECTOR_ENGINE_SECRET_NAME).toBe(CONNECTOR_ENGINE_SECRET);
    });

    it('ships off; start refuses until the plugin is on and says so on the plugin page; strangers get 401', async () => {
        const userId = 'gh_5330';
        const cookie = await signIn(userId);
        const overview = await registryOverHttp(userId as WorkspaceId, cookie).overview();
        expect(overview.plugins.find((p) => p.manifest.id === 'gmail')).toMatchObject({ enabled: false, builtin: true });

        const off = await get('/_agentic/connectors/gmail/start', cookie);
        expect(off.status).toBe(302);
        expect(off.headers.get('location')).toMatch(/^\/plugins\/gmail\?connect_error=turn%20the%20plugin%20on%20first$/);

        expect((await get('/_agentic/connectors/gmail/start')).status).toBe(401);
        expect((await get('/_agentic/connectors/nope/start', cookie)).status).toBe(404);
        expect((await get('/_agentic/connectors/gmail/execute', cookie)).status).toBe(404);
    });

    it('start → callback stores the account sealed, the record carries its id, and the first tool call refreshes the token', async () => {
        const { WS, cookie, registry } = await setUp('gh_5331');
        const back = await connect(cookie, 'code-ok');
        expect(back.status).toBe(302);
        expect(back.headers.get('location')).toBe('/plugins/gmail?connected=1');

        // The record: a conduit connector carrying the account id — ids only.
        const record = await registry.getConnector('gmail');
        expect(record).toMatchObject({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail' });
        expect(record!.account).toEqual(expect.any(String));
        // The engine secret was generated on this first Connect and sealed beside the OAuth client.
        expect((await registry.overview()).secretNames).toEqual(expect.arrayContaining(['client-id', 'client-secret', CONNECTOR_ENGINE_SECRET]));

        // The account: sealed by conduit — neither token appears, and it is not plain JSON.
        const accounts = overHttp(ConnectorAccounts, connectorAccountsKey(WS), cookie);
        const stored = await accounts.getAccount(record!.account!);
        expect(stored).toMatchObject({ owner: WS, connector: 'gmail', status: 'active', displayName: 'owner@example.com' });
        for (const token of ['at-1', 'rt-ok', 'client-shh']) expect(stored!.credentials).not.toContain(token);
        expect(stored!.credentials.trimStart().startsWith('{')).toBe(false);
        expect(await accounts.accounts()).toEqual([expect.objectContaining({ id: record!.account, status: 'active', displayName: 'owner@example.com' })]);
        expect(JSON.stringify(await accounts.accounts())).not.toContain(stored!.credentials);

        // Reconnect runs the same flow over the record's account.
        const reconnected = await connect(cookie, 'code-ok');
        expect(reconnected.headers.get('location')).toBe('/plugins/gmail?connected=1');
        const before = (await googleLog()).filter((l) => l.endsWith('refresh_token')).length;

        // A tool call as the session would make it: the access token expires within the skew, so it is renewed first.
        const out = await call(WS, 'gmail__search-messages', { query: 'is:unread' });
        expect(out.error).toBeUndefined();
        expect(out.output).toEqual([{ id: 'm1', threadId: 't1' }]);
        expect(out.toolNames).toEqual(expect.arrayContaining(['gmail__search-messages', 'gmail__get-message', 'gmail__send-email', 'gmail__reply-to-message', 'gmail__trash-message']));
        expect((await googleLog()).filter((l) => l.endsWith('refresh_token')).length).toBe(before + 1);
        const renewed = await accounts.getAccount(record!.account!);
        expect(renewed!.version).toBeGreaterThan(stored!.version);
        expect(renewed!.credentials).not.toContain('at-2');
        // Reconnecting kept the SAME account id (the record's), so every agent's grant still points at it.
        expect((await registry.getConnector('gmail'))!.account).toBe(record!.account);
    });

    it('a used or foreign sign-in link is refused on the plugin page', async () => {
        const { cookie } = await setUp('gh_5332');
        const start = await get('/_agentic/connectors/gmail/start', cookie);
        const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
        const first = await get(`/_agentic/connectors/callback?state=${encodeURIComponent(state)}&code=code-ok`, cookie);
        expect(first.headers.get('location')).toBe('/plugins/gmail?connected=1');
        const again = await get(`/_agentic/connectors/callback?state=${encodeURIComponent(state)}&code=code-ok`, cookie);
        expect(again.headers.get('location')).toMatch(/^\/plugins\/gmail\?connect_error=/);

        // Another workspace's owner cannot finish this workspace's sign-in: its engine secret and handshakes are its own.
        const other = await setUp('gh_5333');
        const start2 = await get('/_agentic/connectors/gmail/start', cookie);
        const state2 = new URL(start2.headers.get('location')!).searchParams.get('state')!;
        const foreign = await get(`/_agentic/connectors/callback?state=${encodeURIComponent(state2)}&code=code-ok`, other.cookie);
        expect(foreign.headers.get('location')).toMatch(/^\/plugins\/gmail\?connect_error=/);
        expect((await other.registry.getConnector('gmail'))?.account).toBeUndefined();

        // A Google refusal (the owner pressed Cancel) lands on the page too.
        const denied = await get(`/_agentic/connectors/callback?state=${encodeURIComponent(state2)}&error=access_denied`, cookie);
        expect(denied.headers.get('location')).toMatch(/^\/plugins\/gmail\?connect_error=.*access_denied/);
    });

    it('a refresh Google refuses (invalid_grant) marks the account needsReauth, and the call asks for a reconnect', async () => {
        const { WS, cookie, registry } = await setUp('gh_5334');
        expect((await connect(cookie, 'code-revoked')).headers.get('location')).toBe('/plugins/gmail?connected=1');
        const account = (await registry.getConnector('gmail'))!.account!;

        const out = await call(WS, 'gmail__search-messages', {});
        expect(out.error).toMatchObject({ code: 'needs_reauth' });
        expect(out.error!.message).toContain('reconnect');
        const accounts = overHttp(ConnectorAccounts, connectorAccountsKey(WS), cookie);
        expect(await accounts.accounts()).toEqual([expect.objectContaining({ id: account, status: 'needsReauth', displayName: 'revoked@example.com' })]);
    });

    it('Disconnect revokes at Google, forgets the account and clears it from the record; it needs a same-origin POST', async () => {
        const { WS, cookie, registry } = await setUp('gh_5335');
        await connect(cookie, 'code-ok');
        const account = (await registry.getConnector('gmail'))!.account!;

        const crossSite = await SELF.fetch(`${ORIGIN}/_agentic/connectors/gmail/disconnect`, { method: 'POST', headers: { cookie, origin: 'https://evil.test' } });
        expect(crossSite.status).toBe(403);
        expect((await SELF.fetch(`${ORIGIN}/_agentic/connectors/gmail/disconnect`, { headers: { cookie } })).status).toBe(405);

        const revokesBefore = (await googleLog()).filter((l) => l.includes('/revoke')).length;
        const res = await SELF.fetch(`${ORIGIN}/_agentic/connectors/gmail/disconnect`, { method: 'POST', headers: { cookie, origin: ORIGIN } });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ disconnected: true, revoked: true });
        expect((await googleLog()).filter((l) => l.includes('/revoke')).length).toBe(revokesBefore + 1);

        const record = await registry.getConnector('gmail');
        expect(record).toMatchObject({ transport: 'conduit', connector: 'gmail' });
        expect(record!.account).toBeUndefined();
        const accounts = overHttp(ConnectorAccounts, connectorAccountsKey(WS), cookie);
        expect(await accounts.getAccount(account)).toBeNull();
        expect(await accounts.accounts()).toEqual([]);
    });
});
