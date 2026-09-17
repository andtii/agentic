/** Task actor keys: `{ws}:task:{id}` (architecture §4). */

import { actorKey, type TaskId, type WorkspaceId } from '@agentic/core';
import { TaskStateError } from './errors.js';

/** The actor `type` — the wire, directory and storage name. */
export const TASK_TYPE = 'task';

export function taskKey(workspaceId: WorkspaceId, id: TaskId): string {
    return actorKey(workspaceId, 'task', id);
}

/** Split a task key back into its workspace and task id; throws on any other shape. */
export function parseTaskKey(key: string): { readonly workspaceId: WorkspaceId; readonly id: TaskId } {
    const first = key.indexOf(':');
    const second = first > 0 ? key.indexOf(':', first + 1) : -1;
    if (first <= 0 || second < 0 || key.slice(first + 1, second) !== TASK_TYPE || second === key.length - 1) {
        throw new TaskStateError('bad-key', `not a task key: ${key}`);
    }
    return { workspaceId: key.slice(0, first) as WorkspaceId, id: key.slice(second + 1) as TaskId };
}
