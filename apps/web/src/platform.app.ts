/**
 * The platform actor wiring, host-neutral (architecture §3 "Hosts", issues #33, #987).
 *
 * `createPlatform(host)` builds the actor registry over a host's `HostPorts` —
 * its secrets, its chat-file bucket, its artifact sink, its workspace store,
 * its daemon sockets and its host scope. Nothing here imports
 * `@sigx/actors-cloudflare` or `cloudflare:*`: `actors.cloudflare.ts` builds
 * the ports from the Worker's `env` and adds the `ActorHost` Durable Object
 * and the Worker half; another host (Node) builds its own ports and reuses
 * this file verbatim. `stampServerApp` stamps the server app (`authenticate`
 * + principal `codec`) every host half shares.
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
 * platform's `scheduleTrigger()` (#42) over the router — behind
 * `connectorTrigger` (#535), which polls a connector for an entry that
 * watches one and starts a task per new item: the environment
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
import type { ChatFileStore, Principal, TaskId, WorkspaceId } from '@agentic/core';
import {
    AgentActor,
    AuditActor,
    ChatPage,
    ConnectorAccounts,
    LedgerActor,
    Memory,
    FlatMemory,
    OAuthClients,
    OAuthGrants,
    PAIRING_DIRECTORY_KEY,
    PairingDirectory,
    RegistryError,
    SessionPage,
    SessionTranscriptPage,
    TaskActor,
    TaskIndex,
    asPrincipal,
    createAnswerFollowUp,
    createEnvironmentProbe,
    createSessionFactory,
    createToolCallPort,
    createChatTitler,
    defineChatActor,
    defineInbox,
    defineMachineActor,
    defineReleaseDirectory,
    defineRegistry,
    defineRoutingActor,
    defineScheduleActor,
    defineSessionActor,
    defineWorkspace,
    importWorkspaceKek,
    ledgerRecorder,
    machineHistorySource,
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
    type MachineSocketPort,
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
    type KekSource,

    definePullsActor,
    type PullSourcePort,
    pmSummaryTrigger,
    pullMergeNotices,
    pullMergeRelease,

    definePlanActor,

    defineRequestsActor,
} from '@agentic/platform';
import { learningDefaultPlugin } from '@agentic/learning';
import { actor, type AnyActorDefinition, type Host } from '@sigx/actors';
import { createServerApp, setPrincipal } from '@sigx/server/server';
import type { ActorDefs } from './actors/defs';
import type { AuthWiring } from './auth';
import { r2ChatFileStore, type R2ChatFileStore } from './files/store';
import { connectorTrigger } from './connectors/trigger';
import type { ConnectorHttp } from './connectors/engine';
import { channelCatalogue, connectorOpener, learningCatalogue, memoryCatalogue, pluginCatalogue, projectFeatureCatalogue, runtimeCatalogue } from './plugins/catalogue';
import type { R2BucketLike } from './retention';
import { githubPullSources, githubRequestIssues, pullsAutopilot, pullsPlacement } from './actors/pulls';

/** The deployment secrets the wiring reads — thunks, since a host may learn them only with its first request. */
export interface HostSecrets {
    /** ≥ 32 chars when set; signs sessions, OAuth transients and agent tokens. */
    sessionSecret(): string | undefined;
    /** base64, 32 bytes — `importWorkspaceKek`. */
    workspaceKek(): string | undefined;
    /** Public origin, e.g. `https://agentic.example`. */
    appOrigin(): string | undefined;
}

/**
 * What a host gives the platform wiring (#987): everything the actor registry needs that is not the
 * same on every host. Cloudflare builds it from `env` (`actors.cloudflare.ts`); a Node host from its own
 * config, disk and sockets.
 */
export interface HostPorts {
    readonly secrets: HostSecrets;
    /** The bucket chat attachments live in (`files/`, #207) — read at call time. */
    readonly files: () => R2BucketLike | undefined;
    /** Where `Workspace.exportAll` writes. */
    readonly artifacts: ArtifactSink;
    /** How `Workspace.deleteAll` (and a "new session") purges a record. */
    readonly workspaceStore: WorkspaceStore;
    /** The daemon sockets the Machine actor sends through. */
    readonly daemonSockets: MachineSocketPort;
    /** Run `fn` with every ambient `actor()` inside resolving through `host` (#137). */
    readonly runWithHost: <T>(host: Host | (() => Host | undefined), fn: () => T) => T;
}

