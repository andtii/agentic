/**
 * The live Overview's adapters (#933): pure — the project's work items, chat rows and schedules as the rows the
 * Overview draws. The hooks that read them are in `LiveOverview.tsx`.
 */
import type { WorkItem } from '@agentic/core';
import type { ScheduleView } from '@agentic/platform';
import type { IconName } from '@agentic/ui';
import { chatGroupOf, type ProjectChatRow, type WorkChip } from '../chats/groups';
import { scheduleRow } from '../../ops/live';
import { workItemParam } from '../work/WorkView';
import type { OverviewChat, OverviewChatState, OverviewMove, OverviewSchedule } from './model';

/** The project's **Your move** rows: its `your-move` work items, newest first, each opening its work item page. */
export function overviewMovesOf(items: readonly WorkItem[], projectId: string): OverviewMove[] {
    return items
        .filter((i) => i.group === 'your-move')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((i) => ({
            id: i.id,
            title: i.title,
            detail: i.nextStep,
            href: `/projects/${projectId}/work/${workItemParam(i)}`,
            ...(i.pull !== undefined ? { ref: `#${i.pull}`, refIcon: 'branch' as IconName } : i.itemRef ? { ref: i.itemRef } : { ref: i.taskId ?? 'task', refIcon: 'check' as IconName }),
            at: i.updatedAt
        }));
}

const CHAT_STATE: Readonly<Record<'needs-you' | 'working' | 'quiet', OverviewChatState>> = { 'needs-you': 'needs-you', working: 'working', quiet: 'idle' };

const chipOf = (w: WorkChip): { readonly label: string; readonly icon: IconName } =>
    w.kind === 'task' ? { label: w.id, icon: 'check' } : w.kind === 'pull' ? { label: `#${w.number}`, icon: 'branch' } : { label: `${w.count} tasks`, icon: 'check' };

/** A live row's last line says its speaker (`Forge: …`): the speaker is split off when the row has none of its own. */
function speakerLine(c: Pick<ProjectChatRow, 'speaker' | 'lastLine'>): { lastBy?: string; lastLine: string } {
    if (c.speaker) return { lastBy: c.speaker, lastLine: c.lastLine };
    const m = /^([^:\n]{1,40}): ([\s\S]*)$/.exec(c.lastLine);
    return m ? { lastBy: m[1]!, lastLine: m[2]! } : { lastLine: c.lastLine };
}

/** A project Chats row as an Overview chat: the same pill, speaker and line, members and linked work. */
export function overviewChatOf(c: ProjectChatRow): OverviewChat {
    const group = chatGroupOf(c);
    return {
        id: c.id,
        title: c.title,
        state: CHAT_STATE[group === 'archived' ? 'quiet' : group],
        ...speakerLine(c),
        members: c.agentIds,
        links: c.work.map(chipOf),
        at: c.updatedAt
    };
}

/** The project's open chats (archived ones stay on the Chats page), as Overview chats, newest first. */
export function overviewChatsOf(rows: readonly ProjectChatRow[], projectId: string): OverviewChat[] {
    return rows.filter((c) => c.projectId === projectId && !c.archived).map(overviewChatOf).sort((a, b) => b.at - a.at);
}

/** The project's schedules (`ScheduleSpec.projectId`) with their next run in the workspace zone, in index order. */
export function overviewSchedulesOf(views: readonly ScheduleView[], projectId: string, tz: string, now: number): OverviewSchedule[] {
    return views
        .filter((v) => v.projectId === projectId)
        .map((v) => ({ id: v.id, title: v.title, ...(v.agentId ? { agentId: v.agentId } : {}), next: scheduleRow(v, tz, now).nextRun }));
}
