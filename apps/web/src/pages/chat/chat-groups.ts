/**
 * `/chats` grouped by project (#732, PRJ-04, projects redesign decision 4): one
 * group per project that has chats, the most recently active first, then the
 * chats in no project (or in a project that no longer exists) last.
 */
import type { ProjectColor } from '@agentic/core';
import type { MockChatSummary } from '../../mock/workspace';

/** What a group header needs of a project. */
export interface ChatGroupProject {
    readonly id: string;
    readonly name: string;
    readonly color?: ProjectColor;
}

export interface ChatGroup {
    /** The project id, or `null` for the "No project" group. */
    readonly key: string | null;
    /** The project; absent for "No project". */
    readonly project?: ChatGroupProject;
    /** The group's chats, in the order they came in. */
    readonly chats: readonly MockChatSummary[];
    /** The newest `updatedAt` among the group's chats. */
    readonly lastActivityAt: number;
}

/**
 * Groups `chats` by their project: projects by recent activity (newest chat first,
 * ties by name), "No project" last. Projects without chats are left out; a chat
 * whose project is not in `projects` counts as in no project. Within a group the
 * chats keep their input order.
 */
export function groupChatsByProject(chats: readonly MockChatSummary[], projects: readonly ChatGroupProject[]): readonly ChatGroup[] {
    const byId = new Map(projects.map((p) => [p.id, p] as const));
    const rows = new Map<string, MockChatSummary[]>();
    const loose: MockChatSummary[] = [];
    for (const chat of chats) {
        const project = chat.projectId ? byId.get(chat.projectId) : undefined;
        if (!project) {
            loose.push(chat);
            continue;
        }
        const list = rows.get(project.id);
        if (list) list.push(chat);
        else rows.set(project.id, [chat]);
    }
    const newest = (list: readonly MockChatSummary[]): number => list.reduce((at, c) => Math.max(at, c.updatedAt), -Infinity);
    const groups: ChatGroup[] = [...rows].map(([id, list]) => ({ key: id, project: byId.get(id), chats: list, lastActivityAt: newest(list) }));
    groups.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.project!.name.localeCompare(b.project!.name));
    if (loose.length) groups.push({ key: null, chats: loose, lastActivityAt: newest(loose) });
    return groups;
}
