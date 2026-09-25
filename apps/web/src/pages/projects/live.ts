/**
 * The workspace's projects on the platform (#333): `Workspace.projects()`
 * read live — the list page, the chat pages (the project chip and the
 * effective folders) and the New chat / New schedule pickers all read the
 * same stream. `lastProjectId` rides on `Workspace.get()`. Writes go through
 * `saveProjectWith` (New project and the Settings tabs).
 */
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
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

export function useProjects(defs: Pick<ActorDefs, 'Workspace'>, viewer: Pick<ViewerState, 'workspaceId'>): Projects {
    const projects = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'projects'] as const), { live: true });
    const index = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    return {
        list: () => projects.value ?? [],
        byId: (id) => (id ? (projects.value ?? []).find((p) => p.id === id) : undefined),
        get loading() {
            return projects.loading;
        },
        lastProjectId: () => index.value?.lastProjectId ?? null
    };
}

/** `upsertProject` on `ws`; resolves to the record (with its id on a create). */
export async function saveProjectWith(defs: Pick<ActorDefs, 'Workspace'>, ws: string, patch: ProjectPatch): Promise<{ readonly id: string }> {
    const record = await actor(defs.Workspace, workspaceKeyOf(ws)).upsertProject(patch);
    return { id: record.id };
}
