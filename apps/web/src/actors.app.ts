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
 * session's `request` reaches the Inbox through the Session (#40). Memory and
 * learning (#41) run through `platformLearningPorts` over the default
 * `@agentic/learning` plugin. Retention (#100, `docs/retention.md`): the
 * Workspace exports to the `ARTIFACTS` bucket and purges each record
 * through its own object (`src/retention.ts`); the Registry seals secrets
 * under `WORKSPACE_KEK`.
 */
import type { Principal, WorkspaceId } from '@agentic/core';
import {
    AgentActor,
    AuditActor,
    Chat,
    ChatPage,
    LedgerActor,
    Memory,
    OAuthClients,
    OAuthGrants,
    PAIRING_DIRECTORY_KEY,
    PairingDirectory,
    RegistryError,
    TaskActor,
    TaskIndex,
    asPrincipal,
    createEnvironmentProbe,
    createSessionFactory,
    createToolCallPort,
    defineInbox,
    defineMachineActor,
    defineRegistry,
    defineRoutingActor,
    defineScheduleActor,
    defineSessionActor,
    defineWorkspace,
    importWorkspaceKek,
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
    type TriggerPort,
    type WorkspaceStore,
    type ArtifactSink,
    type KekSource
} from '@agentic/platform';
import { learningPlugin } from '@agentic/learning';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { defineActorApp, type ActorApp } from '@sigx/actors/host';
import { createHostDurableObject, createWorkerHandler, type DurableObjectNamespaceLike, type DurableObjectStateLike, type DurableWebSocketLike } from '@sigx/actors-cloudflare';
import { createServerApp, setPrincipal } from '@sigx/server/server';
import type { ActorDefs } from './actors/defs';
import type { AuthWiring } from './auth';
import { actorKeyOfObject, createDaemonSocketHost, createDaemonSocketRegistry, forwardDaemonSocket, DAEMON_SOCKET_PREFIX } from './daemon';
import { createPurgeHandler, durableObjectWorkspaceStore, r2ArtifactSink, type R2BucketLike } from './retention';
import { runWithHost } from './host-scope';

export { DAEMON_SOCKET_PREFIX };

/** Bindings and secrets the worker reads (wrangler.jsonc; secrets via `wrangler secret put`). */
export interface PlatformEnv {
    /** The one Durable Object namespace — every actor is an `ActorHost` object. */
    readonly ACTORS: DurableObjectNamespaceLike;
    /** Artifacts and exports (`Workspace.exportAll`). */
    readonly ARTIFACTS?: R2BucketLike;
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
    /**
     * PREVIEW ONLY (#35): when set (≥ 16 chars), `POST /auth/dev-login` mints a
     * `dev_<user>` session for a caller presenting it, so a scripted walk-through
     * can sign in without GitHub. Never set it on production; unset → no route.
     */
    readonly AGENTIC_DEV_LOGIN?: string;
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
    /** Where `Workspace.exportAll` writes. Default: the `ARTIFACTS` R2 bucket. */
    readonly sink?: ArtifactSink;
    /** How `Workspace.deleteAll` purges a record. Default: each actor's own Durable Object (`PURGE_PATH`). */
    readonly store?: WorkspaceStore;
    /** The Registry's secret key. Default: `importWorkspaceKek(WORKSPACE_KEK)`; absent → `no-kek`. */
    readonly kek?: KekSource;
}

/** Secrets and bindings the actor registry reads lazily: it is built once per isolate, before any request carries `env`. */
const secrets: { anthropicApiKey?: string; sessionSecret?: string; workspaceKek?: string; actors?: DurableObjectNamespaceLike; artifacts?: R2BucketLike } = {};

export const defaultPorts: PlatformPorts = {
    anthropic: () => (secrets.anthropicApiKey ? { apiKey: secrets.anthropicApiKey } : undefined),
    sink: r2ArtifactSink(() => secrets.artifacts),
    store: durableObjectWorkspaceStore({ namespace: () => secrets.actors, secret: () => secrets.sessionSecret }),
    // Throws before the import when the secret is missing, so the Registry does not cache the refusal.
    kek: () => {
        if (!secrets.workspaceKek) throw new RegistryError('no-kek', '[actors.app] WORKSPACE_KEK is not set: secrets cannot be stored (wrangler secret put WORKSPACE_KEK)');
        return importWorkspaceKek(secrets.workspaceKek);
    },
    // Web Push lands with VAPID keys (architecture §3).
    channels: []
};

/** The daemon sockets every Machine object in this isolate holds — the Machine actor's `MachineSocketPort`. */
export const daemonSockets = createDaemonSocketRegistry();

/** Every platform actor this deployment hosts. */
export function platformActors(ports: PlatformPorts = defaultPorts): readonly AnyActorDefinition[] {
    // Session, Machine and Routing reference each other: every cross-reference is a thunk resolved at call time.
    const anthropic = ports.anthropic ?? defaultPorts.anthropic;
    const Inbox = defineInbox({ channels: ports.channels });
    const Session = defineSessionActor({
        factory: ports.factory ?? createSessionFactory({ routing: () => Routing, sessions: () => Session, ...(anthropic ? { anthropic } : {}) }),
        commands: { send: (t, command) => actor(Machine, machineKey(t.workspaceId, t.machineId)).with({ context: asPrincipal(userPrincipal(t.workspaceId, t.workspaceId)) }).sendCommand(t.sessionId, command) },
        usage: ledgerRecorder(),
        learning: platformLearningPorts({ plugin: (c) => learningPlugin({ contextFor: () => ({ ...(c.objective ? { objective: c.objective } : {}), ...(c.tags ? { tags: c.tags } : {}) }) }) }),
        // Approvals (#40): every request, on both paths, becomes an Inbox notification the user answers from any client.
        inbox: () => Inbox
    });
    const Routing: RoutingActor = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
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
    const sink = ports.sink ?? defaultPorts.sink;
    const store = ports.store ?? defaultPorts.store;
    const kek = ports.kek ?? defaultPorts.kek;
    const Workspace = defineWorkspace({ ...(sink ? { sink } : {}), ...(store ? { store } : {}) });
    const Registry = defineRegistry(kek ? { kek } : {});
    // `OAuthClients` / `OAuthGrants`: the OAuth 2.1 server's store for external MCP clients (#50, `src/auth/oauth-server`).
    return [Workspace, AgentActor, Chat, ChatPage, TaskActor, TaskIndex, Session, Machine, Routing, LedgerActor, AuditActor, PairingDirectory, defineScheduleActor({ trigger }), Memory, Inbox, Registry, OAuthClients, OAuthGrants];
}

/** The registry this isolate serves — what the OAuth/MCP mount binds its `PlatformPort` to (#50). */
export function platformRegistry(): readonly AnyActorDefinition[] {
    return defaultActors();
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

/** The definitions the pages read through during SSR (`useActorDefs`, #34): the registry's own objects, picked by type. */
export function platformDefs(actors: readonly AnyActorDefinition[] = defaultActors()): ActorDefs {
    const byType = (type: string): AnyActorDefinition => {
        const def = actors.find((d) => (d as { type: string }).type === type);
        if (!def) throw new Error(`[actors.app] no \`${type}\` actor in the registry`);
        return def;
    };
    return {
        Workspace: byType('Workspace') as ActorDefs['Workspace'],
        Chat: byType('Chat') as ActorDefs['Chat'],
        AgentActor: byType('Agent') as ActorDefs['AgentActor'],
        TaskActor: byType('task') as ActorDefs['TaskActor'],
        Session: byType('session') as ActorDefs['Session'],
        Routing: byType('routing') as ActorDefs['Routing'],
        Inbox: byType('Inbox') as ActorDefs['Inbox'],
        Machine: byType('machine') as ActorDefs['Machine'],
        Schedule: byType('Schedule') as ActorDefs['Schedule'],
        Registry: byType('Registry') as ActorDefs['Registry']
    };
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
    secrets.anthropicApiKey = env.ANTHROPIC_API_KEY || undefined;
    secrets.sessionSecret = secret || undefined;
    secrets.workspaceKek = env.WORKSPACE_KEK || undefined;
    secrets.actors = env.ACTORS;
    secrets.artifacts = env.ARTIFACTS;
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
 *
 * Every entry point runs under the object's OWN host (`runWithHost`, #137):
 * `@sigx/actors` resolves an ambient `actor()` through one global that the
 * last-booted object owns, and the platform hops ambiently wherever a call
 * carries its own principal (`actor(def, key).with({ context })` — the
 * Routing driver's clients, `routing().machineOnline`, the tool and learning
 * ports, the Session's command sink). Unscoped, a hop from this object to an
 * actor the last-booted object hosts ran it HERE, on that object's storage.
 * Booting (`this.host()`) happens before the scope is entered: it starts the
 * host and hops nowhere.
 */
export function createActorHost(actors: readonly AnyActorDefinition[] = defaultActors()) {
    const Base = createHostDurableObject<PlatformEnv>({ actors: [...actors], namespace, socket: {} });
    const Machine = machineDefinition(actors);
    return class ActorHost extends Base {
        readonly #daemon;
        readonly #purge;
        constructor(state: DurableObjectStateLike, env: PlatformEnv) {
            ensureServerApp(env, actors);
            super(state, env);
            const own = actorKeyOfObject(state);
            if (own?.type === 'machine') daemonSockets.bind(own.key, state);
            this.#daemon = createDaemonSocketHost({ state, host: () => this.host(), machine: Machine, registry: daemonSockets });
            this.#purge = createPurgeHandler({ state, host: () => this.host(), own, secret: () => secrets.sessionSecret });
        }
        override async fetch(request: Request): Promise<Response> {
            const host = await this.host();
            return runWithHost(host, () => this.#purge.fetch(request) ?? this.#daemon.fetch(request) ?? super.fetch(request));
        }
        override async webSocketMessage(ws: DurableWebSocketLike, message: unknown): Promise<void> {
            const host = await this.host();
            return runWithHost(host, () => (this.#daemon.owns(ws) ? this.#daemon.message(ws, message) : super.webSocketMessage(ws, message)));
        }
        override async webSocketClose(ws: DurableWebSocketLike): Promise<void> {
            const host = await this.host();
            return runWithHost(host, () => (this.#daemon.owns(ws) ? this.#daemon.close(ws) : super.webSocketClose(ws)));
        }
        override async webSocketError(ws: DurableWebSocketLike): Promise<void> {
            const host = await this.host();
            return runWithHost(host, () => (this.#daemon.owns(ws) ? this.#daemon.close(ws) : super.webSocketError(ws)));
        }
        override async alarm(): Promise<void> {
            const host = await this.host();
            return runWithHost(host, () => super.alarm());
        }
    };
}

export interface ActorWorkerOptions {
    readonly actors?: readonly AnyActorDefinition[];
    /** Requests the actor mount does not own (server functions, SSR). */
    readonly fallback?: (request: Request) => Response | Promise<Response> | undefined;
}

/**
 * The Worker half: daemon socket forwarding, actor HTTP mount,
 * object-terminated socket forwarding. Its requests run under the Worker's
 * own host too (`runWithHost`, #137): the Worker hosts nothing, so a hop it
 * makes ambiently (the machine token lookup in `serverAuth`, `pairingWiring`,
 * the MCP mount) must go OUT to the object — never run locally because an
 * object sharing the isolate stamped the global last. The host boots lazily
 * on the first request, so the scope carries a thunk that resolves to it.
 */
export function createActorWorker(options: ActorWorkerOptions = {}) {
    const actors = options.actors ?? defaultActors();
    let app: ActorApp | undefined;
    const handler = createWorkerHandler<PlatformEnv>({
        actors: [...actors],
        namespace,
        socket: { terminate: 'object' },
        app: (base) => (app = defineActorApp(base)),
        ...(options.fallback ? { fetch: { fallback: options.fallback } } : {})
    });
    return {
        fetch(request: Request, env: PlatformEnv, ctx?: unknown): Promise<Response> {
            ensureServerApp(env, actors);
            return runWithHost(
                () => app?.host ?? undefined,
                () => {
                    if (new URL(request.url).pathname.startsWith(DAEMON_SOCKET_PREFIX)) return Promise.resolve(forwardDaemonSocket(request, env.ACTORS));
                    return handler.fetch(request, env, ctx);
                }
            );
        }
    };
}
