/**
 * `/projects/new` (#733): the New project dialog over the projects index, prefilled from `?name=&env=&path=&origin=`
 * when New chat sent a folder here (#336). Live, Create is `Workspace.upsertProject` with the `pm` spec (the platform
 * creates the manager agent, #784) and opens the new project; on mock data the sample workspace is read-only, so
 * Create closes the dialog back to the index. Cancel goes back to the index too.
 */
import { component, signal, useHead } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import type { ProjectPatch } from '@agentic/core';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { defineTopbar } from '../../../components/topbar';
import { dataMode } from '../../../data-mode';
import { MOCK_PM_SKILLS } from '../../../mock/projects/settings';
import { mockWorkdirEnvironments, useLiveWorkdirEnvironments } from '../../workdir/environments';
import { ProjectsIndex } from '../index/ProjectsIndex';
import { saveProjectWith } from '../live';
import { mockLocate, useLiveLocate } from '../locate';
import { projectPrefillOf } from '../model';
import { NewProjectDialog } from './NewProjectDialog';

defineTopbar('project-new', () => ({ crumb: 'New project' }));

export const NewProject = component(() => {
    useHead({ title: 'New project' });
    const route = useRoute();
    const router = useRouter();
    // Read once: the query is the request the dialog opens on.
    const initial = projectPrefillOf(route.query);
    const live = dataMode() === 'live';
    const defs = live ? useActorDefs() : null;
    const viewer = live ? useViewer()() : null;
    const workdirs = defs && viewer ? useLiveWorkdirEnvironments(defs, viewer) : mockWorkdirEnvironments;
    const locate = defs && viewer ? useLiveLocate(defs, viewer, workdirs.machineOf) : mockLocate();
    const st = signal({ open: true, busy: false, error: '' });
    const close = (): void => {
        st.open = false;
        void router.push('/projects');
    };
    const create = async (patch: ProjectPatch): Promise<void> => {
        if (st.busy) return;
        if (!defs || !viewer) {
            close();
            return;
        }
        const ws = viewer.workspaceId;
        if (!ws) {
            st.error = 'Sign in to create a project.';
            return;
        }
        st.busy = true;
        st.error = '';
        try {
            const { id } = await saveProjectWith(defs, ws, patch);
            st.open = false;
            await router.push(`/projects/${id}`);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    return () => (
        <>
            <ProjectsIndex />
            <NewProjectDialog
                model={() => st.open}
                machines={workdirs.projectMachines()}
                locate={locate}
                skills={live ? [] : MOCK_PM_SKILLS}
                {...(initial ? { initial } : {})}
                busy={st.busy}
                error={st.error}
                onCreate={(patch) => { void create(patch); }}
                onCancel={close}
            />
        </>
    );
}, { name: 'NewProject' });
