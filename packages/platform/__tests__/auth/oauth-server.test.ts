/**
 * The OAuth 2.1 authorization server (#50): discovery, Dynamic Client
 * Registration, PKCE authorization code with consent, the token lifecycle
 * (expiry, refresh rotation with replay detection, revocation) and the
 * actor-backed store.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scope, WorkspaceId } from '@agentic/core';

import {
    ACCESS_TOKEN_TTL_MS,
    ALL_SCOPES,
    CODE_TTL_MS,
    OAUTH_CLIENTS_KEY,
    OAuthClients,
    OAuthGrants,
    REFRESH_TOKEN_TTL_MS,
    actorOAuthStore,
    codeChallengeS256,
    createCodeVerifier,
    createOAuthServer,
    isAcceptableRedirectUri,
    memoryOAuthStore,
    oauthGrantsKey,
    parseScopes,
    redirectUriMatches,
    validateClientMetadata,
    type OAuthServer,
    type OAuthStore,
    type OAuthUser
} from '../../src/auth/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const SECRET = 'a-session-secret-of-at-least-32-characters!';
const ISSUER = 'https://app.test';
const RESOURCE = 'https://app.test/_agentic/mcp';
const REDIRECT = 'http://127.0.0.1:43123/callback';
const T0 = 1_800_000_000_000;
const user: OAuthUser = { userId: 'gh_1', workspaceId: 'gh_1' as WorkspaceId };

interface Harness {
    readonly server: OAuthServer;
    readonly store: ReturnType<typeof memoryOAuthStore>;
    now: number;
}

function harness(store: OAuthStore = memoryOAuthStore()): Harness {
    const h = { now: T0 } as Harness & { now: number };
    const server = createOAuthServer({ secret: SECRET, issuer: ISSUER, resource: RESOURCE, store, now: () => h.now });
    return Object.assign(h, { server, store: store as ReturnType<typeof memoryOAuthStore> });
}

const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request =>
    new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });

async function register(h: Harness, metadata: Record<string, unknown> = {}): Promise<{ client_id: string } & Record<string, unknown>> {
    const res = await h.server.register(new Request(`${ISSUER}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude Code', ...metadata }) }));
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string } & Record<string, unknown>;
}

function txnOf(html: string): string {
    const m = /name="txn" value="([^"]+)"/.exec(html);
    if (!m) throw new Error('no txn in consent page');
    return m[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Registration → consent → code, with PKCE; returns what the token endpoint needs. */
async function consent(h: Harness, options: { scope?: string; clientId?: string; who?: OAuthUser | null; decision?: 'allow' | 'deny' } = {}) {
    const clientId = options.clientId ?? (await register(h)).client_id;
    const verifier = createCodeVerifier();
    const challenge = await codeChallengeS256(verifier);
    const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: RESOURCE });
    if (options.scope !== undefined) params.set('scope', options.scope);
    const who = options.who === undefined ? user : options.who;
    const page = await h.server.authorize(new Request(`${ISSUER}/oauth/authorize?${params}`), who);
    if (page.status !== 200) return { clientId, verifier, page, location: page.headers.get('location'), code: null as string | null };
    const html = await page.text();
    const decided = await h.server.authorize(form(`${ISSUER}/oauth/authorize`, { txn: txnOf(html), decision: options.decision ?? 'allow' }), who);
    const location = decided.headers.get('location');
    const code = location ? new URL(location).searchParams.get('code') : null;
    return { clientId, verifier, page, html, decided, location, code };
}

async function redeem(h: Harness, c: { clientId: string; verifier: string; code: string | null }, overrides: Record<string, string> = {}) {
    const res = await h.server.token(form(`${ISSUER}/oauth/token`, { grant_type: 'authorization_code', code: c.code ?? '', code_verifier: c.verifier, client_id: c.clientId, redirect_uri: REDIRECT, ...overrides }));
    return { status: res.status, body: (await res.json()) as Record<string, string> };
}

