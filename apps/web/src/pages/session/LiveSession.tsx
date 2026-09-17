/**
 * `/sessions/:id` on the platform (#34): the Session actor's record and
 * event log read live, folded by `liveSessionView` into the page body the
 * mock page draws. Cancel, close and approvals go to the actor's own
 * methods; the topbar reads the view (and the actions) from `sessionHead`.
 */
import { component, effect, onUnmounted, signal, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { Decision } from '@sigx/ai-agent';
import { EmptyState } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer } from '../../actors/defs';
import { sessionKeyOf } from '../../actors/keys';
import type { MockSessionView } from '../../mock/workspace';
import { useAgentDirectory } from '../chat/directory';
import { SessionView } from '../Session';
import { liveSessionView } from './live';

/** What the live page tells the topbar: the view for the crumb and the pill, and the two actions. */
export const sessionHead = signal<{ value: { id: string; view: MockSessionView; cancel: () => void; close: () => void } | null }>({ value: null });

export const LiveSession = component<{ id: string }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? sessionKeyOf(viewer.workspaceId, props.id) : null);
    const info = useActorState(defs.Session, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const events = useActorState(defs.Session, () => { const k = key(); return k && ([k, 'events'] as const); }, { live: true });
    const st = signal({ error: '' });
    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };
    const client = () => actor(defs.Session, key()!);

    const view = (): MockSessionView | null => {
        const i = info.value;
        if (!i || !i.opened) return null;
        return liveSessionView(props.id, i, events.value ?? [], directory.lookup(i.spec?.agentId ?? ''));
    };

    const stopHead = effect(() => {
        const v = view();
        sessionHead.value = v ? { id: props.id, view: v, cancel: () => void client().cancel().catch(fail), close: () => void client().close().catch(fail) } : null;
    });
    onUnmounted(stopHead);

    return (): JSXElement => {
        const v = view();
        if (!v) {
            const missing = info.state === 'errored' || (info.value && !info.value.opened) || (!viewer.pending && !viewer.workspaceId);
            return (
                <Page title={missing ? 'Session not found' : 'Session'} page="session" hideTitle>
                    {missing
                        ? <EmptyState variant="generic" title={viewer.workspaceId ? 'No session with that id' : 'Sign in to see your sessions'} caption={info.error?.message ?? `Nothing is called ${props.id}.`} slots={{ actions: () => <Link to="/">Back home</Link> }} />
                        : <p data-panel-note aria-busy="true">Loading session…</p>}
                </Page>
            );
        }
        return (
            <>
                <SessionView v={v} agent={directory.lookup(v.agentId)} onRespond={(requestId: string, decision: Decision) => void client().respond(requestId, decision).catch(fail)} />
                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
            </>
        );
    };
});
