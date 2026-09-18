// @vitest-environment node
/**
 * `/auth/dev-login` (#35, #143): a preview / local-only door that exists
 * only while `AGENTIC_DEV_LOGIN` is set, mints a `dev_<user>` session for
 * the right token (JSON for the smokes, a form for a browser), and refuses
 * everything else without saying why. `GET` is the form; its secret field
 * is prefilled from `?token=` on localhost only.
 */
import { openSession } from '@agentic/platform';
import { createDevLoginRoute, DEV_LOGIN_MIN_SECRET, DEV_LOGIN_PATH, devLoginEnabled, devLoginRouteFor, devUserId, isLocalhost } from '../src/auth/dev-login';
import { currentSignInOptions, setSignInOptions } from '../src/auth/sign-in';

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

    it('refuses a wrong token (403), a malformed user (400), a bad body (400) and PUT (405)', async () => {
        const route = createDevLoginRoute({ SESSION_SECRET, AGENTIC_DEV_LOGIN: TOKEN })!;
        expect((await route(post({ token: `${TOKEN}x`, user: 'demo1' }))).status).toBe(403);
        expect((await route(post({ token: '', user: 'demo1' }))).status).toBe(403);
        expect((await route(post({ token: TOKEN, user: 'has:colon' }))).status).toBe(400);
        expect((await route(post({ token: TOKEN, user: '' }))).status).toBe(400);
        expect((await route(post({ user: 'demo1' }))).status).toBe(400);
        expect((await route(post('not json'))).status).toBe(400);
        const put = await route(new Request('https://app.test/auth/dev-login', { method: 'PUT' }));
        expect(put.status).toBe(405);
        expect(put.headers.get('set-cookie')).toBeNull();
    });
});

const form = (fields: Record<string, string>, origin = 'http://localhost:8787'): Request =>
    new Request(`${origin}${DEV_LOGIN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

describe('dev login form (#143)', () => {
    const route = createDevLoginRoute({ SESSION_SECRET, AGENTIC_DEV_LOGIN: TOKEN }, { now: () => NOW })!;

    it('GET renders the form, prefilled from ?token= on localhost only', async () => {
        for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
            const res = await route(new Request(`${origin}${DEV_LOGIN_PATH}?token=${encodeURIComponent(TOKEN)}&user=ada`));
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toMatch(/^text\/html/);
            expect(res.headers.get('cache-control')).toBe('no-store');
            const html = await res.text();
            expect(html).toContain(`<form method="post" action="${DEV_LOGIN_PATH}"`);
            expect(html).toContain(`name="token" type="password" value="${TOKEN}"`);
            expect(html).toContain('name="user" value="ada"');
        }
        // A deployed host: the secret never comes from the URL, whatever the query says.
        const remote = await route(new Request(`https://agentic-web-preview.workers.dev${DEV_LOGIN_PATH}?token=${encodeURIComponent(TOKEN)}`));
        expect(remote.status).toBe(200);
        const html = await remote.text();
        expect(html).toContain('name="token" type="password" value=""');
        expect(html).not.toContain(TOKEN);
        // No query at all: empty secret, the default user.
        const bare = await (await route(new Request(`http://localhost:8787${DEV_LOGIN_PATH}`))).text();
        expect(bare).toContain('name="token" type="password" value=""');
        expect(bare).toContain('name="user" value="dev"');
        // A malformed ?user= falls back to the default rather than echoing it.
        const odd = await (await route(new Request(`http://localhost:8787${DEV_LOGIN_PATH}?user=${encodeURIComponent('<script>')}`))).text();
        expect(odd).toContain('name="user" value="dev"');
        expect(odd).not.toContain('<script>');
    });

    it('isLocalhost names the loopback hosts only', () => {
        expect(isLocalhost(new URL('http://localhost:8787/x'))).toBe(true);
        expect(isLocalhost(new URL('http://127.0.0.1/x'))).toBe(true);
        expect(isLocalhost(new URL('http://[::1]:8787/x'))).toBe(true);
        expect(isLocalhost(new URL('https://localhost.evil.example/x'))).toBe(false);
        expect(isLocalhost(new URL('https://agentic.example/x'))).toBe(false);
    });

    it('a form POST with the right secret sets the cookie and lands on /', async () => {
        const res = await route(form({ token: TOKEN, user: 'ada' }));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/');
        const cookie = res.headers.get('set-cookie')!;
        expect(cookie).toMatch(/^__Host-session=/);
        const session = await openSession(cookie.split(';')[0]!.slice('__Host-session='.length), SESSION_SECRET, NOW);
        expect(session).toMatchObject({ userId: devUserId('ada'), workspaceId: 'dev_ada' });
    });

    it('a form POST with a wrong secret or user comes back to the form with the reason and no cookie', async () => {
        const wrong = await route(form({ token: `${TOKEN}x`, user: 'ada' }));
        expect(wrong.status).toBe(403);
        expect(wrong.headers.get('set-cookie')).toBeNull();
        const html = await wrong.text();
        expect(html).toContain('data-error');
        expect(html).toContain('name="user" value="ada"');
        expect(html).toContain('name="token" type="password" value=""');
        const bad = await route(form({ token: TOKEN, user: 'has:colon' }));
        expect(bad.status).toBe(400);
        expect(bad.headers.get('set-cookie')).toBeNull();
        expect(await bad.text()).toContain('role="alert"');
    });

    it('devLoginRouteFor mounts GET and POST on the path while the secret is set, nothing otherwise', () => {
        const env = { SESSION_SECRET, AGENTIC_DEV_LOGIN: TOKEN };
        expect(devLoginRouteFor(new Request(`http://localhost:8787${DEV_LOGIN_PATH}`), env)).toBeTypeOf('function');
        expect(devLoginRouteFor(new Request(`http://localhost:8787${DEV_LOGIN_PATH}`, { method: 'POST' }), env)).toBeTypeOf('function');
        expect(devLoginRouteFor(new Request(`http://localhost:8787${DEV_LOGIN_PATH}`, { method: 'DELETE' }), env)).toBeUndefined();
        expect(devLoginRouteFor(new Request('http://localhost:8787/auth/login'), env)).toBeUndefined();
        // Unset (production): not mounted — the path falls through to the app, a 404 like any unknown page.
        expect(devLoginRouteFor(new Request(`http://localhost:8787${DEV_LOGIN_PATH}`), { SESSION_SECRET })).toBeUndefined();
        expect(devLoginRouteFor(new Request(`http://localhost:8787${DEV_LOGIN_PATH}`), { SESSION_SECRET, AGENTIC_DEV_LOGIN: 'short' })).toBeUndefined();
        expect(devLoginRouteFor(new Request(`http://localhost:8787${DEV_LOGIN_PATH}`), {})).toBeUndefined();
    });

    it('the sign-in options the shell reads default to no door and follow what the Worker records', () => {
        expect(currentSignInOptions()).toEqual({ github: false, devLogin: false });
        setSignInOptions({ github: false, devLogin: true });
        expect(currentSignInOptions()).toEqual({ github: false, devLogin: true });
        setSignInOptions({ github: true, devLogin: false });
        expect(currentSignInOptions()).toEqual({ github: true, devLogin: false });
        setSignInOptions({ github: false, devLogin: false });
    });
});
