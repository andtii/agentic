/**
 * The `__Host-session` cookie (architecture §9): a sealed
 * `{ userId, workspaceId }` that `authenticate` turns into the user
 * principal. `__Host-` pins the cookie to this origin — `Secure`, `Path=/`,
 * no `Domain` — so a sibling subdomain can neither read nor plant one.
 *
 * Only cookie mechanics live here; who the user IS is the OAuth flow's job.
 * On a plain-http host the same cookies travel as `agentic-*` (the cookie
 * prefix seam below, #989).
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
 * cookie here is ever read by scripts. A plain-prefixed cookie
 * (`agentic-…`, see "Cookie prefix" below) carries no `Secure` — a browser
 * drops a `Secure` cookie set over plain http — and is always `SameSite=Lax`.
 */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
    const secure = !name.startsWith(PLAIN_COOKIE_PREFIX);
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(attributes.maxAge))}; HttpOnly${secure ? '; Secure' : ''}; SameSite=${secure ? (attributes.sameSite ?? 'Lax') : 'Lax'}`;
}

/*
 * Cookie prefix (#989). Every auth cookie is named `__Host-<base>` — what
 * Cloudflare serves, always over https. A `__Host-` cookie must be `Secure`,
 * which a browser accepts only on https (and on localhost), so a self-hosted
 * node reached over plain http (`http://<lan-ip>:8787`) could never sign in.
 * On such a request the host renames them at its edge: inbound
 * `agentic-<base>` reads as `__Host-<base>` (`plainCookieRequest`), outbound
 * `__Host-<base>` is set as `agentic-<base>`, not `Secure`, `SameSite=Lax`
 * (`plainCookieResponse`). Everything between — the routes, `authenticate`,
 * the names above — keeps the one `__Host-` spelling, and a host that never
 * calls these (Cloudflare) sets exactly what it always did.
 */

export const SECURE_COOKIE_PREFIX = '__Host-';
/** The prefix auth cookies carry on a plain-http request. */
export const PLAIN_COOKIE_PREFIX = 'agentic-';
export type CookiePrefix = typeof SECURE_COOKIE_PREFIX | typeof PLAIN_COOKIE_PREFIX;

/**
 * Whether the browser reached us over https: the request's own scheme, or the
 * first `X-Forwarded-Proto` a TLS-terminating proxy (`tailscale serve`) adds.
 * A client that lies about the header only earns itself a `Secure` cookie its
 * browser will not keep over http — never a weaker cookie.
 */
export function isSecureRequest(request: Request): boolean {
    if (new URL(request.url).protocol === 'https:') return true;
    const forwarded = request.headers.get('x-forwarded-proto');
    return !!forwarded && forwarded.split(',')[0]!.trim().toLowerCase() === 'https';
}

/** The prefix a request's auth cookies carry. */
export function cookiePrefixFor(request: Request): CookiePrefix {
    return isSecureRequest(request) ? SECURE_COOKIE_PREFIX : PLAIN_COOKIE_PREFIX;
}

/**
 * A `Cookie` header as the routes expect it on a plain-http request:
 * `agentic-<base>` renamed `__Host-<base>`, and any real `__Host-` cookie
 * dropped, so exactly one spelling is ever read. Other cookies pass through.
 */
export function plainCookieHeader(cookieHeader: string | null | undefined): string {
    if (!cookieHeader) return '';
    const out: string[] = [];
    for (const part of cookieHeader.split(';')) {
        const pair = part.trim();
        if (!pair || pair.startsWith(SECURE_COOKIE_PREFIX)) continue;
        out.push(pair.startsWith(PLAIN_COOKIE_PREFIX) ? SECURE_COOKIE_PREFIX + pair.slice(PLAIN_COOKIE_PREFIX.length) : pair);
    }
    return out.join('; ');
}

/** `request` with its `Cookie` header rewritten by `plainCookieHeader` — the same request when nothing changes. */
export function plainCookieRequest(request: Request): Request {
    const header = request.headers.get('cookie');
    if (!header) return request;
    const rewritten = plainCookieHeader(header);
    if (rewritten === header) return request;
    const headers = new Headers(request.headers);
    if (rewritten) headers.set('cookie', rewritten);
    else headers.delete('cookie');
    // `new Request(request, init)` keeps method, body, signal and the rest; a streamed body needs `duplex`.
    return new Request(request, { headers, duplex: 'half' } as RequestInit);
}

/**
 * A `Set-Cookie` value for a plain-http response: a `__Host-<base>` cookie
 * becomes `agentic-<base>` without `Secure`, with `SameSite=Lax`; any other
 * cookie is returned as is.
 */
export function plainSetCookie(setCookie: string): string {
    if (!setCookie.startsWith(SECURE_COOKIE_PREFIX)) return setCookie;
    const [pair, ...attributes] = setCookie.split(';').map((a) => a.trim());
    const kept = attributes.filter((a) => {
        const key = a.split('=')[0]!.trim().toLowerCase();
        return a && key !== 'secure' && key !== 'samesite';
    });
    return [PLAIN_COOKIE_PREFIX + pair!.slice(SECURE_COOKIE_PREFIX.length), ...kept, 'SameSite=Lax'].join('; ');
}

/** `response` with every `Set-Cookie` rewritten by `plainSetCookie` — the same response when it sets no `__Host-` cookie. */
export function plainCookieResponse(response: Response): Response {
    const cookies = response.headers.getSetCookie();
    if (!cookies.some((c) => c.startsWith(SECURE_COOKIE_PREFIX))) return response;
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    for (const c of cookies) headers.append('set-cookie', plainSetCookie(c));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
