/**
 * Where a `PullCard` outside the Work view leads, and what feeds it (#826, PRJ-10): Home's "Needs you" rows, the task
 * tree's node line and the chat card all open the in-app PR page (`/projects/:id/work/pr:<n>`) and the provider's diff,
 * not the provider's PR page. On mock data the pull requests are the Work fixtures (`MOCK_WORK`); live they are every
 * Git project's Pulls actor (`LivePulls.tsx`, #865).
 */
import type { PullRequest } from '@agentic/core';
import type { PullLinksFn } from '@agentic/ui';
import { MOCK_WORK } from '../../../../mock/projects/work';
import type { PullNeeds } from '../../../inbox/NeedsYou';
import { usePulls } from '../live';

/** The PR page of pull request `number` in project `projectId`. */
export const pullPageHref = (projectId: string, number: number): string => `/projects/${encodeURIComponent(projectId)}/work/pr:${number}`;

/** The provider's diff of a pull request: GitHub's "Files changed" tab; `undefined` for another provider. */
export function pullDiffHref(pr: Pick<PullRequest, 'provider' | 'url'>): string | undefined {
    return pr.provider === 'github' ? `${pr.url.replace(/\/+$/, '')}/files` : undefined;
}

type UsePull = NonNullable<PullLinksFn['usePull']>;

/**
 * The chat card's live read (#935): the project's pull requests (`usePulls` — the Pulls actor's `get`, or the Work
 * fixtures on mock data), the one with the ref's number and repo. Called in the card's setup.
 */
export const projectUsePull = (projectId: string): UsePull => (ref) => {
    const pulls = usePulls(projectId);
    return () => pulls().find((pr) => pr.number === ref.number && (ref.repo === undefined || pr.repo === ref.repo));
};

/**
 * A chat card's links in project `projectId`: the PR page and its diff, and the live read that keeps the card on the
 * project's Pulls actor. No project → the card keeps the provider's URL and the snapshot the call returned.
 */
export function chatPullLinks(projectId: string | undefined): PullLinksFn | undefined {
    if (!projectId) return undefined;
    const links = (pr: PullRequest) => {
        const diffHref = pullDiffHref(pr);
        return { href: pullPageHref(projectId, pr.number), ...(diffHref ? { diffHref } : {}) };
    };
    return Object.assign(links, { usePull: projectUsePull(projectId) });
}

/** Every mock project's pull requests, each with the project it belongs to. */
function mockPulls(): readonly { readonly projectId: string; readonly pr: PullRequest }[] {
    return Object.entries(MOCK_WORK).flatMap(([projectId, work]) => work.pulls.map((pr) => ({ projectId, pr })));
}

/** Home's pull requests on mock data: the Work fixtures of every project; merging one succeeds. */
export function mockPullNeeds(): PullNeeds {
    const all = mockPulls();
    // Keyed by repo and number, not by object: the list hands the card a reactive view of the record.
    const key = (pr: Pick<PullRequest, 'repo' | 'number'>): string => `${pr.repo}#${pr.number}`;
    const projectOf = new Map(all.map(({ projectId, pr }) => [key(pr), projectId]));
    const prs = all.map(({ pr }) => pr);
    return {
        usePulls: () => () => prs,
        href: (pr) => {
            const projectId = projectOf.get(key(pr));
            return projectId ? pullPageHref(projectId, pr.number) : undefined;
        },
        merge: () => Promise.resolve()
    };
}

/** The pull request task `taskId` (or its short ref) resolved to on mock data (`PullRequest.taskId`), if any. */
export function mockTaskPull(...taskIds: readonly (string | undefined)[]): PullRequest | undefined {
    const ids = new Set(taskIds.filter((id): id is string => !!id));
    return ids.size ? mockPulls().find(({ pr }) => pr.taskId !== undefined && ids.has(pr.taskId))?.pr : undefined;
}
