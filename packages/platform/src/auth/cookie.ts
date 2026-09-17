/**
 * The `__Host-session` cookie (architecture §9): a sealed
 * `{ userId, workspaceId }` that `authenticate` turns into the user
 * principal. `__Host-` pins the cookie to this origin — `Secure`, `Path=/`,
 * no `Domain` — so a sibling subdomain can neither read nor plant one.
 *
 * Only cookie mechanics live here; who the user IS is the OAuth flow's job.
 */
import type { WorkspaceId } from '@agentic/core';
import { open, seal, type SealedPayload } from './seal.js';

export const SESSION_COOKIE = '__Host-session';
/** Sessions last 30 days; each successful login mints a fresh one. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionPayload extends SealedPayload {
    readonly userId: string;
    readonly workspaceId: WorkspaceId;
    /** Issued at, epoch ms. */
    readonly iat: number;
}

export interface SessionClaims {
    readonly userId: string;
    readonly workspaceId: WorkspaceId;
}

export interface SessionOptions {
    /** Epoch ms; defaults to `Date.now()`. */
    now?: number;
    ttlMs?: number;
}

/** The sealed cookie VALUE for a signed-in user. */
export function sealSession(claims: SessionClaims, secret: string, options: SessionOptions = {}): Promise<string> {
    const now = options.now ?? Date.now();
    const payload: SessionPayload = { userId: claims.userId, workspaceId: claims.workspaceId, iat: now, exp: now + (options.ttlMs ?? SESSION_TTL_MS) };
    return seal('ses', payload, secret);
}

/** Verify a cookie value; anything short of a valid, unexpired seal is `null`. */
export async function openSession(value: string | null | undefined, secret: string, now: number = Date.now()): Promise<SessionPayload | null> {
    const payload = await open<SessionPayload>('ses', value, secret, now);
    if (!payload || typeof payload.userId !== 'string' || typeof payload.workspaceId !== 'string' || !payload.userId || !payload.workspaceId) return null;
    return payload;
}

/** The value of cookie `name` in a `Cookie` request header, or `null`. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        const raw = part.slice(eq + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            // Half-encoded input is NO cookie, never a 500.
            return null;
        }
    }
    return null;
}

export interface CookieAttributes {
    /** Seconds; `0` expires the cookie immediately. */
    maxAge: number;
    sameSite?: 'Lax' | 'Strict';
}

/**
 * A `Set-Cookie` header value. `__Host-` cookies are always
 * `Secure; Path=/; HttpOnly` — the prefix demands the first two, and no auth
 * cookie here is ever read by scripts.
 */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(attributes.maxAge))}; HttpOnly; Secure; SameSite=${attributes.sameSite ?? 'Lax'}`;
}

/** `Set-Cookie` for a freshly sealed session value. */
export function sessionCookie(value: string, ttlMs: number = SESSION_TTL_MS): string {
    return serializeCookie(SESSION_COOKIE, value, { maxAge: Math.floor(ttlMs / 1000) });
}

/** `Set-Cookie` that removes the session. */
export function clearSessionCookie(): string {
    return serializeCookie(SESSION_COOKIE, '', { maxAge: 0 });
}

/** The session carried by a request, or `null`. */
export function sessionFromRequest(request: Request, secret: string, now?: number): Promise<SessionPayload | null> {
    return openSession(readCookie(request.headers.get('cookie'), SESSION_COOKIE), secret, now);
}
