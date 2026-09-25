/**
 * Where the Git feature's views read from (#746): the project's pull requests through the Work view's `usePulls`
 * (the Work fixtures on mock data, the project's Pulls actor live, #865) and, for the
 * branches that have no pull request yet, the mock tasks' branches — live task rows carry no branch yet, so none.
 */
import { dataMode } from '../../../../data-mode';
import { mockWorkTasks, usePulls } from '../../work/live';
import { gitSummaryOf, type GitSummary } from './model';

/** A getter for the project's git summary, recomputed on each read. Call it once in setup; it follows `projectId`. */
export function useGitSummary(projectId: () => string): () => GitSummary {
    const pulls = usePulls(projectId);
    return () => gitSummaryOf(pulls(), dataMode() === 'live' ? [] : mockWorkTasks(projectId()));
}
