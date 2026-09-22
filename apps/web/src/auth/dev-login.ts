/**
 * `/auth/dev-login` — a PREVIEW / LOCAL-ONLY door for scripted walk-throughs
 * (#35, `smoke:demo1`) and for `pnpm dev` (#143): GitHub OAuth cannot run
 * headless and needs a registered app, so a deployment that sets the
 * `AGENTIC_DEV_LOGIN` secret lets a caller who presents it mint a user
 * session for a dev identity. The route is not mounted at all when the
 * secret is unset (404 like any unknown path), so production — which never
 * sets it — has no such door. A wrong token is 403, compared in constant
 * time; the token is checked before the user, so nothing about the user is
 * learned without it, and the answer never says how close the token was.
 *
 * Two shapes on one path:
 *   `POST` with a JSON body `{ token, user }` → `{ principal }` + the cookie
 *   (the smokes, the workers tests);
 *   `GET` → a minimal HTML form (user + secret) that POSTs itself as a form
 *   and lands on `/` with the cookie set (the "Dev login" button, the link
 *   `pnpm dev` prints). The secret is prefilled from `?token=` ONLY when the
 *   request's host is localhost, so a preview deployment's link never
 *   carries the secret in a URL a proxy or a browser history would keep.
 *
 * The identity is `dev_<user>`: its own namespace, so a dev workspace can
 * never collide with a GitHub user's (`gh_<id>`, `defaultResolveUser`).
 *
 * `elevate` (#355) — `?elevate=1` on the form's link, `elevate: true` in the
 * JSON body, the form's checkbox — also mints `__Host-elevated` for that
 * user, so a preview or a workers test can make an elevated change without
 * a GitHub round trip.
 */
import type { WorkspaceId } from '@agentic/core';
import { elevationCookie, sealElevation, sealSession, sessionCookie } from '@agentic/platform';
import type { RouteHandler } from './index';

export const DEV_LOGIN_PATH = '/auth/dev-login';

/** Anything shorter reads as unset — a one-character "secret" must not open the door. */
export const DEV_LOGIN_MIN_SECRET = 16;

/** The `user` part: letters, digits, `_` and `-`; 1–64 chars; colon-free so every actor key parses. */
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The user the form suggests when nothing else names one. */
const DEFAULT_USER = 'dev';

/** Both present and long enough — what `devLoginEnabled` proves about a partial env. */
export interface DevLoginEnv {
    readonly SESSION_SECRET: string;
    readonly AGENTIC_DEV_LOGIN: string;
}

