/**
 * What the Schedule actor hands to the rest of the platform when an entry
 * fires. Task creation and Inbox delivery are integration issues; the actor
 * only knows this port (AST-03: nothing here needs a browser or a chat).
 */
import type { AgentId, EnvironmentId, MachineId, ProjectId, ScheduleId, WorkspaceId } from '@agentic/core';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';

export type ScheduleKind = 'reminder' | 'recurring' | 'agent-task';

/** What to do when the entry needs an environment that is offline (AST-05). */
export type OfflinePolicy = 'queue' | 'fail' | 'fallback-api';

/** One firing, as delivered to the `TriggerPort`. */
export interface ScheduleFired {
    readonly type: 'ScheduleFired';
    readonly workspaceId: WorkspaceId;
    readonly scheduleId: ScheduleId;
    /** The actor key the event came from (`{ws}:schedule:{id}`). */
    readonly key: string;
    readonly kind: ScheduleKind;
    readonly title: string;
    /** The instant this occurrence was due. */
    readonly scheduledFor: number;
    /** The instant the reminder actually ran; `firedAt - scheduledFor` is the lateness. */
    readonly firedAt: number;
    /** 1-based count of firings so far for this entry. */
    readonly occurrence: number;
    /** Occurrences that fell between `scheduledFor` and `firedAt` and were skipped (catch-up policy `skip`). */
    readonly skipped: number;
    readonly agentId?: AgentId;
    readonly environmentId?: EnvironmentId;
    /** The folder the fired task runs in (#190); only with `environmentId`. */
    readonly workdir?: string;
    /** The project the fired task belongs to (#332); never with `environmentId` or `workdir`. */
    readonly projectId?: ProjectId;
    /** The machine the fired task runs on (#414); never with `environmentId` or `workdir`. The router resolves the agent's account there — the trigger asks no probe about it. */
    readonly machineId?: MachineId;
    readonly prompt?: string;
    readonly offlinePolicy: OfflinePolicy;
}

/**
 * How the port reaches the rest of the platform: the Schedule actor's own
 * `ctx.actor`, handed over per firing. A hop is not an entry point — no
 * `authorize` re-runs on the callee — which is what a reminder needs: it
 * runs with no principal (nothing entered the system), so an in-process
 * `actor()` call from the port would be refused by `sameWorkspace`.
 */
export interface TriggerHop {
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClient<D>;
}

/**
 * The outbound seam. `scheduleTrigger()` (trigger.ts) is the platform's
 * implementation: a Task (`TaskOrigin {kind: 'schedule'}`) for an entry with
 * an agent, an Inbox notification (`'reminder'`) otherwise; in tests it is a
 * recorder. A rejection is retried by the actor a bounded number of times,
 * then logged and skipped — the calendar never wedges on a failing consumer.
 */
export interface TriggerPort {
    fired(event: ScheduleFired, hop: TriggerHop): void | Promise<void>;
}
