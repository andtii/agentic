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
 * Execution routing (#37): the Session factory runs `anthropic-api`
 * in-process (`createSessionFactory`, BYO key), the Routing actor drives
 * tasks to their environment (`Machine.openSession`) or the local runtime,
 * the daemon's `tool.call` runs the platform tools over the actors
 * (`createToolCallPort`), and `POST /auth/pair` resolves codes through the
 * `PairingDirectory` (`pairingWiring`). The Schedule trigger is the
 * platform's `scheduleTrigger()` (#42) over the router: the environment
 * probe reads the Machines, and every task a firing creates — queued, or
 * parked `waiting {environment-offline}` — is handed to `Routing.run`.
 * Delegation (#39): the same tool ports serve `delegate` on both paths; a
 * child session's `request` reaches the Inbox through the router. Memory and
 * learning (#41) run through `platformLearningPorts` over the default
 * `@agentic/learning` plugin.
 */
import type { Principal, WorkspaceId } from '@agentic/core';
import {
    AgentActor,
    Chat,
    ChatPage,
    LedgerActor,
    Memory,
    PAIRING_DIRECTORY_KEY,
    PairingDirectory,
    TaskActor,
    Workspace,
    asPrincipal,
    createEnvironmentProbe,
    createSessionFactory,
    createToolCallPort,
    defineInbox,
    defineMachineActor,
    defineRoutingActor,
    defineScheduleActor,
    defineSessionActor,
    ledgerRecorder,
    machineKey,
    machinePrincipal,
    platformLearningPorts,
    principalCodec,
    routingKey,
    scheduleTrigger,
    serverAuth,
    userPrincipal,
    type MachineActor,
    type NotificationChannel,
    type RoutingActor,
    type SessionFactory,
    type SessionFactoryOptions,
    type ToolCallPort,
    type TriggerPort
} from '@agentic/platform';
import { learningPlugin } from '@agentic/learning';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { createHostDurableObject, createWorkerHandler, type DurableObjectNamespaceLike, type DurableObjectStateLike, type DurableWebSocketLike } from '@sigx/actors-cloudflare';
import { createServerApp, setPrincipal } from '@sigx/server/server';
import type { AuthWiring } from './auth';
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
    /**
     * The Anthropic API key the `anthropic-api` runtime uses, for every workspace
     * of this deployment, until per-workspace BYO keys land with the Registry
     * (architecture §5a). Absent → an API-runtime task fails `no-api-key`.
     */
    readonly ANTHROPIC_API_KEY?: string;
}

/** The seams an app (or a test) may override; the defaults are the real wiring. */
export interface PlatformPorts {
    /** Runtime id → in-process session, or `null` for a daemon-hosted runtime. Default: `createSessionFactory` over `anthropic`. */
    readonly factory?: SessionFactory;
    /** The Anthropic provider options a workspace's sessions run with. Default: the deployment's `ANTHROPIC_API_KEY`. */
    readonly anthropic?: SessionFactoryOptions['anthropic'];
    /** Where a schedule firing goes. Default: `scheduleTrigger` over the Machines (environment probe) and the router (`Routing.run`). */
    readonly trigger?: TriggerPort;
    readonly channels: readonly NotificationChannel[];
    /** Platform tools a daemon session calls back through `tool.call`. Default: `createToolCallPort` over the actors. */
    readonly tools?: ToolCallPort;
}

/** Secrets the actor registry reads lazily: it is built once per isolate, before any request carries `env`. */
const secrets: { anthropicApiKey?: string } = {};

export const defaultPorts: PlatformPorts = {
    anthropic: () => (secrets.anthropicApiKey ? { apiKey: secrets.anthropicApiKey } : undefined),
    // Web Push lands with VAPID keys (architecture §3).
    channels: []
};

/** The daemon sockets every Machine object in this isolate holds — the Machine actor's `MachineSocketPort`. */
export const daemonSockets = createDaemonSocketRegistry();

/** Every platform actor this deployment hosts. */
export function platformActors(ports: PlatformPorts = defaultPorts): readonly AnyActorDefinition[] {
    // Session, Machine and Routing reference each other: every cross-reference is a thunk resolved at call time.
    const anthropic = ports.anthropic ?? defaultPorts.anthropic;
    const Session = defineSessionActor({
        factory: ports.factory ?? createSessionFactory({ routing: () => Routing, ...(anthropic ? { anthropic } : {}) }),
        commands: { send: (t, command) => actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, command) },
        usage: ledgerRecorder(),
        learning: platformLearningPorts({ plugin: (c) => learningPlugin({ contextFor: () => ({ ...(c.objective ? { objective: c.objective } : {}), ...(c.tags ? { tags: c.tags } : {}) }) }) })
    });
    const Inbox = defineInbox({ channels: ports.channels });
    const Routing: RoutingActor = defineRoutingActor({ sessions: () => Session, machines: () => Machine, inbox: () => Inbox });
    const Machine: MachineActor = defineMachineActor({
        socket: daemonSockets.port,
        sessions: () => Session,
        routing: () => Routing,
        tools: ports.tools ?? createToolCallPort({ routing: () => Routing, sessions: () => Session })
    });
    // A firing's task goes to the router (queued, or parked `waiting {environment-offline}` by the trigger for the router to resolve, #42/#37).
    // Fire and forget: the observer never fails a firing, and the Schedule alarm does not wait on the run.
    const trigger =
        ports.trigger ??
        scheduleTrigger({
            environments: createEnvironmentProbe({ machines: () => Machine }),
            onOutcome: (event, outcome) => {
                if (outcome.kind !== 'task' || (outcome.status !== 'queued' && outcome.wait?.kind !== 'environment-offline')) return;
                const ws = event.workspaceId;
                void actor(Routing, routingKey(ws))
                    .with({ context: asPrincipal(userPrincipal(ws, ws)) })
                    .run(outcome.taskId)
                    .catch((e: unknown) => console.warn(`[actors.app] routing ${outcome.taskId} from schedule ${event.scheduleId} failed:`, e));
            }
        });
    return [Workspace, AgentActor, Chat, ChatPage, TaskActor, Session, Machine, Routing, LedgerActor, PairingDirectory, defineScheduleActor({ trigger }), Memory, Inbox];
}

/**
 * The `POST /auth/pair` wiring over the registry: the anonymous directory
 * lookup, then `Machine.pair` as the machine the code was issued for.
 */
export function pairingWiring(actors: readonly AnyActorDefinition[] = defaultActors()): NonNullable<AuthWiring['pairing']> {
    const Machine = machineDefinition(actors);
    const anonymous = (): { locals: Record<string, unknown> } => {
        const context = { locals: {} as Record<string, unknown> };
        setPrincipal(context, null);
        return context;
    };
    return {
        resolve: (code) => actor(PairingDirectory, PAIRING_DIRECTORY_KEY).with({ context: anonymous() }).resolve(code),
        pair: (target, code, info) =>
            actor(Machine, machineKey(target.workspaceId, target.machineId))
                .with({ context: asPrincipal(machinePrincipal(target.workspaceId as WorkspaceId, target.machineId)) })
                .pair(code, info)
    };
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
    secrets.anthropicApiKey = env.ANTHROPIC_API_KEY || undefined;
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
