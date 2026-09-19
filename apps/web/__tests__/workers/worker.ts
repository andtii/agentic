// The worker the workers pool runs: the actor half of `entry.cloudflare.ts`
// without the SSR build's virtual modules (those only exist in a Vite app build).
//
// The `anthropic-api` runtime is a mock agent (#34): the chat test drives a
// post through activation, routing and a session inside workerd, offline —
// every other port is the production wiring. Since #231 it sits behind the
// production session factory and Registry: the router gates the run on the
// plugin, and the runtime opens only with the workspace's `anthropic-api-key`
// secret (sealed under the pool's `WORKSPACE_KEK`), as `anthropicApiRuntime`
// does — so a test that expects an answer sets the key first (`setAnthropicKey`).
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, CLAUDE_CODE_PLUGIN_ID } from '@agentic/runtimes';
import { NO_API_KEY_CODE, type RuntimeCatalogue } from '@agentic/platform';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { createActorHost, createActorWorker, defaultPorts, pairingWiring, platformActors, platformFiles, type PlatformEnv } from '../../src/actors.app';
import { createAuthMount } from '../../src/auth/mount';
import { devLoginRouteFor } from '../../src/auth/dev-login';
import { createFilesMount, type WaitUntilLike } from '../../src/files/route';
import { runWithHost } from '../../src/host-scope';

const agent = mockAgent({ respond: (input) => [{ text: `echo: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }] });

const runtimes: RuntimeCatalogue = {
    [ANTHROPIC_API_PLUGIN_ID]: {
        host: 'local',
        async open(c, plugin) {
            // The key check `anthropicApiRuntime` makes, against the real Registry; only the model is the mock.
            if (!(await plugin.secret(ANTHROPIC_API_KEY_SECRET))) throw new Error(`${NO_API_KEY_CODE}: workspace ${c.workspaceId} has no Anthropic API key — add one at /plugins/${ANTHROPIC_API_PLUGIN_ID}`);
            const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
            return { session, agentId: agent.id, capabilities: agent.capabilities };
        }
    },
    [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' }
};

const actors = platformActors({ ...defaultPorts, runtimes });

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

const worker = createActorWorker({ actors });

// The same shape as `entry.cloudflare.ts`: the dev login (#35, #143: GET form + POST), the auth
// routes, then the actor worker — all of it under ONE scope, the Worker's own host (#137, #172).
export default {
    fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        return runWithHost(worker.host, async () => {
            const route = devLoginRouteFor(request, env) ?? authRoute(request, env) ?? filesRoute(request, env, ctx as WaitUntilLike | undefined);
            if (route) {
                // The Worker host boots from `env` before an auth route hops (#182).
                await worker.boot(env);
                return route(request);
            }
            return worker.fetch(request, env, ctx);
        });
    }
};
