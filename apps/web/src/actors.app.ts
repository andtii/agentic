/**
 * The platform actor app on Cloudflare (architecture §3, issue #33).
 *
 * One registry, two halves of one bundle:
 *
 * - `ActorHost` — the Durable Object class. One object per actor, SQLite
 *   backed; `createHostDurableObject` derives `durableObjectStorage()` and
 *   `durableObjectReminders()` from the object's own state, and terminates
 *   client sockets inside the object (`socket`), hibernation-ready. A
 *   Machine's object also accepts its daemon's socket (`src/daemon`, #36).
 * - `createActorWorker()` — the Worker half: the HTTP actor mount
 *   (`/_sigx/actor`), the forwarded socket upgrade
 *   (`/_sigx/socket/{type}/{key}`), the daemon upgrade
 *   (`/_agentic/daemon/{machineId}`), everything else to `fallback`.
 *
 * Both halves stamp the same server app (`authenticate` + principal `codec`)
 * on first use, so a principal resolved in the Worker survives the hop into
 * the object and every `ctx.actor()` call after it.
 *
 * Ports that later issues fill are explicit and fail loudly until then:
 * the Session factory (`anthropic-api`, #35) and the platform tools a daemon
 * session calls back (#37). The Schedule trigger is the platform's
 * `scheduleTrigger()` (#42): a reminder lands in the Inbox from the entry's
 * own alarm, an agent entry becomes a Task; with no environment probe wired
 * yet every environment counts as offline (the router, #37, resolves it).
 */
import type { Principal } from '@agentic/core';
import {
    AgentActor,
    Chat,
    ChatPage,
    Memory,
    TaskActor,
    Workspace,
    asPrincipal,
    defineInbox,
    defineMachineActor,
    defineScheduleActor,
    defineSessionActor,
    machineKey,
    machinePrincipal,
    principalCodec,
    scheduleTrigger,
    serverAuth,
    type MachineActor,
    type NotificationChannel,
    type SessionFactory,
    type ToolCallPort,
    type TriggerPort
} from '@agentic/platform';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { createHostDurableObject, createWorkerHandler, type DurableObjectNamespaceLike, type DurableObjectStateLike, type DurableWebSocketLike } from '@sigx/actors-cloudflare';
import { createServerApp } from '@sigx/server/server';
import { actorKeyOfObject, createDaemonSocketHost, createDaemonSocketRegistry, forwardDaemonSocket, DAEMON_SOCKET_PREFIX } from './daemon';

export { DAEMON_SOCKET_PREFIX };

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
    /** Runtime id → in-process session, or `null` for a daemon-hosted runtime. */
    readonly factory: SessionFactory;
    readonly trigger: TriggerPort;
    readonly channels: readonly NotificationChannel[];
    /** Platform tools a daemon session calls back through `tool.call` (#37). Absent → answered `unsupported`. */
    readonly tools?: ToolCallPort;
}

export const defaultPorts: PlatformPorts = {
    // `null` = not platform-managed; the Session then expects daemon frames. The `anthropic-api` factory is wired by #35.
    factory: () => null,
    // Inbox reminder / Task under the entry's offline policy (#42). No `environments`
    // probe wired yet: a task that needs an environment waits `environment-offline`
    // for the router (#37).
    trigger: scheduleTrigger(),
    // Web Push lands with VAPID keys (architecture §3).
    channels: []
};

/** The daemon sockets every Machine object in this isolate holds — the Machine actor's `MachineSocketPort`. */
export const daemonSockets = createDaemonSocketRegistry();

/** Every platform actor this deployment hosts. */
export function platformActors(ports: PlatformPorts = defaultPorts): readonly AnyActorDefinition[] {
    // Session and Machine reference each other: the sink resolves the Machine at call time, the Machine gets the Session lazily.
    const Session = defineSessionActor({
        factory: ports.factory,
        commands: { send: (t, command) => actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, command) }
    });
    const Machine: MachineActor = defineMachineActor({ socket: daemonSockets.port, sessions: () => Session, ...(ports.tools ? { tools: ports.tools } : {}) });
    return [Workspace, AgentActor, Chat, ChatPage, TaskActor, Session, Machine, defineScheduleActor({ trigger: ports.trigger }), Memory, defineInbox({ channels: ports.channels })];
}

let shared: readonly AnyActorDefinition[] | undefined;
/** One registry per isolate, so the Worker, the objects and the `machines` lookup agree on the definitions. */
function defaultActors(): readonly AnyActorDefinition[] {
    return (shared ??= platformActors());
}

