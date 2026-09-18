/**
 * The auth route table the Worker mounts, resolved per request from its env
 * — shared by `entry.cloudflare.ts` and the workers-pool test worker so a
 * test sees the production mount, not a copy of it (#180).
 *
 * What the env has decides what exists:
 *
 *   `SESSION_SECRET` (≥ 32)               → `POST /auth/pair`, `GET /auth/me`, `POST /auth/logout`
 *   + `GITHUB_CLIENT_ID/SECRET` + origin  → `GET /auth/login`, `GET /auth/callback`
 *   + origin                              → the OAuth 2.1 server (#50): well-known documents,
 *                                            `/oauth/*`, `/_agentic/mcp` (bearer = its access token)
 *
 * The origin is `APP_ORIGIN`, or — on localhost only — the request's own, so
 * `wrangler dev` on another port still works without editing `wrangler.jsonc`.
 * A `pnpm dev` with the dev login alone therefore pairs a machine: the daemon's
 * `POST /auth/pair` never falls through to the document again.
 */
import type { AnyActorDefinition } from '@sigx/actors';
import { isLocalhost } from './dev-login';
import { createWebAuth, defaultResolveUser, loginConfigured, type AuthWiring, type RouteHandler, type WebAuth } from './index';
import { createOAuthRoutes, MCP_PATH, type WebOAuthServer } from './oauth-server';

/** The env keys the mount reads (all optional: what is missing decides what is mounted). */
export interface AuthMountEnv {
    readonly SESSION_SECRET?: string;
    readonly GITHUB_CLIENT_ID?: string;
    readonly GITHUB_CLIENT_SECRET?: string;
    readonly APP_ORIGIN?: string;
}

export interface AuthMountWiring {
    /** `POST /auth/pair`: the directory lookup and `Machine.pair` over the registry (`pairingWiring`). */
    readonly pairing: NonNullable<AuthWiring['pairing']>;
    /** The registry the MCP mount binds to (`platformRegistry()`). */
    readonly actors: readonly AnyActorDefinition[];
}

/** The session secret when it can sign anything; `''` otherwise. */
const secretOf = (env: AuthMountEnv): string => ((env.SESSION_SECRET ?? '').length >= 32 ? env.SESSION_SECRET! : '');

/** `APP_ORIGIN`, else the request's own origin on localhost (`wrangler dev`), else `undefined`. */
export function originOf(env: AuthMountEnv, request: Request): string | undefined {
    if (env.APP_ORIGIN) return env.APP_ORIGIN;
    const url = new URL(request.url);
    return isLocalhost(url) ? url.origin : undefined;
}

/** Whether the GitHub OAuth login is mounted for this request: the session secret, the OAuth app's secrets and an origin. */
export const githubEnabled = (env: AuthMountEnv, request: Request): boolean => !!secretOf(env) && loginConfigured({ ...env, APP_ORIGIN: originOf(env, request) });

/**
 * Build the resolver: `(request, env) → handler | undefined`. The route
 * tables are built once per distinct (secret, origin, GitHub) triple and
 * kept — a Worker's env does not change between requests, but a test's may.
 */
export function createAuthMount(wiring: AuthMountWiring): (request: Request, env: AuthMountEnv) => RouteHandler | undefined {
    let built: { key: string; routes: WebAuth['routes']; oauth: WebOAuthServer | null } | null = null;
    return (request, env) => {
        const secret = secretOf(env);
        if (!secret) return undefined;
        const origin = originOf(env, request);
        const github = loginConfigured({ ...env, APP_ORIGIN: origin });
        const key = `${secret}\n${origin ?? ''}\n${github}`;
        if (built?.key !== key) {
            const web = createWebAuth(
                { SESSION_SECRET: secret, ...(github ? { GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET } : {}), ...(origin ? { APP_ORIGIN: origin } : {}) },
                // `POST /auth/pair`: the code is resolved through the global `PairingDirectory`, then redeemed with `Machine.pair` (#37).
                { resolveUser: defaultResolveUser, pairing: wiring.pairing }
            );
            const oauth = origin ? createOAuthRoutes({ SESSION_SECRET: secret, APP_ORIGIN: origin }, { actors: wiring.actors }) : null;
            built = { key, routes: web.routes, oauth };
        }
        const { pathname } = new URL(request.url);
        if (pathname === MCP_PATH && built.oauth) return built.oauth.mcp;
        const route = `${request.method} ${pathname}`;
        return built.routes[route as keyof WebAuth['routes']] ?? built.oauth?.routes[route as keyof WebOAuthServer['routes']];
    };
}
