/**
 * What the Schedule actor hands to the rest of the platform when an entry
 * fires. Task creation and Inbox delivery are integration issues; the actor
 * only knows this port (AST-03: nothing here needs a browser or a chat).
 */
import type { AgentId, EnvironmentId, ScheduleId, WorkspaceId } from '@agentic/core';

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
    readonly prompt?: string;
    readonly offlinePolicy: OfflinePolicy;
}

/**
 * The outbound seam. In integration this creates a Task (`kind:
 * 'agent-task'`, `TaskOrigin {kind: 'schedule'}`) or posts an Inbox
 * notification (`'reminder'`); in tests it is a recorder. A rejection is
 * retried by the actor a bounded number of times, then logged and skipped —
 * the calendar never wedges on a failing consumer.
 */
export interface TriggerPort {
    fired(event: ScheduleFired): void | Promise<void>;
}
