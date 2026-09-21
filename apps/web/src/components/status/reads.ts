/**
 * The two live reads an interruption is told from (#368), in one place for
 * the chat, task, session and inbox pages: the workspace Audit's newest
 * `session.interrupted` / `session.resumed` / `task.machine-lost` rows (the
 * cause, and whether it went on) and the router's routes (`Routing.get()`:
 * whether a parked route re-opens its session or resumes on its own). Both
 * are live, so "resuming automatically" turns into "resumed" without a
 * reload. `interruptionOf` folds them.
 */
import { onMounted, useData } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { AuditEvent, AuditPage, Route } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { auditKeyOf, routingKeyOf, workspaceKeyOf } from '../../actors/keys';
import { INTERRUPTION_KINDS } from './interruption';

/** How many of the newest interruption rows a page reads: enough for what is still on screen. */
export const INTERRUPTION_ROWS = 50;

export interface InterruptionReads {
    /** The Audit rows, newest first; empty while loading or unreadable. */
    audit(): readonly AuditEvent[];
    /** Every route the router holds. */
    routes(): readonly Route[];
}

/** Called in a component's setup. `taskId`, when given, narrows the Audit read to that task's rows. */
export function useInterruptionReads(defs: Pick<ActorDefs, 'Audit' | 'Routing'>, viewer: Pick<ViewerState, 'workspaceId'>, taskId?: () => string | undefined): InterruptionReads {
    // `list` takes a query object, which a live read's key cannot carry: the log's live `stats` keys the read instead
    // (as the History page does), so every recorded row re-reads it.
    const stats = useActorState(defs.Audit, () => viewer.workspaceId && ([auditKeyOf(viewer.workspaceId), 'stats'] as const), { live: true });
    const audit = useData(
        () => {
            const ws = viewer.workspaceId;
            return ws ? (['interruptions', ws, taskId?.() ?? '', stats.value?.recorded ?? -1] as const) : false;
        },
        async (key): Promise<AuditPage> => actor(defs.Audit, auditKeyOf(key[1])).list({ kinds: [...INTERRUPTION_KINDS], limit: INTERRUPTION_ROWS, ...(key[2] ? { taskId: key[2] } : {}) })
    );
    // The page cache restores `stats` on a remount without a fetch; re-reading it moves the key.
    onMounted(() => {
        if (stats.hasValue) void stats.refresh();
    });
    const routing = useActorState(defs.Routing, () => viewer.workspaceId && ([routingKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    return {
        audit: () => audit.value?.events ?? [],
        routes: () => routing.value?.routes ?? []
    };
}

/**
 * A machine id → its name, from the Workspace's machine index (`Workspace.get().machines`, live): one read, no
 * `Machine.get` per machine — what a page needs to name the machine a wait or a cut turn names.
 */
export function useMachineNames(defs: Pick<ActorDefs, 'Workspace'>, viewer: Pick<ViewerState, 'workspaceId'>): (id: string) => string | undefined {
    const ws = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    return (id) => ws.value?.machines.find((m) => m.id === id)?.name;
}