/** The seams an app (or a test) may override; the defaults are the real wiring. */
export interface PlatformPorts {
    /** Runtime id → in-process session, or `null` for a daemon-hosted runtime. Default: `createSessionFactory` over `runtimes`, keys from the Registry. */
    readonly factory?: SessionFactory;
    /** Where each runtime's sessions run — shared by the factory and the router. Default: `runtimeCatalogue` (`src/plugins/catalogue.ts`). */
    readonly runtimes?: RuntimeCatalogue;
    /** The plugins every workspace's Registry lists (#231). Default: `pluginCatalogue` (`src/plugins/catalogue.ts`). */
    readonly catalogue?: readonly CatalogueEntry[];
    /**
     * Where a schedule firing goes. Default: `pmSummaryTrigger` (a project's weekly summary posts to Home, #868) over
     * `connectorTrigger` (an entry watching a connector polls it, #535) over `scheduleTrigger` (the Machines as the
     * environment probe), both starting their tasks through `Routing.run`.
     */
    readonly trigger?: TriggerPort;
    /** `fetch` replacement for a connector trigger's provider calls (tests). Default: the global `fetch`. */
    readonly connectorHttp?: ConnectorHttp;
    /** Channels every notification goes through whatever the Registry says — tests. The workspace's own are `channelPlugins`. */
    readonly channels: readonly NotificationChannel[];
    /** Notification plugin id → implementation, opened per notification when that plugin is on (#244). Default: `channelCatalogue` (`src/plugins/catalogue.ts`). */
    readonly channelPlugins?: ChannelCatalogue;
    /** How the ReleaseDirectory reads the daemon release manifests (#365). Default: the global `fetch`. */
    readonly releasesFetch?: typeof fetch;
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
    /**
     * Where the Pulls actor reads a project's pull requests (#742, #793). Default: the GitHub adapter over the project's
     * credential (#840, `projectPullToken`) — its `github` connector's secret, else the workspace's `github` connector,
     * else the workspace's `github-token` secret under the git plugin's `secret:github-token` grant.
     */
    readonly pulls?: PullSourcePort;
}

/** A host's platform: its chat file store, its default ports and the actor registry over them. */
export interface Platform {
    /**
     * The deployment's chat file store (#207): the host's bucket under `files/`. One per
     * isolate — the actors' ports and the upload routes (`src/files/route.ts`) share it,
     * and so may any other route that serves chat files (the platform MCP server, #209).
     */
    readonly files: R2ChatFileStore;
    /** The real wiring over the host's ports; an app (or a test) overrides any of them. */
    readonly defaultPorts: PlatformPorts;
    /** Every platform actor this deployment hosts. */
    actors(ports?: PlatformPorts): readonly AnyActorDefinition[];
}

/** Build the platform over a host's ports (#987). */
export function createPlatform(host: HostPorts): Platform {
    const files = r2ChatFileStore(host.files);
    const defaultPorts: PlatformPorts = {
        sink: host.artifacts,
        files,
        store: host.workspaceStore,
        // Throws before the import when the secret is missing, so the Registry does not cache the refusal.
        kek: () => {
            const workspaceKek = host.secrets.workspaceKek();
            if (!workspaceKek) throw new RegistryError('no-kek', '[actors.app] WORKSPACE_KEK is not set: secrets cannot be stored (wrangler secret put WORKSPACE_KEK)');
            return importWorkspaceKek(workspaceKek);
        },
        // Web Push is a notification plugin (#244): `channelPlugins`, opened per workspace while its plugin is on.
        channels: []
    };
    return { files, defaultPorts, actors: (ports = defaultPorts) => platformActors(host, defaultPorts, ports) };
}