/** The Machine definition in a registry — what the daemon socket and the token lookup dispatch on. */
export function machineDefinition(actors: readonly AnyActorDefinition[]): MachineActor {
    const def = actors.find((d) => (d as { type: string }).type === 'machine');
    if (!def) throw new Error('[actors.app] no `machine` actor in the registry');
    return def as MachineActor;
}

/** The minimum a signing secret must be; shorter is treated as absent. */
const MIN_SECRET = 32;

let stampedFor: string | undefined;

/**
 * Stamp `createServerApp` once per isolate (last-wins seam in `@sigx/server`).
 * Without `SESSION_SECRET` the app still decodes principals propagated by a
 * hop but authenticates nobody — fail-closed, never a dev fallback secret.
 * A machine bearer token is checked against the Machine actor's stored hash
 * (`tokenRecord`, read as that machine: the ids in a token are an address,
 * the hash match is the proof).
 */
export function ensureServerApp(env: PlatformEnv, actors: readonly AnyActorDefinition[] = defaultActors()): void {
    const secret = env.SESSION_SECRET && env.SESSION_SECRET.length >= MIN_SECRET ? env.SESSION_SECRET : '';
    if (stampedFor === secret) return;
    stampedFor = secret;
    if (secret) {
        const Machine = machineDefinition(actors);
        createServerApp<Principal>({
            ...serverAuth({
                sessionSecret: secret,
                machines: (ref) => actor(Machine, machineKey(ref.workspaceId, ref.machineId)).with({ context: asPrincipal(machinePrincipal(ref.workspaceId, ref.machineId)) }).tokenRecord()
            })
        });
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

/**
 * Build the Durable Object class over `actors`. A Machine's object also
 * accepts its daemon socket: the upgrade at `/_agentic/daemon/{machineId}`
 * is verified against the actor's token hash and accepted under the
 * `agentic:daemon` tag; the hibernation handlers route those sockets to the
 * Machine actor and everything else back to the actor host's own session.
 */
export function createActorHost(actors: readonly AnyActorDefinition[] = defaultActors()) {
    const Base = createHostDurableObject<PlatformEnv>({ actors: [...actors], namespace, socket: {} });
    const Machine = machineDefinition(actors);
    return class ActorHost extends Base {
        readonly #daemon;
        constructor(state: DurableObjectStateLike, env: PlatformEnv) {
            ensureServerApp(env, actors);
            super(state, env);
            const own = actorKeyOfObject(state);
            if (own?.type === 'machine') daemonSockets.bind(own.key, state);
            this.#daemon = createDaemonSocketHost({ state, host: () => this.host(), machine: Machine, registry: daemonSockets });
        }
        override fetch(request: Request): Promise<Response> {
            return this.#daemon.fetch(request) ?? super.fetch(request);
        }
        override webSocketMessage(ws: DurableWebSocketLike, message: unknown): Promise<void> {
            return this.#daemon.owns(ws) ? this.#daemon.message(ws, message) : super.webSocketMessage(ws, message);
        }
        override webSocketClose(ws: DurableWebSocketLike): Promise<void> {
            return this.#daemon.owns(ws) ? this.#daemon.close(ws) : super.webSocketClose(ws);
        }
        override webSocketError(ws: DurableWebSocketLike): Promise<void> {
            return this.#daemon.owns(ws) ? this.#daemon.close(ws) : super.webSocketError(ws);
        }
    };
}

export interface ActorWorkerOptions {
    readonly actors?: readonly AnyActorDefinition[];
    /** Requests the actor mount does not own (server functions, SSR). */
    readonly fallback?: (request: Request) => Response | Promise<Response> | undefined;
}

/** The Worker half: daemon socket forwarding, actor HTTP mount, object-terminated socket forwarding. */
export function createActorWorker(options: ActorWorkerOptions = {}) {
    const actors = options.actors ?? defaultActors();
    const handler = createWorkerHandler<PlatformEnv>({
        actors: [...actors],
        namespace,
        socket: { terminate: 'object' },
        ...(options.fallback ? { fetch: { fallback: options.fallback } } : {})
    });
    return {
        fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
            ensureServerApp(env, actors);
            if (new URL(request.url).pathname.startsWith(DAEMON_SOCKET_PREFIX)) return Promise.resolve(forwardDaemonSocket(request, env.ACTORS));
            return handler.fetch(request, env, ctx);
        }
    };
}
