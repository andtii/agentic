// @vitest-environment node
/**
 * `POST /auth/dev-login` (#35): a preview-only door that exists only while
 * `AGENTIC_DEV_LOGIN` is set, mints a `dev_<user>` session for the right
 * token, and refuses everything else without saying why.
 */
import { openSession } from '@agentic/platform';
import { createDevLoginRoute, DEV_LOGIN_MIN_SECRET, devLoginEnabled, devUserId } from '../src/auth/dev-login';

const SESSION_SECRET = 'a-session-secret-of-at-least-32-characters!';
const TOKEN = 'preview-walkthrough-token-0123456789';
const NOW = 1_800_000_000_000;

const post = (body: unknown, init: RequestInit = {}): Request =>
    new Request('https://app.test/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init });

describe('dev login', () => {
    it('is not mounted without the secret, with a short secret, or without a signing secret', () => {
        expect(createDevLoginRoute({ SESSION_SECRET })).toBeNull();
        expect(createDevLoginRoute({ SESSION_SECRET, AGENTIC_DEV_LOGIN: 'x'.repeat(DEV_LOGIN_MIN_SECRET - 1) })).toBeNull();
        expect(createDevLoginRoute({ AGENTIC_DEV_LOGIN: TOKEN })).toBeNull();
        expect(createDevLoginRoute({ SESSION_SECRET: 'short', AGENTIC_DEV_LOGIN: TOKEN })).toBeNull();
        expect(devLoginEnabled({ SESSION_SECRET, AGENTIC_DEV_LOGIN: TOKEN })).toBe(true);
    });

    it('mints a dev_<user> session cookie for the right token', async () => {
        const route = createDevLoginRoute({ SESSION_SECRET, AGENTIC_DEV_LOGIN: TOKEN }, { now: () => NOW })!;
        const res = await route(post({ token: TOKEN, user: 'demo1' }));
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ principal: { kind: 'user', userId: 'dev_demo1', workspaceId: 'dev_demo1' } });
        const cookie = res.headers.get('set-cookie')!;
        expect(cookie).toMatch(/^__Host-session=/);
        expect(cookie).toMatch(/HttpOnly; Secure/);
        const session = await openSession(cookie.split(';')[0]!.slice('__Host-session='.length), SESSION_SECRET, NOW);
        expect(session).toMatchObject({ userId: devUserId('demo1'), workspaceId: 'dev_demo1' });
    });

    it('refuses a wrong token (403), a malformed user (400), a bad body (400) and GET (405)', async () => {
        const route = createDevLoginRoute({ SESSION_SECRET, AGENTIC_DEV_LOGIN: TOKEN })!;
        expect((await route(post({ token: `${TOKEN}x`, user: 'demo1' }))).status).toBe(403);
        expect((await route(post({ token: '', user: 'demo1' }))).status).toBe(403);
        expect((await route(post({ token: TOKEN, user: 'has:colon' }))).status).toBe(400);
        expect((await route(post({ token: TOKEN, user: '' }))).status).toBe(400);
        expect((await route(post({ user: 'demo1' }))).status).toBe(400);
        expect((await route(post('not json'))).status).toBe(400);
        const get = await route(new Request('https://app.test/auth/dev-login'));
        expect(get.status).toBe(405);
        expect(get.headers.get('set-cookie')).toBeNull();
    });
});
