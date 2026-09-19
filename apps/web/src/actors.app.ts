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
 * Plugins (#231): the Registry lists the build's plugins (`src/plugins/
 * catalogue.ts`); the Session factory and the Routing actor share one
 * runtime catalogue. `anthropic-api` runs in-process (`createSessionFactory`)
 * with the workspace's own key — the `anthropic-api-key` Registry secret,
 * set at `/plugins/anthropic-api`; the deployment holds no Anthropic key.
 * Execution routing (#37): the Routing actor gates each run on the
 * Registry and drives tasks to their environment (`Machine.openSession`) or the local runtime,
 * the daemon's `tool.call` runs the platform tools over the actors
 * (`createToolCallPort`), and `POST /auth/pair` resolves codes through the
 * `PairingDirectory` (`pairingWiring`). The Schedule trigger is the
 * platform's `scheduleTrigger()` (#42) over the router: the environment
 * probe reads the Machines, and every task a firing creates — queued, or
 * parked `waiting {environment-offline}` — is handed to `Routing.run`.
 * Delegation (#39): the same tool ports serve `delegate` on both paths; a
 * session's `request` reaches the Inbox through the Session (#40). Memory and
 * learning (#41) run through `platformLearningPorts`, and each session uses
 * the workspace's ACTIVE memory and learning plugin over its config (#242,
 * `memoryCatalogue` / `learningCatalogue`) — the same store its tools reach,
 * on both paths. Retention (#100, `docs/retention.md`): the
 * Workspace exports to the `ARTIFACTS` bucket and purges each record
 * through its own object (`src/retention.ts`); the Registry seals secrets
 * under `WORKSPACE_KEK`. Chat attachments (#207): one `ChatFileStore` on R2
 * (`platformFiles`, `src/files`) reaches the Chat, the router, both tool
 * ports and the Workspace.
 */
import type { ChatFileStore, Principal, WorkspaceId } from '@agentic/core';
import {
    AgentActor,
    AuditActor,
    ChatPage,
    LedgerActor,
    Memory,
    OAuthClients,
    OAuthGrants,
    PAIRING_DIRECTORY_KEY,
    PairingDirectory,
    RegistryError,
    SessionPage,
    TaskActor,
    TaskIndex,
    asPrincipal,
    createEnvironmentProbe,
    createSessionFactory,
    createToolCallPort,
    defineChatActor,
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
    memoryAccess,
    platformLearningPorts,
    principalCodec,
    routingKey,
    scheduleTrigger,
    serverAuth,
    userPrincipal,
    type MachineActor,
    type NotificationChannel,
    type ChannelCatalogue,
    type CatalogueEntry,
    type RoutingActor,
    type RegistryGate,
    type RuntimeCatalogue,
    type SessionMemory,
    type SessionFactory,
    type ToolCallPort,
    type TriggerPort,
    type WorkspaceStore,
    type ArtifactSink,
    type KekSource
} from '@agentic/platform';
import { learningDefaultPlugin } from '@agentic/learning';
import { actor, type AnyActorDefinition, type Host } from '@sigx/actors';
import { defineActorApp, type ActorApp } from '@sigx/actors/host';
import { createFetchHandler } from '@sigx/actors/server';
import { createHostDurableObject, durableObjectStubResolver, durableObjects, objectSocketRoute, unhostedStorage, type DurableObjectNamespaceLike, type DurableObjectStateLike, type DurableWebSocketLike } from '@sigx/actors-cloudflare';
import { createServerApp, setPrincipal } from '@sigx/server/server';
import type { ActorDefs } from './actors/defs';
import type { AuthWiring } from './auth';
import { actorKeyOfObject, createDaemonSocketHost, createDaemonSocketRegistry, forwardDaemonSocket, DAEMON_SOCKET_PREFIX } from './daemon';
import { r2ChatFileStore } from './files/store';
import { channelCatalogue, learningCatalogue, memoryCatalogue, pluginCatalogue, runtimeCatalogue } from './plugins/catalogue';
import { createPurgeHandler, durableObjectWorkspaceStore, r2ArtifactSink, type R2BucketLike } from './retention';
import { runWithHost } from './host-scope';

export { DAEMON_SOCKET_PREFIX };

/** Bindings and secrets the worker reads (wrangler.jsonc; secrets via `wrangler secret put`). */
export interface PlatformEnv {
    /** The one Durable Object namespace — every actor is an `ActorHost` object. */
    readonly ACTORS: DurableObjectNamespaceLike;
    /** Artifacts and exports (`Workspace.exportAll`); chat attachments under `files/` (`src/files`, #207). */
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
     * PREVIEW ONLY (#35): when set (≥ 16 chars), `POST /auth/dev-login` mints a
     * `dev_<user>` session for a caller presenting it, so a scripted walk-through
     * can sign in without GitHub. Never set it on production; unset → no route.
     */
    readonly AGENTIC_DEV_LOGIN?: string;
}

/** The seams an app (or a test) may override; the defaults are the real wiring. */
export interface PlatformPorts {
    /** Runtime id → in-process session, or `null` for a daemon-hosted runtime. Default: `createSessionFactory` over `runtimes`, keys from the Registry. */
    readonly factory?: SessionFactory;
    /** Where each runtime's sessions run — shared by the factory and the router. Default: `runtimeCatalogue` (`src/plugins/catalogue.ts`). */
    readonly runtimes?: RuntimeCatalogue;
    /** The plugins every workspace's Registry lists (#231). Default: `pluginCatalogue` (`src/plugins/catalogue.ts`). */
    readonly catalogue?: readonly CatalogueEntry[];
    /** Where a schedule firing goes. Default: `scheduleTrigger` over the Machines (environment probe) and the router (`Routing.run`). */
    readonly trigger?: TriggerPort;
    /** Channels every notification goes through whatever the Registry says — tests. The workspace's own are `channelPlugins`. */
    readonly channels: readonly NotificationChannel[];
    /** Notification plugin id → implementation, opened per notification when that plugin is on (#244). Default: `channelCatalogue` (`src/plugins/catalogue.ts`). */
    readonly channelPlugins?: ChannelCatalogue;
    /** Platform tools a daemon session calls back through `tool.call`. Default: `createToolCallPort` over the actors. */
    readonly tools?: ToolCallPort;
    /** Where `Workspace.exportAll` writes. Default: the `ARTIFACTS` R2 bucket. */
    readonly sink?: ArtifactSink;
    /** How `Workspace.deleteAll` purges a record. Default: each actor's own Durable Object (`PURGE_PATH`). */
    readonly store?: WorkspaceStore;
    /** The Registry's secret key. Default: `importWorkspaceKek(WORKSPACE_KEK)`; absent → `no-kek`. */
    readonly kek?: KekSource;
    /**
     * Where chat attachments live (#203, #207). Default: `r2ChatFileStore` over the `ARTIFACTS` bucket
     * (`files/<ws>/<chat>/<fileId>`). Passed to the Chat (`markPosted`), the router (image hydration),
     * both tool ports (`chat_file_read`) and the Workspace (the purge).
     */
    readonly files?: ChatFileStore;
}

/** Secrets and bindings the actor registry reads lazily: it is built once per isolate, before any request carries `env`. */
const secrets: { sessionSecret?: string; workspaceKek?: string; actors?: DurableObjectNamespaceLike; artifacts?: R2BucketLike } = {};

/**
 * The deployment's chat file store (#207): R2, the `ARTIFACTS` bucket under `files/`. One per
 * isolate — the actors' ports and the Worker's upload routes (`src/files/route.ts`) share it,
 * and so may any other Worker route that serves chat files (the platform MCP server, #209).
 */
export const platformFiles = r2ChatFileStore(() => secrets.artifacts);

export const defaultPorts: PlatformPorts = {
    sink: r2ArtifactSink(() => secrets.artifacts),
    files: platformFiles,
    store: durableObjectWorkspaceStore({ namespace: () => secrets.actors, secret: () => secrets.sessionSecret }),
    // Throws before the import when the secret is missing, so the Registry does not cache the refusal.
    kek: () => {
        if (!secrets.workspaceKek) throw new RegistryError('no-kek', '[actors.app] WORKSPACE_KEK is not set: secrets cannot be stored (wrangler secret put WORKSPACE_KEK)');
        return importWorkspaceKek(secrets.workspaceKek);
    },
    // Web Push is a notification plugin (#244): `channelPlugins`, opened per workspace while its plugin is on.
    channels: []
};

/** The daemon sockets every Machine object in this isolate holds — the Machine actor's `MachineSocketPort`. */
export const daemonSockets = createDaemonSocketRegistry();

/** Every platform actor this deployment hosts. */
export function platformActors(ports: PlatformPorts = defaultPorts): readonly AnyActorDefinition[] {
    // Session, Machine and Routing reference each other: every cross-reference is a thunk resolved at call time.
    // Chat attachments (#207): one store, passed everywhere it is used (architecture §7, "Wiring the file store").
    const files = ports.files ?? defaultPorts.files;
    const withFiles = files ? { files } : {};
    // The build's plugins (#231): the Registry lists them, the router gates on them, a local runtime's key is their secret.
    const kek = ports.kek ?? defaultPorts.kek;
    const Registry = defineRegistry({ ...(kek ? { kek } : {}), catalogue: ports.catalogue ?? pluginCatalogue });
    const registry = () => Registry;
    // Notification channels (#244): the static ones, then every enabled notification plugin this build implements — one Registry hop per notification.
    const Inbox = defineInbox({ channels: ports.channels, channelPlugins: ports.channelPlugins ?? channelCatalogue, registry });
    // Memory and learning (#242): the workspace's active plugin of each, from the gate the router recorded on the spec. The
    // tools reach the same store the session retrieves from, on both paths.
    const learning = platformLearningPorts({ plugin: learningCatalogue[learningDefaultPlugin.id]!({}), memoryPlugins: memoryCatalogue, learningPlugins: learningCatalogue });
    const memory = (gate: RegistryGate | undefined): SessionMemory => memoryAccess(learning, gate);
    const runtimes = ports.runtimes ?? runtimeCatalogue({ routing: () => Routing, sessions: () => Session, machines: () => Machine, memory, ...withFiles });
    const Session = defineSessionActor({
        factory: ports.factory ?? createSessionFactory({ routing: () => Routing, sessions: () => Session, machines: () => Machine, registry, runtimes, ...withFiles }),
        commands: { send: (t, command) => actor(Machine, machineKey(t.workspaceId, t.machineId)).with({ context: asPrincipal(userPrincipal(t.workspaceId, t.workspaceId)) }).sendCommand(t.sessionId, command) },
        usage: ledgerRecorder(),
        learning,
        // Approvals (#40): every request, on both paths, becomes an Inbox notification the user answers from any client.
        inbox: () => Inbox
    });
    const Routing: RoutingActor = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry, runtimes, ...withFiles });
    const Machine: MachineActor = defineMachineActor({
        socket: daemonSockets.port,
        sessions: () => Session,
        routing: () => Routing,
        tools: ports.tools ?? createToolCallPort({ routing: () => Routing, sessions: () => Session, machines: () => Machine, registry, memory, ...withFiles })
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
    const Workspace = defineWorkspace({ ...(sink ? { sink } : {}), ...(store ? { store } : {}), ...withFiles });
    const Chat = defineChatActor(withFiles);
    // `OAuthClients` / `OAuthGrants`: the OAuth 2.1 server's store for external MCP clients (#50, `src/auth/oauth-server`).
    return [Workspace, AgentActor, Chat, ChatPage, TaskActor, TaskIndex, Session, SessionPage, Machine, Routing, LedgerActor, AuditActor, PairingDirectory, defineScheduleActor({ trigger }), Memory, Inbox, Registry, OAuthClients, OAuthGrants];
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
        Registry: byType('Registry') as ActorDefs['Registry'],
        TaskIndex: byType('task-index') as ActorDefs['TaskIndex'],
        Audit: byType('audit') as ActorDefs['Audit'],
        Ledger: byType('ledger') as ActorDefs['Ledger'],
        Memory: byType('Memory') as ActorDefs['Memory']
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
 * object-terminated socket forwarding. Its requests must run under the
 * Worker's own host (`runWithHost`, #137): the Worker hosts nothing, so a hop
 * it makes ambiently (the machine token lookup in `serverAuth`, `pairingWiring`,
 * the MCP mount) must go OUT to the object — never run locally because an
 * object sharing the isolate stamped the global last. The scope is entered
 * ONCE, at the top of the Worker's `fetch`, around every route — the auth
 * routes hop too (#172) — as `runWithHost(worker.host, ...)`; this `fetch`
 * does not wrap itself, so the entry's scope is the only one.
 *
 * The host boots once per isolate, from `env` alone (`boot`, #182): the app
 * is built the way `createWorkerHandler` builds it (`unhostedStorage`, the
 * `durableObjects` placement, the object-terminated socket route, the public
 * mount with `fallback`) but started on demand rather than by the first
 * MOUNT request — an auth route hops before any mount request on a cold
 * isolate (a daemon's `POST /auth/pair` retry), and found no host
 * (upstream: signalxjs/actors#457 asks for `boot(env)` on the handler). `host` is
 * a thunk the entry's `runWithHost` reads at call time, so a scope entered
 * before the boot resolves to the host once it is up. A failed boot is never
 * cached: the next request retries instead of poisoning the isolate.
 */
export function createActorWorker(options: ActorWorkerOptions = {}) {
    const actors = options.actors ?? defaultActors();
    let app: ActorApp | undefined;
    let booting: Promise<(request: Request) => Promise<Response>> | undefined;
    const build = async (env: PlatformEnv): Promise<(request: Request) => Promise<Response>> => {
        const built = defineActorApp({ storage: unhostedStorage(), actors: [...actors] });
        // The BINDING is captured once (safe: a stub, which workerd refuses to carry across requests, is derived fresh per dispatch); no `isSelf` — the Worker hosts nothing.
        built.use(durableObjects({ namespace: namespace(env), hostId: 'cf-worker' }));
        // `/_sigx/socket/{type}/{key}` is forwarded to that actor's object, which terminates it (`createActorHost`'s `socket`).
        const socket = objectSocketRoute({ resolver: durableObjectStubResolver({ namespace: namespace(env) }) });
        built.use({ name: 'cloudflare:object-socket', setup: (registry) => registry.route(socket) });
        const handle = createFetchHandler(built, options.fallback ? { fallback: options.fallback } : {});
        await built.start();
        app = built;
        return handle;
    };
    const boot = (env: PlatformEnv): Promise<(request: Request) => Promise<Response>> => {
        ensureServerApp(env, actors);
        return (booting ??= build(env).catch((e: unknown) => {
            booting = undefined;
            throw e;
        }));
    };
    return {
        /** The Worker's own host once `boot` ran — what the entry's `runWithHost` resolves through. */
        host: (): Host | undefined => app?.host ?? undefined,
        /** Stamp the server app for `env` and start the Worker host if this isolate has none yet — before any route that hops. */
        boot: async (env: PlatformEnv): Promise<void> => {
            await boot(env);
        },
        async fetch(request: Request, env: PlatformEnv, _ctx?: unknown): Promise<Response> {
            if (new URL(request.url).pathname.startsWith(DAEMON_SOCKET_PREFIX)) {
                ensureServerApp(env, actors);
                return forwardDaemonSocket(request, env.ACTORS);
            }
            return (await boot(env))(request);
        }
    };
}
