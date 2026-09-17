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
import { createActorHost, createActorWorker, ensureServerApp, type PlatformEnv } from './actors.app';
import { createWebAuth, defaultResolveUser, type RouteHandler, type WebAuth } from './auth';

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

let auth: { secret: string; routes: WebAuth['routes'] } | null = null;

/** Auth routes need the secrets; without them they are simply not mounted. */
function authRoute(request: Request, env: PlatformEnv): RouteHandler | undefined {
    const secret = env.SESSION_SECRET ?? '';
    if (secret.length < 32 || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.APP_ORIGIN) return undefined;
    if (auth?.secret !== secret) {
        const web = createWebAuth(
            { SESSION_SECRET: secret, GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET, APP_ORIGIN: env.APP_ORIGIN },
            // `POST /auth/pair` needs a code → workspace resolution no actor provides yet (the code alone names no
            // workspace); the platform-side redemption is `Machine.pair(code, info)` — the wiring issue after #90 binds it.
            { resolveUser: defaultResolveUser }
        );
        auth = { secret, routes: web.routes };
    }
    const key = `${request.method} ${new URL(request.url).pathname}` as keyof WebAuth['routes'];
    return auth.routes[key];
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
