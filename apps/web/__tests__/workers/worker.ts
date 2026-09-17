// The worker the workers pool runs: the actor half of `entry.cloudflare.ts`
// without the SSR build's virtual modules (those only exist in a Vite app build).
//
// The `anthropic-api` runtime is a mock agent (#34): the chat test drives a
// post through activation, routing and a session inside workerd, offline —
// every other port is the production wiring.
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { createActorHost, createActorWorker, defaultPorts, platformActors, type PlatformEnv } from '../../src/actors.app';
import { createDevLoginRoute, DEV_LOGIN_PATH } from '../../src/auth/dev-login';

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

// The preview-only dev login (#35) is mounted here exactly as `entry.cloudflare.ts` mounts it,
// so the demo walk-through signs in over the wire the way the Playwright smoke does.
export default {
    fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        if (request.method === 'POST' && new URL(request.url).pathname === DEV_LOGIN_PATH) {
            const route = createDevLoginRoute({ ...(env.SESSION_SECRET ? { SESSION_SECRET: env.SESSION_SECRET } : {}), ...(env.AGENTIC_DEV_LOGIN ? { AGENTIC_DEV_LOGIN: env.AGENTIC_DEV_LOGIN } : {}) });
            if (route) return route(request);
        }
        return worker.fetch(request, env, ctx);
    }
};
