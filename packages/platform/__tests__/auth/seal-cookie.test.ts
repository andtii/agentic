// @vitest-environment node
import { clearSessionCookie, openSession, readCookie, seal, open, sealSession, serializeCookie, sessionCookie, sessionFromRequest, SESSION_COOKIE } from '../../src/index';
import { fromBase64Url, toBase64Url } from '../../src/auth/encoding';
import type { WorkspaceId } from '@agentic/core';

const SECRET = 'test-session-secret-that-is-long-enough';
const OTHER = 'another-secret-that-is-also-long-enough';
const NOW = 1_800_000_000_000;
const ws = 'ws_abc' as WorkspaceId;

describe('base64url', () => {
    it('round-trips every length mod 3 and accepts plain base64', () => {
        for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
            const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
            const text = toBase64Url(bytes);
            expect(text).not.toMatch(/[=+/]/);
            expect(Array.from(fromBase64Url(text)!)).toEqual(Array.from(bytes));
        }
        expect(Array.from(fromBase64Url('+/8=')!)).toEqual([0xfb, 0xff]);
        expect(fromBase64Url('a')).toBeNull();
        expect(fromBase64Url('ab$c')).toBeNull();
    });
});

describe('seal / open', () => {
    it('opens what it sealed and rejects a wrong kind, secret, or a tampered byte', async () => {
        const token = await seal('k1', { exp: NOW + 1000, x: 1 }, SECRET);
        expect(token.startsWith('k1.')).toBe(true);
        await expect(open('k1', token, SECRET, NOW)).resolves.toEqual({ exp: NOW + 1000, x: 1 });
        await expect(open('k2', token, SECRET, NOW)).resolves.toBeNull();
        await expect(open('k1', token, OTHER, NOW)).resolves.toBeNull();
        const [kind, payload, mac] = token.split('.') as [string, string, string];
        const flipped = `${kind}.${payload}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
        await expect(open('k1', flipped, SECRET, NOW)).resolves.toBeNull();
        await expect(open('k1', `${kind}.${payload}`, SECRET, NOW)).resolves.toBeNull();
        await expect(open('k1', '', SECRET, NOW)).resolves.toBeNull();
        await expect(open('k1', undefined, SECRET, NOW)).resolves.toBeNull();
    });

    it('treats expiry as no token', async () => {
        const token = await seal('k1', { exp: NOW + 1000 }, SECRET);
        await expect(open('k1', token, SECRET, NOW + 999)).resolves.not.toBeNull();
        await expect(open('k1', token, SECRET, NOW + 1000)).resolves.toBeNull();
    });

    it('refuses a short secret loudly — a forgeable session is a boot failure, not a default', async () => {
        await expect(seal('k1', { exp: NOW + 1 }, 'short')).rejects.toThrow(/at least 16/);
    });
});

describe('__Host-session cookie', () => {
    it('seals claims, serialises with the __Host- attributes, and opens from a request', async () => {
        const value = await sealSession({ userId: 'gh_1', workspaceId: ws }, SECRET, { now: NOW });
        const header = sessionCookie(value);
        expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=.+; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$`));
        const request = new Request('https://app.test/', { headers: { cookie: `other=1; ${header.split(';')[0]}` } });
        await expect(sessionFromRequest(request, SECRET, NOW + 1)).resolves.toMatchObject({ userId: 'gh_1', workspaceId: ws, iat: NOW, exp: NOW + 30 * 86_400_000 });
        await expect(sessionFromRequest(request, SECRET, NOW + 31 * 86_400_000)).resolves.toBeNull();
        await expect(sessionFromRequest(request, OTHER, NOW)).resolves.toBeNull();
        await expect(sessionFromRequest(new Request('https://app.test/'), SECRET, NOW)).resolves.toBeNull();
    });

    it('rejects a valid seal of the wrong shape', async () => {
        const token = await seal('ses', { exp: NOW + 1000, userId: '', workspaceId: ws, iat: NOW }, SECRET);
        await expect(openSession(token, SECRET, NOW)).resolves.toBeNull();
    });

    it('clears with Max-Age=0', () => {
        expect(clearSessionCookie()).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
        expect(serializeCookie('a', 'b c', { maxAge: 5.9, sameSite: 'Strict' })).toBe('a=b%20c; Path=/; Max-Age=5; HttpOnly; Secure; SameSite=Strict');
    });

    it('readCookie: exact name match, decoding, and null on half-encoded input', () => {
        expect(readCookie('a=1; __Host-session=x%20y; b=2', '__Host-session')).toBe('x y');
        expect(readCookie('x__Host-session=1', '__Host-session')).toBeNull();
        expect(readCookie('__Host-session=%E0%A4%A', '__Host-session')).toBeNull();
        expect(readCookie(null, 'a')).toBeNull();
    });
});
