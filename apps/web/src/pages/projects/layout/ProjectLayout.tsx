/**
 * The frame of every page inside a project (#725): it loads the project from the route's `:id` — the sample workspace
 * on mock data, `Workspace.projects()` live — and renders the page with it, or the project's not-found / sign-in
 * state. Live, it publishes the project to `projectHead` so the shell draws the project's menu under `Projects` in the
 * sidebar (`menu.ts`) and the crumbs name it (`trail.ts`).
 *
 * Live, it also reads `Workspace.projectSummaries()` and publishes the project's line to `projectCounts` for the
 * menu's counts (#728). Around the page it mounts the project picker (`ProjectPicker.tsx`), which the sidebar's
 * switcher opens.
 *
 * `inProject(Page)` is what the route table registers, so a page issue only ever writes its page.
 * #728 owns this folder.
 */
import { component, effect, onUnmounted, type Define } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { useActorState } from '@sigx/actors/app';
import type { ProjectRecord } from '@agentic/core';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { workspaceKeyOf } from '../../../actors/keys';
import { Page } from '../../../components/Page';
import { dataMode } from '../../../data-mode';
import { LAST_PROJECT_ID, PROJECTS, projectNamed } from '../../../mock/workspace';
import { projectHead, type ProjectHead } from '../head';
import { useProjects } from '../live';
import { countsFor, projectCounts } from './counts';
import { ProjectPicker } from './ProjectPicker';
import type { ProjectPage } from './types';

type LayoutProps = Define.Prop<'id', string, true> & Define.Prop<'page', ProjectPage, true>;

const headOf = (p: ProjectRecord): ProjectHead => ({ id: p.id, name: p.name, features: Object.keys(p.features), manager: p.members.coordinator !== null });

const notFound = (id: string) => (
    <Page title="Project not found" page="project-missing">
        <EmptyState variant="generic" title="No project with that id" caption={`Nothing is called ${id}. It may have been removed.`} slots={{ actions: () => <Link to="/projects">Back to projects</Link> }} />
    </Page>
);

const frame = (p: ProjectRecord, Inner: ProjectPage, projects: readonly ProjectRecord[], lastProjectId: string | null) => (
    <div data-project-layout={p.id}>
        <Inner project={p} />
        <ProjectPicker projects={projects} lastProjectId={lastProjectId} currentId={p.id} />
    </div>
);

const MockProjectLayout = component<LayoutProps>(({ props }) => () => {
    const p = projectNamed(props.id);
    return p ? frame(p, props.page, PROJECTS, LAST_PROJECT_ID) : notFound(props.id);
}, { name: 'MockProjectLayout' });

const LiveProjectLayout = component<LayoutProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const projects = useProjects(defs, viewer);
    const summaries = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'projectSummaries'] as const), { live: true });
    // The head and counts this instance published: a later layout (the next project page) may already have replaced them.
    let mine: ProjectHead | null = null;
    let myCounts: typeof projectCounts.value = null;
    const stop = effect(() => {
        const p = projects.byId(props.id);
        mine = p ? headOf(p) : { id: props.id, name: props.id };
        projectHead.value = mine;
    });
    const stopCounts = effect(() => {
        const counts = countsFor(props.id, summaries.value?.projects);
        myCounts = counts ? { id: props.id, counts } : null;
        projectCounts.value = myCounts;
    });
    onUnmounted(() => {
        stop();
        stopCounts();
        if (projectHead.value === mine) projectHead.value = null;
        if (projectCounts.value === myCounts) projectCounts.value = null;
    });
    return () => {
        if (!viewer.pending && !viewer.workspaceId) {
            return <Page title="Projects" page="project-missing"><EmptyState variant="generic" title="Sign in to see your projects" caption="Projects belong to your workspace." /></Page>;
        }
        const p = projects.byId(props.id);
        if (p) return frame(p, props.page, projects.list(), projects.lastProjectId());
        return projects.loading || viewer.pending ? <p data-panel-note="">Loading…</p> : notFound(props.id);
    };
}, { name: 'LiveProjectLayout' });

export const ProjectLayout = component<LayoutProps>(({ props }) => () => (dataMode() === 'live'
    ? <LiveProjectLayout id={props.id} page={props.page} />
    : <MockProjectLayout id={props.id} page={props.page} />), { name: 'ProjectLayout' });

/** The route component for a page inside a project: the layout around `Page`, for the route's `:id`. */
export function inProject(Inner: ProjectPage, name: string) {
    return component(() => {
        const route = useRoute();
        return () => <ProjectLayout id={String(route.params.id ?? '')} page={Inner} />;
    }, { name });
}
