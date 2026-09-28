// @vitest-environment node
/** The cookie-prefix seam (#989): `__Host-` stays what Cloudflare sets; plain http travels as `agentic-`. */
import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@agentic/core';
import {
    authenticateRequest,
    clearSessionCookie,
    cookiePrefixFor,
    ELEVATION_COOKIE,
    elevationCookie,
    isSecureRequest,
    OAUTH_COOKIE,
    plainCookieHeader,
    plainCookieRequest,
    plainCookieResponse,
    plainSetCookie,
    sealSession,
    serializeCookie,
    SESSION_COOKIE,
    sessionCookie
} from '../../src/index';

const SECRET = 'test-session-secret-that-is-long-enough';

describe('Cloudflare cookie names', () => {
    it('are unchanged: __Host-, Secure, Path=/, HttpOnly', () => {
        expect(SESSION_COOKIE).toBe('__Host-session');
        expect(ELEVATION_COOKIE).toBe('__Host-elevated');
        expect(OAUTH_COOKIE).toBe('__Host-oauth');
        expect(sessionCookie('v', 60_000)).toBe('__Host-session=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
        expect(elevationCookie('v', 60_000)).toBe('__Host-elevated=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
        expect(clearSessionCookie()).toBe('__Host-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
        expect(serializeCookie('__Host-x', 'v', { maxAge: 1, sameSite: 'Strict' })).toContain('; Secure; SameSite=Strict');
    });
});

describe('isSecureRequest', () => {
    it('is the scheme, or the first X-Forwarded-Proto', () => {
        expect(isSecureRequest(new Request('https://agentic.example/'))).toBe(true);
        expect(isSecureRequest(new Request('http://192.168.1.5:8787/'))).toBe(false);
        expect(isSecureRequest(new Request('http://localhost:8787/', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
        expect(isSecureRequest(new Request('http://localhost:8787/', { headers: { 'x-forwarded-proto': 'HTTPS, http' } }))).toBe(true);
        expect(isSecureRequest(new Request('http://localhost:8787/', { headers: { 'x-forwarded-proto': 'http' } }))).toBe(false);
        expect(cookiePrefixFor(new Request('https://a.example/'))).toBe('__Host-');
        expect(cookiePrefixFor(new Request('http://a.example/'))).toBe('agentic-');
    });
});

describe('plain-http cookies', () => {
    it('sets agentic-<base> without Secure, SameSite=Lax', () => {
        expect(plainSetCookie('__Host-session=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Strict')).toBe('agentic-session=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
        expect(plainSetCookie('other=v; Path=/; Secure')).toBe('other=v; Path=/; Secure');
        expect(serializeCookie('agentic-session', 'v', { maxAge: 1, sameSite: 'Strict' })).toBe('agentic-session=v; Path=/; Max-Age=1; HttpOnly; SameSite=Lax');
    });

    it('reads agentic-<base> as __Host-<base>, and drops a real __Host- cookie', () => {
        expect(plainCookieHeader('a=1; agentic-session=s; __Host-session=forged; agentic-elevated=e')).toBe('a=1; __Host-session=s; __Host-elevated=e');
        expect(plainCookieHeader(null)).toBe('');
        const same = new Request('http://x/', { headers: { cookie: 'a=1' } });
        expect(plainCookieRequest(same)).toBe(same);
        expect(plainCookieRequest(new Request('http://x/', { headers: { cookie: '__Host-session=x' } })).headers.get('cookie')).toBeNull();
    });

    it('keeps the method and body of a rewritten request', async () => {
        const request = plainCookieRequest(new Request('http://x/p', { method: 'POST', body: 'hi', headers: { cookie: 'agentic-session=s' } }));
        expect(request.method).toBe('POST');
        expect(await request.text()).toBe('hi');
        expect(request.headers.get('cookie')).toBe('__Host-session=s');
    });

    it('rewrites every __Host- Set-Cookie on a response and keeps the rest', async () => {
        const headers = new Headers({ location: '/' });
        headers.append('set-cookie', sessionCookie('s', 60_000));
        headers.append('set-cookie', 'other=1; Path=/');
        const out = plainCookieResponse(new Response('body', { status: 303, headers }));
        expect(out.status).toBe(303);
        expect(out.headers.get('location')).toBe('/');
        expect(out.headers.getSetCookie()).toEqual(['agentic-session=s; Path=/; Max-Age=60; HttpOnly; SameSite=Lax', 'other=1; Path=/']);
        expect(await out.text()).toBe('body');
        const untouched = new Response('x');
        expect(plainCookieResponse(untouched)).toBe(untouched);
    });

    it('round-trips a session over plain http through authenticate', async () => {
        const value = await sealSession({ userId: 'local_owner', workspaceId: 'local_owner' as WorkspaceId }, SECRET);
        const set = plainSetCookie(sessionCookie(value));
        const cookie = set.split(';')[0]!;
        expect(cookie.startsWith('agentic-session=')).toBe(true);
        const request = plainCookieRequest(new Request('http://192.168.1.5:8787/auth/me', { headers: { cookie } }));
        expect(await authenticateRequest(request, { sessionSecret: SECRET })).toEqual({ kind: 'user', userId: 'local_owner', workspaceId: 'local_owner' });
        // Without the rename, the plain cookie is nobody.
        expect(await authenticateRequest(new Request('http://192.168.1.5:8787/', { headers: { cookie } }), { sessionSecret: SECRET })).toBeNull();
    });
});
