/**
 * The OAuth 2.1 authorization server (architecture §9, issue #50) — pure
 * `Request → Response` functions over an `OAuthStore`, WebCrypto only, so
 * they run unchanged in the Worker and in tests. The app mounts them
 * (`apps/web/src/auth/oauth-server`) and resolves the signed-in user from
 * its own session cookie; this module never reads a cookie itself.
 *
 * What it enforces, in the order a client meets it:
 *
 * 1. Discovery: RFC 8414 + RFC 9728 (`metadata`, `protectedResource`,
 *    `challenge` for the 401 that starts the dance).
 * 2. Registration: RFC 7591, public clients only (`register`).
 * 3. Authorization code with PKCE S256 required, exact-match redirect URI
 *    (loopback port excepted), scopes validated against the `Scope` union,
 *    consent by a signed-in user (`authorize`, GET renders, POST decides).
 * 4. Tokens: short-lived sealed access tokens; refresh tokens rotate on
 *    every use and a replayed generation revokes the grant (`token`).
 * 5. Revocation: RFC 7009 (`revoke`); `verify` then refuses the access token
 *    immediately — revocation is not deferred to expiry.
 *
 * Access tokens decode to `{ kind: 'external', workspaceId, clientId, scopes }`,
 * the principal every actor's `authorize` chain understands.
 */
import type { Principal, Scope, WorkspaceId } from '@agentic/core';
import { sha256, timingSafeEqualText, toBase64Url } from '../encoding.js';
import { bearerToken } from '../machine-token.js';
import { clientRegistrationResponse, newClientId, redirectUriMatches, validateClientMetadata } from './client.js';
import { renderConsent, renderError } from './consent.js';
import { AUTHORIZATION_PATH, authorizationServerMetadata, protectedResourceMetadata, protectedResourceMetadataUrl } from './metadata.js';
import { ALL_SCOPES, formatScopes, parseScopes } from './scopes.js';
import {
    ACCESS_TOKEN_TTL_MS,
    CODE_TTL_MS,
    CONSENT_TTL_MS,
    REFRESH_TOKEN_TTL_MS,
    openAccessToken,
    openCode,
    openConsent,
    openRefreshToken,
    randomId,
    sealAccessToken,
    sealCode,
    sealConsent,
    sealRefreshToken
} from './tokens.js';
import type { OAuthErrorCode, OAuthGrant, OAuthStore, OAuthUser, RegisteredClient } from './types.js';

export type ExternalPrincipal = Extract<Principal, { kind: 'external' }>;

export interface OAuthServerOptions {
    /** Signs every token; the app's `SESSION_SECRET`. */
    readonly secret: string;
    /** The origin the server lives on, no trailing slash. */
    readonly issuer: string;
    /** The MCP endpoint's absolute URL — the protected resource. */
    readonly resource: string;
    readonly store: OAuthStore;
    /** Scopes issued. Default: every `Scope`. */
    readonly scopes?: readonly Scope[];
    /** Where an anonymous user is sent to sign in; must bring them back to `returnTo`. Default `/auth/login?returnTo=…`. */
    readonly loginUrl?: (returnTo: string) => string;
    readonly now?: () => number;
    readonly accessTokenTtlMs?: number;
    readonly refreshTokenTtlMs?: number;
    readonly codeTtlMs?: number;
}

export interface OAuthServer {
    /** `GET /.well-known/oauth-authorization-server`. */
    metadata(): Response;
    /** `GET /.well-known/oauth-protected-resource[/_agentic/mcp]`. */
    protectedResource(): Response;
    /** The 401 an unauthenticated resource request gets — names where the metadata is (RFC 9728 §5.1). */
    challenge(detail?: { readonly error?: 'invalid_token' | 'insufficient_scope'; readonly description?: string; readonly scope?: readonly Scope[] }): Response;
    /** `POST /oauth/register`. */
    register(request: Request): Promise<Response>;
    /** `GET|POST /oauth/authorize`; `user` is the signed-in user or `null`. */
    authorize(request: Request, user: OAuthUser | null): Promise<Response>;
    /** `POST /oauth/token`. */
    token(request: Request): Promise<Response>;
    /** `POST /oauth/revoke`. */
    revoke(request: Request): Promise<Response>;
    /** The external principal a bearer token (or a request carrying one) proves, or `null`. */
    verify(tokenOrRequest: string | Request | null | undefined): Promise<ExternalPrincipal | null>;
    /** The absolute URL of the protected-resource metadata this server serves. */
    readonly resourceMetadataUrl: string;
    readonly scopes: readonly Scope[];
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...headers } });

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } });

