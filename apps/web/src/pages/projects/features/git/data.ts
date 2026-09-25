/**
 * Where the Git feature's views read from (#746): the project's pull requests through the Work view's `usePulls`
 * (mock Pulls state on mock data; `[]` live until the git feature's pull request store feeds it) and, for the
 * branches that have no pull request yet, the mock tasks' branches — live task rows carry no branch yet, so none.
 */
import { dataMode } from '../../../../data-mode';
import { mockWorkTasks, usePulls } from '../../work/live';
import { gitSummaryOf, type GitSummary } from './model';

/**
 * A getter for the project's git summary, recomputed on each read. Call it once in setup: the pulls reader for
 * the project it starts on is made here, in setup, never in a render. A component reused for another project
 * follows it — that one change makes a reader for the new id when it is first read.
 */
export function useGitSummary(projectId: () => string): () => GitSummary {
    const first = projectId();
    let current: { readonly id: string; readonly pulls: ReturnType<typeof usePulls> } = { id: first, pulls: usePulls(first) };
    return () => {
        const id = projectId();
        if (current.id !== id) current = { id, pulls: usePulls(id) };
        return gitSummaryOf(current.pulls(), dataMode() === 'live' ? [] : mockWorkTasks(id));
    };
}
