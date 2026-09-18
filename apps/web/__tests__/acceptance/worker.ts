/**
 * The Worker the acceptance suite's workerd half runs: `../workers/worker.ts`
 * (the production wiring with a mock `anthropic-api` runtime and the
 * preview dev login), on the production `ActorHost` — every Durable Object
 * entry point runs under its own host through `src/host-scope.ts` (#137),
 * so the scenarios' second machine saying hello after the first no longer
 * runs its Machine actor inside the Routing object.
 */
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { createActorHost, createActorWorker, defaultPorts, platformActors, type PlatformEnv } from '../../src/actors.app';
import { createDevLoginRoute, DEV_LOGIN_PATH } from '../../src/auth/dev-login';
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

const worker = createActorWorker({ actors });

// Every route under ONE scope, the Worker's own host — as `entry.cloudflare.ts` does it (#172).
export default {
    fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        return runWithHost(worker.host, async () => {
            if (request.method === 'POST' && new URL(request.url).pathname === DEV_LOGIN_PATH) {
                const route = createDevLoginRoute({ ...(env.SESSION_SECRET ? { SESSION_SECRET: env.SESSION_SECRET } : {}), ...(env.AGENTIC_DEV_LOGIN ? { AGENTIC_DEV_LOGIN: env.AGENTIC_DEV_LOGIN } : {}) });
                if (route) return route(request);
            }
            return worker.fetch(request, env, ctx);
        });
    }
};
