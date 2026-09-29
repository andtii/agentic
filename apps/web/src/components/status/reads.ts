/**
 * The two live reads an interruption is told from (#368), in one place for
 * the chat, task, session and inbox pages: the workspace Audit's newest
 * `session.interrupted` / `session.resumed` / `task.machine-lost` rows (the
 * cause, and whether it went on) and the router's routes (`Routing.get()`:
 * whether a parked route re-opens its session or resumes on its own). Both
 * are live, so "resuming automatically" turns into "resumed" without a
 * reload. `interruptionOf` folds them. Both workspace reads are the inbox store's
 * (#1123), so a page mount opens no socket for them.
 */
import { useData } from 'sigx';
import { actor } from '@sigx/actors';
import type { AuditEvent, AuditPage, Route } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { INTERRUPTION_AUDIT_ROWS, useInboxStore, useWorkspaceStore } from '@agentic/client';
import { auditKeyOf } from '../../actors/keys';
import { INTERRUPTION_KINDS } from './interruption';

/** How many of the newest interruption rows a page reads: enough for what is still on screen. */
export const INTERRUPTION_ROWS = INTERRUPTION_AUDIT_ROWS;

export interface InterruptionReads {
    /** The Audit rows, newest first; empty while loading or unreadable. */
    audit(): readonly AuditEvent[];
    /** Every route the router holds. */
    routes(): readonly Route[];
}

/**
 * Called in a component's setup. The routes and the workspace's interruption rows come from the inbox store (#1123),
 * the app's one live read of each; `taskId`, when given and set, narrows the Audit read to that task's rows — a page
 * read of its own, keyed by the store's live `stats` so every recorded row re-reads it.
 */
export function useInterruptionReads(defs: Pick<ActorDefs, 'Audit' | 'Routing'>, viewer: Pick<ViewerState, 'workspaceId'>, taskId?: () => string | undefined): InterruptionReads {
    const store = useInboxStore();
    const audit = taskId
        ? useData(
            () => {
                const ws = viewer.workspaceId;
                const task = taskId();
                return ws && task ? (['interruptions', ws, task, store.auditRecorded] as const) : false;
            },
            async (key): Promise<AuditPage> => actor(defs.Audit, auditKeyOf(key[1])).list({ kinds: [...INTERRUPTION_KINDS], limit: INTERRUPTION_ROWS, taskId: key[2] })
        )
        : null;
    return {
        audit: () => (audit && taskId?.() ? (audit.value?.events ?? []) : store.interruptions),
        routes: () => store.routes
    };
}

/**
 * A machine id → its name, from the Workspace's machine index (`Workspace.get().machines`, live, through the workspace
 * store, #1118): one read, no `Machine.get` per machine — what a page needs to name the machine a wait or a cut turn names.
 */
export function useMachineNames(_defs: Pick<ActorDefs, 'Workspace'>, _viewer: Pick<ViewerState, 'workspaceId'>): (id: string) => string | undefined {
    const store = useWorkspaceStore();
    return (id) => store.machineNames.get(id);
}
