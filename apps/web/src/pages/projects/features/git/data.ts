/**
 * Where the Git feature's views read from (#746): the project's pull requests through the Work view's `usePulls`
 * (the Work fixtures on mock data, the project's Pulls actor live, #865) and, for the branches that have no pull
 * request yet, the project's tasks — the mock tasks on mock data, live the TaskIndex rows whose chat is in the
 * project, each carrying the branch its chat worktree works on (#937).
 */
import { useActorDefs, useViewer } from '../../../../actors/defs';
import { dataMode } from '../../../../data-mode';
import { useAgentDirectory } from '../../../chat/directory';
import { useChatRows } from '../../../chat/LiveChats';
import { mockWorkTasks, projectTasks, usePulls, useTaskIndexRows } from '../../work/live';
import type { WorkTask } from '../../work/model';
import { gitSummaryOf, type GitSummary } from './model';

/** The project's tasks, live: the TaskIndex rows whose chat is one of the project's (as the Work view reads them). */
function useLiveProjectTasks(projectId: () => string): () => readonly WorkTask[] {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const chats = useChatRows(defs, viewer, useAgentDirectory(defs, viewer));
    const index = useTaskIndexRows(defs, viewer);
    return () => {
        const id = projectId();
        return projectTasks(index.rows(), new Set(chats.rows().filter((c) => c.projectId === id).map((c) => c.id)));
    };
}

/** A getter for the project's git summary, recomputed on each read. Call it once in setup; it follows `projectId`. */
export function useGitSummary(projectId: () => string): () => GitSummary {
    const pulls = usePulls(projectId);
    const tasks = dataMode() === 'live' ? useLiveProjectTasks(projectId) : () => mockWorkTasks(projectId());
    return () => gitSummaryOf(pulls(), tasks());
}
