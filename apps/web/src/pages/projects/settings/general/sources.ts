/**
 * What the General, Members, Folders and Connectors tabs read and write (#733), on either data source. Live: a save
 * is `Workspace.upsertProject` (`saveProjectWith`) and the layout's live `Workspace.projects()` read brings the record
 * back; the agents come from the chat directory, the machines from the folder-picker directory, the connectors from
 * `Registry.overview()`, Find from `Machine.fsRequest(locate)`. On mock data a save resolves at once into `mockSettingsSaves` (the
 * sample workspace is read-only), the rest is the sample workspace's. `dataMode()` is fixed for an app, so each hook takes
 * one branch for the life of the page.
 */
import { signal } from 'sigx';
import { useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import type { ProjectId, ProjectPatch } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../../../actors/defs';
import { workspaceKeyOf } from '../../../../actors/keys';
import { dataMode } from '../../../../data-mode';
import { opsPlugins } from '../../../../mock/ops';
import { mockSettingsSaves } from '../../../../mock/projects/settings';
import { AGENTS } from '../../../../mock/workspace';
import { useAgentDirectory } from '../../../chat/directory';
import type { AgentIdentity } from '../../../chat/live';
import { useWorkspaceReadiness } from '../../../plugins/readiness';
import { mockWorkdirEnvironments, useLiveWorkdirEnvironments } from '../../../workdir/environments';
import { saveProjectWith } from '../../live';
import { mockLocate, useLiveLocate, type LocateBackend } from '../../locate';
import { connectorOptionsOf, type ProjectMachine } from '../../model';

export type SaveProject = (patch: ProjectPatch) => Promise<void>;

const live = (): boolean => dataMode() === 'live';

function useLiveSave(): SaveProject {
    const defs = useActorDefs();
    const viewer = useViewer()();
    return async (patch) => {
        const ws = viewer.workspaceId;
        if (!ws) throw new Error('Sign in to change the project.');
        await saveProjectWith(defs, ws, patch);
    };
}

/** `upsertProject` live; on mock data a save that always lands, recorded in `mockSettingsSaves`. */
export const useProjectSave = (): SaveProject => (live() ? useLiveSave() : async (patch) => { mockSettingsSaves.push(patch); });

/** A tab's save: in flight, its refusal, and the patch that last landed (as `JSON.stringify`) — "Saved" while the form still says that. */
export interface TabSave {
    readonly state: { busy: boolean; error: string; saved: string };
    run(patch: ProjectPatch): Promise<void>;
}

export function useTabSave(): TabSave {
    const save = useProjectSave();
    const state = signal({ busy: false, error: '', saved: '' });
    return {
        state,
        async run(patch) {
            if (state.busy) return;
            Object.assign(state, { busy: true, error: '', saved: '' });
            try {
                await save(patch);
                state.saved = JSON.stringify(patch);
            } catch (e) {
                state.error = e instanceof Error ? e.message : String(e);
            } finally {
                state.busy = false;
            }
        }
    };
}

/** Delete the project, then back to the list: `Workspace.removeProject` live; on mock data only the navigation. */
export function useProjectRemove(): (id: string) => Promise<void> {
    const router = useRouter();
    if (!live()) return async () => { await router.push('/projects'); };
    const defs = useActorDefs();
    const viewer = useViewer()();
    return async (id) => {
        const ws = viewer.workspaceId;
        if (!ws) throw new Error('Sign in to change the project.');
        await actor(defs.Workspace, workspaceKeyOf(ws)).removeProject(id as ProjectId);
        await router.push('/projects');
    };
}

/** The Members tab's agents and the environments their quota badges read. */
export function useMembersSource(): { agents(): readonly AgentIdentity[]; environments(): readonly WorkdirEnvironment[] } {
    if (!live()) return { agents: () => AGENTS, environments: () => mockWorkdirEnvironments.list() };
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    return { agents: () => directory.all(), environments: () => workdirs.list() };
}

/** The Folders tab's machines (one row each) and Find. */
export function useFoldersSource(): { machines(): readonly ProjectMachine[]; locate: LocateBackend } {
    if (!live()) return { machines: () => mockWorkdirEnvironments.projectMachines(), locate: mockLocate() };
    const defs = useActorDefs();
    const viewer = useViewer()();
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    return { machines: () => workdirs.projectMachines(), locate: useLiveLocate(defs, viewer, workdirs.machineOf) };
}

/** The enabled connector plugins as chip options. */
export function useConnectorOptions(): () => readonly { readonly value: string; readonly label: string }[] {
    if (!live()) return () => connectorOptionsOf(opsPlugins);
    const defs = useActorDefs();
    const viewer = useViewer()();
    const readiness = useWorkspaceReadiness(defs, viewer);
    return () => connectorOptionsOf(readiness.overview()?.plugins ?? []);
}
