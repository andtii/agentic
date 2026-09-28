// The worker the workers pool runs: the actor half of `entry.cloudflare.ts`
// without the SSR build's virtual modules (those only exist in a Vite app build).
// The test seams (mock runtime, fake Google, scripted pull requests) are
// `./fixture.ts`, shared with the Node host's run of this suite (#995); every
// other port is the production wiring.
import type { AnyActorDefinition } from '@sigx/actors';
import { createA2aMount } from '../../src/a2a/mount';
import { createActorHost, createActorWorker, defaultPorts, pairingWiring, platformActors, platformFiles, type PlatformEnv } from '../../src/actors.cloudflare';
import { createAuthMount } from '../../src/auth/mount';
import { devLoginRouteFor } from '../../src/auth/dev-login';
import { createFilesMount, type WaitUntilLike } from '../../src/files/route';
import { runWithHost } from '../../src/host-scope';
import { connectorsRoute, testPorts, testRoute } from './fixture';

const actors: readonly AnyActorDefinition[] = platformActors({ ...defaultPorts, ...testPorts(() => actors) });

export const ActorHost = createActorHost(actors);

/**
 * The auth routes (#144, #180): the PRODUCTION mount (`createAuthMount`, the
 * one `entry.cloudflare.ts` uses) over THIS worker's registry and env. The
 * pool binds only `SESSION_SECRET`, `WORKSPACE_KEK` and `AGENTIC_DEV_LOGIN`
 * — no GitHub app, no `APP_ORIGIN` — so what is mounted here is exactly what
 * a fresh `pnpm dev` mounts: `POST /auth/pair` (the daemon's redeem route),
 * `/auth/me`, `/auth/logout`; never the GitHub login. Mounted in the
 * production route order: BEFORE the actor mount, as an auth route (#172).
 */
const authRoute = createAuthMount({ pairing: pairingWiring(actors), actors });

/** The chat file routes (#207), as the production entry mounts them: after the auth routes, over the same R2 store the actors use. */
const filesRoute = createFilesMount({ store: platformFiles });

/**
 * The A2A server (#245), as the production entry mounts it: after the auth routes. Like the OAuth server it
 * verifies tokens with, it needs an origin — the pool sets no `APP_ORIGIN`, so it answers on `http://localhost`.
 */
const a2aRoute = createA2aMount({ actors, pollMs: 20 });

const worker = createActorWorker({ actors });

// The same shape as `entry.cloudflare.ts`: the dev login (#35, #143: GET form + POST), the auth
// routes, then the actor worker — all of it under ONE scope, the Worker's own host (#137, #172).
export default {
    fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        return runWithHost(worker.host, async () => {
            // Test-only: what the fake Google saw, and one conduit tool call the way a session makes it (`./google.ts`).
            const route = testRoute(request) ?? devLoginRouteFor(request, env) ?? authRoute(request, env) ?? a2aRoute(request, env) ?? filesRoute(request, env, ctx as WaitUntilLike | undefined) ?? connectorsRoute(request, env);
            if (route) {
                // The Worker host boots from `env` before an auth route hops (#182).
                await worker.boot(env);
                return route(request);
            }
            return worker.fetch(request, env, ctx);
        });
    }
};
