/**
 * The task list's view model (#146): pure adapters from what the TaskIndex
 * returns — `TaskIndex.list()`, one row per task the workspace's Task
 * actors wrote — to the rows Home's active-tasks table and `/tasks` render
 * with the same columns the mock pages draw. Nothing here touches a hook
 * or the DOM.
 */
import type { TaskStatus } from '@agentic/core';
import type { TaskIndexRow } from '@agentic/platform';
import type { AgentHue, EnvironmentParts } from '@agentic/ui';
import type { AgentLookup } from '../chat/live';
import { waitDetailOf } from './LiveTask';

/** The tasks table template (docs/design/HANDOFF.md → tables) — Home's and `/tasks`', mock and live. */
export const TASK_TABLE_COLS = '100px 1fr 140px 270px 60px';
export const TASK_TABLE_COLUMNS = [{ label: 'Status' }, { label: 'Objective' }, { label: 'Assignee' }, { label: 'Environment' }, { label: 'Age', align: 'end' as const }];

/** What Home lists: everything not settled. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['queued', 'active', 'waiting'];

export type TaskFilter = TaskStatus | 'all';

export const TASK_FILTERS: readonly { readonly value: TaskFilter; readonly label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'waiting', label: 'Waiting' },
    { value: 'active', label: 'Active' },
    { value: 'queued', label: 'Queued' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' }
];

/** One row as the table draws it: the index row plus the assignee's identity. */
export interface TaskListRow {
    readonly id: string;
    readonly objective: string;
    readonly status: TaskStatus;
    readonly wait?: TaskIndexRow['wait'];
    readonly waitDetail?: string;
    readonly agent: { readonly id: string; readonly name: string; readonly hue: AgentHue };
    readonly environment: EnvironmentParts;
    readonly createdAt: number;
    readonly parentId?: string;
    readonly depth: number;
}

/** An index row with its assignee resolved through the agent directory. */
export function taskListRow(row: TaskIndexRow, lookup: AgentLookup, machineName?: (id: string) => string | undefined): TaskListRow {
    const agent = lookup(row.assignee);
    const detail = waitDetailOf(row.wait, machineName);
    return {
        id: row.id,
        objective: row.objective,
        status: row.status,
        ...(row.wait ? { wait: row.wait } : {}),
        ...(detail ? { waitDetail: detail } : {}),
        agent: { id: agent.id, name: agent.name, hue: agent.hue },
        environment: agent.environment,
        createdAt: row.createdAt,
        ...(row.parentId !== undefined ? { parentId: row.parentId } : {}),
        depth: row.depth
    };
}

export const isActiveRow = (row: { readonly status: TaskStatus }): boolean => ACTIVE_STATUSES.includes(row.status);

/** The rows a chip keeps; the index already orders them newest first. */
export function filterTasks<T extends { readonly status: TaskStatus }>(rows: readonly T[], filter: TaskFilter): T[] {
    return filter === 'all' ? [...rows] : rows.filter((r) => r.status === filter);
}

/** How many rows each chip would show. */
export function countTasks(rows: readonly { readonly status: TaskStatus }[]): Record<TaskFilter, number> {
    const out = { all: rows.length, queued: 0, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of rows) out[r.status] += 1;
    return out;
}

/**
 * The chains "Stop all" stops: every active task whose parent is not itself
 * among the active rows — cancelling a root cascades to its subtree
 * (COL-12), so children are never cancelled twice.
 */
export function chainRoots<T extends { readonly id: string; readonly status: TaskStatus; readonly parentId?: string }>(rows: readonly T[]): T[] {
    const active = rows.filter(isActiveRow);
    const ids = new Set(active.map((r) => r.id));
    return active.filter((r) => r.parentId === undefined || !ids.has(r.parentId));
}
