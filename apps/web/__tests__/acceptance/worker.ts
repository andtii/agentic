/**
 * The Worker the acceptance suite's workerd half runs: `../workers/worker.ts`
 * (the production wiring with a mock `anthropic-api` runtime and the
 * preview dev login) with ONE addition — every Durable Object entry point
 * runs under its own host.
 *
 * Why: `@sigx/actors` keeps the current host in one global
 * (`__SIGX_ACTOR_HOST__`, last `start()` wins). Several `ActorHost` objects
 * share one isolate, so the platform's ambient `actor()` hops (the driver
 * principal's fresh clients, the Machine's `routing().machineOnline`, the
 * learning and tool ports) resolve through whichever object booted LAST.
 * Its placement answers `isSelf` for that object's actor, so a hop to it
 * from another object runs the actor locally on the other object's storage
 * — "Cannot perform I/O on behalf of a different Durable Object", the
 * object is reset and its unsaved turn is lost. The scenarios here hit it
 * as soon as a second machine says hello after a first one did. Tracked as
 * #137 (the fix belongs in the seam, not here); until then the
 * global is an accessor over an `AsyncLocalStorage` each object enters on
 * `fetch`, the hibernation handlers and `alarm`, so a hop resolves through
 * the object that is actually executing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import type { Host } from '@sigx/actors';
import type { DurableWebSocketLike } from '@sigx/actors-cloudflare';
import { createActorHost, createActorWorker, defaultPorts, platformActors, type PlatformEnv } from '../../src/actors.app';
import { createDevLoginRoute, DEV_LOGIN_PATH } from '../../src/auth/dev-login';

const scope = new AsyncLocalStorage<Host>();
let stamped: Host | undefined;
Object.defineProperty(globalThis, '__SIGX_ACTOR_HOST__', {
    configurable: true,
    enumerable: false,
    get: () => scope.getStore() ?? stamped,
    set: (host: Host | undefined) => {
        stamped = host;
    }
});

const agent = mockAgent({ respond: (input) => [{ text: `echo: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }] });

const actors = platformActors({
    ...defaultPorts,
    factory: async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    }
});

const Base = createActorHost(actors);

export class ActorHost extends Base {
    override async fetch(request: Request): Promise<Response> {
        return scope.run(await this.host(), () => super.fetch(request));
    }
    override async webSocketMessage(ws: DurableWebSocketLike, message: unknown): Promise<void> {
        return scope.run(await this.host(), () => super.webSocketMessage(ws, message));
    }
    override async webSocketClose(ws: DurableWebSocketLike): Promise<void> {
        return scope.run(await this.host(), () => super.webSocketClose(ws));
    }
    override async webSocketError(ws: DurableWebSocketLike): Promise<void> {
        return scope.run(await this.host(), () => super.webSocketError(ws));
    }
    override async alarm(): Promise<void> {
        return scope.run(await this.host(), () => super.alarm());
    }
}

const worker = createActorWorker({ actors });

export default {
    fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
        if (request.method === 'POST' && new URL(request.url).pathname === DEV_LOGIN_PATH) {
            const route = createDevLoginRoute({ ...(env.SESSION_SECRET ? { SESSION_SECRET: env.SESSION_SECRET } : {}), ...(env.AGENTIC_DEV_LOGIN ? { AGENTIC_DEV_LOGIN: env.AGENTIC_DEV_LOGIN } : {}) });
            if (route) return route(request);
        }
        return worker.fetch(request, env, ctx);
    }
};
