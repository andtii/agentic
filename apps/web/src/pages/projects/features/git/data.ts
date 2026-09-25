/**
 * Where the Git feature's views read from (#746): the project's pull requests through the Work view's `usePulls`
 * (mock Pulls state on mock data; `[]` live until the git feature's pull request store feeds it) and, for the
 * branches that have no pull request yet, the mock tasks' branches — live task rows carry no branch yet, so none.
 */
import { dataMode } from '../../../../data-mode';
import { mockWorkTasks, usePulls } from '../../work/live';
import { gitSummaryOf, type GitSummary } from './model';

/**
 * A getter for the project's git summary, recomputed on each read. Call it once in setup: `projectId` is read on
 * each read, and the pulls reader is made again only when it changes — a component reused for another project
 * follows it, and a render never makes a reader (it subscribes once pulls are live).
 */
export function useGitSummary(projectId: () => string): () => GitSummary {
    let current: { readonly id: string; readonly pulls: ReturnType<typeof usePulls> } | undefined;
    return () => {
        const id = projectId();
        if (current?.id !== id) current = { id, pulls: usePulls(id) };
        return gitSummaryOf(current.pulls(), dataMode() === 'live' ? [] : mockWorkTasks(id));
    };
}
