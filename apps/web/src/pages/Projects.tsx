import { component, signal, useHead } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import type { ProjectPatch, ProjectRecord } from '@agentic/core';
import { EmptyState } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar, routeId } from '../components/topbar';
import { dataMode } from '../data-mode';
import { opsPlugins } from '../mock/ops';
import { AGENTS, PROJECTS, agentNamed, projectNamed } from '../mock/workspace';
import { LinkButton } from './ops/LinkButton';
import { projectHead } from './projects/head';
import { LiveProject, LiveProjects } from './projects/LiveProjects';
import { mockLocate } from './projects/locate';
import { connectorOptionsOf, featureManifestsOf, projectPrefillOf, type ProjectDraft } from './projects/model';
import { ProjectForm } from './projects/ProjectForm';
import { ProjectsView } from './projects/ProjectsView';
import { mockWorkdirEnvironments } from './workdir/environments';

defineTopbar('projects', () => ({ actions: () => <LinkButton to="/projects/new" intent="primary" icon="plus">New project</LinkButton> }));
defineTopbar('project-new', () => ({ crumb: 'New project' }));
defineTopbar('project', (route) => {
    const id = routeId(route);
    // Live: what the page published for THIS project (`projects/head.ts`); mock: the sample workspace's.
    const name = dataMode() === 'live' ? (projectHead.value?.id === id ? projectHead.value.name : undefined) : projectNamed(id)?.name;
    return { crumb: name };
});

const mockFeatureName = (id: string): string => opsPlugins.find((p) => p.manifest.id === id)?.manifest.name ?? id;

/** `/projects` (#333): the workspace's projects on the platform (`LiveProjects`), or the mock workspace's. */
export const Projects = component(() => {
    useHead({ title: 'Projects' });
    return () => (dataMode() === 'live'
        ? <LiveProjects />
        : <ProjectsView projects={PROJECTS} environments={mockWorkdirEnvironments.list()} lookup={agentNamed} featureName={mockFeatureName} />);
});

/** The form on mock data: the sample agents, environments, plugins and folders; a save only navigates. */
const MockProjectForm = component<{ project?: ProjectRecord; initial?: Partial<ProjectDraft> }>(({ props }) => {
    const router = useRouter();
    const locate = mockLocate();
    const st = signal({ error: '' });
    const save = (_patch: ProjectPatch): void => { void router.push(props.project ? `/projects/${props.project.id}` : '/projects'); };
    return () => (
        <ProjectForm
            {...(props.project ? { project: props.project } : {})}
            {...(props.initial ? { initial: props.initial } : {})}
            agents={AGENTS}
            environments={mockWorkdirEnvironments.list()}
            machineOf={mockWorkdirEnvironments.machineOf}
            connectors={connectorOptionsOf(opsPlugins)}
            features={featureManifestsOf(opsPlugins)}
            locate={locate}
            error={st.error}
            onSave={save}
            onRemove={() => { void router.push('/projects'); }}
            onCancel={() => { void router.push('/projects'); }}
        />
    );
});

/** `/projects/new`, prefilled from `?name=&env=&path=&origin=` when New chat sent a folder here (#336). */
export const NewProject = component(() => {
    useHead({ title: 'New project' });
    const route = useRoute();
    // Read once: the query is the request the form opens on.
    const initial = projectPrefillOf(route.query);
    const prefill = initial ? { initial } : {};
    return () => (dataMode() === 'live' ? <LiveProject {...prefill} /> : (
        <Page title="New project" page="project">
            <MockProjectForm {...prefill} />
        </Page>
    ));
});

/** `/projects/:id`. */
export const EditProject = component(() => {
    const route = useRoute();
    return () => {
        const id = String(route.params.id);
        if (dataMode() === 'live') return <LiveProject id={id} />;
        const project = projectNamed(id);
        if (!project) {
            return (
                <Page title="Project not found" page="project">
                    <EmptyState variant="generic" title="No project with that id" caption={`Nothing is called ${id}.`} slots={{ actions: () => <Link to="/projects">Back to projects</Link> }} />
                </Page>
            );
        }
        return (
            <Page title={project.name} page="project">
                <MockProjectForm project={project} />
            </Page>
        );
    };
});
