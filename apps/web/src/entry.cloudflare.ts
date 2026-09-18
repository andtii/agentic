// The Cloudflare Worker entry — one bundle exports the Worker and the
// `ActorHost` Durable Object (architecture §3). Static assets never reach
// this code — wrangler's `assets` config serves matching files first.
// What is left, in order:
//
//     auth routes  ->  daemon socket + actor mount + actor sockets
//                  ->  server functions  ->  document render
//
// all of it inside ONE `runWithHost` scope — the Worker's own host (#137, #172).
import { createFetchHandler } from '@sigx/server-renderer/server';
import { template, assets } from 'virtual:sigx-app';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { serverFns, serverFnBase } from 'virtual:sigx-server-fns';
import { createApp } from './entry-server';
import { createActorHost, createActorWorker, ensureServerApp, pairingWiring, platformRegistry, type PlatformEnv } from './actors.app';
import { devLoginEnabled, devLoginRouteFor } from './auth/dev-login';
import { createAuthMount, githubEnabled } from './auth/mount';
import { setSignInOptions } from './auth/sign-in';
import { runWithHost } from './host-scope';

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

/**
 * The auth routes, by what the env has (#180): the session secret alone mounts
 * `POST /auth/pair` (the daemon's redeem route), `/auth/me` and `/auth/logout`;
 * the GitHub login needs the OAuth app's secrets; the OAuth 2.1 server for MCP
 * clients (#50) needs an origin (`APP_ORIGIN`, or the request's on localhost).
 * `POST /auth/pair`: the code is resolved through the global `PairingDirectory`,
 * then redeemed with `Machine.pair` (#37).
 */
const authRoute = createAuthMount({ pairing: pairingWiring(), actors: platformRegistry() });

export default {
    // Every route runs under the Worker's own host scope (#137, #172): the auth routes hop
    // to the objects too (`pairingWiring`, the token lookup, the MCP mount), and an unscoped
    // hop resolves through whichever object booted last when one shares the isolate.
    fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        return runWithHost(actors.host, async () => {
            // What the shell's signed-out state may offer (`signInOptions`), from this request's env.
            setSignInOptions({ github: githubEnabled(env, request), devLogin: devLoginEnabled(env) });
            // The preview / local-only dev login (#35, #143): `GET` (the form) and `POST` (JSON or the form's
            // body) on `/auth/dev-login`, mounted only while `AGENTIC_DEV_LOGIN` is set; independent of the GitHub secrets.
            const route = devLoginRouteFor(request, env) ?? authRoute(request, env);
            if (route) {
                ensureServerApp(env);
                return route(request);
            }
            return actors.fetch(request, env, ctx);
        });
    }
};
