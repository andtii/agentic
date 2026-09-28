/**
 * The platform on one Node process (#988, architecture §3 "Hosts").
 *
 * `createNodeHost` builds the host-neutral platform (`createPlatform`, #987)
 * over this host's ports — the secrets from `NodeHostEnv`, `fsBucket` files,
 * the local purge, the `Map` of daemon sockets — and runs every actor in ONE
 * `@sigx/actors` host on the given storage (`sqliteStorage` in production),
 * with the default timer scheduler, sharded reminders and roster task
 * liveness. Unlike a Durable Object, the process lives on: `onDeactivate`
 * runs, idle activations are swept, and `host.stop()` drains on shutdown.
 *
 * `fetch` serves every HTTP route in the Worker's order (`entry.cloudflare.ts`):
 *
 *     local owner / dev login / auth / A2A / files / connectors  ->  daemon path refusal  ->  actor mount (`/_sigx/actor`)
 *                    ->  `fallback` (server functions, then the document render)
 *
 * The local owner's claim link and passphrase login (#989) come first when a
 * `localOwner` store is given. On a plain-http request (no https, no
 * `X-Forwarded-Proto: https`) the auth cookies travel as `agentic-*` instead
 * of `__Host-*` — `fetch` and `openActorSocket` rename them at this edge with
 * `@agentic/platform`'s cookie-prefix seam, so a LAN address can sign in.
 *
 * A plain-HTTP request on the daemon socket path gets `identifyDaemon`'s
 * refusal (426, as the Worker answers, #1008) — the upgrade itself is the
 * server's (`daemon` below), so nothing on that path reaches the actor mount.
 *
 * Static assets are the server's (`server.ts`), before this. The sockets are
 * transport-free here: `openActorSocket` builds the `@sigx/actors` socket
 * session for `/_sigx/socket/*`, and `daemon` accepts, feeds and closes a
 * daemon socket with the host-neutral checks from `apps/web/src/daemon`.
 */
import type { AnyActorDefinition, ActorStorage, Host } from '@sigx/actors';
import { defineActorApp, type ActorApp, type HostDefaults } from '@sigx/actors/host';
import { createActorSocketSession, createFetchHandler, type ActorSocketSession } from '@sigx/actors/server';
import { asPrincipal, isSecureRequest, machinePrincipal, plainCookieRequest, plainCookieResponse, type MachineActor } from '@agentic/platform';
import { createA2aMount } from '../../web/src/a2a/mount';
import { observeSlowTurns } from '../../web/src/actors/slow-turns';
import { devLoginEnabled, devLoginRouteFor } from '../../web/src/auth/dev-login';
import { createAuthMount, githubEnabled } from '../../web/src/auth/mount';
import { setSignInOptions } from '../../web/src/auth/sign-in';
import { createConnectorMount } from '../../web/src/connectors/routes';
import { DAEMON_PING, identifyDaemon, parseDaemonSocketPath, verifyDaemonToken, type DaemonIdentity } from '../../web/src/daemon';
import { createFilesMount, type WaitUntilLike } from '../../web/src/files/route';
import { runWithHost } from '../../web/src/host-scope';
import { createPlatform, machineDefinition, pairingWiring, stampServerApp, type HostPorts, type PlatformPorts } from '../../web/src/platform.app';
import { conduitConnectorCatalogue } from '../../web/src/plugins/catalogue';
import { r2ArtifactSink, type R2BucketLike } from '../../web/src/retention';
import { nodeDaemonSockets, type DaemonSocketLike, type NodeDaemonSockets } from './daemon-sockets';
import type { NodeHostEnv } from './home';
import { createLocalOwnerRoutes, type LocalOwnerStore } from './local-owner';

