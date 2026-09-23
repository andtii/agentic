/**
 * The session a Changes or Files view is about (#564), resolved the same way
 * in both data modes: the mock workspace's session and folder fixture, or on
 * the platform the Session record, its machine, the chat and the project —
 * folded into the view, the agent and the `SessionFiles` the view renders
 * from. The live frame also tells the topbar about the session
 * (`sessionHead`), as the Transcript page does.
 */
import { component, effect, onUnmounted, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { EmptyState } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, sessionKeyOf } from '../../actors/keys';
import { dataMode } from '../../data-mode';
import { agentNamed, loadSession, type MockSessionView } from '../../mock/workspace';
import { useWorkspaceZone, zoneFormat } from '../../time';
import { useAgentDirectory } from '../chat/directory';
import type { AgentIdentity } from '../chat/live';
import type { SessionFiles } from './files';
import { liveSessionFiles, machineClientFor, mockSessionFiles, useLiveFilesExtras } from './files-sources';
import { liveSessionView } from './live';
import { sessionHead } from './LiveSession';

export interface SessionFrameContext {
    readonly v: MockSessionView;
    readonly agent: AgentIdentity;
    readonly files: SessionFiles;
}

export type SessionFrameProps =
    & Define.Prop<'id', string, true>
    /** The page title while loading or missing ("Changes", "Files"). */
    & Define.Prop<'title', string, true>
    & Define.Prop<'page', string, true>
    & Define.Prop<'render', (ctx: SessionFrameContext) => JSXElement, true>;

const Missing = (props: { title: string; page: string; id: string; caption?: string; signedOut?: boolean }): JSXElement => (
    <Page title="Session not found" page={props.page} hideTitle flush>
        <div data-files-empty>
            <EmptyState variant="generic" title={props.signedOut ? 'Sign in to see your sessions' : 'No session with that id'} caption={props.caption ?? `Nothing is called ${props.id}.`} slots={{ actions: () => <Link to="/">Back home</Link> }} />
        </div>
    </Page>
);

export const SessionFrame = component<SessionFrameProps>(({ props }) => () => {
    if (dataMode() === 'live') return <LiveSessionFrame id={props.id} title={props.title} page={props.page} render={props.render} />;
    const v = loadSession(props.id);
    if (!v) return <Missing title={props.title} page={props.page} id={props.id} />;
    return props.render({ v, agent: agentNamed(v.agentId), files: mockSessionFiles(v) });
});

const LiveSessionFrame = component<SessionFrameProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const zone = useWorkspaceZone(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? sessionKeyOf(viewer.workspaceId, props.id) : null);
    const info = useActorState(defs.Session, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const machine = useActorState(defs.Machine, () => { const ws = viewer.workspaceId; const m = info.value?.spec?.machineId; return ws && m && ([machineKeyOf(ws, m), 'get'] as const); }, { live: true });
    const extras = useLiveFilesExtras(defs, viewer, () => info.value);

    const context = (): SessionFrameContext | null => {
        const i = info.value;
        const ws = viewer.workspaceId;
        if (!i || !i.opened || !ws) return null;
        const agent = directory.lookup(i.spec?.agentId ?? '');
        const v = liveSessionView(props.id, i, [], agent, machine.value ?? undefined);
        const files = liveSessionFiles(props.id, i, machine.value, machineClientFor(defs, ws), { ...extras(), time: zoneFormat(zone()).time });
        return files ? { v, agent, files } : null;
    };

    const client = () => actor(defs.Session, key()!);
    const stopHead = effect(() => {
        const c = context();
        sessionHead.value = c ? { id: props.id, view: c.v, agentName: c.agent.name, cancel: () => void client().cancel().catch(() => undefined), close: () => void client().close().catch(() => undefined) } : null;
    });
    onUnmounted(stopHead);

    return () => {
        const c = context();
        if (c) return props.render(c);
        const missing = info.state === 'errored' || (info.value && !info.value.opened) || (!viewer.pending && !viewer.workspaceId);
        if (missing) return <Missing title={props.title} page={props.page} id={props.id} signedOut={!viewer.workspaceId} {...(info.error?.message ? { caption: info.error.message } : {})} />;
        return (
            <Page title={props.title} page={props.page} hideTitle flush>
                <p data-panel-note data-files-loading aria-busy="true">Loading session…</p>
            </Page>
        );
    };
});
