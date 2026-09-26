/**
 * `/projects` (#729; PRJ-02): the projects index board on mock data or on the platform. Live, the cards are
 * `Workspace.projects()` with `Workspace.projectSummaries()` (#734) for each card's chats line and the unassigned
 * strip, and the open-links strip counts the workspace's open cross-project links (`workspaceLinks`, #881). The
 * summary line's work (#934) gives each card its your-move and agents-on-it pills and its `Next:` line, and the
 * unassigned line its tasks; a line without work (a source it could not read) shows no pills, never QUIET.
 */
import type { ProjectRecord } from '@agentic/core';
import { component, useHead } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import { ageText, EmptyState } from '@agentic/ui';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { dataMode } from '../../../data-mode';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { workspaceKeyOf } from '../../../actors/keys';
import { MOCK_OPEN_LINKS, MOCK_PROJECT_CARDS, MOCK_UNASSIGNED } from '../../../mock/projects/index';
import { agentNamed } from '../../../mock/workspace';
import { useAgentDirectory } from '../../chat/directory';
import { mockWorkdirEnvironments, useLiveWorkdirEnvironments } from '../../workdir/environments';
import { useProjects } from '../live';
import { openLinksOf, useLiveLinks } from '../links/live';
import type { ProjectCardData, UnassignedData } from './model';
import { ProjectsBoard } from './ProjectsBoard';

// The board draws New project in its own head; the topbar keeps only the crumb.
defineTopbar('projects', () => ({}));

/** A live card's last line from its summary: `3 open chats · active 2 h ago`. */
export function chatsLine(openChats: number, lastActivityAt: number | undefined, now: number): string {
    if (!openChats) return 'No chats yet';
    const chats = `${openChats} open ${openChats === 1 ? 'chat' : 'chats'}`;
    return lastActivityAt !== undefined ? `${chats} · active ${ageText(Math.max(0, now - lastActivityAt))}` : chats;
}

/** The subset of a `ProjectSummaryLine` a live card reads. */
export interface CardSummaryLine {
    readonly openChats: number;
    readonly lastActivityAt?: number;
    readonly work?: { readonly yourMove: number; readonly agentsOnIt: number; readonly next: readonly string[] };
}

/** A live card from its summary line: the pills when the work was counted, `Next:` the moves, else the chats line. */
export function liveCard(project: ProjectRecord, line: CardSummaryLine | undefined, now: number): ProjectCardData {
    if (!line) return { project };
    const w = line.work;
    const next = w?.next.length ? `Next: ${w.next.join(' · ')}` : chatsLine(line.openChats, line.lastActivityAt, now);
    return { project, next, ...(w ? { yourMove: w.yourMove, agentsOnIt: w.agentsOnIt } : {}) };
}

/** The unassigned strip from the summary's line: its chats, and its tasks when the task index was read. */
export const liveUnassigned = (u: { readonly openChats: number; readonly openTasks?: number }): UnassignedData => ({ chats: u.openChats, ...(u.openTasks !== undefined ? { tasks: u.openTasks } : {}) });

const LiveProjectsIndex = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const projects = useProjects(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    const summaries = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'projectSummaries'] as const), { live: true });
    const links = useLiveLinks(defs, viewer, () => projects.list());
    return () => {
        if (!viewer.pending && !viewer.workspaceId) {
            return <Page title="Projects" page="projects"><EmptyState variant="generic" title="Sign in to see your projects" caption="Projects belong to your workspace." /></Page>;
        }
        const s = summaries.value;
        const now = Date.now();
        const cards: ProjectCardData[] = projects.list().map((project) => liveCard(project, s?.projects.find((l) => l.projectId === project.id), now));
        const graphs = links.graphs();
        const open = graphs ? openLinksOf(graphs.open) : undefined;
        return (
            <ProjectsBoard
                cards={cards}
                machines={workdirs.projectMachines()}
                lookup={directory.lookup}
                loading={projects.loading}
                {...(s ? { unassigned: liveUnassigned(s.unassigned) } : {})}
                {...(open ? { links: open } : {})}
            />
        );
    };
}, { name: 'LiveProjectsIndex' });

export const ProjectsIndex = component(() => {
    useHead({ title: 'Projects' });
    return () => (dataMode() === 'live'
        ? <LiveProjectsIndex />
        : <ProjectsBoard cards={MOCK_PROJECT_CARDS} machines={mockWorkdirEnvironments.projectMachines()} lookup={agentNamed} links={MOCK_OPEN_LINKS} unassigned={MOCK_UNASSIGNED} />);
}, { name: 'ProjectsIndex' });
