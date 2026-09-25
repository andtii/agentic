/**
 * Where the Git feature's views read from (#746): the project's pull requests through the Work view's `usePulls`
 * (mock Pulls state on mock data; `[]` live until the git feature's pull request store feeds it) and, for the
 * branches that have no pull request yet, the mock tasks' branches — live task rows carry no branch yet, so none.
 */
import { dataMode } from '../../../../data-mode';
import { mockWorkTasks, usePulls } from '../../work/live';
import { gitSummaryOf, type GitSummary } from './model';

/** A getter for the project's git summary, recomputed on each read. */
export function useGitSummary(projectId: string): () => GitSummary {
    const pulls = usePulls(projectId);
    return () => gitSummaryOf(pulls(), dataMode() === 'live' ? [] : mockWorkTasks(projectId));
}
