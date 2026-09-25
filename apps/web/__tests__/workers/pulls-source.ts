/**
 * The workers pool's pull request source (#742): scripted by the repo's name, so the test drives it without
 * reaching into the worker's module. `fake/merge-after-N`: PR #1 on head `chat/one` is open for the first N
 * reads of the repo's open list, merged after. Any other repo (`workerPullSources`) is read through the app's own
 * credential lookup (#840, `projectPullToken` over the worker's Registry and Workspace) with an empty fake adapter.
 */
import type { PullRequest } from '@agentic/core';
import { projectPullToken, tokenPullSources, type PullSourcePort } from '@agentic/platform';
import { GIT_FEATURE_ID, GITHUB_TOKEN_SECRET } from '@agentic/plugins-git';
import type { AnyActorDefinition } from '@sigx/actors';

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

/** `fake/*` from the script above; any other repo needs the project's credential, then reads as an empty repo. */
export function workerPullSources(actors: () => readonly AnyActorDefinition[]): PullSourcePort {
    const byType = (type: string) => (): AnyActorDefinition => actors().find((d) => (d as { type?: string }).type === type)!;
    const credentialed = tokenPullSources({
        adapters: { github: () => ({ listOpen: async () => [], get: async () => undefined }) },
        token: projectPullToken({ registry: byType('Registry'), workspace: byType('Workspace'), pluginId: GIT_FEATURE_ID, secret: GITHUB_TOKEN_SECRET }),
        ttlMs: 0
    });
    return { open: (ref) => (ref.repo.startsWith('fake/') ? fakePullSources.open(ref) : credentialed.open(ref)) };
}
