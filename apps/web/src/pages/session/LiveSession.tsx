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
import type { AgentEvent, Decision } from '@sigx/ai-agent';
import type { TaskId } from '@agentic/core';
import { EmptyState, ErrorNote } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useInterruptionReads } from '../../components/status';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, routingKeyOf, sessionKeyOf } from '../../actors/keys';
import type { MockSessionView } from '../../mock/workspace';
import { useWorkspaceZone, zoneFormat } from '../../time';
import { useAgentDirectory } from '../chat/directory';
import { SessionView } from '../Session';
import { liveSessionView } from './live';
import { callIn, type CallFocus } from './call';
import { liveSessionFiles, machineClientFor, useLiveFilesExtras } from './files-sources';

/** What the live page tells the topbar: the view for the crumb and the pill, and the two actions. */
export const sessionHead = signal<{ value: { id: string; view: MockSessionView; agentName?: string; cancel: () => void; close: () => void } | null }>({ value: null });

export type LiveSessionProps = {
    id: string;
    /** `?call=<callId>` (#1056): the tool call the page opens at. */
    call?: string;
};

export const LiveSession = component<LiveSessionProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const zone = useWorkspaceZone(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? sessionKeyOf(viewer.workspaceId, props.id) : null);
    const info = useActorState(defs.Session, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const events = useActorState(defs.Session, () => { const k = key(); return k && ([k, 'events'] as const); }, { live: true });
    // A daemon session's machine, live: `Machine.online` and the environment's account are two of the four failure signals (OPS-04).
    const machine = useActorState(defs.Machine, () => { const ws = viewer.workspaceId; const m = info.value?.spec?.machineId; return ws && m && ([machineKeyOf(ws, m), 'get'] as const); }, { live: true });
    // The router's route for this session (#368): whether a cut turn re-opens, or resumes on its own.
    const cuts = useInterruptionReads(defs, viewer, () => info.value?.spec?.taskId);
    const extras = useLiveFilesExtras(defs, viewer, () => info.value);
    /** The session's folder (#564): the session bar's Changes and Files tabs. */
    const files = () => (viewer.workspaceId ? liveSessionFiles(props.id, info.value, machine.value, machineClientFor(defs, viewer.workspaceId), { ...extras(), time: zoneFormat(zone()).time }) : null);
    const st = signal({ error: '', recovering: false });
    const fail = (e: unknown): void => { st.error = e instanceof Error ? e.message : String(e); };
    const client = () => actor(defs.Session, key()!);

    /**
     * The requested call (#1056). The log read (`events()`) already spans the window, the retained pages and what the
     * machine still holds; when that read fails on the forgotten range (#397), the retained part alone is read from
     * `archivedTo` on — once per call. Not in either: the session no longer holds it.
     */
    const retained = signal<{ value: { callId: string; events: readonly AgentEvent[] | null; failed: boolean } | null }>({ value: null });
    const stopRetained = effect(() => {
        const callId = props.call;
        const from = info.value?.archivedTo;
        if (!callId || events.state !== 'errored' || !from || !key() || retained.value?.callId === callId) return;
        retained.value = { callId, events: null, failed: false };
        client().events({ epoch: from.epoch, seq: from.seq }).then(
            (evs) => { if (retained.value?.callId === callId) retained.value = { callId, events: evs, failed: false }; },
            () => { if (retained.value?.callId === callId) retained.value = { callId, events: null, failed: true }; }
        );
    });
    onUnmounted(stopRetained);
    const focus = (): CallFocus | undefined => {
        const callId = props.call;
        if (!callId) return undefined;
        const found = events.value ? callIn(props.id, events.value, callId) : null;
        if (found) return { callId, status: 'found', ...found };
        if (events.state === 'errored') {
            const r = retained.value;
            if (!info.value?.archivedTo || r?.failed) return { callId, status: 'missing' };
            if (r?.callId !== callId || !r.events) return { callId, status: 'loading' };
            const held = callIn(props.id, r.events, callId);
            return held ? { callId, status: 'found', ...held } : { callId, status: 'missing' };
        }
        return events.value ? { callId, status: 'missing' } : { callId, status: 'loading' };
    };

    const view = (): MockSessionView | null => {
        const i = info.value;
        if (!i || !i.opened) return null;
        return liveSessionView(props.id, i, events.value ?? [], directory.lookup(i.spec?.agentId ?? ''), machine.value ?? undefined, cuts.routes().find((r) => r.sessionId === props.id) ?? null);
    };

    /** "Resume" on an interrupted turn (OPS-05): through the router when the session runs a task (it follows the new turn), else the session itself. */
    const resume = async (): Promise<void> => {
        const ws = viewer.workspaceId;
        const taskId = info.value?.spec?.taskId;
        if (!ws || st.recovering) return;
        st.recovering = true;
        st.error = '';
        try {
            if (taskId) await actor(defs.Routing, routingKeyOf(ws)).resume(taskId as TaskId);
            else await client().resume();
        } catch (e) {
            fail(e);
        } finally {
            st.recovering = false;
        }
    };

    const stopHead = effect(() => {
        const v = view();
        sessionHead.value = v ? { id: props.id, view: v, agentName: directory.lookup(v.agentId).name, cancel: () => void client().cancel().catch(fail), close: () => void client().close().catch(fail) } : null;
    });
    onUnmounted(stopHead);

    return (): JSXElement => {
        const v = view();
        if (!v) {
            const missing = info.state === 'errored' || (info.value && !info.value.opened) || (!viewer.pending && !viewer.workspaceId);
            return (
                <Page title={missing ? 'Session not found' : 'Session'} page="session" hideTitle>
                    <div data-files-empty>
                        {missing
                            ? <EmptyState variant="generic" title={viewer.workspaceId ? 'No session with that id' : 'Sign in to see your sessions'} caption={info.error?.message ?? `Nothing is called ${props.id}.`} slots={{ actions: () => <Link to="/">Back home</Link> }} />
                            : <p data-panel-note aria-busy="true">Loading session…</p>}
                    </div>
                </Page>
            );
        }
        return (
            <>
                <SessionView v={v} agent={directory.lookup(v.agentId)} onRespond={(requestId: string, decision: Decision) => void client().respond(requestId, decision).catch(fail)} onResume={() => { void resume(); }} recovering={st.recovering} time={zoneFormat(zone()).time} files={files()} {...(focus() ? { focus: focus()! } : {})} />
                {st.error ? <ErrorNote data-chat-error="">{st.error}</ErrorNote> : null}
            </>
        );
    };
});
