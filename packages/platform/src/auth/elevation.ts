/**
 * Elevation (#355; decisions 2026-09-22): a security-sensitive machine change
 * from the web — the folders the web may use, browsing outside `cwdRoots`,
 * turning `bypassPermissions` on, revoking a machine — needs more than a
 * session cookie. The user re-confirms through the login provider and gets
 * the `__Host-elevated` cookie: a sealed `{ userId }` that lives ten minutes.
 * `authenticate` turns it into `elevatedUntil` on the user principal, and
 * only when it names the same user as the session — so a stolen
 * `__Host-session` alone cannot make those changes, and an elevation cannot
 * be lent to another session. `requireElevated` is what the owner-only actor
 * methods call first.
 *
 * Only cookie mechanics live here; re-proving who the user is happens in the
 * OAuth flow (`beginOAuth({ purpose: 'elevate' })`, the web's `/auth/elevate`).
 */
import { ELEVATION_REQUIRED, ELEVATION_TTL_MS, isElevated, type Principal } from '@agentic/core';
import { ServerFnError } from '@sigx/server';
import { readCookie, serializeCookie } from './cookie.js';
import { open, seal, type SealedPayload } from './seal.js';

export const ELEVATION_COOKIE = '__Host-elevated';
export { ELEVATION_REQUIRED, ELEVATION_TTL_MS, isElevated };

export interface ElevationPayload extends SealedPayload {
    readonly userId: string;
    /** Issued at, epoch ms. */
    readonly iat: number;
}

export interface ElevationOptions {
    /** Epoch ms; defaults to `Date.now()`. */
    now?: number;
    ttlMs?: number;
}

/** The sealed cookie VALUE for a user who just re-confirmed. */
export function sealElevation(claims: { readonly userId: string }, secret: string, options: ElevationOptions = {}): Promise<string> {
    const now = options.now ?? Date.now();
    const payload: ElevationPayload = { userId: claims.userId, iat: now, exp: now + (options.ttlMs ?? ELEVATION_TTL_MS) };
    return seal('elv', payload, secret);
}

/** Verify a cookie value; anything short of a valid, unexpired seal is `null`. */
export async function openElevation(value: string | null | undefined, secret: string, now: number = Date.now()): Promise<ElevationPayload | null> {
    const payload = await open<ElevationPayload>('elv', value, secret, now);
    if (!payload || typeof payload.userId !== 'string' || !payload.userId) return null;
    return payload;
}

/** `Set-Cookie` for a freshly sealed elevation value: `__Host-`, so `Secure; Path=/; HttpOnly`, no `Domain`. */
export function elevationCookie(value: string, ttlMs: number = ELEVATION_TTL_MS): string {
    return serializeCookie(ELEVATION_COOKIE, value, { maxAge: Math.floor(ttlMs / 1000) });
}

/** `Set-Cookie` that removes the elevation. */
export function clearElevationCookie(): string {
    return serializeCookie(ELEVATION_COOKIE, '', { maxAge: 0 });
}

/** The elevation carried by a request, or `null`. */
export function elevationFromRequest(request: Request, secret: string, now?: number): Promise<ElevationPayload | null> {
    return openElevation(readCookie(request.headers.get('cookie'), ELEVATION_COOKIE), secret, now);
}

/**
 * Refuse with 403 `elevation-required: …` unless the caller is a user whose elevation is live. Owner-only methods call it
 * after their `methodAuthorize` ran, so a non-user never reaches it; a user who is one is told what to do.
 */
export function requireElevated(principal: Principal | null | undefined, now: number = Date.now(), what = 'change this machine'): void {
    if (!isElevated(principal, now)) throw new ServerFnError(403, `${ELEVATION_REQUIRED}: confirm with your login provider to ${what}`);
}