export interface DevLoginBody {
    readonly token: string;
    readonly user: string;
    /** Also mint the elevation cookie (#355). */
    readonly elevate?: boolean;
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

/** A loopback host: the only place the form takes its secret from the URL. */
export function isLocalhost(url: URL): boolean {
    const host = url.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** The form: plain HTML, no script, a few inline rules — it works before any asset does. */
export function renderDevLoginForm(fields: { user: string; token: string; elevate?: boolean; error?: string }, status = 200): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dev login · agentic</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; background: #0f1115; color: #e6e8ec; }
form { width: min(360px, 90vw); display: grid; gap: 12px; padding: 24px; border: 1px solid #2a2f3a; border-radius: 12px; background: #161a22; }
h1 { margin: 0 0 4px; font-size: 18px; }
p { margin: 0; color: #9aa3b2; font-size: 13px; }
label { display: grid; gap: 4px; font-size: 13px; color: #9aa3b2; }
input { font: inherit; padding: 8px 10px; border: 1px solid #2a2f3a; border-radius: 8px; background: #0f1115; color: inherit; }
button { font: inherit; font-weight: 600; padding: 9px 12px; border: 0; border-radius: 8px; background: #4f8cff; color: #fff; cursor: pointer; }
[data-error] { color: #ff7b72; font-size: 13px; }
</style>
</head>
<body>
<form method="post" action="${DEV_LOGIN_PATH}" data-dev-login>
<h1>Dev login</h1>
<p>Local and preview deployments only: signs you in as <code>dev_&lt;user&gt;</code>.</p>
${fields.error ? `<p data-error role="alert">${escapeHtml(fields.error)}</p>` : ''}
<label>User<input name="user" value="${escapeHtml(fields.user)}" autocomplete="username" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"></label>
<label>Secret (AGENTIC_DEV_LOGIN)<input name="token" type="password" value="${escapeHtml(fields.token)}" autocomplete="off" required></label>
<label><input name="elevate" type="checkbox" value="1"${fields.elevate ? ' checked' : ''}> Elevated (may change machine security for ten minutes)</label>
<button type="submit">Sign in</button>
</form>
</body>
</html>
`;
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const ERRORS: Record<string, string> = {
    forbidden: 'Wrong secret: it must match AGENTIC_DEV_LOGIN (apps/web/.dev.vars locally).',
    bad_user: 'The user is letters, digits, "_" and "-" only (1 to 64 characters).',
    bad_request: 'Both fields are needed.'
};

/**
 * The handler, or `null` when the door is closed — the caller then mounts
 * nothing, so the path falls through to whatever else serves it.
 */
export function createDevLoginRoute(env: Partial<DevLoginEnv>, options: { now?: () => number } = {}): RouteHandler | null {
    if (!devLoginEnabled(env)) return null;
    const secret = env.AGENTIC_DEV_LOGIN;
    const now = options.now ?? Date.now;

    const issue = async (user: string, elevate: boolean): Promise<{ principal: { kind: 'user'; userId: string; workspaceId: WorkspaceId }; cookies: string[] }> => {
        const userId = devUserId(user);
        const principal = { kind: 'user' as const, userId, workspaceId: userId as WorkspaceId };
        const cookies = [sessionCookie(await sealSession({ userId, workspaceId: principal.workspaceId }, env.SESSION_SECRET, { now: now() }))];
        if (elevate) cookies.push(elevationCookie(await sealElevation({ userId }, env.SESSION_SECRET, { now: now() })));
        return { principal, cookies };
    };
    const withCookies = (response: Response, cookies: readonly string[]): Response => {
        for (const c of cookies) response.headers.append('set-cookie', c);
        return response;
    };

    /** `null` when the body checks out; otherwise the error code and its status. */
    const check = (body: Partial<DevLoginBody>): { error: string; status: number } | null => {
        if (typeof body.token !== 'string' || typeof body.user !== 'string') return { error: 'bad_request', status: 400 };
        if (!sameSecret(body.token, secret)) return { error: 'forbidden', status: 403 };
        if (!USER_RE.test(body.user)) return { error: 'bad_user', status: 400 };
        return null;
    };

    return async (request) => {
        const url = new URL(request.url);
        if (request.method === 'GET') {
            const token = isLocalhost(url) ? url.searchParams.get('token') ?? '' : '';
            const user = url.searchParams.get('user') ?? DEFAULT_USER;
            return renderDevLoginForm({ user: USER_RE.test(user) ? user : DEFAULT_USER, token, elevate: url.searchParams.get('elevate') === '1' });
        }
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });

        const type = request.headers.get('content-type') ?? '';
        if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
            // The form: back to the form with the reason on a failure, to `/` with the cookie on success.
            let form: FormData;
            try {
                form = await request.formData();
            } catch {
                return renderDevLoginForm({ user: DEFAULT_USER, token: '', error: ERRORS.bad_request! }, 400);
            }
            const body = { token: String(form.get('token') ?? ''), user: String(form.get('user') ?? '') };
            const failed = check(body);
            if (failed) return renderDevLoginForm({ user: body.user || DEFAULT_USER, token: '', error: ERRORS[failed.error] ?? failed.error }, failed.status);
            const { cookies } = await issue(body.user, form.get('elevate') === '1');
            return withCookies(new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store' } }), cookies);
        }

        let body: Partial<DevLoginBody>;
        try {
            body = (await request.json()) as Partial<DevLoginBody>;
        } catch {
            return json({ error: 'bad_request' }, 400);
        }
        const failed = check(body);
        if (failed) return json({ error: failed.error }, failed.status);
        const { principal, cookies } = await issue(body.user!, body.elevate === true);
        return withCookies(json({ principal }, 200), cookies);
    };
}

/**
 * The route for `request`, or `undefined` when it is not `/auth/dev-login`
 * or the door is closed — what a Worker's `fetch` asks first. `env` is the
 * Worker's; only the two secrets are read.
 */
export function devLoginRouteFor(request: Request, env: { readonly SESSION_SECRET?: string; readonly AGENTIC_DEV_LOGIN?: string }): RouteHandler | undefined {
    if (request.method !== 'GET' && request.method !== 'POST') return undefined;
    if (new URL(request.url).pathname !== DEV_LOGIN_PATH) return undefined;
    return createDevLoginRoute({ ...(env.SESSION_SECRET ? { SESSION_SECRET: env.SESSION_SECRET } : {}), ...(env.AGENTIC_DEV_LOGIN ? { AGENTIC_DEV_LOGIN: env.AGENTIC_DEV_LOGIN } : {}) }) ?? undefined;
}
