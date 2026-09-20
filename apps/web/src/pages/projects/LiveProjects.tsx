/**
 * `/projects`, `/projects/new` and `/projects/:id` on the platform (#333):
 * `Workspace.projects()` read live, the agents through the chat directory,
 * the environments through the folder-picker directory, the connectors and
 * feature manifests through `Registry.overview()`; a save is
 * `Workspace.upsertProject(patch)` (its 400 shown inline), a delete
 * `removeProject`, Find `Machine.fsRequest(locate)` (`useLiveLocate`).
 */
import { component, effect, onUnmounted, signal, useHead } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import type { ProjectId, ProjectPatch } from '@agentic/core';
import { EmptyState } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer, type ActorDefs } from '../../actors/defs';
import { workspaceKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { useLiveWorkdirEnvironments } from '../workdir/environments';
import { projectHead } from './head';
import { useProjects } from './live';
import { useLiveLocate } from './locate';
import { connectorOptionsOf, featureManifestsOf, type ProjectDraft } from './model';
import { ProjectForm } from './ProjectForm';
import { ProjectsView } from './ProjectsView';

/** `upsertProject` on `ws`; resolves to the record (with its id on a create). */
export async function saveProjectWith(defs: Pick<ActorDefs, 'Workspace'>, ws: string, patch: ProjectPatch): Promise<{ readonly id: string }> {
    const record = await actor(defs.Workspace, workspaceKeyOf(ws)).upsertProject(patch);
    return { id: record.id };
}

export const LiveProjects = component(() => {
    useHead({ title: 'Projects' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const projects = useProjects(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    const readiness = useWorkspaceReadiness(defs, viewer);
    const featureName = (id: string): string => readiness.overview()?.plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id;
    return () => {
        const signedOut = !viewer.pending && !viewer.workspaceId;
        return signedOut
            ? <Page title="Projects" page="projects"><EmptyState variant="generic" title="Sign in to see your projects" caption="Projects belong to your workspace." /></Page>
            : <ProjectsView projects={projects.list()} environments={workdirs.list()} lookup={directory.lookup} featureName={featureName} loading={projects.loading} />;
    };
});

/** The form page, live: `id` absent on New project (`initial`: what it opens on, #336). Reads everything the form needs and writes through the Workspace. */
export const LiveProject = component<{ id?: string; initial?: Partial<ProjectDraft> }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
    const projects = useProjects(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    const readiness = useWorkspaceReadiness(defs, viewer);
    const locate = useLiveLocate(defs, viewer, workdirs.machineOf);
    const st = signal({ busy: false, error: '' });
    const project = () => projects.byId(props.id);
    useHead({ title: props.id ? (project()?.name ?? 'Project') : 'New project' });
    // The topbar reads the crumb from here.
    const stopHead = effect(() => {
        const p = project();
        projectHead.value = props.id ? { id: props.id, name: p?.name ?? props.id } : null;
    });
    onUnmounted(() => { stopHead(); projectHead.value = null; });
    const save = async (patch: ProjectPatch): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            const { id } = await saveProjectWith(defs, ws, patch);
            await router.push(`/projects/${id}`);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    const remove = async (): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || !props.id || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await actor(defs.Workspace, workspaceKeyOf(ws)).removeProject(props.id as ProjectId);
            await router.push('/projects');
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    return () => {
        const p = project();
        const signedOut = !viewer.pending && !viewer.workspaceId;
        if (signedOut || (props.id && !projects.loading && !p)) {
            return (
                <Page title={signedOut ? 'Projects' : 'Project not found'} page="project">
                    <EmptyState
                        variant="generic"
                        title={signedOut ? 'Sign in to see your projects' : 'No project with that id'}
                        caption={signedOut ? 'Projects belong to your workspace.' : `Nothing is called ${props.id}. It may have been removed.`}
                        slots={{ actions: () => <Link to="/projects">Back to projects</Link> }}
                    />
                </Page>
            );
        }
        const plugins = readiness.overview()?.plugins ?? [];
        return (
            <Page title={props.id ? (p?.name ?? 'Project') : 'New project'} page="project">
                {props.id && !p ? <p data-panel-note>Loading…</p> : (
                    <ProjectForm
                        {...(p ? { project: p } : {})}
                        {...(props.initial ? { initial: props.initial } : {})}
                        agents={directory.all()}
                        environments={workdirs.list()}
                        machineOf={workdirs.machineOf}
                        connectors={connectorOptionsOf(plugins)}
                        features={featureManifestsOf(plugins)}
                        locate={locate}
                        busy={st.busy}
                        error={st.error}
                        onSave={(patch) => { void save(patch); }}
                        onRemove={() => { void remove(); }}
                        onCancel={() => { void router.push('/projects'); }}
                    />
                )}
            </Page>
        );
    };
});
