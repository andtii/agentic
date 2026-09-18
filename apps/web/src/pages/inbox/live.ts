/**
 * `liveNeedsSource` — "Needs you" over the platform actors (#40): the
 * workspace Inbox's list as a live read (every unread `approval` / `input`
 * notification the Sessions pushed), each row's `Session.request(id)` as a
 * live read (the record every client shares), and `Session.respond` for the
 * answer. Both reads re-run on the page's live channel after any turn that
 * changed them, whoever caused it — a decision from the chat, the phone or
 * another tab drops the row here and collapses the card to its record.
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
import type { InboxNotification } from '@agentic/platform';
import type { AgentHue } from '@agentic/ui';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { inboxKeyOf, sessionKeyOf } from '../../actors/keys';
import { formatAge } from '../../mock/workspace';
import type { NeedsRow, NeedsSource, RequestRef, RequestState } from './source';

export type LiveNeedsDefs = Pick<ActorDefs, 'Inbox' | 'Session'>;

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

/** `viewer` is the reactive state `useViewer()()` returns — read at call time, never captured. */
export function liveNeedsSource(defs: LiveNeedsDefs, viewer: Pick<ViewerState, 'workspaceId'>): NeedsSource {
    const sessionKey = (ref: RequestRef): string | null => (viewer.workspaceId ? sessionKeyOf(viewer.workspaceId, ref.sessionId) : null);
    return {
        useRows() {
            const list = useActorState(defs.Inbox, () => viewer.workspaceId && ([inboxKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
            return () => (list.value ?? []).map(rowOf).filter((r): r is NeedsRow => r !== null);
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
                    value: view ? { view, requestedBy: { name: view.agentId, hue: hueOf(view.agentId) } } : null,
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
        age: (at) => formatAge(at, Date.now())
    };
}
