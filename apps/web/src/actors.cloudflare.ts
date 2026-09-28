/**
 * The platform actor app on Cloudflare (architecture §3, issues #33, #987).
 *
 * The registry itself is host-neutral (`platform.app.ts`, `createPlatform`);
 * this file builds its `HostPorts` from the Worker's `env` — the secrets, the
 * `ARTIFACTS` R2 bucket (chat files and exports), the workspace store over the
 * actors' own Durable Objects, the daemon sockets the Machine objects hold —
 * and adds the two halves of one bundle:
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
 */
import type { AnyActorDefinition, Host } from '@sigx/actors';
import { defineActorApp, type ActorApp } from '@sigx/actors/host';
import { createFetchHandler } from '@sigx/actors/server';
import { createHostDurableObject, durableObjectStubResolver, durableObjects, objectSocketRoute, unhostedStorage, type DurableObjectNamespaceLike, type DurableObjectStateLike, type DurableWebSocketLike } from '@sigx/actors-cloudflare';
import { closeOrphanedLiveSockets } from './actors/hibernation';
import type { ActorDefs } from './actors/defs';
import type { AuthWiring } from './auth';
import { actorKeyOfObject, createDaemonSocketHost, createDaemonSocketRegistry, forwardDaemonSocket, DAEMON_SOCKET_PREFIX } from './daemon';
import { createExportHandler, createExportRoute, type ExportNamespace } from './export';
import { createPurgeHandler, durableObjectWorkspaceStore, r2ArtifactSink, type R2BucketLike } from './retention';
import { runWithHost } from './host-scope';
import { observeSlowTurns } from './actors/slow-turns';
import { createPlatform, machineDefinition, pairingWiring as pairingWiringOf, platformDefs as platformDefsOf, sessionSecretOf, stampServerApp, type HostPorts, type PlatformPorts } from './platform.app';

export { DAEMON_SOCKET_PREFIX };
export { machineDefinition, resetServerAppStamp } from './platform.app';
export type { HostPorts, PlatformPorts } from './platform.app';

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

/** Secrets and bindings the actor registry reads lazily: it is built once per isolate, before any request carries `env`. */
const secrets: { sessionSecret?: string; workspaceKek?: string; appOrigin?: string; actors?: DurableObjectNamespaceLike; artifacts?: R2BucketLike } = {};

/** The daemon sockets every Machine object in this isolate holds — the Machine actor's `MachineSocketPort`. */
export const daemonSockets = createDaemonSocketRegistry();

/** The Cloudflare host's ports (#987), read from `env` by `ensureServerApp`. */
export const cloudflareHostPorts: HostPorts = {
    secrets: {
        sessionSecret: () => secrets.sessionSecret,
        workspaceKek: () => secrets.workspaceKek,
        appOrigin: () => secrets.appOrigin
    },
    files: () => secrets.artifacts,
    artifacts: r2ArtifactSink(() => secrets.artifacts),
    workspaceStore: durableObjectWorkspaceStore({ namespace: () => secrets.actors, secret: () => secrets.sessionSecret }),
    daemonSockets: daemonSockets.port,
    runWithHost
};

const platform = createPlatform(cloudflareHostPorts);

/**
 * The deployment's chat file store (#207): R2, the `ARTIFACTS` bucket under `files/`. One per
 * isolate — the actors' ports and the Worker's upload routes (`src/files/route.ts`) share it,
 * and so may any other Worker route that serves chat files (the platform MCP server, #209).
 */
export const platformFiles = platform.files;

export const defaultPorts: PlatformPorts = platform.defaultPorts;

/** Every platform actor this deployment hosts. */
export function platformActors(ports: PlatformPorts = defaultPorts): readonly AnyActorDefinition[] {
    return platform.actors(ports);
}

let shared: readonly AnyActorDefinition[] | undefined;
/** One registry per isolate, so the Worker, the objects and the `machines` lookup agree on the definitions. */
function defaultActors(): readonly AnyActorDefinition[] {
    return (shared ??= platformActors());
}

/** The registry this isolate serves — what the OAuth/MCP mount binds its `PlatformPort` to (#50). */
export function platformRegistry(): readonly AnyActorDefinition[] {
    return defaultActors();
}

/** The `POST /auth/pair` wiring over the registry (`platform.app.ts`). */
export function pairingWiring(actors: readonly AnyActorDefinition[] = defaultActors()): NonNullable<AuthWiring['pairing']> {
    return pairingWiringOf(actors);
}

/** The definitions the pages read through during SSR (`useActorDefs`, #34). */
export function platformDefs(actors: readonly AnyActorDefinition[] = defaultActors()): ActorDefs {
    return platformDefsOf(actors);
}

/**
 * Read `env` into the host's ports and stamp the server app once per isolate
 * (`stampServerApp`): every request and every object constructor calls it first.
 */
export function ensureServerApp(env: PlatformEnv, actors: readonly AnyActorDefinition[] = defaultActors()): void {
    secrets.sessionSecret = sessionSecretOf(env.SESSION_SECRET);
    secrets.workspaceKek = env.WORKSPACE_KEK || undefined;
    secrets.appOrigin = env.APP_ORIGIN || undefined;
    secrets.actors = env.ACTORS;
    secrets.artifacts = env.ARTIFACTS;
    stampServerApp(secrets.sessionSecret, actors);
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
        readonly #export;
        readonly #orphans;
        constructor(state: DurableObjectStateLike, env: PlatformEnv) {
            ensureServerApp(env, actors);
            super(state, env);
            // A fresh instance holds no live session: sockets left open across a hibernation are told to redial (#714).
            this.#orphans = closeOrphanedLiveSockets(state);
            const own = actorKeyOfObject(state);
            if (own?.type === 'machine') daemonSockets.bind(own.key, state);
            this.#daemon = createDaemonSocketHost({ state, host: () => this.host(), machine: Machine, registry: daemonSockets });
            this.#purge = createPurgeHandler({ state, host: () => this.host(), own, secret: () => secrets.sessionSecret });
            this.#export = createExportHandler({ state, secret: () => secrets.sessionSecret });
        }
        /** The running host, with the slow-turn log attached (#492) — once; the base memoizes the host. */
        override async host(): Promise<Host> {
            const host = await super.host();
            observeSlowTurns(host);
            return host;
        }
        override async fetch(request: Request): Promise<Response> {
            // The export (#994) reads storage only — answered before the host boots, so nothing activates.
            const exported = this.#export.fetch(request);
            if (exported) return exported;
            const host = await this.host();
            return runWithHost(host, () => this.#purge.fetch(request) ?? this.#daemon.fetch(request) ?? super.fetch(request));
        }
        override async webSocketMessage(ws: DurableWebSocketLike, message: unknown): Promise<void> {
            if (this.#orphans.has(ws)) return;
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
            // The state export (#994): fanned out to the listed objects, before (and without) the Worker host.
            const exported = createExportRoute({ namespace: () => env.ACTORS as ExportNamespace, bucket: () => env.ARTIFACTS, secret: () => sessionSecretOf(env.SESSION_SECRET) }).fetch(request);
            if (exported) return exported;
            return (await boot(env))(request);
        }
    };
}
