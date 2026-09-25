import { component, effect, onUnmounted, signal, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { ProjectId } from '@agentic/core';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { chatKeyOf, taskIndexKeyOf } from '../../../actors/keys';
import { dataMode } from '../../../data-mode';
import { MOCK_PROJECT_CHATS } from '../../../mock/projects/chats';
import { PROJECTS, USER, agentNamed, formatAge } from '../../../mock/workspace';
import { useAgentDirectory } from '../../chat/directory';
import { LIST_TAIL } from '../../chat/live';
import { useChatRows } from '../../chat/LiveChats';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';
import { useProjects } from '../live';
import { ChatsView } from './ChatsView';
import type { ProjectChatRow, WorkChip } from './groups';
import { chatTaskSummaries, summaryOf } from './tasks';

defineTopbar('project-chats', (route) => ({ trail: projectTrail(route, { label: 'Chats', href: `/projects/${String(route.params.id)}/chats` }) }));

/** Most task chips a live row shows before it says `N tasks`. */
const TASK_CHIPS = 2;

/** A chat's root tasks as its linked-work chips: each id, or their count when there are more than fit. */
export function taskChips(taskIds: readonly string[]): WorkChip[] {
    if (taskIds.length > TASK_CHIPS) return [{ kind: 'tasks', count: taskIds.length }];
    return taskIds.map((id) => ({ kind: 'task', id }));
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** On mock data: the sample chats; a move changes them for the page's lifetime. */
const MockProjectChats = component<ProjectPageProps>(({ props }) => {
    const st = signal({ moved: {} as Record<string, string> });
    const rows = (): ProjectChatRow[] => MOCK_PROJECT_CHATS.map((c) => (st.moved[c.id] ? { ...c, projectId: st.moved[c.id] } : c));
    const move = async (ids: readonly string[]): Promise<void> => {
        st.moved = { ...st.moved, ...Object.fromEntries(ids.map((id) => [id, props.project.id])) };
    };
    return () => (
        <ChatsView project={props.project} chats={rows()} projects={PROJECTS} lookup={agentNamed} you={USER.name} age={(at) => formatAge(at)} onMove={move} />
    );
}, { name: 'MockProjectChats' });

type ChatRead = Parameters<ReturnType<typeof useChatRows>['report']>[0];

/** Renderless: keeps one chat's row current through live reads of `Chat.get` and its newest entries (as `/chats` does). */
const ChatWatch = component<{ id: string; workspaceId: string; onRead: (read: ChatRead) => void }>(({ props }) => {
    const defs = useActorDefs();
    const summary = useActorState(defs.Chat, () => [chatKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    const tail = useActorState(defs.Chat, () => [chatKeyOf(props.workspaceId, props.id), 'history', null, LIST_TAIL] as const, { live: true });
    const stop = effect(() => {
        if (summary.value && tail.value) props.onRead({ id: props.id, summary: summary.value, newest: tail.value.entries });
    });
    onUnmounted(stop);
    return (): JSXElement => null;
}, { name: 'ProjectChatWatch' });

/**
 * Live: the workspace's chats as the `/chats` list reads them (`useChatRows`), whose move is whose from the task
 * index (a running task of the chat's tree is WORKING, #258), and "Review and move" calls `Chat.setProject` per chat —
 * the Chat actor runs each feature's release hook server-side.
 */
const LiveProjectChats = component<ProjectPageProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const chats = useChatRows(defs, viewer, directory);
    const projects = useProjects(defs, viewer);
    const index = useActorState(defs.TaskIndex, () => viewer.workspaceId && ([taskIndexKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
    // The chats this page moved: shown in the project at once, before the chat's own read comes back.
    const st = signal({ moved: {} as Record<string, string>, busy: false, error: '' });
    const rows = (): ProjectChatRow[] => {
        // One pass over the index for every chat's roots and working flag, looked up per row (#804).
        const tasks = chatTaskSummaries(index.value ?? []);
        return chats.rows().map((c) => {
            const summary = summaryOf(tasks, c.id);
            // The chat's own read wins once it names a project; until then, the move this page just made.
            const projectId = c.projectId ?? st.moved[c.id];
            return {
                id: c.id,
                title: c.title,
                lastLine: c.lastLine,
                agentIds: c.members.map((m) => m.agentId),
                waiting: c.waiting,
                working: summary.working,
                updatedAt: c.updatedAt,
                ...(projectId ? { projectId } : {}),
                work: taskChips(summary.roots)
            };
        });
    };
    const move = async (ids: readonly string[]): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws) return;
        st.busy = true;
        st.error = '';
        try {
            for (const id of ids) {
                await actor(defs.Chat, chatKeyOf(ws, id)).setProject(props.project.id as ProjectId);
                st.moved = { ...st.moved, [id]: props.project.id };
            }
        } catch (e) {
            st.error = errorText(e);
            throw e;
        } finally {
            st.busy = false;
        }
    };
    return () => (
        <>
        <ChatsView
            project={props.project}
            chats={rows()}
            projects={projects.list()}
            lookup={directory.lookup}
            you="You"
            age={(at) => (at ? formatAge(at, Date.now()) : '')}
            busy={st.busy}
            error={st.error}
            onMove={move}
        />
        {viewer.workspaceId ? chats.ids().map((id) => <ChatWatch key={id} id={id} workspaceId={viewer.workspaceId!} onRead={chats.report} />) : null}
        </>
    );
}, { name: 'LiveProjectChats' });

/** `/projects/:id/chats` — the project’s chats, grouped by who acts next (#731, PRJ-04). */
export const ProjectChats = component<ProjectPageProps>(({ props }) => () => (
    <Page title="Chats" page="project-chats" hideTitle>
        {dataMode() === 'live' ? <LiveProjectChats project={props.project} /> : <MockProjectChats project={props.project} />}
    </Page>
), { name: 'ProjectChats' });