function platformActors(host: HostPorts, defaultPorts: PlatformPorts, ports: PlatformPorts): readonly AnyActorDefinition[] {
    // Session, Machine and Routing reference each other: every cross-reference is a thunk resolved at call time.
    // Chat attachments (#207): one store, passed everywhere it is used (architecture §7, "Wiring the file store").
    const files = ports.files ?? defaultPorts.files;
    const withFiles = files ? { files } : {};
    // The build's plugins (#231): the Registry lists them, the router gates on them, a local runtime's key is their secret.
    const kek = ports.kek ?? defaultPorts.kek;
    // Switching the active memory plugin moves the memories between these implementations (#243).
    const Registry = defineRegistry({ ...(kek ? { kek } : {}), catalogue: ports.catalogue ?? pluginCatalogue, memoryPlugins: memoryCatalogue, projectFeatures: projectFeatureCatalogue });
    const registry = () => Registry;
    // Notification channels (#244): the static ones, then every enabled notification plugin this build implements — one Registry hop per notification.
    // The Workspace's notification prefs decide first (#302): push off reaches no channel, inbox off records without counting unread.
    const Inbox = defineInbox({ channels: ports.channels, channelPlugins: ports.channelPlugins ?? channelCatalogue, registry, workspace: () => Workspace });
    // Memory and learning (#242): the workspace's active plugin of each, from the gate the router recorded on the spec. The
    // tools reach the same store the session retrieves from, on both paths.
    const learning = platformLearningPorts({ plugin: learningCatalogue[learningDefaultPlugin.id]!({}), memoryPlugins: memoryCatalogue, learningPlugins: learningCatalogue });
    const memory = (gate: RegistryGate | undefined): SessionMemory => memoryAccess(learning, gate);
    // Conduit connectors (#533): a session's engine names the deployment's callback, though it never begins a sign-in.
    const runtimes = ports.runtimes ?? runtimeCatalogue({ routing: () => Routing, sessions: () => Session, machines: () => Machine, pulls: () => Pulls, memory, ...withFiles }, { origin: host.secrets.appOrigin });
    const Session = defineSessionActor({
        factory: ports.factory ?? createSessionFactory({ routing: () => Routing, sessions: () => Session, machines: () => Machine, pulls: () => Pulls, registry, runtimes, ...withFiles }),
        commands: { send: (t, command) => actor(Machine, machineKey(t.workspaceId, t.machineId)).with({ context: asPrincipal(userPrincipal(t.workspaceId, t.workspaceId)) }).sendCommand(t.sessionId, command) },
        // The machine owns a daemon session's history (#397): the record keeps `RETAINED_PAGES` pages and reads older events here.
        history: machineHistorySource(() => Machine),
        usage: ledgerRecorder(),
        learning,
        // Approvals (#40): every request, on both paths, becomes an Inbox notification the user answers from any client.
        inbox: () => Inbox,
        // A late answer to a detached `ask_user` (#285): posted in the chat, and the asker started again with it.
        answered: createAnswerFollowUp({ routing: () => Routing })
    });
    const sink = ports.sink ?? defaultPorts.sink;
    const store = ports.store ?? defaultPorts.store;
    // "New session" (#399): the router ends a chat member's session and purges its record and pages through the same store `deleteAll` uses.
    // A placement in a project with Git on watches its repo and links the chat's branch to the task (#793).
    const Routing: RoutingActor = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry, runtimes, projectFeatures: projectFeatureCatalogue, placed: pullsPlacement(() => Pulls), ...withFiles, ...(store ? { store } : {}) });
    // Daemon updates (#365): the global release directory every Machine compares its daemon against; update notices go to the Inbox.
    const Releases = defineReleaseDirectory(ports.releasesFetch ? { fetch: ports.releasesFetch } : {});
    const Machine: MachineActor = defineMachineActor({
        socket: host.daemonSockets,
        sessions: () => Session,
        routing: () => Routing,
        releases: () => Releases,
        inbox: () => Inbox,
        // A daemon session's conduit connectors run here, through the opener local sessions use (#534).
        tools: ports.tools ?? createToolCallPort({ routing: () => Routing, sessions: () => Session, machines: () => Machine, pulls: () => Pulls, registry, memory, connectors: connectorOpener({ origin: host.secrets.appOrigin }), ...withFiles })
    });
    // A firing's task goes to the router (queued, or parked `waiting {environment-offline}` by the trigger for the router to resolve, #42/#37).
    // Fire and forget: the observer never fails a firing, and the Schedule alarm does not wait on the run.
    const route = (ws: WorkspaceId, taskId: TaskId, from: string): void => {
        void actor(Routing, routingKey(ws))
            .with({ context: asPrincipal(userPrincipal(ws, ws)) })
            .run(taskId)
            .catch((e: unknown) => console.warn(`[actors.app] routing ${taskId} from ${from} failed:`, e));
    };
    // A project's weekly summary (#868) posts the week to Home; an entry that watches a connector (#535) polls it and
    // starts a task per new item; every other firing is `scheduleTrigger`'s.
    const trigger =
        ports.trigger ??
        pmSummaryTrigger({
            next: connectorTrigger({
                fallback: scheduleTrigger({
                    environments: createEnvironmentProbe({ machines: () => Machine }),
                    onOutcome: (event, outcome) => {
                        if (outcome.kind !== 'task' || (outcome.status !== 'queued' && outcome.wait?.kind !== 'environment-offline')) return;
                        route(event.workspaceId, outcome.taskId, `schedule ${event.scheduleId}`);
                    }
                }),
                route: (ws, taskId) => route(ws, taskId, 'a connector trigger'),
                origin: host.secrets.appOrigin,
                ...(ports.connectorHttp ? { http: ports.connectorHttp } : {})
            })
        });
    // A project's pull requests (#742): read through the git feature's GitHub adapter with the project's credential (#840),
    // falling back to the workspace's token (#793); no credential → the view says `needs-sign-in`.
    // Autopilot (#820): turns in the PR's chat through the router, rows to the Inbox, the merge through the same adapter and credential (#915).
    // A merge tells the requesters whose request became the plan item it finishes, in their chat, as the manager (#868).
    const Pulls = definePullsActor({ sources: ports.pulls ?? githubPullSources({ registry, workspace: () => Workspace }), autopilot: pullsAutopilot({ routing: () => Routing, inbox: () => Inbox, registry, workspace: () => Workspace }), merged: pullMergeRelease({ routing: () => Routing, then: pullMergeNotices() }), inbox: () => Inbox });
    const Workspace = defineWorkspace({ ...(sink ? { sink } : {}), ...(store ? { store } : {}), ...withFiles });
    // Removing a member ends its session through the router (#399, architecture §6). A chat titles itself (#460): the
    // runtime's title when one reports it, else the platform's own model call with the workspace's Anthropic key.
    const Chat = defineChatActor({ ...withFiles, routing: () => Routing, titles: createChatTitler({ registry }) });
    // `OAuthClients` / `OAuthGrants`: the OAuth 2.1 server's store for external MCP clients (#50, `src/auth/oauth-server`).
    // `ConnectorAccounts`: conduit's accounts, handshakes and refresh locks per workspace (#532, #533) — the one `ActorHost` DO serves it.
    return [
        Workspace, AgentActor, Chat, ChatPage, TaskActor, TaskIndex, Session, SessionPage, SessionTranscriptPage, Machine, Routing, LedgerActor, AuditActor, PairingDirectory, Releases, defineScheduleActor({ trigger }), Memory, FlatMemory, Inbox, Registry, ConnectorAccounts, OAuthClients, OAuthGrants,

        Pulls,

        definePlanActor(),

        // An accept with "open GitHub issue" opens it with the project's GitHub credential (#932).
        defineRequestsActor({ issues: githubRequestIssues({ registry, workspace: () => Workspace }) }),
    ];
}

