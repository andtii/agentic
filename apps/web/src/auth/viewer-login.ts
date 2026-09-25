/**
 * The viewer's provider login (#893) — the GitHub handle a pull request names
 * in its requested reviewers, so Home's "Needs you" can tell a review
 * requested of YOU. The session (`__Host-session`, `@agentic/platform`) carries
 * only `userId` / `workspaceId`; the login rides next to it in its own sealed
 * `__Host-login` cookie, minted by the OAuth callback with the session and
 * bound to its user: `viewerLogin` answers only for the session's user, so a
 * login left behind by another sign-in is ignored.
 *
 * It is a display handle, never an identity: nothing authorizes on it.
 */
import { open, readCookie, seal, serializeCookie, SESSION_TTL_MS, type SealedPayload } from '@agentic/platform';

export const LOGIN_COOKIE = '__Host-login';

interface LoginPayload extends SealedPayload {
    readonly userId: string;
    readonly login: string;
}

/** `Set-Cookie` for `login`, bound to `userId`; it lives as long as the session. */
export async function loginCookie(claims: { readonly userId: string; readonly login: string }, secret: string, options: { now?: number; ttlMs?: number } = {}): Promise<string> {
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    const payload: LoginPayload = { userId: claims.userId, login: claims.login, exp: now + ttlMs };
    return serializeCookie(LOGIN_COOKIE, await seal('lgn', payload, secret), { maxAge: Math.floor(ttlMs / 1000) });
}

/** `Set-Cookie` that removes the login. */
export function clearLoginCookie(): string {
    return serializeCookie(LOGIN_COOKIE, '', { maxAge: 0 });
}

/** The login `request` carries for `userId`, or `undefined`: none, forged, expired, or minted for another user. */
export async function loginFromRequest(request: Request, userId: string, secret: string, now: number = Date.now()): Promise<string | undefined> {
    const payload = await open<LoginPayload>('lgn', readCookie(request.headers.get('cookie'), LOGIN_COOKIE), secret, now);
    if (!payload || payload.userId !== userId || typeof payload.login !== 'string' || !payload.login) return undefined;
    return payload.login;
}

/**
 * The secret `viewerLogin` opens the cookie with. The auth mount records it from the Worker's env at the top of every
 * request (`createAuthMount`), the same way `setSignInOptions` records the doors; unset (the mock dev server, tests),
 * there is no login.
 */
let loginSecret = '';

export function setLoginSecret(secret: string): void {
    loginSecret = secret;
}

/** `whoami`'s read: the signed-in user's provider login, when this deployment can open it. */
export function viewerLogin(request: Request, userId: string): Promise<string | undefined> {
    return loginSecret ? loginFromRequest(request, userId, loginSecret) : Promise.resolve(undefined);
}