describe('discovery (RFC 8414 / RFC 9728)', () => {
    it('serves authorization-server metadata with PKCE S256, DCR and the full scope list', async () => {
        const h = harness();
        const meta = (await h.server.metadata().json()) as Record<string, unknown>;
        expect(meta).toMatchObject({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/oauth/authorize`,
            token_endpoint: `${ISSUER}/oauth/token`,
            registration_endpoint: `${ISSUER}/oauth/register`,
            revocation_endpoint: `${ISSUER}/oauth/revoke`,
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: [...ALL_SCOPES]
        });
        expect(ALL_SCOPES).toEqual(['machines', 'environments', 'agents', 'sessions', 'tasks', 'chats', 'memory', 'schedules', 'usage'] satisfies Scope[]);
    });

    it('serves protected-resource metadata naming this issuer, and the 401 challenge points at it', async () => {
        const h = harness();
        const meta = (await h.server.protectedResource().json()) as Record<string, unknown>;
        expect(meta).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ['header'] });
        expect(h.server.resourceMetadataUrl).toBe(`${ISSUER}/.well-known/oauth-protected-resource/_agentic/mcp`);
        const challenge = h.server.challenge();
        expect(challenge.status).toBe(401);
        expect(challenge.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/_agentic/mcp"`);
        expect(h.server.challenge({ error: 'insufficient_scope', scope: ['sessions'] }).headers.get('www-authenticate')).toContain('error="insufficient_scope", scope="sessions"');
    });
});

describe('dynamic client registration (RFC 7591)', () => {
    it('registers a public client and echoes its metadata with an issued id', async () => {
        const h = harness();
        const reg = await register(h, { scope: 'sessions tasks', software_id: 'claude-code', grant_types: ['authorization_code', 'refresh_token'] });
        expect(reg.client_id).toMatch(/^oac_[A-Za-z0-9_-]{22}$/);
        expect(reg).toMatchObject({ client_name: 'Claude Code', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', response_types: ['code'], scope: 'sessions tasks', software_id: 'claude-code', client_id_issued_at: Math.floor(T0 / 1000) });
        expect(reg.client_secret).toBeUndefined();
        expect(await h.store.client(reg.client_id)).toMatchObject({ name: 'Claude Code' });
    });

    it('refuses confidential clients, bad redirect URIs, unknown scopes and unsupported grant types', async () => {
        const h = harness();
        const post = (body: unknown) => h.server.register(new Request(`${ISSUER}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
        const error = async (body: unknown) => ((await (await post(body)).json()) as { error: string }).error;
        expect(await error({ redirect_uris: [] })).toBe('invalid_redirect_uri');
        expect(await error({ redirect_uris: ['http://evil.example/cb'] })).toBe('invalid_redirect_uri');
        expect(await error({ redirect_uris: ['https://ok.example/cb#frag'] })).toBe('invalid_redirect_uri');
        expect(await error({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })).toBe('invalid_client_metadata');
        expect(await error({ redirect_uris: [REDIRECT], scope: 'sessions admin' })).toBe('invalid_client_metadata');
        expect(await error({ redirect_uris: [REDIRECT], grant_types: ['implicit'] })).toBe('invalid_client_metadata');
        expect(await error({ redirect_uris: [REDIRECT], response_types: ['token'] })).toBe('invalid_client_metadata');
        expect((await post('nope')).status).toBe(400);
        expect(validateClientMetadata({ redirect_uris: ['https://ok.example/cb'] })).toMatchObject({ ok: true, client: { name: 'MCP client', grantTypes: ['authorization_code', 'refresh_token'] } });
    });

    it('accepts https and loopback http redirect URIs; a loopback port may differ at authorization time', () => {
        expect(isAcceptableRedirectUri('https://app.example/cb')).toBe(true);
        expect(isAcceptableRedirectUri('http://localhost:1234/cb')).toBe(true);
        expect(isAcceptableRedirectUri('http://[::1]:1234/cb')).toBe(true);
        expect(redirectUriMatches(['http://[::1]:1234/cb'], 'http://[::1]:5555/cb')).toBe(true);
        expect(isAcceptableRedirectUri('http://app.example/cb')).toBe(false);
        expect(isAcceptableRedirectUri('custom://cb')).toBe(false);
        expect(redirectUriMatches([REDIRECT], 'http://127.0.0.1:50000/callback')).toBe(true);
        expect(redirectUriMatches([REDIRECT], 'http://127.0.0.1:50000/other')).toBe(false);
        expect(redirectUriMatches(['https://app.example/cb'], 'https://app.example:8443/cb')).toBe(false);
    });
});

describe('authorization endpoint: PKCE, consent, redirects', () => {
    it('sends an anonymous user to login with the whole request as returnTo', async () => {
        const h = harness();
        const c = await consent(h, { who: null });
        expect(c.page.status).toBe(302);
        const location = c.location!;
        expect(location.startsWith('/auth/login?returnTo=')).toBe(true);
        const returnTo = decodeURIComponent(location.slice('/auth/login?returnTo='.length));
        expect(returnTo.startsWith('/oauth/authorize?')).toBe(true);
        expect(new URL(`${ISSUER}${returnTo}`).searchParams.get('client_id')).toBe(c.clientId);
    });

    it('never redirects for an unknown client or an unregistered redirect_uri', async () => {
        const h = harness();
        const { client_id } = await register(h);
        const unknown = await h.server.authorize(new Request(`${ISSUER}/oauth/authorize?response_type=code&client_id=oac_nope&redirect_uri=${encodeURIComponent(REDIRECT)}`), user);
        expect(unknown.status).toBe(400);
        expect(unknown.headers.get('content-type')).toContain('text/html');
        const bad = await h.server.authorize(new Request(`${ISSUER}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`), user);
        expect(bad.status).toBe(400);
        expect(bad.headers.get('location')).toBeNull();
    });

    it('redirects protocol errors to the registered redirect_uri: missing PKCE, plain method, unknown scope', async () => {
        const h = harness();
        const { client_id } = await register(h);
        const go = async (extra: Record<string, string>) => {
            const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, state: 's', ...extra });
            const res = await h.server.authorize(new Request(`${ISSUER}/oauth/authorize?${params}`), user);
            expect(res.status).toBe(302);
            const url = new URL(res.headers.get('location')!);
            expect(url.origin + url.pathname).toBe(REDIRECT);
            expect(url.searchParams.get('state')).toBe('s');
            return url.searchParams.get('error');
        };
        expect(await go({})).toBe('invalid_request');
        expect(await go({ code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' })).toBe('invalid_request');
        expect(await go({ code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', scope: 'sessions root' })).toBe('invalid_scope');
        expect(await go({ code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', response_type: 'token' })).toBe('unsupported_response_type');
        expect(await go({ code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: 'https://other.example/mcp' })).toBe('invalid_request');
    });

    it('renders a consent page listing the requested scopes, and a denial redirects with access_denied', async () => {
        const h = harness();
        const c = await consent(h, { scope: 'sessions machines', decision: 'deny' });
        expect(c.page.status).toBe(200);
        expect(c.html).toContain('Claude Code');
        expect(c.html).toContain('<code>sessions</code>');
        expect(c.html).toContain('<code>machines</code>');
        expect(c.html).not.toContain('<code>memory</code>');
        expect(c.html).toContain('action="https://app.test/oauth/authorize"');
        const url = new URL(c.location!);
        expect(url.searchParams.get('error')).toBe('access_denied');
        expect(url.searchParams.get('state')).toBe('xyz');
        expect(url.searchParams.get('code')).toBeNull();
    });

    it('the user may untick scopes on the consent form: the grant is the ticked subset, none ticked is a denial', async () => {
        const h = harness();
        const c = await consent(h, { scope: 'sessions machines tasks' });
        expect(c.html).toContain('<input type="checkbox" name="scope" value="sessions" checked>');
        const { client_id } = await register(h);
        const verifier = createCodeVerifier();
        const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: await codeChallengeS256(verifier), code_challenge_method: 'S256', scope: 'sessions machines tasks' });
        const html = await (await h.server.authorize(new Request(`${ISSUER}/oauth/authorize?${params}`), user)).text();
        const body = new URLSearchParams({ txn: txnOf(html), decision: 'allow' });
        body.append('scope', 'machines');
        body.append('scope', 'memory'); // not requested → ignored, never widened
        const decided = await h.server.authorize(new Request(`${ISSUER}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }), user);
        const code = new URL(decided.headers.get('location')!).searchParams.get('code');
        const { body: tokens } = await redeem(h, { clientId: client_id, verifier, code });
        expect(tokens.scope).toBe('machines');
        await expect(h.server.verify(tokens.access_token)).resolves.toMatchObject({ scopes: ['machines'] });

        const html2 = await (await h.server.authorize(new Request(`${ISSUER}/oauth/authorize?${params}`), user)).text();
        const none = new URLSearchParams({ txn: txnOf(html2), decision: 'allow' });
        none.append('scope', 'memory');
        const refused = await h.server.authorize(new Request(`${ISSUER}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: none.toString() }), user);
        expect(new URL(refused.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    });

    it('a consent decision must come from the user it was issued to', async () => {
        const h = harness();
        const c = await consent(h);
        const html = c.html!;
        const other: OAuthUser = { userId: 'gh_2', workspaceId: 'gh_2' as WorkspaceId };
        const forged = await h.server.authorize(form(`${ISSUER}/oauth/authorize`, { txn: txnOf(html), decision: 'allow' }), other);
        expect(forged.status).toBe(403);
        const anonymous = await h.server.authorize(form(`${ISSUER}/oauth/authorize`, { txn: txnOf(html), decision: 'allow' }), null);
        expect(anonymous.status).toBe(403);
        const garbage = await h.server.authorize(form(`${ISSUER}/oauth/authorize`, { txn: 'oatx.nope.nope', decision: 'allow' }), user);
        expect(garbage.status).toBe(400);
    });
});

describe('token endpoint: code exchange', () => {
    it('exchanges a code with the right verifier for a bearer access token + refresh token that decode to the external principal', async () => {
        const h = harness();
        const c = await consent(h, { scope: 'sessions machines' });
        expect(c.code).toBeTruthy();
        expect(new URL(c.location!).searchParams.get('state')).toBe('xyz');
        const { status, body } = await redeem(h, c);
        expect(status).toBe(200);
        expect(body).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_MS / 1000, scope: 'sessions machines' });
        expect(body.access_token).toMatch(/^oaac\./);
        expect(body.refresh_token).toMatch(/^oarf\./);
        await expect(h.server.verify(body.access_token)).resolves.toEqual({ kind: 'external', workspaceId: 'gh_1', clientId: c.clientId, scopes: ['sessions', 'machines'] });
        await expect(h.server.verify(new Request(RESOURCE, { headers: { authorization: `Bearer ${body.access_token}` } }))).resolves.toMatchObject({ kind: 'external' });
        expect(h.store.grants('gh_1' as WorkspaceId)).toHaveLength(1);
        expect(h.store.grants('gh_1' as WorkspaceId)[0]).toMatchObject({ clientId: c.clientId, userId: 'gh_1', scopes: ['sessions', 'machines'], generation: 0 });
    });

    it('no scope requested → every scope granted', async () => {
        const h = harness();
        const c = await consent(h);
        const { body } = await redeem(h, c);
        expect(body.scope).toBe(ALL_SCOPES.join(' '));
        expect(parseScopes(body.scope)).toEqual([...ALL_SCOPES]);
    });

    it('refuses a wrong verifier, a wrong client, a wrong redirect_uri, and a second use of the code', async () => {
        const h = harness();
        const c = await consent(h);
        expect((await redeem(h, c, { code_verifier: createCodeVerifier() })).body.error).toBe('invalid_grant');
        // The code was consumed by the failed attempt: single use, even after failure.
        expect((await redeem(h, c)).body.error).toBe('invalid_grant');

        const c2 = await consent(h);
        const other = await register(h);
        expect((await redeem(h, c2, { client_id: other.client_id })).body.error).toBe('invalid_grant');

        const c3 = await consent(h);
        expect((await redeem(h, c3, { redirect_uri: 'http://127.0.0.1:43123/elsewhere' })).body.error).toBe('invalid_grant');

        const c4 = await consent(h);
        const ok = await redeem(h, c4);
        expect(ok.status).toBe(200);
        expect((await redeem(h, c4)).body.error).toBe('invalid_grant');

        expect((await redeem(h, { ...c4, code: 'oacd.forged.forged' })).body.error).toBe('invalid_grant');
        expect((await redeem(h, c4, { client_id: '' })).status).toBe(401);
        expect((await redeem(h, c4, { code_verifier: 'short' })).body.error).toBe('invalid_request');
    });

    it('an authorization code expires', async () => {
        const h = harness();
        const c = await consent(h);
        h.now = T0 + CODE_TTL_MS + 1;
        expect((await redeem(h, c)).body.error).toBe('invalid_grant');
    });

    it('unsupported grant types and non-form bodies are refused', async () => {
        const h = harness();
        const bad = await h.server.token(form(`${ISSUER}/oauth/token`, { grant_type: 'password' }));
        expect(((await bad.json()) as { error: string }).error).toBe('unsupported_grant_type');
        const text = await h.server.token(new Request(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }));
        expect(((await text.json()) as { error: string }).error).toBe('invalid_request');
        expect((await h.server.token(new Request(`${ISSUER}/oauth/token`))).status).toBe(405);
    });
});

describe('token lifecycle: expiry, refresh rotation, revocation', () => {
    async function tokens(h: Harness, scope = 'sessions') {
        const c = await consent(h, { scope });
        const { body } = await redeem(h, c);
        return { clientId: c.clientId, access: body.access_token, refresh: body.refresh_token };
    }
    const refresh = async (h: Harness, token: string, extra: Record<string, string> = {}) => {
        const res = await h.server.token(form(`${ISSUER}/oauth/token`, { grant_type: 'refresh_token', refresh_token: token, ...extra }));
        return { status: res.status, body: (await res.json()) as Record<string, string> };
    };

    it('an access token stops verifying at its expiry; a refresh token at its own', async () => {
        const h = harness();
        const t = await tokens(h);
        h.now = T0 + ACCESS_TOKEN_TTL_MS - 1;
        await expect(h.server.verify(t.access)).resolves.not.toBeNull();
        h.now = T0 + ACCESS_TOKEN_TTL_MS;
        await expect(h.server.verify(t.access)).resolves.toBeNull();
        expect((await refresh(h, t.refresh)).status).toBe(200);
        h.now = T0 + REFRESH_TOKEN_TTL_MS + 1;
        expect((await refresh(h, t.refresh)).body.error).toBe('invalid_grant');
    });

    it('refresh rotates: the new pair works, the old refresh token is a replay that revokes the whole grant', async () => {
        const h = harness();
        const t = await tokens(h);
        h.now = T0 + 1000;
        const first = await refresh(h, t.refresh);
        expect(first.status).toBe(200);
        expect(first.body.refresh_token).not.toBe(t.refresh);
        expect(first.body.access_token).not.toBe(t.access);
        await expect(h.server.verify(first.body.access_token)).resolves.toMatchObject({ scopes: ['sessions'] });
        expect(h.store.grants('gh_1' as WorkspaceId)[0]).toMatchObject({ generation: 1, lastRefreshedAt: T0 + 1000 });

        // Replay of the rotated-out token: the grant is revoked, every token of it dies with it.
        const replay = await refresh(h, t.refresh);
        expect(replay.body.error).toBe('invalid_grant');
        expect(replay.body.error_description).toMatch(/already used/);
        expect((await refresh(h, first.body.refresh_token)).body.error).toBe('invalid_grant');
        await expect(h.server.verify(first.body.access_token)).resolves.toBeNull();
        expect(h.store.grants('gh_1' as WorkspaceId)[0]!.revokedAt).toBe(T0 + 1000);
    });

    it('refresh may narrow scopes, never widen, and must come from the same client', async () => {
        const h = harness();
        const t = await tokens(h, 'sessions tasks machines');
        const narrowed = await refresh(h, t.refresh, { scope: 'sessions' });
        expect(narrowed.body.scope).toBe('sessions');
        await expect(h.server.verify(narrowed.body.access_token)).resolves.toMatchObject({ scopes: ['sessions'] });
        const wider = await refresh(h, narrowed.body.refresh_token, { scope: 'memory' });
        expect(wider.body.error).toBe('invalid_scope');
        const t2 = await tokens(h);
        const other = await register(h);
        expect((await refresh(h, t2.refresh, { client_id: other.client_id })).status).toBe(401);
    });

    it('revocation (RFC 7009) of either token kills the grant at once; unknown tokens are 200 too', async () => {
        const h = harness();
        const t = await tokens(h);
        const revoke = (token: string, clientId = t.clientId) => h.server.revoke(form(`${ISSUER}/oauth/revoke`, { token, client_id: clientId }));
        expect((await revoke('garbage')).status).toBe(200);
        await expect(h.server.verify(t.access)).resolves.not.toBeNull();
        expect((await revoke(t.access)).status).toBe(200);
        await expect(h.server.verify(t.access)).resolves.toBeNull();
        expect((await refresh(h, t.refresh)).body.error).toBe('invalid_grant');

        const t2 = await tokens(h);
        expect((await revoke(t2.refresh, t2.clientId)).status).toBe(200);
        await expect(h.server.verify(t2.access)).resolves.toBeNull();
        const other = await register(h);
        const t3 = await tokens(h);
        expect((await h.server.revoke(form(`${ISSUER}/oauth/revoke`, { token: t3.access, client_id: other.client_id }))).status).toBe(401);
        await expect(h.server.verify(t3.access)).resolves.not.toBeNull();
    });

    it('a token sealed with another secret, a truncated one, or a session cookie value never verifies', async () => {
        const h = harness();
        const t = await tokens(h);
        const foreign = createOAuthServer({ secret: 'another-secret-of-32-characters-or-more!!', issuer: ISSUER, resource: RESOURCE, store: h.store, now: () => h.now });
        await expect(foreign.verify(t.access)).resolves.toBeNull();
        await expect(h.server.verify(t.access.slice(0, -3))).resolves.toBeNull();
        await expect(h.server.verify(t.refresh)).resolves.toBeNull();
        await expect(h.server.verify(undefined)).resolves.toBeNull();
    });
});

describe('actor-backed store (OAuthClients + OAuthGrants)', () => {
    let app: TestActorApp;
    beforeEach(async () => {
        app = testActorApp([OAuthClients, OAuthGrants]);
        await app.start();
    });
    afterEach(() => app.stop());

    it('runs the whole flow on the actors, saving every mutation inside the turn', async () => {
        const h = harness(actorOAuthStore());
        const c = await consent(h, { scope: 'tasks' });
        const { status, body } = await redeem(h, c);
        expect(status).toBe(200);
        await expect(h.server.verify(body.access_token)).resolves.toMatchObject({ kind: 'external', clientId: c.clientId, scopes: ['tasks'] });
        // Single use holds on the actor too.
        expect((await redeem(h, c)).body.error).toBe('invalid_grant');
        const rotated = await h.server.token(form(`${ISSUER}/oauth/token`, { grant_type: 'refresh_token', refresh_token: body.refresh_token }));
        expect(rotated.status).toBe(200);
        const replay = await h.server.token(form(`${ISSUER}/oauth/token`, { grant_type: 'refresh_token', refresh_token: body.refresh_token }));
        expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
        await expect(h.server.verify(body.access_token)).resolves.toBeNull();

        const grants = app.as(userPrincipal('gh_1')).actor(OAuthGrants, oauthGrantsKey('gh_1'));
        const listed = await grants.list();
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ clientId: c.clientId, generation: 1 });
        expect(listed[0]!.revokedAt).toBeDefined();
        expect(app.saves.filter((s) => s.type === 'OAuthGrants').length).toBeGreaterThanOrEqual(5);
        expect(app.saves.filter((s) => s.type === 'OAuthClients')).toHaveLength(1);
    });

    it('registration and lookup are anonymous; grants belong to the workspace user only', async () => {
        const clients = app.as(null).actor(OAuthClients, OAUTH_CLIENTS_KEY);
        await clients.register({ clientId: 'oac_x', name: 'x', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], issuedAt: T0 });
        await expect(clients.get('oac_x')).resolves.toMatchObject({ name: 'x' });
        expect([401, 403]).toContain(await statusOf(clients.count()));

        const stranger = app.as(userPrincipal('gh_2')).actor(OAuthGrants, oauthGrantsKey('gh_1'));
        expect([401, 403]).toContain(await statusOf(stranger.list()));
        const external = app.as({ kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['sessions'] }).actor(OAuthGrants, oauthGrantsKey('gh_1'));
        expect([401, 403]).toContain(await statusOf(external.list()));
        await expect(app.as(userPrincipal('gh_1')).actor(OAuthGrants, oauthGrantsKey('gh_1')).list()).resolves.toEqual([]);
    });
});