/**
 * The `POST /auth/pair` wiring over the registry: the anonymous directory
 * lookup, then `Machine.pair` as the machine the code was issued for.
 */
export function pairingWiring(actors: readonly AnyActorDefinition[]): NonNullable<AuthWiring['pairing']> {
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

/** The definitions the pages read through during SSR (`useActorDefs`, #34): the registry's own objects, picked by type. */
export function platformDefs(actors: readonly AnyActorDefinition[]): ActorDefs {
    return defsBy((type) => {
        const def = actors.find((d) => (d as { type: string }).type === type);
        if (!def) throw new Error(`[actors.app] no \`${type}\` actor in the registry`);
        return def;
    });
}

/**
 * The same definitions, read off a running host (#1017): what a host's SSR provides when it holds the
 * registry only through its `Host` — the Node entry (`entry.node.ts`) renders inside the host's own scope
 * (`runWithHost`), so `currentHost()` is the host that serves the reads. Every platform actor is
 * array-registered, so the lookup is synchronous; a lazy or missing one is a wiring error.
 */
export function hostDefs(host: Host): ActorDefs {
    return defsBy((type) => {
        const def = host.definition(type);
        if (!def || typeof (def as { then?: unknown }).then === 'function') throw new Error(`[actors.app] no \`${type}\` actor registered on the host`);
        return def as AnyActorDefinition;
    });
}

function defsBy(byType: (type: string) => AnyActorDefinition): ActorDefs {
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
        Memory: byType('Memory') as ActorDefs['Memory'],
        FlatMemory: byType('FlatMemory') as ActorDefs['FlatMemory'],
        ConnectorAccounts: byType('ConnectorAccounts') as ActorDefs['ConnectorAccounts'],

        Pulls: byType('pulls') as ActorDefs['Pulls'],

        Plan: byType('plan') as ActorDefs['Plan'],

        Requests: byType('requests') as ActorDefs['Requests'],
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

/** A session secret as the platform takes it: shorter than `MIN_SECRET` is treated as absent. */
export function sessionSecretOf(value: string | undefined): string | undefined {
    return value && value.length >= MIN_SECRET ? value : undefined;
}

/**
 * Stamp `createServerApp` once per isolate (last-wins seam in `@sigx/server`);
 * a later call with the same secret is a no-op. Without a session secret the
 * app still decodes principals propagated by a hop but authenticates nobody —
 * fail-closed, never a dev fallback secret. A machine bearer token is checked
 * against the Machine actor's stored hash (`tokenRecord`, read as that
 * machine: the ids in a token are an address, the hash match is the proof).
 */
export function stampServerApp(sessionSecret: string | undefined, actors: readonly AnyActorDefinition[]): void {
    const secret = sessionSecretOf(sessionSecret) ?? '';
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
