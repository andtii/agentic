// The worker the workers pool runs: the actor half of `entry.cloudflare.ts`
// without the SSR build's virtual modules (those only exist in a Vite app build).
//
// The `anthropic-api` runtime is a mock agent (#34): the chat test drives a
// post through activation, routing and a session inside workerd, offline —
// every other port is the production wiring.
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { createActorHost, createActorWorker, defaultPorts, ensureServerApp, pairingWiring, platformActors, type PlatformEnv } from '../../src/actors.app';
import { createWebAuth, defaultResolveUser, type RouteHandler } from '../../src/auth';
import { devLoginRouteFor } from '../../src/auth/dev-login';
import { runWithHost } from '../../src/host-scope';

const agent = mockAgent({ respond: (input) => [{ text: `echo: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }] });

const actors = platformActors({
    ...defaultPorts,
    factory: async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    }
});

export const ActorHost = createActorHost(actors);

/**
 * `POST /auth/pair` (#144): the daemon's redeem route over THIS worker's
 * registry, built as `entry.cloudflare.ts` builds it (the GitHub half is
 * never called here). It hops to the Machine object (`pairingWiring`), and
 * is mounted in the production route order: BEFORE the actor mount, as an
 * auth route (#172).
 */
let pairRoute: RouteHandler | undefined;
function authRoute(request: Request, env: PlatformEnv): RouteHandler | undefined {
    if (!env.SESSION_SECRET || request.method !== 'POST' || new URL(request.url).pathname !== '/auth/pair') return undefined;
    pairRoute ??= createWebAuth(
        { SESSION_SECRET: env.SESSION_SECRET, GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', APP_ORIGIN: 'https://agentic.test' },
        { resolveUser: defaultResolveUser, pairing: pairingWiring(actors) }
    ).routes['POST /auth/pair'];
    return pairRoute;
}

const worker = createActorWorker({ actors });

// The same shape as `entry.cloudflare.ts`: the dev login (#35, #143: GET form + POST), the auth
// routes, then the actor worker — all of it under ONE scope, the Worker's own host (#137, #172).
export default {
    fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        return runWithHost(worker.host, async () => {
            const route = devLoginRouteFor(request, env) ?? authRoute(request, env);
            if (route) {
                ensureServerApp(env, actors);
                return route(request);
            }
            return worker.fetch(request, env, ctx);
        });
    }
};
