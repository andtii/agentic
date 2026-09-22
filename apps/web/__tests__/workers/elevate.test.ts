/**
 * Elevation on the deployed Worker (#355): the dev login's `elevate` mints `__Host-elevated` beside the session, and
 * `/auth/me` then reports `elevatedUntil` on the principal — for that user's session only. The GitHub round trip itself
 * is pinned by `apps/web/__tests__/auth.test.ts` over a stubbed provider; the workers pool has no OAuth app, so
 * `/auth/elevate` is not mounted here (404 like `/auth/login`, #180).
 */
import { SELF } from 'cloudflare:test';
import { ELEVATION_COOKIE, ELEVATION_TTL_MS } from '@agentic/platform';
import { DEV_LOGIN_PATH } from '../../src/auth/dev-login';
import { signIn } from './http';
import { TEST_DEV_LOGIN } from './secret';

const ORIGIN = 'https://agentic.test';

const devLogin = (body: Record<string, unknown>) => SELF.fetch(`${ORIGIN}${DEV_LOGIN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TEST_DEV_LOGIN, ...body }) });
const cookieOf = (response: Response, name: string): string | undefined => response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0];

describe('worker: elevation (#355)', () => {
    it('dev login with elevate mints the elevation cookie beside the session; /auth/me reports elevatedUntil for that user only', async () => {
        const plain = await devLogin({ user: 'elev_plain' });
        expect(plain.status).toBe(200);
        expect(cookieOf(plain, '__Host-session')).toBeDefined();
        expect(cookieOf(plain, ELEVATION_COOKIE)).toBeUndefined();

        const before = Date.now();
        const elevated = await devLogin({ user: 'elev_owner', elevate: true });
        expect(elevated.status).toBe(200);
        const session = cookieOf(elevated, '__Host-session')!;
        const elevation = cookieOf(elevated, ELEVATION_COOKIE)!;
        expect(elevated.headers.getSetCookie().find((c) => c.startsWith(`${ELEVATION_COOKIE}=`))).toMatch(/Max-Age=600; HttpOnly; Secure/);

        const me = await SELF.fetch(`${ORIGIN}/auth/me`, { headers: { cookie: `${session}; ${elevation}` } });
        const { principal } = (await me.json()) as { principal: { kind: string; userId: string; elevatedUntil?: number } };
        expect(principal).toMatchObject({ kind: 'user', userId: 'dev_elev_owner' });
        expect(principal.elevatedUntil).toBeGreaterThanOrEqual(before + ELEVATION_TTL_MS);
        expect(principal.elevatedUntil).toBeLessThanOrEqual(Date.now() + ELEVATION_TTL_MS);

        // The session alone is not elevated; another user's session with this elevation is not either.
        const alone = (await (await SELF.fetch(`${ORIGIN}/auth/me`, { headers: { cookie: session } })).json()) as { principal: Record<string, unknown> };
        expect(alone.principal.elevatedUntil).toBeUndefined();
        const other = await signIn('dev_elev_other');
        const lent = (await (await SELF.fetch(`${ORIGIN}/auth/me`, { headers: { cookie: `${other}; ${elevation}` } })).json()) as { principal: Record<string, unknown> };
        expect(lent.principal).toMatchObject({ userId: 'dev_elev_other' });
        expect(lent.principal.elevatedUntil).toBeUndefined();
    });

    it('the form offers elevation; without an OAuth app /auth/elevate is not mounted', async () => {
        const form = await SELF.fetch(`${ORIGIN}${DEV_LOGIN_PATH}?elevate=1`);
        expect(await form.text()).toMatch(/name="elevate" type="checkbox" value="1" checked/);
        expect((await SELF.fetch(`${ORIGIN}/auth/elevate`, { redirect: 'manual' })).status).toBe(404);
    });
});