export interface NodeHostOptions {
    /** The actors' durable storage — `sqliteStorage` in production. The purge clears records on it directly. */
    readonly storage: ActorStorage;
    /** Chat attachments and exports — `fsBucket(<home>/files)` in production. */
    readonly bucket: R2BucketLike;
    readonly env: NodeHostEnv;
    /** What the actor mount does not own: server functions, then the document render (`apps/web/src/entry.node.ts`). */
    readonly fallback?: (request: Request) => Response | Promise<Response>;
    /** Host defaults (`callTimeoutMs`, `reminderTickMs`, …); the `@sigx/actors` defaults otherwise. */
    readonly defaults?: HostDefaults;
    /** Overrides of the platform's default ports (tests). */
    readonly ports?: Partial<PlatformPorts>;
    /** The local owner's record (#989): mounts `/auth/claim` and `/auth/local-login`. Absent → neither exists. */
    readonly localOwner?: LocalOwnerStore;
    /** PBKDF2 iterations for the owner's passphrase (tests lower it). */
    readonly passphraseIterations?: number;
    /** The actor registry instead of the platform's (tests). */
    readonly actors?: (platformActors: (ports?: PlatformPorts) => readonly AnyActorDefinition[]) => readonly AnyActorDefinition[];
}

/** A daemon socket the host accepted — handed back on every message and on close. */
export interface AcceptedDaemon {
    readonly who: DaemonIdentity;
}

export interface NodeDaemonEndpoint {
    /** Check an upgrade at `/_agentic/daemon/{id}`: the identity to accept, or the refusal to write. */
    verify(request: Request): Promise<DaemonIdentity | Response>;
    /** The upgrade completed: `ws` is the machine's socket now. */
    opened(who: DaemonIdentity, ws: DaemonSocketLike): void;
    /** One text frame from the daemon. */
    message(who: DaemonIdentity, ws: DaemonSocketLike, text: string): Promise<void>;
    /** The socket closed; the machine goes offline unless a redial replaced it. */
    closed(who: DaemonIdentity, ws: DaemonSocketLike): Promise<void>;
}

export interface NodeHost {
    readonly app: ActorApp;
    readonly host: Host;
    readonly actors: readonly AnyActorDefinition[];
    readonly daemonSockets: NodeDaemonSockets;
    /** Every HTTP route but the static assets. */
    fetch(request: Request, ctx?: WaitUntilLike): Promise<Response>;
    /** The client socket session for an upgrade at `/_sigx/socket/*`. Rejects (after `close`) when the upgrade is refused. */
    openActorSocket(request: Request, send: (message: string) => void, close: (code: number, reason: string) => void): Promise<ActorSocketSession>;
    readonly daemon: NodeDaemonEndpoint;
    /** Drain turns and flush state (`host.stop()`). */
    stop(options?: { timeoutMs?: number }): Promise<void>;
}

