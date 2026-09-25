/**
 * The actor definitions the pages read through (#34), as an injectable so
 * each entry provides its own half of the wire without a build transform:
 *
 * - the server (SSR in the Worker) provides the platform definitions
 *   (`platformDefs()` in `actors.app.ts`) — `actor(def, key)` dispatches
 *   in-process through the host seam, straight to the Durable Objects;
 * - the browser provides `clientDefs()` (`./client.ts`): `__actorRef` stubs
 *   that speak the actor mount over HTTP, exactly what `@sigx/actors/vite`
 *   would emit for a `*.actor.ts` module — which the platform's definitions
 *   are not (they are built by `defineSessionActor(ports)` and friends, so
 *   the static extraction cannot see them).
 *
 * Tests provide either, plus their own transport.
 */
import { defineInjectable } from 'sigx';
import type { AgentActor, AuditActor, Chat, ConnectorAccounts, FlatMemory, Inbox, LedgerActor, MachineActor, Memory, Registry, RoutingActor, ScheduleActor, SessionActor, TaskActor, TaskIndex, Workspace } from '@agentic/platform';

import type { PullsActor } from '@agentic/platform';

import type { PlanStoreActor } from '@agentic/platform';

import type { RequestsActor } from '@agentic/platform';

export interface ActorDefs {
    readonly Workspace: typeof Workspace;
    readonly Chat: typeof Chat;
    readonly AgentActor: typeof AgentActor;
    readonly TaskActor: typeof TaskActor;
    readonly Session: SessionActor;
    readonly Routing: RoutingActor;
    /** The workspace Inbox — "Needs you" (#40). */
    readonly Inbox: typeof Inbox;
    /** Machines — `online` for the connection strip and the failure cards (#46). */
    readonly Machine: MachineActor;
    /** One entry per schedule — the Schedules page (#145). */
    readonly Schedule: ScheduleActor;
    /** The workspace Registry — plugins, connectors, secret names (#145). */
    readonly Registry: typeof Registry;
    /** The workspace's task list — Home's active tasks and `/tasks` (#146). */
    readonly TaskIndex: typeof TaskIndex;
    /** The audit log — `/history` (#146). */
    readonly Audit: typeof AuditActor;
    /** The month's ledger — `/usage` and Home's spend (#146). */
    readonly Ledger: typeof LedgerActor;
    /** One per memory scope — the agent Memory tab and the roster's counts (#150). */
    readonly Memory: typeof Memory;
    /** The flat memory plugin's store of a scope, same key (#281) — read instead of `Memory` while that plugin is active. */
    readonly FlatMemory: typeof FlatMemory;
    /** The workspace's connected conduit accounts (#532) — a connector page's status (#533). Summaries only, never credentials. */
    readonly ConnectorAccounts: typeof ConnectorAccounts;

    /** One per project — its pull requests, polled (#742). */
    readonly Pulls: PullsActor;

    /** One per project — its plans, queues, claims and leases (#750). */
    readonly Plan: PlanStoreActor;

    /** One per project — the requests sent to it, triaged by its manager (#758). */
    readonly Requests: RequestsActor;
}

export const useActorDefs = defineInjectable<ActorDefs>('ActorDefs', { hint: 'app.defineProvide(useActorDefs, () => clientDefs()) in the entry (see src/actors/defs.ts).' });

/** The signed-in viewer, as the pages see it — reactive getters over `whoami`. */
export interface ViewerState {
    readonly workspaceId: string | null;
    /** Still asking; `workspaceId` is `null` meanwhile. */
    readonly pending: boolean;
}

/** A hook: called in a component's setup, returns the viewer state for its render. */
export type ViewerHook = () => ViewerState;

export const useViewer = defineInjectable<ViewerHook>('Viewer', { hint: 'app.defineProvide(useViewer, () => viewerHook) in the entry (see src/actors/viewer.ts).' });
