// The Cloudflare Worker entry — one bundle exports the Worker and the
// `ActorHost` Durable Object (architecture §3). Static assets never reach
// this code — wrangler's `assets` config serves matching files first.
// What is left, in order:
//
//     auth routes  ->  daemon socket + actor mount + actor sockets
//                  ->  server functions  ->  document render
import { createFetchHandler } from '@sigx/server-renderer/server';
import { template, assets } from 'virtual:sigx-app';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { serverFns, serverFnBase } from 'virtual:sigx-server-fns';
import { createApp } from './entry-server';
import { createActorHost, createActorWorker, ensureServerApp, pairingWiring, platformRegistry, type PlatformEnv } from './actors.app';
import { createWebAuth, defaultResolveUser, type RouteHandler, type WebAuth } from './auth';
import { createOAuthRoutes, MCP_PATH, type WebOAuthServer } from './auth/oauth-server';

const render = createFetchHandler({
    template,
    app: (url) => createApp(url),
    document: { assets }
});

// The daemon socket (`/_agentic/daemon/{machineId}`) is forwarded by the actor
// worker to the Machine's Durable Object, which verifies the token and accepts it (#36).
const actors = createActorWorker({
    fallback: (request) => {
        if (matchesServerFn(request, serverFnBase)) {
            return handleServerFnRequest(request, {
                // The build's own mount path, so router and handler cannot disagree.
                base: serverFnBase,
                // The registry is passed explicitly, never ambient.
                resolve: (symbol) => serverFns[symbol]?.() ?? null
            });
        }
        return render(request);
    }
});

/** The Durable Object class `wrangler.jsonc` binds as `ACTORS`. */
export const ActorHost = createActorHost();

let auth: { secret: string; routes: WebAuth['routes']; oauth: WebOAuthServer } | null = null;

/**
 * Auth routes need the secrets; without them they are simply not mounted.
 * The OAuth 2.1 server for external MCP clients (#50) shares the secret and
 * the origin: its well-known documents, `/oauth/*` endpoints and the
 * `/_agentic/mcp` mount (bearer = its access token) are mounted alongside.
 */
function authRoute(request: Request, env: PlatformEnv): RouteHandler | undefined {
    const secret = env.SESSION_SECRET ?? '';
    if (secret.length < 32 || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.APP_ORIGIN) return undefined;
    if (auth?.secret !== secret) {
        const web = createWebAuth(
            { SESSION_SECRET: secret, GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET, APP_ORIGIN: env.APP_ORIGIN },
            // `POST /auth/pair`: the code is resolved through the global `PairingDirectory`, then redeemed with `Machine.pair` (#37).
            { resolveUser: defaultResolveUser, pairing: pairingWiring() }
        );
        const oauth = createOAuthRoutes({ SESSION_SECRET: secret, APP_ORIGIN: env.APP_ORIGIN }, { actors: platformRegistry() });
        auth = { secret, routes: web.routes, oauth };
    }
    const { pathname } = new URL(request.url);
    if (pathname === MCP_PATH) return auth.oauth.mcp;
    const key = `${request.method} ${pathname}`;
    return auth.routes[key as keyof WebAuth['routes']] ?? auth.oauth.routes[key as keyof WebOAuthServer['routes']];
}

export default {
    async fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        const route = authRoute(request, env);
        if (route) {
            ensureServerApp(env);
            return route(request);
        }
        return actors.fetch(request, env, ctx);
    }
};
