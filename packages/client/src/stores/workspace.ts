/**
 * The workspace store (#1118): the one owner of the workspace-index live reads —
 * `Workspace.get`, `projects`, `projectSummaries` and `listMachines` for the
 * viewer's workspace. Every page that needs the zone, the machine names, the
 * projects or the machine index reads them here, so a route change reuses the
 * app's subscriptions instead of redialling the Workspace actor.
 *
 * With no actor definitions or viewer provided (a render on mock data), the
 * store reads nothing and every selector answers empty.
 */
import { computed } from '@sigx/reactivity';
import type { MachineIndexEntry, ProjectSummaries, WorkspaceView } from '@agentic/platform';
import type { ProjectRecord } from '@agentic/core';
import { useActorDefs } from '../defs';
import { useViewer } from '../viewer';
import { defineAppStore } from './define';
import { useLiveActorState, type LiveActorState } from './live';

/** What a workspace without a saved zone uses — the platform's `DEFAULT_SETTINGS.timeZone`. */
export const DEFAULT_WORKSPACE_ZONE = 'UTC';

/** The Workspace root actor's key — the platform's `workspaceKey`, spelled here so the bundle never imports the platform for a string. */
const workspaceKeyOf = (ws: string): string => `ws:${ws}`;

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

export const useWorkspaceStore = defineAppStore('workspace', (ctx) => {
    const defs = optional(useActorDefs);
    const viewer = defs ? optional(() => useViewer()()) : null;
    const key = (): string | null => (viewer?.workspaceId ? workspaceKeyOf(viewer.workspaceId) : null);
    const index = defs && viewer ? useLiveActorState(ctx, defs.Workspace, () => { const k = key(); return k ? ([k, 'get'] as const) : null; }) : idle<WorkspaceView>();
    const projectRecords = defs && viewer ? useLiveActorState(ctx, defs.Workspace, () => { const k = key(); return k ? ([k, 'projects'] as const) : null; }) : idle<readonly ProjectRecord[]>();
    const summaries = defs && viewer ? useLiveActorState(ctx, defs.Workspace, () => { const k = key(); return k ? ([k, 'projectSummaries'] as const) : null; }) : idle<ProjectSummaries>();
    const machineIndex = defs && viewer ? useLiveActorState(ctx, defs.Workspace, () => { const k = key(); return k ? ([k, 'listMachines'] as const) : null; }) : idle<readonly MachineIndexEntry[]>();

    /** `Workspace.get()`: the index (agents, chats, machines, settings); `undefined` until it lands. */
    const view = computed(() => index.value);
    /** The workspace's time zone (`settings.timeZone`), else {@link DEFAULT_WORKSPACE_ZONE}. */
    const zone = computed(() => index.value?.settings.timeZone || DEFAULT_WORKSPACE_ZONE);
    /** Machine id → name, from the index's machines. */
    const machineNames = computed(() => new Map((index.value?.machines ?? []).map((m) => [m.id as string, m.name] as const)));
    /** `Workspace.projects()`, creation order; empty until it lands. */
    const projects = computed(() => projectRecords.value ?? []);
    /** `Workspace.get().lastProjectId`: what the New chat picker preselects. */
    const lastProjectId = computed(() => index.value?.lastProjectId ?? null);
    /** `Workspace.projectSummaries()`; `undefined` until it lands. */
    const projectSummaries = computed(() => summaries.value);
    /** `Workspace.listMachines()`; `undefined` until it lands. */
    const machines = computed(() => machineIndex.value);

    return {
        view,
        zone,
        machineNames,
        projects,
        lastProjectId,
        projectSummaries,
        machines,
        /** The reads themselves, for a page that needs a read's state (`loading`, `error`) as well as its value. */
        indexRead: index,
        projectsRead: projectRecords,
        projectSummariesRead: summaries,
        machinesRead: machineIndex
    };
});
