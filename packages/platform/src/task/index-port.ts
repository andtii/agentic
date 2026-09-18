/**
 * The hop from a Task to the workspace's TaskIndex (#146). Awaited — so
 * two writes from one turn land in order — but never a gate: an index
 * that is not registered, refuses or is gone leaves the page stale and
 * the task's own record untouched.
 */

import type { WorkspaceId } from '@agentic/core';
import type { ActorClientWith, AnyActorDefinition } from '@sigx/actors';
import { TaskIndex, taskIndexKey, taskIndexRowOf } from './task-index.js';
import type { TaskState } from './types.js';

/** The slice of an `ActorContext` the hop needs (`ctx` itself satisfies it). */
export interface TaskIndexHops {
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D>;
}

/** Write the task's current row to `{ws}:task-index`; resolves once the index answered or failed. */
export async function indexTask(hops: TaskIndexHops, workspaceId: WorkspaceId, state: TaskState, at: number = Date.now()): Promise<void> {
    try {
        await hops.actor(TaskIndex, taskIndexKey(workspaceId)).upsert(taskIndexRowOf(state, at));
    } catch {
        // The index is a view of the record, never the record: a hop that fails does not fail the work.
    }
}
