// @vitest-environment node
import { createWebAuth, defaultResolveUser, userOf, type AuthEnv } from '../src/auth/index';
import { issuePairing, OAUTH_COOKIE, readCookie, sealSession, sessionCookie, verifyMachineToken, type AuthProvider, type PendingPairing } from '@agentic/platform';
import type { MachineId, WorkspaceId } from '@agentic/core';

const NOW = 1_800_000_000_000;
const env: AuthEnv = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sec', SESSION_SECRET: 'a-session-secret-of-at-least-32-characters!', APP_ORIGIN: 'https://app.test/' };

/** A provider that never talks to the network. */
const provider: AuthProvider = {
    id: 'github',
    pkce: true,
    authorizationUrl: ({ state, codeChallenge }) => `https://gh.test/authorize?state=${state}&cc=${codeChallenge}`,
    exchangeCode: async ({ code }) => {
        if (code !== 'good') throw new Error('bad code');
        return { provider: 'github', subject: '42', login: 'ada' };
    }
};

const setCookies = (response: Response): string[] => response.headers.getSetCookie();

describe('apps/web auth routes (stub for #23/#33)', () => {
    it('refuses to start without a real SESSION_SECRET', () => {
        expect(() => createWebAuth({ ...env, SESSION_SECRET: 'short' }, { resolveUser: defaultResolveUser })).toThrow(/SESSION_SECRET/);
    });

    it('login → 302 to the provider with the transient cookie; callback → session cookie + returnTo', async () => {
        const auth = createWebAuth(env, { resolveUser: defaultResolveUser, provider, now: () => NOW });
        const login = await auth.routes['GET /auth/login'](new Request('https://app.test/auth/login?returnTo=/machines'));
        expect(login.status).toBe(302);
        const location = new URL(login.headers.get('location')!);
        expect(location.origin).toBe('https://gh.test');
        const state = location.searchParams.get('state')!;
        const transient = setCookies(login).find((c) => c.startsWith(OAUTH_COOKIE))!;
        expect(transient).toMatch(/HttpOnly; Secure/);

        const callback = await auth.routes['GET /auth/callback'](new Request(`https://app.test/auth/callback?code=good&state=${state}`, { headers: { cookie: transient.split(';')[0]! } }));
        expect(callback.status).toBe(302);
        expect(callback.headers.get('location')).toBe('/machines');
        const cookies = setCookies(callback);
        const session = cookies.find((c) => c.startsWith('__Host-session='))!;
        expect(session).toMatch(/Max-Age=2592000/);
        expect(cookies.find((c) => c.startsWith(`${OAUTH_COOKIE}=`))).toMatch(/Max-Age=0/);

        const me = await auth.routes['GET /auth/me'](new Request('https://app.test/auth/me', { headers: { cookie: session.split(';')[0]! } }));
        expect(me.status).toBe(200);
        await expect(me.json()).resolves.toEqual({ principal: { kind: 'user', userId: 'gh_42', workspaceId: 'gh_42' } });
    });

    it('callback with a forged state is 400 and clears the transient; a failed exchange is 502', async () => {
        const auth = createWebAuth(env, { resolveUser: defaultResolveUser, provider, now: () => NOW });
        const login = await auth.routes['GET /auth/login'](new Request('https://app.test/auth/login'));
        const transient = setCookies(login)[0]!.split(';')[0]!;
        const forged = await auth.routes['GET /auth/callback'](new Request('https://app.test/auth/callback?code=good&state=nope', { headers: { cookie: transient } }));
        expect(forged.status).toBe(400);
        await expect(forged.json()).resolves.toEqual({ error: 'state_mismatch' });
        expect(setCookies(forged)[0]).toMatch(/Max-Age=0/);
        const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
        const failed = await auth.routes['GET /auth/callback'](new Request(`https://app.test/auth/callback?code=bad&state=${state}`, { headers: { cookie: transient } }));
        expect(failed.status).toBe(502);
    });

    it('me without a session is 401; logout clears the cookie', async () => {
        const auth = createWebAuth(env, { resolveUser: defaultResolveUser, provider });
        expect((await auth.routes['GET /auth/me'](new Request('https://app.test/auth/me'))).status).toBe(401);
        const out = await auth.routes['POST /auth/logout'](new Request('https://app.test/auth/logout', { method: 'POST' }));
        expect(out.status).toBe(302);
        expect(setCookies(out)[0]).toMatch(/^__Host-session=; Path=\/; Max-Age=0/);
    });

    it('serverApp.authenticate resolves the same cookie the callback set', async () => {
        const auth = createWebAuth(env, { resolveUser: defaultResolveUser, provider, now: () => NOW });
        const cookie = sessionCookie(await sealSession({ userId: 'gh_42', workspaceId: 'gh_42' as WorkspaceId }, env.SESSION_SECRET, { now: NOW })).split(';')[0]!;
        const principal = await auth.serverApp.authenticate({ request: new Request('https://app.test/', { headers: { cookie } }) });
        expect(userOf(principal)?.userId).toBe('gh_42');
        expect(userOf(null)).toBeNull();
    });

    it('pair: a live code once → machine token whose hash the wiring stored; then used/mismatch → 401', async () => {
        const machineId = 'machine_1' as MachineId;
        const workspaceId = 'gh_42' as WorkspaceId;
        const issued = await issuePairing({ machineId, now: NOW });
        let pending: PendingPairing = issued.pending;
        const stored: { tokenHash?: string; name?: string } = {};
        const auth = createWebAuth(env, {
            resolveUser: defaultResolveUser,
            provider,
            now: () => NOW + 1000,
            pairing: {
                find: async (code) => (readCookie(null, 'x') === null && code.length ? { workspaceId, pending } : null),
                redeem: async (input) => {
                    pending = input.pending;
                    stored.tokenHash = input.tokenHash;
                    stored.name = input.name;
                }
            }
        });
        const post = (body: unknown) => auth.routes['POST /auth/pair'](new Request('https://app.test/auth/pair', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
        const ok = await post({ code: issued.code.toLowerCase(), name: ' laptop ' });
        expect(ok.status).toBe(200);
        const result = (await ok.json()) as { token: string; workspaceId: string; machineId: string };
        expect(result).toMatchObject({ workspaceId, machineId });
        expect(stored.name).toBe('laptop');
        await expect(verifyMachineToken(result.token, { tokenHash: stored.tokenHash! })).resolves.toMatchObject({ ok: true });
        expect(pending.consumedAt).toBe(NOW + 1000);

        const again = await post({ code: issued.code, name: 'laptop' });
        expect(again.status).toBe(401);
        await expect(again.json()).resolves.toEqual({ error: 'used' });
        expect((await post({ code: 'ZZZZZZ', name: 'x' })).status).toBe(401);
        expect((await post({ name: 'x' })).status).toBe(400);
        expect((await auth.routes['POST /auth/pair'](new Request('https://app.test/auth/pair', { method: 'POST', body: '{' }))).status).toBe(400);
        const unwired = createWebAuth(env, { resolveUser: defaultResolveUser, provider });
        expect((await unwired.routes['POST /auth/pair'](new Request('https://app.test/auth/pair', { method: 'POST', body: '{}' }))).status).toBe(503);
    });
});
