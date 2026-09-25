/**
 * `/projects` (#729; PRJ-02): the projects index board on mock data or on the platform. Live, the cards are
 * `Workspace.projects()` with `Workspace.projectSummaries()` (#734) for each card's chats line and the unassigned
 * strip; your-move and agents-on-it counts and the open-links strip wait for sources that count them.
 */
// Projects.tsx registers the old list's topbar (New project in the topbar); importing it first makes ours win.
import '../../Projects';
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
import type { ProjectCardData } from './model';
import { ProjectsBoard } from './ProjectsBoard';

// The board draws New project in its own head; the topbar keeps only the crumb.
defineTopbar('projects', () => ({}));

/** A live card's last line from its summary: `3 open chats · active 2 h ago`. */
export function chatsLine(openChats: number, lastActivityAt: number | undefined, now: number): string {
    if (!openChats) return 'No chats yet';
    const chats = `${openChats} open ${openChats === 1 ? 'chat' : 'chats'}`;
    return lastActivityAt !== undefined ? `${chats} · active ${ageText(Math.max(0, now - lastActivityAt))}` : chats;
}

const LiveProjectsIndex = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const projects = useProjects(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    const summaries = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'projectSummaries'] as const), { live: true });
    return () => {
        if (!viewer.pending && !viewer.workspaceId) {
            return <Page title="Projects" page="projects"><EmptyState variant="generic" title="Sign in to see your projects" caption="Projects belong to your workspace." /></Page>;
        }
        const s = summaries.value;
        const now = Date.now();
        const cards: ProjectCardData[] = projects.list().map((project) => {
            const line = s?.projects.find((l) => l.projectId === project.id);
            return line ? { project, next: chatsLine(line.openChats, line.lastActivityAt, now) } : { project };
        });
        return (
            <ProjectsBoard
                cards={cards}
                machines={workdirs.projectMachines()}
                lookup={directory.lookup}
                loading={projects.loading}
                {...(s ? { unassigned: { chats: s.unassigned.openChats } } : {})}
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
