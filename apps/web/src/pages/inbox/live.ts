/**
 * `liveNeedsSource` — "Needs you" over the platform actors (#40): the
 * workspace Inbox's list as a live read (every unread `approval` / `input`
 * notification the Sessions pushed), each row's `Session.request(id)` as a
 * live read (the record every client shares), and `Session.respond` for the
 * answer. Both reads re-run on the page's live channel after any turn that
 * changed them, whoever caused it — a decision from the chat, the phone or
 * another tab drops the row here and collapses the card to its record.
 *
 * Interrupted work (OPS-05, #151) is not a notification: it is the router's
 * own record. The rows also carry every route parked `interrupted`
 * (`Routing.get()`, live), and "Resume" is `Routing.resume(taskId)` — the
 * route runs again and the row leaves, here and in every other tab.
 * #368: the row names why the turn was cut (the Audit's
 * `session.interrupted` row) and, while the route re-opens its session or
 * its agent's `onInterrupt: 'auto'` resumes it, says so with Resume disabled.
 *
 * The definitions come from `useActorDefs` (during SSR the platform's own —
 * `actor()` dispatches in-process through the host seam — in the browser
 * the `__actorRef` stubs that speak the actor mount over HTTP) and the
 * workspace from `useViewer`, reactively: while the viewer is pending the
 * reads park in `idle` and the list is empty. This module never imports
 * `@agentic/platform` at runtime.
 */
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { AuditEvent, InboxNotification, RoutingView } from '@agentic/platform';
import type { TaskId } from '@agentic/core';
import type { AgentHue } from '@agentic/ui';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { interruptionCause, interruptionOf, useInterruptionReads, useMachineNames } from '../../components/status';
import { inboxKeyOf, routingKeyOf, sessionKeyOf } from '../../actors/keys';
import { clockNow, zoneFormat } from '../../time';
import type { NeedsRow, NeedsSource, RequestRef, RequestState } from './source';

export type LiveNeedsDefs = Pick<ActorDefs, 'Inbox' | 'Session' | 'Routing' | 'Audit' | 'Workspace'>;

/** What an interrupted row says under its title (OPS-05: nothing is replayed, the person decides), after its cause. */
export const INTERRUPTED_CONTEXT = 'Nothing was replayed. The transcript is intact.';

/** A stable identity hue for an agent id the page has no record for. */
export function hueOf(id: string): AgentHue {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return ((h % 4) + 1) as AgentHue;
}

/** An inbox notification as a row, or `null` when it is not something a person answers. */
export function rowOf(n: InboxNotification): NeedsRow | null {
    if ((n.kind !== 'approval' && n.kind !== 'input') || n.read) return null;
    if (n.ref?.kind !== 'session' || !n.ref.requestId) return null;
    return {
        id: n.id,
        kind: n.kind,
        title: n.title,
        at: n.at,
        ref: { sessionId: n.ref.sessionId, requestId: n.ref.requestId },
        ...(n.body ? { context: n.body } : {})
    };
}

/**
 * The router's routes parked `interrupted`, as rows: the agent by its frozen config, the cause (the Audit's rows,
 * #368), the chat the task came from (else the task), Resume — disabled while the resume is already under way.
 */
export function interruptedRows(view: Pick<RoutingView, 'routes'> | null | undefined, audit: readonly AuditEvent[] = [], machineName?: (id: string) => string | undefined): NeedsRow[] {
    return (view?.routes ?? [])
        .filter((route) => route.status === 'interrupted')
        .map((route): NeedsRow => {
            const name = route.config.name || route.agentId;
            const cut = interruptionOf({ audit, taskId: route.taskId, ...(route.turnId ? { turnId: route.turnId } : {}), route, ...(machineName ? { machineName } : {}) });
            const cause = interruptionCause(cut);
            return {
                id: `interrupted:${route.taskId}`,
                kind: 'interrupted',
                title: `${name} was interrupted mid-turn`,
                at: route.updatedAt,
                taskId: route.taskId,
                agent: { name, hue: hueOf(route.agentId) },
                context: `Interrupted: ${cause}. ${INTERRUPTED_CONTEXT}`,
                href: route.chatId ? `/chats/${route.chatId}` : `/tasks/${route.taskId}`,
                hrefLabel: route.chatId ? 'Open chat' : 'Open task',
                primary: cut?.resume === 'auto' ? { label: 'Resuming automatically', disabled: true } : cut?.resume === 'resuming' ? { label: 'Resuming…', disabled: true } : { label: 'Resume' }
            };
        });
}

/**
 * `viewer` is the reactive state `useViewer()()` returns — read at call time, never captured.
 * `zone` is the workspace's IANA zone (`useWorkspaceZone`), a getter for the same reason; absent, UTC.
 */
export function liveNeedsSource(defs: LiveNeedsDefs, viewer: Pick<ViewerState, 'workspaceId'>, zone?: () => string): NeedsSource {
    const sessionKey = (ref: RequestRef): string | null => (viewer.workspaceId ? sessionKeyOf(viewer.workspaceId, ref.sessionId) : null);
    return {
        useRows() {
            const list = useActorState(defs.Inbox, () => viewer.workspaceId && ([inboxKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
            const cuts = useInterruptionReads(defs, viewer);
            const machineName = useMachineNames(defs, viewer);
            return () => [...(list.value ?? []).map(rowOf).filter((r): r is NeedsRow => r !== null), ...interruptedRows({ routes: cuts.routes() }, cuts.audit(), machineName)];
        },
        useRequest(ref) {
            const state = useActorState(defs.Session, () => {
                const key = sessionKey(ref);
                return key && ([key, 'request', ref.requestId] as const);
            }, { live: true });
            return (): RequestState => {
                const view = state.value ?? null;
                return {
                    loading: state.loading,
                    value: view ? { view, requestedBy: { name: view.agentName || view.agentId, hue: hueOf(view.agentId) } } : null,
                    error: state.error
                };
            };
        },
        async respond(ref, decision) {
            const key = sessionKey(ref);
            if (!key) throw new Error('not signed in');
            const reply = await actor(defs.Session, key).respond(ref.requestId, decision);
            if (reply.kind === 'error') throw new Error(reply.message);
        },
        async resume(row) {
            if (!row.taskId) return;
            if (!viewer.workspaceId) throw new Error('not signed in');
            await actor(defs.Routing, routingKeyOf(viewer.workspaceId)).resume(row.taskId as TaskId);
        },
        age: (at) => zoneFormat(zone?.()).age(at, clockNow())
    };
}
