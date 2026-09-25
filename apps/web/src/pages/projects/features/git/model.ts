/**
 * The Git feature's view model (#746): what its Overview card and its Code section draw, derived from the project's
 * pull requests (the Pulls state) and its tasks. Pure — the hooks that feed it live in `data.ts`.
 *
 * - **Branch** is the pull requests' base (the default branch), `main` when there are none.
 * - **Checks** is what the last merge into it ran: `pass` when every check passed, `fail` when one failed, `running`
 *   while some still run, `none` when nothing merged yet or it ran no checks (skipped ones do not count).
 * - **Your move** counts the open pull requests the Work view puts in its Your move group (`workItemsOf`).
 * - **Branches without a PR** are the branches a task works on that no open or merged pull request heads.
 */
import type { PullRequest } from '@agentic/core';
import { workItemsOf, type WorkTask } from '../../work/model';

/** The git feature's plugin id — the key of its entry in `features/registry.ts`. */
export const GIT_FEATURE_ID = 'agentic.feature.git';

export type GitChecks = 'pass' | 'fail' | 'running' | 'none';

export interface GitBranch {
    readonly name: string;
    /** The task working on it. */
    readonly taskId: string;
    readonly title: string;
}

export interface GitOpenPull {
    readonly pr: PullRequest;
    /** What happens next, one line — the Work view's next step. */
    readonly nextStep: string;
    readonly yourMove: boolean;
    readonly failing: number;
}

export interface GitSummary {
    readonly branch: string;
    readonly checks: GitChecks;
    readonly open: readonly GitOpenPull[];
    readonly yourMove: number;
    /** Open pull requests with at least one failed check. */
    readonly failing: number;
    readonly branchesWithoutPr: readonly GitBranch[];
    readonly lastMerge?: { readonly number: number; readonly at: number };
}

const NO_FEATURES = { enabled: [], uiOf: () => undefined };

/** A merged pull request's checks as the base branch's checks pill. */
export function checksOf(pr: Pick<PullRequest, 'checks'> | undefined): GitChecks {
    const ran = (pr?.checks ?? []).filter((c) => c.state !== 'skipped');
    if (ran.length === 0) return 'none';
    if (ran.some((c) => c.state === 'failed')) return 'fail';
    if (ran.some((c) => c.state === 'queued' || c.state === 'running')) return 'running';
    return 'pass';
}

/** The card's and the section's numbers from the project's pull requests and tasks. */
export function gitSummaryOf(pulls: readonly PullRequest[], tasks: readonly WorkTask[], now: number = Date.now()): GitSummary {
    const openPulls = pulls.filter((p) => p.state === 'open');
    const items = new Map(workItemsOf([], openPulls, [], NO_FEATURES, now).map((i) => [i.pull, i]));
    const open: GitOpenPull[] = openPulls
        .map((pr) => {
            const item = items.get(pr.number);
            return { pr, nextStep: item?.nextStep ?? '', yourMove: item?.group === 'your-move', failing: pr.checks.filter((c) => c.state === 'failed').length };
        })
        .sort((a, b) => b.pr.openedAt - a.pr.openedAt);
    const merged = pulls
        .filter((p) => p.state === 'merged')
        .sort((a, b) => (b.mergedAt ?? b.openedAt) - (a.mergedAt ?? a.openedAt));
    const last = merged[0];
    const heads = new Set(pulls.filter((p) => p.state !== 'closed').map((p) => p.head));
    const seen = new Set<string>();
    const branchesWithoutPr: GitBranch[] = [];
    for (const t of tasks) {
        if (!t.branch || heads.has(t.branch) || seen.has(t.branch)) continue;
        seen.add(t.branch);
        branchesWithoutPr.push({ name: t.branch, taskId: t.id, title: t.title });
    }
    return {
        branch: pulls[0]?.base ?? 'main',
        checks: checksOf(last),
        open,
        yourMove: open.filter((o) => o.yourMove).length,
        failing: open.filter((o) => o.failing > 0).length,
        branchesWithoutPr,
        ...(last ? { lastMerge: { number: last.number, at: last.mergedAt ?? last.openedAt } } : {})
    };
}

/** The checks pill: the StatusPill status it borrows the tone of, and its label. */
export const CHECKS_PILL: Readonly<Record<GitChecks, { readonly tone: 'live' | 'failed' | 'working' | 'dim'; readonly label: string }>> = {
    pass: { tone: 'live', label: 'CHECKS PASS' },
    fail: { tone: 'failed', label: 'CHECKS FAIL' },
    running: { tone: 'working', label: 'CHECKS RUNNING' },
    none: { tone: 'dim', label: 'NO CHECKS' }
};

/** Where the Code section lives in a project. */
export const gitSectionHref = (projectId: string): string => `/projects/${projectId}/code`;

/** A pull request's work item page. */
export const pullHref = (projectId: string, n: number): string => `/projects/${projectId}/work/pr:${n}`;

/** A task's work item page. */
export const taskItemHref = (projectId: string, taskId: string): string => `/projects/${projectId}/work/${taskId}`;
