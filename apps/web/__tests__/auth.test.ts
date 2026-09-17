// @vitest-environment node
import { createWebAuth, defaultResolveUser, userOf, type AuthEnv } from '../src/auth/index';
import { issueMachineToken, OAUTH_COOKIE, sealSession, sessionCookie, type AuthProvider } from '@agentic/platform';
import { ServerFnError } from '@sigx/server';
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

    it('pair: a live code resolves once to its machine, which redeems it → token; then used/mismatch/malformed → refused', async () => {
        const machineId = 'machine_1' as MachineId;
        const workspaceId = 'gh_42' as WorkspaceId;
        const CODE = 'ABC234';
        // A directory with one live code, and a machine that pairs once (the shapes `pairingWiring` binds to the actors).
        const codes = new Map([[CODE, { workspaceId, machineId }]]);
        const paired: { code?: string; name?: string; target?: unknown } = {};
        const auth = createWebAuth(env, {
            resolveUser: defaultResolveUser,
            provider,
            now: () => NOW + 1000,
            pairing: {
                resolve: async (code) => {
                    const target = codes.get(code) ?? null;
                    codes.delete(code);
                    return target;
                },
                pair: async (target, code, info) => {
                    if (paired.code) throw new ServerFnError(409, 'already paired');
                    paired.code = code;
                    paired.name = info.name;
                    paired.target = target;
                    const issued = await issueMachineToken(target);
                    return { token: issued.token, workspaceId: target.workspaceId, machineId: target.machineId };
                }
            }
        });
        const post = (body: unknown) => auth.routes['POST /auth/pair'](new Request('https://app.test/auth/pair', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
        const ok = await post({ code: 'abc-234', name: ' laptop ' });
        expect(ok.status).toBe(200);
        const result = (await ok.json()) as { token: string; workspaceId: string; machineId: string };
        expect(result).toMatchObject({ workspaceId, machineId });
        expect(result.token).toMatch(/^amt\./);
        expect(paired).toEqual({ code: CODE, name: 'laptop', target: { workspaceId, machineId } });

        // The directory is single use: the same code is a mismatch now.
        const again = await post({ code: CODE, name: 'laptop' });
        expect(again.status).toBe(401);
        await expect(again.json()).resolves.toEqual({ error: 'mismatch' });
        // A machine that refuses (already paired) answers with the refusal, not a token.
        codes.set(CODE, { workspaceId, machineId });
        const refused = await post({ code: CODE, name: 'laptop' });
        expect(refused.status).toBe(409);
        await expect(refused.json()).resolves.toEqual({ error: 'used' });

        expect((await post({ code: 'ZZ', name: 'x' })).status).toBe(401);
        await expect((await post({ code: 'ZZ', name: 'x' })).json()).resolves.toEqual({ error: 'malformed' });
        expect((await post({ name: 'x' })).status).toBe(400);
        expect((await auth.routes['POST /auth/pair'](new Request('https://app.test/auth/pair', { method: 'POST', body: '{' }))).status).toBe(400);
        const unwired = createWebAuth(env, { resolveUser: defaultResolveUser, provider });
        expect((await unwired.routes['POST /auth/pair'](new Request('https://app.test/auth/pair', { method: 'POST', body: '{}' }))).status).toBe(503);
    });
});
