// @vitest-environment node
/**
 * The viewer's provider login (#893): the OAuth callback mints `__Host-login` beside the session, bound to its user;
 * `viewerLogin` answers only for that user; logout clears it; Home's pull needs read it as `me`, so a review
 * requested of the viewer is theirs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { OAUTH_COOKIE, type AuthProvider } from '@agentic/platform';
import type { PullRequest } from '@agentic/core';
import { createWebAuth, defaultResolveUser, type AuthEnv } from '../src/auth/index';
import { LOGIN_COOKIE, loginCookie, loginFromRequest, setLoginSecret, viewerLogin } from '../src/auth/viewer-login';
import { createWorkspacePulls, livePullNeeds } from '../src/pages/projects/work/pull/LivePulls';
import { pullsNeedingYou } from '../src/pages/inbox/NeedsYou';
import { clientDefs } from '../src/actors/client';

const NOW = 1_800_000_000_000;
const SECRET = 'a-session-secret-of-at-least-32-characters!';
const env: AuthEnv = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sec', SESSION_SECRET: SECRET, APP_ORIGIN: 'https://app.test/' };

const providerWith = (login?: string): AuthProvider => ({
    id: 'github',
    pkce: true,
    authorizationUrl: ({ state, codeChallenge }) => `https://gh.test/authorize?state=${state}&cc=${codeChallenge}`,
    exchangeCode: async () => ({ provider: 'github', subject: '42', ...(login ? { login } : {}) })
});

async function signIn(login?: string): Promise<string[]> {
    const auth = createWebAuth(env, { resolveUser: defaultResolveUser, provider: providerWith(login), now: () => NOW });
    const begin = await auth.routes['GET /auth/login']!(new Request('https://app.test/auth/login'));
    const state = new URL(begin.headers.get('location')!).searchParams.get('state')!;
    const transient = begin.headers.getSetCookie().find((c) => c.startsWith(OAUTH_COOKIE))!.split(';')[0]!;
    const callback = await auth.routes['GET /auth/callback']!(new Request(`https://app.test/auth/callback?code=good&state=${state}`, { headers: { cookie: transient } }));
    expect(callback.status).toBe(302);
    return callback.headers.getSetCookie();
}

const withCookie = (cookie: string): Request => new Request('https://app.test/', { headers: { cookie: cookie.split(';')[0]! } });

afterEach(() => setLoginSecret(''));

describe('the viewer login cookie (#893)', () => {
    it('the callback mints __Host-login for the session user; it opens only for that user', async () => {
        const cookies = await signIn('ada');
        const login = cookies.find((c) => c.startsWith(`${LOGIN_COOKIE}=`))!;
        expect(login).toMatch(/Max-Age=2592000; HttpOnly; Secure/);
        expect(await loginFromRequest(withCookie(login), 'gh_42', SECRET, NOW)).toBe('ada');
        // Bound to its user: another session's user gets nothing from it.
        expect(await loginFromRequest(withCookie(login), 'gh_7', SECRET, NOW)).toBeUndefined();
        // Another secret, or none at all: nothing.
        expect(await loginFromRequest(withCookie(login), 'gh_42', 'another-secret-of-at-least-32-characters', NOW)).toBeUndefined();
        expect(await loginFromRequest(new Request('https://app.test/'), 'gh_42', SECRET, NOW)).toBeUndefined();
    });

    it('an identity without a login clears any stale cookie; logout clears it too', async () => {
        const cookies = await signIn();
        expect(cookies.find((c) => c.startsWith(`${LOGIN_COOKIE}=`))).toMatch(/^__Host-login=; Path=\/; Max-Age=0/);
        const auth = createWebAuth(env, { resolveUser: defaultResolveUser, provider: providerWith('ada') });
        const out = await auth.routes['POST /auth/logout'](new Request('https://app.test/auth/logout', { method: 'POST' }));
        expect(out.headers.getSetCookie().find((c) => c.startsWith(`${LOGIN_COOKIE}=`))).toMatch(/Max-Age=0/);
    });

    it('viewerLogin reads with the recorded secret, and answers nothing before one is recorded', async () => {
        const cookie = await loginCookie({ userId: 'gh_42', login: 'ada' }, SECRET);
        expect(await viewerLogin(withCookie(cookie), 'gh_42')).toBeUndefined();
        setLoginSecret(SECRET);
        expect(await viewerLogin(withCookie(cookie), 'gh_42')).toBe('ada');
    });
});

describe('Home pull needs take the viewer login as me (#893)', () => {
    const requested: PullRequest = {
        provider: 'github', repo: 'andtii/agentic', number: 9, title: 'review me', url: 'https://github.com/andtii/agentic/pull/9',
        head: 'x', base: 'main', state: 'open', additions: 1, deletions: 1, files: 1, openedBy: 'forge', openedAt: 1,
        checks: [{ name: 'test', state: 'running' }], review: { state: 'requested', reviewers: ['ada'], threads: [] }
    };

    it('a review requested of the viewer joins once the login arrives', () => {
        const feed = createWorkspacePulls();
        feed.put('p1', [requested]);
        let login: string | null = null;
        const needs = livePullNeeds(feed, clientDefs(), () => 'ws', () => login);
        expect(needs.me).toBeUndefined();
        expect(pullsNeedingYou(needs.usePulls()(), needs.me)).toEqual([]);
        login = 'ada';
        expect(needs.me).toBe('ada');
        expect(pullsNeedingYou(needs.usePulls()(), needs.me).map((p) => p.number)).toEqual([9]);
        login = 'grace';
        expect(pullsNeedingYou(needs.usePulls()(), needs.me)).toEqual([]);
    });
});
