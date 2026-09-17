/**
 * `POST /auth/dev-login` — a PREVIEW-ONLY door for scripted walk-throughs
 * (#35, `smoke:demo1`): GitHub OAuth cannot run headless, so a deployment
 * that sets the `AGENTIC_DEV_LOGIN` secret lets a caller who presents it
 * mint a user session for a dev identity. The route is not mounted at all
 * when the secret is unset (404 like any unknown path), so production —
 * which never sets it — has no such door; a wrong token is 403 and never
 * says which part was wrong.
 *
 * The identity is `dev_<user>`: its own namespace, so a dev workspace can
 * never collide with a GitHub user's (`gh_<id>`, `defaultResolveUser`).
 */
import type { WorkspaceId } from '@agentic/core';
import { sealSession, sessionCookie } from '@agentic/platform';
import type { RouteHandler } from './index';

export const DEV_LOGIN_PATH = '/auth/dev-login';

/** Anything shorter reads as unset — a one-character "secret" must not open the door. */
export const DEV_LOGIN_MIN_SECRET = 16;

/** The `user` part: letters, digits, `_` and `-`; 1–64 chars; colon-free so every actor key parses. */
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Both present and long enough — what `devLoginEnabled` proves about a partial env. */
export interface DevLoginEnv {
    readonly SESSION_SECRET: string;
    readonly AGENTIC_DEV_LOGIN: string;
}

export interface DevLoginBody {
    readonly token: string;
    readonly user: string;
}

/** The identity a dev login mints for `user`. */
export const devUserId = (user: string): string => `dev_${user}`;

/** Byte-wise constant-time equality of two strings (lengths differ → false, after a full pass). */
function sameSecret(a: string, b: string): boolean {
    const x = new TextEncoder().encode(a);
    const y = new TextEncoder().encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i % x.length] ?? 0) ^ (y[i % y.length] ?? 0);
    return diff === 0;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

/** Whether `env` enables the route: the secret is set and long enough, and sessions can be signed. */
export function devLoginEnabled(env: Partial<DevLoginEnv>): env is DevLoginEnv {
    return typeof env.AGENTIC_DEV_LOGIN === 'string' && env.AGENTIC_DEV_LOGIN.length >= DEV_LOGIN_MIN_SECRET && typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= 32;
}

/**
 * The handler, or `null` when the door is closed — the caller then mounts
 * nothing, so the path falls through to whatever else serves it.
 */
export function createDevLoginRoute(env: Partial<DevLoginEnv>, options: { now?: () => number } = {}): RouteHandler | null {
    if (!devLoginEnabled(env)) return null;
    const secret = env.AGENTIC_DEV_LOGIN;
    const now = options.now ?? Date.now;
    return async (request) => {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
        let body: Partial<DevLoginBody>;
        try {
            body = (await request.json()) as Partial<DevLoginBody>;
        } catch {
            return json({ error: 'bad_request' }, 400);
        }
        if (typeof body.token !== 'string' || typeof body.user !== 'string') return json({ error: 'bad_request' }, 400);
        if (!sameSecret(body.token, secret)) return json({ error: 'forbidden' }, 403);
        if (!USER_RE.test(body.user)) return json({ error: 'bad_user' }, 400);
        const userId = devUserId(body.user);
        const principal = { kind: 'user' as const, userId, workspaceId: userId as WorkspaceId };
        const cookie = sessionCookie(await sealSession({ userId, workspaceId: principal.workspaceId }, env.SESSION_SECRET, { now: now() }));
        return json({ principal }, 200, { 'set-cookie': cookie });
    };
}