const oauthError = (error: OAuthErrorCode, description: string, status = 400): Response => json({ error, error_description: description }, status);

const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location, ...NO_STORE } });

/** Append error or code parameters to a redirect URI, keeping whatever query it already has. */
function redirectWith(uri: string, params: Record<string, string | undefined>): string {
    const url = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    return url.toString();
}

/** RFC 7636 §4.1 verifier / §4.2 challenge alphabet and length. */
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

async function readForm(request: Request): Promise<URLSearchParams | null> {
    const type = request.headers.get('content-type') ?? '';
    try {
        if (/^application\/x-www-form-urlencoded\b/i.test(type)) return new URLSearchParams(await request.text());
        if (/^application\/json\b/i.test(type)) {
            const body = (await request.json()) as unknown;
            if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (typeof v === 'string') params.set(k, v);
            return params;
        }
        if (/^multipart\/form-data\b/i.test(type)) {
            const form = await request.formData();
            const params = new URLSearchParams();
            form.forEach((v, k) => {
                if (typeof v === 'string') params.set(k, v);
            });
            return params;
        }
    } catch {
        return null;
    }
    return null;
}

export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
    if (!options.secret || options.secret.length < 16) throw new Error('[oauth] secret must be at least 16 characters');
    const issuer = options.issuer.replace(/\/+$/, '');
    const { store, resource, secret } = options;
    const scopes = options.scopes ?? ALL_SCOPES;
    const now = options.now ?? Date.now;
    const accessTtl = options.accessTokenTtlMs ?? ACCESS_TOKEN_TTL_MS;
    const refreshTtl = options.refreshTokenTtlMs ?? REFRESH_TOKEN_TTL_MS;
    const codeTtl = options.codeTtlMs ?? CODE_TTL_MS;
    const loginUrl = options.loginUrl ?? ((returnTo: string) => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    const resourceMetadataUrl = protectedResourceMetadataUrl(issuer, resource);
    const authorizationEndpoint = `${issuer}${AUTHORIZATION_PATH}`;

    const allowedScopes = (requested: readonly Scope[]): Scope[] => requested.filter((s) => scopes.includes(s));

    async function issueTokens(ws: WorkspaceId, grant: OAuthGrant): Promise<Response> {
        const at = now();
        const access = await sealAccessToken({ ws, cid: grant.clientId, gid: grant.id, uid: grant.userId, sc: grant.scopes, iat: at }, secret, at + accessTtl);
        const refresh = grant.scopes.length > 0 ? await sealRefreshToken({ ws, cid: grant.clientId, gid: grant.id, gen: grant.generation }, secret, at + refreshTtl) : null;
        return json({
            access_token: access,
            token_type: 'Bearer',
            expires_in: Math.floor(accessTtl / 1000),
            ...(refresh ? { refresh_token: refresh } : {}),
            scope: formatScopes(grant.scopes)
        });
    }

    const server: OAuthServer = {
        scopes,
        resourceMetadataUrl,

        metadata: () => json(authorizationServerMetadata({ issuer, resource, scopes })),

        protectedResource: () => json(protectedResourceMetadata({ issuer, resource, scopes })),

        challenge(detail = {}) {
            const parts = [`resource_metadata="${resourceMetadataUrl}"`];
            if (detail.error) parts.push(`error="${detail.error}"`);
            if (detail.description) parts.push(`error_description="${detail.description.replace(/["\\]/g, '')}"`);
            if (detail.scope && detail.scope.length > 0) parts.push(`scope="${formatScopes(detail.scope)}"`);
            return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer ${parts.join(', ')}`, ...NO_STORE } });
        },

        async register(request) {
            if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
            let body: unknown;
            try {
                body = await request.json();
            } catch {
                return oauthError('invalid_client_metadata', 'the registration request must be JSON');
            }
            const verdict = validateClientMetadata(body);
            if (!verdict.ok) return oauthError(verdict.error, verdict.description);
            const client: RegisteredClient = { ...verdict.client, clientId: newClientId(), issuedAt: now() };
            await store.registerClient(client);
            return json(clientRegistrationResponse(client), 201);
        },

        async authorize(request, user) {
            if (request.method === 'GET') return authorizeStart(request, user);
            if (request.method === 'POST') return authorizeDecide(request, user);
            return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
        },

        async token(request) {
            if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
            const form = await readForm(request);
            if (!form) return oauthError('invalid_request', 'the token request must be application/x-www-form-urlencoded');
            const grantType = form.get('grant_type');
            if (grantType === 'authorization_code') return redeemCode(form);
            if (grantType === 'refresh_token') return refresh(form);
            return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
        },

        async revoke(request) {
            if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
            const form = await readForm(request);
            const token = form?.get('token');
            // RFC 7009 §2.2: an invalid token is not an error — the client's goal (that it no longer works) is met.
            if (!form || !token) return oauthError('invalid_request', 'token is required');
            const at = now();
            const asRefresh = await openRefreshToken(token, secret, at);
            const asAccess = asRefresh ? null : await openAccessToken(token, secret, at);
            const ref = asRefresh ?? asAccess;
            if (ref) {
                const clientId = form.get('client_id');
                if (clientId && clientId !== ref.cid) return oauthError('invalid_client', 'token was not issued to this client', 401);
                await store.revokeGrant(ref.ws, ref.gid, at);
            }
            return new Response(null, { status: 200, headers: NO_STORE });
        },

        async verify(tokenOrRequest) {
            const token = tokenOrRequest instanceof Request ? bearerToken(tokenOrRequest.headers) : tokenOrRequest;
            const claims = await openAccessToken(token, secret, now());
            if (!claims) return null;
            let grant: OAuthGrant | null;
            try {
                grant = await store.grant(claims.ws, claims.gid);
            } catch {
                return null;
            }
            if (!grant || grant.revokedAt !== undefined || grant.clientId !== claims.cid) return null;
            return { kind: 'external', workspaceId: claims.ws, clientId: claims.cid, scopes: [...claims.sc] };
        }
    };

    async function authorizeStart(request: Request, user: OAuthUser | null): Promise<Response> {
        const url = new URL(request.url);
        const q = url.searchParams;
        const clientId = q.get('client_id') ?? '';
        const client = clientId ? await store.client(clientId) : null;
        // Nothing is ever redirected to a URI the registration does not vouch for (RFC 6749 §4.1.2.1).
        if (!client) return html(renderError('Unknown client', 'This client is not registered with the platform. Register it first (RFC 7591), then retry.'), 400);
        const redirectUri = q.get('redirect_uri') ?? '';
        if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
            return html(renderError('Invalid redirect URI', 'The redirect_uri does not match one the client registered.'), 400);
        }
        const state = q.get('state') ?? undefined;
        const fail = (error: OAuthErrorCode, description: string): Response => redirect(redirectWith(redirectUri, { error, error_description: description, state }));
        if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
        const challenge = q.get('code_challenge') ?? '';
        if (!PKCE_RE.test(challenge)) return fail('invalid_request', 'code_challenge is required (PKCE, 43–128 characters)');
        if ((q.get('code_challenge_method') ?? '') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
        const requested = parseScopes(q.get('scope') ?? client.scope);
        if (requested === null) return fail('invalid_scope', 'scope names a scope this server does not issue');
        const granted = requested.length === 0 ? [...scopes] : allowedScopes(requested);
        if (granted.length === 0) return fail('invalid_scope', 'no requested scope is issued by this server');
        const resourceParam = q.get('resource') ?? undefined;
        if (resourceParam !== undefined && resourceParam !== resource) return fail('invalid_request', `resource must be ${resource}`);

        if (!user) return redirect(loginUrl(`${url.pathname}${url.search}`));

        const txn = await sealConsent(
            { ws: user.workspaceId, uid: user.userId, cid: client.clientId, ru: redirectUri, cc: challenge, sc: granted, ...(state !== undefined ? { st: state } : {}), ...(resourceParam !== undefined ? { res: resourceParam } : {}) },
            secret,
            now() + CONSENT_TTL_MS
        );
        return html(renderConsent({ clientName: client.name, ...(client.clientUri ? { clientUri: client.clientUri } : {}), scopes: granted, txn, action: authorizationEndpoint, userId: user.userId }));
    }

    async function authorizeDecide(request: Request, user: OAuthUser | null): Promise<Response> {
        const form = await readForm(request);
        if (!form) return html(renderError('Bad request', 'The consent form was not understood.'), 400);
        const txn = await openConsent(form.get('txn'), secret, now());
        if (!txn) return html(renderError('Expired', 'This authorization request has expired. Start again from the client.'), 400);
        // The decision must come from the user the transaction was sealed for, signed in right now.
        if (!user || user.userId !== txn.uid || user.workspaceId !== txn.ws) return html(renderError('Not signed in', 'Sign in as the user who started this authorization, then retry.'), 403);
        const decision = form.get('decision');
        const denied = (): Response => redirect(redirectWith(txn.ru, { error: 'access_denied', error_description: 'the user denied the request', state: txn.st }));
        if (decision !== 'allow') return denied();
        // The user may grant fewer scopes than requested. The rendered form carries `consent=scoped` plus one `scope` field per
        // ticked box, so with the marker the ticked set is authoritative — a browser sends NO `scope` field when every box is
        // unticked, and that is a denial, never a grant of everything. A programmatic POST without the marker grants what was requested.
        const scoped = form.get('consent') === 'scoped' || form.has('scope');
        const ticked = scoped ? txn.sc.filter((s) => form.getAll('scope').includes(s)) : txn.sc;
        if (ticked.length === 0) return denied();
        const at = now();
        const id = randomId();
        await store.issueCode(txn.ws, { id, clientId: txn.cid, redirectUri: txn.ru, codeChallenge: txn.cc, scopes: ticked, userId: txn.uid, ...(txn.res !== undefined ? { resource: txn.res } : {}), exp: at + codeTtl });
        const code = await sealCode({ ws: txn.ws, id }, secret, at + codeTtl);
        return redirect(redirectWith(txn.ru, { code, state: txn.st }));
    }

    async function redeemCode(form: URLSearchParams): Promise<Response> {
        const at = now();
        const clientId = form.get('client_id') ?? '';
        const verifier = form.get('code_verifier') ?? '';
        const redirectUri = form.get('redirect_uri') ?? '';
        if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);
        if (!PKCE_RE.test(verifier)) return oauthError('invalid_request', 'code_verifier is required (PKCE)');
        const ref = await openCode(form.get('code'), secret, at);
        if (!ref) return oauthError('invalid_grant', 'the authorization code is invalid or expired');
        // Single use: the record is consumed before any further check, so a replay after a failure cannot succeed either.
        const pending = await store.consumeCode(ref.ws, ref.id, at);
        if (!pending) return oauthError('invalid_grant', 'the authorization code was already used or has expired');
        if (pending.clientId !== clientId) return oauthError('invalid_grant', 'the authorization code was issued to another client');
        if (!redirectUri || redirectUri !== pending.redirectUri) return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
        const challenge = toBase64Url(await sha256(verifier));
        if (!timingSafeEqualText(challenge, pending.codeChallenge)) return oauthError('invalid_grant', 'code_verifier does not match the code_challenge');
        const grant: OAuthGrant = { id: randomId(), clientId, userId: pending.userId, scopes: pending.scopes, createdAt: at, generation: 0 };
        await store.createGrant(ref.ws, grant);
        return issueTokens(ref.ws, grant);
    }

    async function refresh(form: URLSearchParams): Promise<Response> {
        const at = now();
        const ref = await openRefreshToken(form.get('refresh_token'), secret, at);
        if (!ref) return oauthError('invalid_grant', 'the refresh token is invalid or expired');
        const clientId = form.get('client_id');
        if (clientId && clientId !== ref.cid) return oauthError('invalid_client', 'the refresh token was not issued to this client', 401);
        const rotated = await store.rotateGrant(ref.ws, ref.gid, ref.gen, at);
        if (!rotated.ok) {
            const why = rotated.reason === 'reused' ? 'the refresh token was already used; the grant has been revoked' : rotated.reason === 'revoked' ? 'the grant was revoked' : 'the grant no longer exists';
            return oauthError('invalid_grant', why);
        }
        // A narrower scope may be requested on refresh, never a wider one (RFC 6749 §6).
        const narrower = parseScopes(form.get('scope'));
        if (narrower === null) return oauthError('invalid_scope', 'scope names a scope this server does not issue');
        const grant = narrower.length === 0 ? rotated.grant : { ...rotated.grant, scopes: narrower.filter((s) => rotated.grant.scopes.includes(s)) };
        if (grant.scopes.length === 0) return oauthError('invalid_scope', 'no requested scope is part of the grant');
        return issueTokens(ref.ws, grant);
    }

    return server;
}
