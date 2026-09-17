/**
 * The platform's `TriggerPort` (issue #42; architecture §4 Schedule;
 * AST-03/04/05, AC-08): what a `ScheduleFired` becomes.
 *
 * - An entry WITHOUT an agent (`kind: 'reminder'`, or a `'recurring'` entry
 *   with no `agentId`) → one Inbox notification of kind `reminder`, pushed
 *   through every configured channel. Nothing here needs a browser or a
 *   machine: the reminder runs from the entry's own Durable Object alarm.
 * - An entry WITH an agent → one Task (`TaskOrigin {kind: 'schedule'}`),
 *   owned and assigned to that agent. It lands `queued` — or, when it needs
 *   an environment that is offline, follows the entry's offline policy:
 *   `queue` / `fallback-api` record `waiting {environment-offline, policy}`
 *   for the router (#37) to resolve; `fail` fails the task and tells the
 *   inbox. With no `EnvironmentProbe` every environment is offline — the
 *   Machine actor (#36) supplies the probe.
 *
 * Exactly once per occurrence: the task id is a pure function of the entry
 * and its `scheduledFor`, and `Task.create` is idempotent, so the Schedule
 * actor's retry of a firing that threw half-way never creates a second task.
 */
import type { EnvironmentId, ScheduleId, TaskContract, TaskId, TaskStatus, WaitReason, WorkspaceId } from '@agentic/core';
import type { ActorClient } from '@sigx/actors';
import { Inbox, inboxKey } from '../notify/index.js';
import { TaskActor, taskKey } from '../task/index.js';
import type { ScheduleFired, TriggerHop, TriggerPort } from './ports.js';

/** Whether an environment can take work right now — the Machine actor's word (#36). */
export interface EnvironmentProbe {
    isOnline(workspaceId: WorkspaceId, environmentId: EnvironmentId): boolean | Promise<boolean>;
}

export interface ScheduleTriggerOptions {
    /** Default: nothing is online (no machine registered). */
    readonly environments?: EnvironmentProbe;
    /** Observe what each firing became (tests, metrics). */
    readonly onOutcome?: (event: ScheduleFired, outcome: ScheduleTriggerOutcome) => void;
}

/** What one firing became. */
export type ScheduleTriggerOutcome =
    | { readonly kind: 'notified'; readonly notificationId: string }
    | { readonly kind: 'task'; readonly taskId: TaskId; readonly status: TaskStatus; readonly wait?: WaitReason };

/** The task an occurrence creates — deterministic, so a retried firing finds the task it already made. */
export function scheduledTaskId(scheduleId: ScheduleId, scheduledFor: number): TaskId {
    return `task_${scheduleId}_${scheduledFor}` as TaskId;
}

/** The `by` label the trigger signs Task transitions with. */
export function scheduleActorLabel(scheduleId: ScheduleId): string {
    return `schedule:${scheduleId}`;
}

/** Deliver one firing through `hop`. Throws only when an actor call does — the Schedule actor then retries. */
export async function deliverScheduleFired(event: ScheduleFired, hop: TriggerHop, options: ScheduleTriggerOptions = {}): Promise<ScheduleTriggerOutcome> {
    const inbox = () => hop.actor(Inbox, inboxKey(event.workspaceId));
    const scheduleRef = { kind: 'schedule', scheduleId: event.scheduleId } as const;

    if (event.kind === 'reminder' || event.agentId === undefined) {
        const notification = await inbox().push({
            kind: 'reminder',
            title: event.title,
            ...(event.prompt !== undefined ? { body: event.prompt } : {}),
            ref: scheduleRef
        });
        return { kind: 'notified', notificationId: notification.id };
    }

    const taskId = scheduledTaskId(event.scheduleId, event.scheduledFor);
    const task = hop.actor(TaskActor, taskKey(event.workspaceId, taskId));
    const contract: TaskContract = {
        objective: event.prompt ?? event.title,
        origin: { kind: 'schedule', scheduleId: event.scheduleId },
        assignee: event.agentId,
        context: [{ type: 'text', text: describe(event) }],
        constraints: {},
        ...(event.environmentId !== undefined ? { environmentId: event.environmentId } : {})
    };
    let view = await task.create(contract, { owner: event.agentId });
    if (view.status !== 'queued') {
        // An earlier attempt of this same occurrence already routed it. The one
        // step that can still be owed is the inbox's word on a `fail` — when the
        // earlier attempt failed the task but threw before the notification landed.
        if (view.status === 'failed' && view.error?.code === OFFLINE_CODE) await notifyTaskFailedOnce(inbox(), taskId, event.title, view.error.message);
        return taskOutcome(taskId, view.status, view.wait);
    }

    if (event.environmentId !== undefined) {
        const online = await (options.environments?.isOnline(event.workspaceId, event.environmentId) ?? false);
        if (!online) {
            const by = scheduleActorLabel(event.scheduleId);
            if (event.offlinePolicy === 'fail') {
                const message = `environment ${event.environmentId} is offline and the entry's offline policy is "fail"`;
                view = await task.fail({ code: OFFLINE_CODE, message, recoverable: false }, by);
                await notifyTaskFailedOnce(inbox(), taskId, event.title, message);
            } else {
                view = await task.reportWaiting({ kind: 'environment-offline', environmentId: event.environmentId, policy: event.offlinePolicy }, by);
            }
        }
    }
    return taskOutcome(taskId, view.status, view.wait);
}

/** The platform's trigger: register it as `defineScheduleActor({ trigger: scheduleTrigger(options) })`. */
export function scheduleTrigger(options: ScheduleTriggerOptions = {}): TriggerPort {
    return {
        async fired(event, hop) {
            const outcome = await deliverScheduleFired(event, hop, options);
            // Observation only: a throwing observer must not fail the firing and
            // send the Schedule actor into a retry that would repeat the side effects.
            try {
                await (options.onOutcome?.(event, outcome) as unknown);
            } catch {
                // best effort
            }
        }
    };
}

/** The `TaskError.code` a `fail` offline policy records. */
const OFFLINE_CODE = 'environment-offline';

/**
 * Tell the inbox a scheduled task failed — once. The Schedule actor retries a
 * firing that threw, and `task.fail` may already have landed when the push
 * did not; so the notification is keyed by the task it is about and only
 * pushed when the inbox has none for it yet.
 */
async function notifyTaskFailedOnce(inbox: ActorClient<typeof Inbox>, taskId: TaskId, title: string, body: string): Promise<void> {
    const existing = await inbox.list();
    if (existing.some((n) => n.kind === 'task-failed' && n.ref?.kind === 'task' && n.ref.taskId === taskId)) return;
    await inbox.push({ kind: 'task-failed', title, body, ref: { kind: 'task', taskId } });
}

function taskOutcome(taskId: TaskId, status: TaskStatus, wait: WaitReason | undefined): ScheduleTriggerOutcome {
    return { kind: 'task', taskId, status, ...(wait ? { wait } : {}) };
}

function describe(event: ScheduleFired): string {
    const due = new Date(event.scheduledFor).toISOString();
    const late = event.skipped > 0 ? `; ${event.skipped} earlier occurrence(s) were skipped` : '';
    return `Scheduled entry "${event.title}" (${event.scheduleId}), occurrence ${event.occurrence}, due ${due}${late}.`;
}
