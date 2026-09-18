/**
 * The TaskIndex actor — `{ws}:task-index` (architecture §4 Task; #146):
 * the workspace's list of tasks as ONE record, one denormalised row per
 * task, so the Tasks page and Home's active-tasks table are a single live
 * read (`list(query)`) instead of a `Task.get` per id nobody can enumerate.
 *
 * The Task actor is the source of truth; the index is a view of it. The
 * Task writes a row over a `ctx.actor` hop on `create` and after every
 * status or wait change (`indexTask`, `./index-port.ts`), awaited in turn
 * order and never failing the work — an index that cannot be reached is a
 * stale page, not a lost transition. Rows only move forward: a row whose
 * transition count `n` is below the one held is ignored, so a retried or
 * late hop cannot overwrite a newer status.
 *
 * The record is capped at `TASK_INDEX_CAP` rows: past it the oldest
 * settled tasks drop off the index (their records stay). Persistence is
 * explicit — every `upsert` ends in `ctx.save()` inside the turn (Workers
 * never run `onDeactivate`).
 */

import type { AgentId, ChatId, EnvironmentId, SessionId, TaskId, TaskOrigin, TaskStatus, WaitReason, WorkspaceId } from '@agentic/core';
import { isTerminal } from '@agentic/core';
import { defineActor, type ActorDefinition, type ActorPolicy } from '@sigx/actors';
import { sameWorkspace } from '../auth/index.js';
import type { TaskState } from './types.js';

/** The actor `type` — the wire, directory and storage name. */
export const TASK_INDEX_TYPE = 'task-index';

/** How many rows the index keeps; beyond it the oldest settled rows are dropped. */
export const TASK_INDEX_CAP = 2000;

/** The index of workspace `ws`: `{ws}:task-index`. */
export function taskIndexKey(workspaceId: WorkspaceId | string): string {
    return `${workspaceId}:${TASK_INDEX_TYPE}`;
}

/** One task as the list shows it: what the Task last told the index. */
export interface TaskIndexRow {
    readonly id: TaskId;
    readonly objective: string;
    readonly assignee: AgentId;
    readonly owner: AgentId;
    readonly status: TaskStatus;
    readonly wait?: WaitReason;
    readonly origin: TaskOrigin['kind'];
    /** The chat the task came from (`origin.kind === 'user'`). */
    readonly chatId?: ChatId;
    readonly parentId?: TaskId;
    readonly depth: number;
    readonly environmentId?: EnvironmentId;
    readonly sessionId?: SessionId;
    readonly createdAt: number;
    readonly updatedAt: number;
    /** The Task's transition count when the row was written — the forward-only clock. */
    readonly n: number;
}

export interface TaskIndexQuery {
    /** Only these statuses; default all. */
    readonly status?: readonly TaskStatus[];
    readonly assignee?: string;
    /** Only children of this task; `null` for root tasks only. */
    readonly parentId?: TaskId | null;
    /** Newest (by `createdAt`) first; default all. */
    readonly limit?: number;
}

export interface TaskIndexState {
    v: 1;
    rows: Record<string, TaskIndexRow>;
}

export function initialTaskIndexState(): TaskIndexState {
    return { v: 1, rows: {} };
}

/** A type alias, not an interface: `ActorMethodTable` needs the implicit index signature only aliases carry. */
export type TaskIndexMethods = {
    /** Write a row (hops only). Resolves `true` when the index changed; a row older than the one held is ignored. */
    upsert(row: TaskIndexRow): Promise<boolean>;
    /** The rows a filter keeps, newest first. A live read: `useActorState(TaskIndex, [key, 'list', query], { live: true })` re-runs after every upsert. */
    list(query?: TaskIndexQuery): TaskIndexRow[];
    /** How many rows the index holds. */
    size(): number;
};

/** The row the Task actor writes for its state (`ctx.snapshot()`), `at` being the write time. */
export function taskIndexRowOf(s: TaskState, at: number): TaskIndexRow {
    const createdAt = s.transitions.length ? Math.min(at, s.transitions[0]!.at) : at;
    return {
        id: s.id,
        objective: s.objective,
        assignee: s.assignee,
        owner: s.owner,
        status: s.status,
        ...(s.wait ? { wait: s.wait } : {}),
        origin: s.origin.kind,
        ...(s.origin.kind === 'user' ? { chatId: s.origin.chatId } : {}),
        ...(s.parentId !== undefined ? { parentId: s.parentId } : {}),
        depth: s.depth,
        ...(s.environmentId !== undefined ? { environmentId: s.environmentId } : {}),
        ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
        createdAt,
        updatedAt: at,
        n: s.transitions.length
    };
}

/** Newest first: by `createdAt`, then by id so two tasks born in the same millisecond keep one order. */
export const newestFirst = (a: TaskIndexRow, b: TaskIndexRow): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Drop the oldest settled rows until at most `cap` remain; live rows (queued, active, waiting) are never dropped. */
export function trimIndex(rows: Record<string, TaskIndexRow>, cap: number = TASK_INDEX_CAP): TaskId[] {
    const ids = Object.keys(rows);
    const excess = ids.length - cap;
    if (excess <= 0) return [];
    const settled = ids.map((id) => rows[id]!).filter((r) => isTerminal(r.status)).sort(newestFirst);
    const dropped: TaskId[] = [];
    for (const old of settled.slice(Math.max(0, settled.length - excess))) {
        delete rows[old.id];
        dropped.push(old.id);
    }
    return dropped;
}

/** Over the wire nobody writes the index — only the Task actor's hop, which runs no policy. */
const never: ActorPolicy = () => false;

export const TaskIndex: ActorDefinition<TaskIndexState, TaskIndexMethods, Record<never, never>> = defineActor({
    type: TASK_INDEX_TYPE,
    authorize: [sameWorkspace],
    methodAuthorize: { upsert: never },
    persistence: 'explicit',
    methodReentrancy: { list: 'always', size: 'always' },
    state: initialTaskIndexState,
    methods: (ctx): TaskIndexMethods => {
        const s = ctx.state;
        return {
            async upsert(row) {
                const cur = s.rows[row.id];
                if (cur && (row.n < cur.n || (row.n === cur.n && row.updatedAt < cur.updatedAt))) return false;
                // A known task keeps its first `createdAt`: the clock at creation, not at the latest write.
                s.rows[row.id] = cur ? { ...row, createdAt: Math.min(cur.createdAt, row.createdAt) } : row;
                trimIndex(s.rows);
                await ctx.save();
                return true;
            },
            list(query = {}) {
                const status = query.status ? new Set<string>(query.status) : null;
                const rows = Object.values(ctx.snapshot(s.rows)).filter((r) => {
                    if (status && !status.has(r.status)) return false;
                    if (query.assignee !== undefined && r.assignee !== query.assignee) return false;
                    if (query.parentId === null && r.parentId !== undefined) return false;
                    if (query.parentId != null && r.parentId !== query.parentId) return false;
                    return true;
                });
                rows.sort(newestFirst);
                return query.limit !== undefined ? rows.slice(0, Math.max(0, query.limit)) : rows;
            },
            size() {
                return Object.keys(s.rows).length;
            }
        };
    }
});
