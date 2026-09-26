/**
 * The live Overview's reads (#933): Your move from the project's work items (`workItemsOf` over the same sources as
 * the Work view — TaskIndex rows whose chat is in the project, pull requests, plan items, the features' stages), the
 * five most recent project chats as the `/chats` list reads them (with the project Chats row's pill, speaker, tiles
 * and linked work), and the project's schedules (`ScheduleSpec.projectId`) from the Workspace index. Each card is
 * `loading` until its first read lands, so it draws skeleton rows rather than its empty line.
 */
import { component, effect, onUnmounted, signal, type JSXElement } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import type { ProjectRecord } from '@agentic/core';
import type { ScheduleView } from '@agentic/platform';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { chatKeyOf, scheduleKeyOf, workspaceKeyOf } from '../../../actors/keys';
import { useAgentDirectory } from '../../chat/directory';
import { LIST_TAIL } from '../../chat/live';
import { useChatRows } from '../../chat/LiveChats';
import { projectChatRow } from '../chats/ProjectChats';
import { chatTaskSummaries, summaryOf } from '../chats/tasks';
import { featuresOf, planItemsOf, projectTasks, useFeatureUi, usePlans, usePullsState, useTaskIndexRows } from '../work/live';
import { workItemsOf } from '../work/model';
import { overviewChatsOf, overviewMovesOf, overviewSchedulesOf } from './live';
import type { AgentNames, OverviewData, OverviewLoading } from './model';

type ChatRead = Parameters<ReturnType<typeof useChatRows>['report']>[0];

/** Renderless: keeps one chat's row current through live reads of `Chat.get` and its newest entries. */
const ChatWatch = component<{ id: string; workspaceId: string; onRead: (read: ChatRead) => void }>(({ props }) => {
    const defs = useActorDefs();
    const summary = useActorState(defs.Chat, () => [chatKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    const tail = useActorState(defs.Chat, () => [chatKeyOf(props.workspaceId, props.id), 'history', null, LIST_TAIL] as const, { live: true });
    const stop = effect(() => {
        if (summary.value && tail.value) props.onRead({ id: props.id, summary: summary.value, newest: tail.value.entries });
    });
    onUnmounted(stop);
    return (): JSXElement => null;
}, { name: 'OverviewChatWatch' });

/** What a schedule's read gave: its view, or `null` when it failed (a deleted entry) — either way it is read. */
type ScheduleRead = ScheduleView | null;

/** Renderless: one schedule's live `Schedule.get()`. */
const ScheduleWatch = component<{ id: string; workspaceId: string; onRead: (id: string, read: ScheduleRead) => void }>(({ props }) => {
    const defs = useActorDefs();
    const view = useActorState(defs.Schedule, () => [scheduleKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    const stop = effect(() => {
        if (view.value) props.onRead(props.id, view.value);
        else if (view.error) props.onRead(props.id, null);
    });
    onUnmounted(stop);
    return (): JSXElement => null;
}, { name: 'OverviewScheduleWatch' });

export interface LiveOverview {
    data(): OverviewData;
    /** Every open chat of the project, for `All N chats →`. */
    chatCount(): number;
    loading(): OverviewLoading;
    readonly names: AgentNames;
    /** The renderless watchers that keep the chats and schedules current: render them beside the view. */
    watchers(): JSXElement;
}

/** The project's Overview data, live. Call in setup; `project` is read on every call (the route may move on). */
export function useLiveOverview(project: () => ProjectRecord): LiveOverview {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const chats = useChatRows(defs, viewer, directory);
    const index = useTaskIndexRows(defs, viewer);
    const uiOf = useFeatureUi(defs, viewer);
    const pulls = usePullsState(() => project().id);
    const plans = usePlans(() => project().id, { defs, viewer });
    const workspace = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const schedules = signal<{ map: Record<string, ScheduleRead> }>({ map: {} });
    const readSchedule = (id: string, read: ScheduleRead): void => {
        if (schedules.map[id] === read) return;
        schedules.map = { ...schedules.map, [id]: read };
    };
    const scheduleIds = (): readonly string[] => workspace.value?.schedules ?? [];

    const projectRows = () => {
        const tasks = chatTaskSummaries(index.rows());
        return chats.rows().map((c) => projectChatRow(c, summaryOf(tasks, c.id)));
    };

    return {
        data: () => {
            const p = project();
            const rows = projectRows();
            const ids = new Set(rows.filter((c) => c.projectId === p.id).map((c) => c.id));
            const items = workItemsOf(projectTasks(index.rows(), ids), pulls.pulls(), planItemsOf(plans.plans()), featuresOf(p, uiOf), Date.now());
            const views = scheduleIds().map((id) => schedules.map[id]).filter((v): v is ScheduleView => !!v);
            const tz = workspace.value?.settings.timeZone ?? 'UTC';
            return { moves: overviewMovesOf(items, p.id), chats: overviewChatsOf(rows, p.id), schedules: overviewSchedulesOf(views, p.id, tz, Date.now()) };
        },
        chatCount: () => overviewChatsOf(projectRows(), project().id).length,
        loading: () => ({
            moves: index.loading || chats.loading || plans.loading,
            chats: chats.loading,
            schedules: workspace.loading || scheduleIds().some((id) => !(id in schedules.map))
        }),
        names: (id) => {
            const a = directory.lookup(id);
            return { name: a.name, hue: a.hue };
        },
        watchers: () => {
            const ws = viewer.workspaceId;
            if (!ws) return null;
            return (
                <>
                    {chats.ids().map((id) => <ChatWatch key={`c:${id}`} id={id} workspaceId={ws} onRead={chats.report} />)}
                    {scheduleIds().map((id) => <ScheduleWatch key={`s:${id}`} id={id} workspaceId={ws} onRead={readSchedule} />)}
                </>
            );
        }
    };
}
