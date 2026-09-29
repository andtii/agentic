/**
 * The task store (#1122): the one owner of the workspace's live `TaskIndex.list()`.
 * The tasks page, Home's active tasks, the agent roster and page, a chat's task
 * panel, a project's chats and its Work board all read the index here, so a
 * route change between them reuses the app's subscription instead of
 * redialling the TaskIndex actor.
 *
 * A live read's arguments are part of its key and must be JSON primitives, so
 * the query object stays out: the whole index (capped at the platform's
 * `TASK_INDEX_CAP` rows) is read once and pages filter it.
 *
 * With no actor definitions or viewer provided (a render on mock data), the
 * store reads nothing and answers empty.
 */
import { computed } from '@sigx/reactivity';
import type { TaskIndexRow } from '@agentic/platform';
import { useActorDefs } from '../defs';
import { useViewer } from '../viewer';
import { defineAppStore } from './define';
import { useLiveActorState, type LiveActorState } from './live';

/** The TaskIndex actor's key — the platform's `taskIndexKey`, spelled here so the bundle never imports the platform for a string. */
const taskIndexKeyOf = (ws: string): string => `${ws}:task-index`;

/** The read a store without actor definitions holds: never loading, never a value. */
const idle = <T>(): LiveActorState<T> => ({ state: 'idle', value: undefined, hasValue: false, loading: false, error: null, refresh: async () => undefined });

/** An injectable the app may not provide (a render on mock data): `null` then. */
function optional<T>(use: () => T): T | null {
    try {
        return use();
    } catch {
        return null;
    }
}

export const useTaskStore = defineAppStore('tasks', (ctx) => {
    // An app that provides no TaskIndex definition (a test of another store, say) reads nothing either.
    const defs = optional(useActorDefs);
    const viewer = defs?.TaskIndex ? optional(() => useViewer()()) : null;
    const index =
        defs?.TaskIndex && viewer
            ? useLiveActorState(ctx, defs.TaskIndex, () => (viewer.workspaceId ? ([taskIndexKeyOf(viewer.workspaceId), 'list'] as const) : null))
            : idle<readonly TaskIndexRow[]>();

    /** `TaskIndex.list()`: every row the index holds, newest first; empty until it lands. */
    const rows = computed((): readonly TaskIndexRow[] => index.value ?? []);

    return {
        rows,
        /** The read itself, for a page that needs its state (`loading`, `error`) as well as its value. */
        read: index
    };
});
