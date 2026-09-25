/**
 * The workers pool's pull request source (#742): scripted by the repo's name, so the test drives it without
 * reaching into the worker's module. `fake/merge-after-N`: PR #1 on head `chat/one` is open for the first N
 * reads of the repo's open list, merged after.
 */
import type { PullRequest } from '@agentic/core';
import type { PullSourcePort } from '@agentic/platform';

const reads = new Map<string, number>();

function prOf(repo: string, open: boolean): PullRequest {
    return {
        provider: 'github',
        repo,
        number: 1,
        title: 'One',
        url: `https://github.com/${repo}/pull/1`,
        head: 'chat/one',
        base: 'main',
        state: open ? 'open' : 'merged',
        additions: 1,
        deletions: 0,
        files: 1,
        openedBy: 'forge',
        openedAt: 0,
        ...(open ? {} : { mergedAt: Date.now() }),
        checks: [],
        review: { state: 'none', reviewers: [], threads: [] }
    };
}

const openFor = (repo: string): boolean => (reads.get(repo) ?? 0) <= Number(/^fake\/merge-after-(\d+)$/.exec(repo)?.[1] ?? Infinity);

export const fakePullSources: PullSourcePort = {
    open: () => ({
        async listOpen(repo) {
            reads.set(repo, (reads.get(repo) ?? 0) + 1);
            return openFor(repo) ? [prOf(repo, true)] : [];
        },
        async get(repo, number) {
            return number === 1 ? prOf(repo, openFor(repo)) : undefined;
        }
    })
};
