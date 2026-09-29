/**
 * The workspace's projects on the platform (#333): `Workspace.projects()`
 * read live — the list page, the chat pages (the project chip and the
 * effective folders) and the New chat / New schedule pickers all read the
 * same stream. `lastProjectId` rides on `Workspace.get()`. Writes go through
 * `saveProjectWith` (New project and the Settings tabs).
 */
import { actor } from '@sigx/actors';
import { useWorkspaceStore } from '@agentic/client';
import type { ProjectPatch, ProjectRecord } from '@agentic/core';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { workspaceKeyOf } from '../../actors/keys';

export interface Projects {
    /** Every project, creation order; empty until the read lands. */
    list(): readonly ProjectRecord[];
    byId(id: string | undefined | null): ProjectRecord | undefined;
    readonly loading: boolean;
    /** `Workspace.get().lastProjectId`: what the New chat picker preselects. */
    lastProjectId(): string | null;
}

/** Over the workspace store (#1118), which owns both reads; the arguments stay for the call sites' shape. */
export function useProjects(_defs: Pick<ActorDefs, 'Workspace'>, _viewer: Pick<ViewerState, 'workspaceId'>): Projects {
    const store = useWorkspaceStore();
    return {
        list: () => store.projects,
        byId: (id) => (id ? store.projects.find((p) => p.id === id) : undefined),
        get loading() {
            return store.projectsRead.loading;
        },
        lastProjectId: () => store.lastProjectId
    };
}

/** `upsertProject` on `ws`; resolves to the record (with its id on a create). */
export async function saveProjectWith(defs: Pick<ActorDefs, 'Workspace'>, ws: string, patch: ProjectPatch): Promise<{ readonly id: string }> {
    const record = await actor(defs.Workspace, workspaceKeyOf(ws)).upsertProject(patch);
    return { id: record.id };
}