/** Start the platform's actors on `options.storage` and return its routes and socket endpoints. */
export async function createNodeHost(options: NodeHostOptions): Promise<NodeHost> {
    const { env, storage } = options;
    const daemonSockets = nodeDaemonSockets();
    // Resolved once the host exists; the purge and `runWithHost` read it at call time.
    let started: Host | undefined;
    const need = (): Host => {
        if (!started) throw new Error('[node] the actor host is not started');
        return started;
    };

    const hostPorts: HostPorts = {
        secrets: {
            sessionSecret: () => env.SESSION_SECRET,
            workspaceKek: () => env.WORKSPACE_KEK,
            appOrigin: () => env.APP_ORIGIN
        },
        files: () => options.bucket,
        artifacts: r2ArtifactSink(() => options.bucket),
        // `deleteAll` / "new session": deactivate the live activation first, so nothing re-saves, then clear the record.
        workspaceStore: {
            async purge(ref) {
                await need().deactivate({ type: ref.type, key: ref.key }, 'explicit');
                const record = await storage.load(ref.type, ref.key);
                if (record) await storage.clear(ref.type, ref.key, record.etag);
            }
        },
        daemonSockets: daemonSockets.port,
        runWithHost
    };

    const platform = createPlatform(hostPorts);
    const ports: PlatformPorts = { ...platform.defaultPorts, ...options.ports };
    const actors = options.actors ? options.actors((p) => platform.actors(p ?? ports)) : platform.actors(ports);
    const Machine: MachineActor = machineDefinition(actors);
    stampServerApp(env.SESSION_SECRET, actors);

    const app = defineActorApp({ storage, actors: [...actors], ...(options.defaults ? { defaults: options.defaults } : {}) });
    const actorFetch = createFetchHandler(app, options.fallback ? { fallback: options.fallback } : {});
    const host = await app.start();
    started = host;
    observeSlowTurns(host);

    const authRoute = createAuthMount({ pairing: pairingWiring(actors), actors, files: platform.files });
    const filesRoute = createFilesMount({ store: platform.files });
    const a2aRoute = createA2aMount({ actors });
    const connectorsRoute = createConnectorMount({ connectors: conduitConnectorCatalogue });
    const localOwnerRoute =
        options.localOwner && env.SESSION_SECRET
            ? createLocalOwnerRoutes({ store: options.localOwner, secret: env.SESSION_SECRET, ...(options.passphraseIterations ? { iterations: options.passphraseIterations } : {}) })
            : null;

    // The daemon socket is upgraded by the server (`daemon`); a request that reaches `fetch` on its path is refused as the Worker does.
    const daemonRefusal = (request: Request): Response | null => {
        if (parseDaemonSocketPath(new URL(request.url).pathname) === null) return null;
        const who = identifyDaemon(request);
        return who instanceof Response ? who : Response.json({ error: 'upgrade_required', detail: 'the daemon socket is a WebSocket' }, { status: 426 });
    };

    let claimed = false;

    const asMachine = (who: DaemonIdentity) => host.actor(Machine, who.key).with({ context: asPrincipal(machinePrincipal(who.workspaceId, who.machineId)) });

    return {
        app,
        host,
        actors,
        daemonSockets,
        fetch(incoming, ctx) {
            // Plain http: `agentic-*` cookies in, `agentic-*` cookies out; everything between reads `__Host-*`.
            const plain = !isSecureRequest(incoming);
            const request = plain ? plainCookieRequest(incoming) : incoming;
            // One host in the process, but the same scope the Worker enters: an ambient hop inside resolves to it.
            return runWithHost(host, async () => {
                // The passphrase door is open once the local owner exists; before that, the shell points at the claim link.
                // Once claimed, a node stays claimed: the record is read (from disk) only until then.
                if (localOwnerRoute && !claimed) claimed = !!options.localOwner!.load().owner;
                const owned = localOwnerRoute ? claimed : null;
                setSignInOptions({ github: githubEnabled(env, request), devLogin: devLoginEnabled(env), localPassphrase: owned === true, localUnclaimed: owned === false });
                const route =
                    (await localOwnerRoute?.(request)) ??
                    devLoginRouteFor(request, env) ??
                    authRoute(request, env) ??
                    a2aRoute(request, env) ??
                    filesRoute(request, env, ctx) ??
                    connectorsRoute(request, env);
                const response = await (route ? route(request) : daemonRefusal(request) ?? actorFetch(request));
                return plain ? plainCookieResponse(response) : response;
            });
        },
        openActorSocket: (request, send, close) =>
            runWithHost(host, () => createActorSocketSession({ host, request: isSecureRequest(request) ? request : plainCookieRequest(request), send, close })),
        daemon: {
            async verify(request) {
                const who = identifyDaemon(request);
                if (who instanceof Response) return who;
                return (await runWithHost(host, () => verifyDaemonToken(who, host, Machine))) ?? who;
            },
            opened(who, ws) {
                daemonSockets.add(who.key, ws);
            },
            async message(who, ws, text) {
                // The keepalive is the host's to answer (#984) — it never reaches the actor.
                if (text === DAEMON_PING) {
                    daemonSockets.pinged(who.key, ws);
                    ws.send(DAEMON_PING);
                    return;
                }
                await runWithHost(host, () => asMachine(who).socketMessage(text));
            },
            async closed(who, ws) {
                if (!daemonSockets.remove(who.key, ws)) return;
                await runWithHost(host, () => asMachine(who).socketClosed());
            }
        },
        stop: (opts) => app.stop(opts)
    };
}
