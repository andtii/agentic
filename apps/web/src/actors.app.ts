/**
 * The platform actor app on Cloudflare (architecture §3, issue #33).
 *
 * One registry, two halves of one bundle:
 *
 * - `ActorHost` — the Durable Object class. One object per actor, SQLite
 *   backed; `createHostDurableObject` derives `durableObjectStorage()` and
 *   `durableObjectReminders()` from the object's own state, and terminates
 *   client sockets inside the object (`socket`), hibernation-ready.
 * - `createActorWorker()` — the Worker half: the HTTP actor mount
 *   (`/_sigx/actor`) and the forwarded socket upgrade
 *   (`/_sigx/socket/{type}/{key}`), everything else to `fallback`.
 *
 * Both halves stamp the same server app (`authenticate` + principal `codec`)
 * on first use, so a principal resolved in the Worker survives the hop into
 * the object and every `ctx.actor()` call after it.
 *
 * Ports that later issues fill are explicit and fail loudly until then:
 * the Session factory (`anthropic-api`, #35), the daemon command sink
 * (Machine actor, #36) and the Schedule trigger (#42).
 */
import type { Principal } from '@agentic/core';
import {
    AgentActor,
    Chat,
    ChatPage,
    Memory,
    TaskActor,
    Workspace,
    defineInbox,
    defineScheduleActor,
    defineSessionActor,
    principalCodec,
    serverAuth,
    type NotificationChannel,
    type SessionPorts,
    type TriggerPort
} from '@agentic/platform';
import type { AnyActorDefinition } from '@sigx/actors';
import { createHostDurableObject, createWorkerHandler, type DurableObjectNamespaceLike, type DurableObjectStateLike } from '@sigx/actors-cloudflare';
import { createServerApp } from '@sigx/server/server';

/** Bindings and secrets the worker reads (wrangler.jsonc; secrets via `wrangler secret put`). */
export interface PlatformEnv {
    /** The one Durable Object namespace — every actor is an `ActorHost` object. */
    readonly ACTORS: DurableObjectNamespaceLike;
    /** Artifacts and exports. */
    readonly ARTIFACTS?: unknown;
    /** ≥ 32 chars; signs `__Host-session`, OAuth transients and agent tokens. Absent → every call is anonymous. */
    readonly SESSION_SECRET?: string;
    readonly GITHUB_CLIENT_ID?: string;
    readonly GITHUB_CLIENT_SECRET?: string;
    /** base64, 32 bytes — `importWorkspaceKek`. */
    readonly WORKSPACE_KEK?: string;
    /** Public origin, e.g. `https://agentic.example`. */
    readonly APP_ORIGIN?: string;
}

/** The seams later issues plug. Every default refuses with the issue that owns it. */
export interface PlatformPorts {
    readonly session: SessionPorts;
    readonly trigger: TriggerPort;
    readonly channels: readonly NotificationChannel[];
}

export const defaultPorts: PlatformPorts = {
    session: {
        // `null` = not platform-managed; the Session then expects daemon frames.
        // The `anthropic-api` factory is wired by #35; the daemon `commands` sink by #36.
        factory: () => null
    },
    trigger: {
        fired(event) {
            throw new Error(`[actors.app] schedule trigger not wired (#42): dropped ${event.kind} ${event.key}`);
        }
    },
    // Web Push lands with VAPID keys (architecture §3).
    channels: []
};

/** Every platform actor this deployment hosts. The Machine actor joins in #36. */
export function platformActors(ports: PlatformPorts = defaultPorts): readonly AnyActorDefinition[] {
    return [
        Workspace,
        AgentActor,
        Chat,
        ChatPage,
        TaskActor,
        defineSessionActor(ports.session),
        defineScheduleActor({ trigger: ports.trigger }),
        Memory,
        defineInbox({ channels: ports.channels })
    ];
}

/** The minimum a signing secret must be; shorter is treated as absent. */
const MIN_SECRET = 32;

let stampedFor: string | undefined;

/**
 * Stamp `createServerApp` once per isolate (last-wins seam in `@sigx/server`).
 * Without `SESSION_SECRET` the app still decodes principals propagated by a
 * hop but authenticates nobody — fail-closed, never a dev fallback secret.
 */
export function ensureServerApp(env: PlatformEnv): void {
    const secret = env.SESSION_SECRET && env.SESSION_SECRET.length >= MIN_SECRET ? env.SESSION_SECRET : '';
    if (stampedFor === secret) return;
    stampedFor = secret;
    if (secret) {
        createServerApp<Principal>({ ...serverAuth({ sessionSecret: secret }) });
    } else {
        console.warn('[actors.app] SESSION_SECRET is not set: every request is anonymous (set it with `wrangler secret put SESSION_SECRET` or .dev.vars)');
        createServerApp<Principal>({ authenticate: () => null, codec: principalCodec });
    }
}

/** Test seam: forget the stamp so the next request re-stamps. */
export function resetServerAppStamp(): void {
    stampedFor = undefined;
}

const namespace = (env: PlatformEnv): DurableObjectNamespaceLike => env.ACTORS;

/** Build the Durable Object class over `actors`. */
export function createActorHost(actors: readonly AnyActorDefinition[] = platformActors()) {
    const Base = createHostDurableObject<PlatformEnv>({ actors: [...actors], namespace, socket: {} });
    return class ActorHost extends Base {
        constructor(state: DurableObjectStateLike, env: PlatformEnv) {
            ensureServerApp(env);
            super(state, env);
        }
    };
}

export interface ActorWorkerOptions {
    readonly actors?: readonly AnyActorDefinition[];
    /** Requests the actor mount does not own (server functions, SSR). */
    readonly fallback?: (request: Request) => Response | Promise<Response> | undefined;
}

/** The Worker half: actor HTTP mount + object-terminated socket forwarding. */
export function createActorWorker(options: ActorWorkerOptions = {}) {
    const handler = createWorkerHandler<PlatformEnv>({
        actors: [...(options.actors ?? platformActors())],
        namespace,
        socket: { terminate: 'object' },
        ...(options.fallback ? { fetch: { fallback: options.fallback } } : {})
    });
    return {
        fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
            ensureServerApp(env);
            return handler.fetch(request, env, ctx);
        }
    };
}

/** The daemon socket (`/_agentic/daemon/{machineId}`) is accepted by the Machine object — #36. */
export const DAEMON_SOCKET_PREFIX = '/_agentic/daemon/';

export function daemonSocketStub(): Response {
    return new Response(JSON.stringify({ error: 'machine_actor_unavailable', detail: 'the daemon socket is accepted by the Machine actor (#36)' }), {
        status: 501,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
}
