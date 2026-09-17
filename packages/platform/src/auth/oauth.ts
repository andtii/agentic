/**
 * The provider-neutral OAuth flow over WinterCG `Request`/`Response` parts:
 *
 *   begin  →  302 to the provider + a sealed `__Host-oauth` transient cookie
 *             carrying { state, PKCE verifier, returnTo } for 10 minutes
 *   complete  ←  the callback: state must match the transient, the code is
 *             exchanged through the provider, and the transient is cleared
 *
 * The transient is signed with the session secret, so a callback with no
 * matching transient — a replay, a cross-site link, an expired attempt —
 * cannot complete a login. Nothing here writes the session; the route
 * handler does that once it has mapped the identity to a user.
 */
import { randomBytes, sha256, timingSafeEqualText, toBase64Url } from './encoding.js';
import { readCookie, serializeCookie } from './cookie.js';
import { AuthProviderError, type AuthProvider, type ExternalIdentity } from './provider.js';
import { open, seal, type SealedPayload } from './seal.js';

export const OAUTH_COOKIE = '__Host-oauth';
export const OAUTH_TRANSIENT_TTL_MS = 10 * 60 * 1000;

interface OAuthTransient extends SealedPayload {
    readonly state: string;
    readonly verifier?: string;
    readonly returnTo: string;
}

export interface BeginOAuthOptions {
    /** The session secret — the transient is sealed with it. */
    readonly secret: string;
    /** Absolute callback URL registered with the provider. */
    readonly redirectUri: string;
    /** Same-origin path to land on after login. Default `/`. */
    readonly returnTo?: string;
    readonly now?: number;
}

export interface BeginOAuthResult {
    /** `Location` for the 302. */
    readonly location: string;
    /** `Set-Cookie` for the transient. */
    readonly setCookie: string;
}

export interface CompleteOAuthOptions {
    readonly secret: string;
    readonly redirectUri: string;
    readonly now?: number;
}

export type CompleteOAuthResult =
    | { readonly ok: true; readonly identity: ExternalIdentity; readonly returnTo: string; readonly clearCookie: string }
    | { readonly ok: false; readonly reason: 'missing_transient' | 'state_mismatch' | 'provider_denied' | 'missing_code' | 'exchange_failed'; readonly error?: AuthProviderError; readonly clearCookie: string };

export function createOAuthState(): string {
    return toBase64Url(randomBytes(24));
}

/** RFC 7636 §4.1: 43–128 url-safe chars. 32 random bytes → 43. */
export function createCodeVerifier(): string {
    return toBase64Url(randomBytes(32));
}

/** RFC 7636 §4.2 S256. */
export async function codeChallengeS256(verifier: string): Promise<string> {
    return toBase64Url(await sha256(verifier));
}

/** Only a same-origin path survives; anything else — a scheme, `//evil` — falls back to `/`. */
export function safeReturnTo(value: string | null | undefined): string {
    if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
    return value;
}

export async function beginOAuth(provider: AuthProvider, options: BeginOAuthOptions): Promise<BeginOAuthResult> {
    const now = options.now ?? Date.now();
    const state = createOAuthState();
    const verifier = provider.pkce ? createCodeVerifier() : undefined;
    const transient: OAuthTransient = { state, ...(verifier ? { verifier } : {}), returnTo: safeReturnTo(options.returnTo), exp: now + OAUTH_TRANSIENT_TTL_MS };
    const sealed = await seal('oat', transient, options.secret);
    const location = provider.authorizationUrl({
        redirectUri: options.redirectUri,
        state,
        ...(verifier ? { codeChallenge: await codeChallengeS256(verifier) } : {})
    });
    return { location, setCookie: serializeCookie(OAUTH_COOKIE, sealed, { maxAge: OAUTH_TRANSIENT_TTL_MS / 1000 }) };
}

export function clearOAuthCookie(): string {
    return serializeCookie(OAUTH_COOKIE, '', { maxAge: 0 });
}

/** Handle the provider's redirect back. Never throws for a bad callback; a provider fault is reported, not thrown. */
export async function completeOAuth(provider: AuthProvider, request: Request, options: CompleteOAuthOptions): Promise<CompleteOAuthResult> {
    const now = options.now ?? Date.now();
    const clearCookie = clearOAuthCookie();
    const transient = await open<OAuthTransient>('oat', readCookie(request.headers.get('cookie'), OAUTH_COOKIE), options.secret, now);
    if (!transient || typeof transient.state !== 'string') return { ok: false, reason: 'missing_transient', clearCookie };
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    if (!state || !timingSafeEqualText(state, transient.state)) return { ok: false, reason: 'state_mismatch', clearCookie };
    if (url.searchParams.get('error')) return { ok: false, reason: 'provider_denied', clearCookie };
    const code = url.searchParams.get('code');
    if (!code) return { ok: false, reason: 'missing_code', clearCookie };
    try {
        const identity = await provider.exchangeCode({ code, redirectUri: options.redirectUri, ...(transient.verifier ? { codeVerifier: transient.verifier } : {}) });
        return { ok: true, identity, returnTo: safeReturnTo(transient.returnTo), clearCookie };
    } catch (error) {
        const wrapped = error instanceof AuthProviderError ? error : new AuthProviderError(provider.id, 'exchange_failed', String(error));
        return { ok: false, reason: 'exchange_failed', error: wrapped, clearCookie };
    }
}
