/**
 * Pull requests (#724, projects redesign #722): the provider-neutral shape the git feature's adapters fill (GitHub
 * first) and the UI reads — checks, reviews, mergeable, autopilot; nothing provider specific
 * (docs/design/projects/HANDOFF.md, "Pull request").
 */

import type { AgentId, ChatId, SessionId, TaskId } from './ids.js';

export type PullState = 'open' | 'merged' | 'closed';
export type PullCheckState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped';
export type PullThreadState = 'open' | 'replying' | 'resolved';
export type PullReviewState = 'none' | 'requested' | 'changes-requested' | 'approved';

export interface PullCheck {
    readonly name: string;
    readonly state: PullCheckState;
    readonly detail?: string;
    readonly durationMs?: number;
}

export interface PullThread {
    readonly id: string;
    /** A login, or an agent id when an agent wrote it. */
    readonly author: string;
    readonly path?: string;
    readonly line?: number;
    readonly body: string;
    readonly state: PullThreadState;
    /** The latest reply, when there is one. */
    readonly reply?: string;
}

/** What the PR's agent may do without asking (the four switches on the PR page). */
export interface Autopilot {
    readonly agentId: AgentId;
    readonly fixChecks: boolean;
    /** Fix attempts before it stops and makes it your move. */
    readonly maxAttempts: number;
    readonly answerThreads: boolean;
    /** Rebase when the base moves; stops on conflicts. */
    readonly rebase: boolean;
    /** Merge when green and approved — still through the approval rule `ask on merge`. */
    readonly mergeWhenGreen: boolean;
    /** The attempt in progress, 1-based. */
    readonly attempt?: number;
    /** What it is doing now, one line ("Fixing size-limit"). */
    readonly activity?: string;
}

export interface PullRequest {
    /** The adapter that reads it, e.g. `github`. */
    readonly provider: string;
    /** `owner/name`. */
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly head: string;
    readonly base: string;
    readonly state: PullState;
    readonly draft?: boolean;
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
    readonly openedBy: string;
    readonly openedAt: number;
    readonly mergedAt?: number;
    readonly checks: readonly PullCheck[];
    readonly review: { readonly state: PullReviewState; readonly reviewers: readonly string[]; readonly threads: readonly PullThread[] };
    /** `false` on conflicts; `undefined` while the provider is still computing it. */
    readonly mergeable?: boolean;
    readonly autopilot?: Autopilot;
    readonly taskId?: TaskId;
    readonly chatId?: ChatId;
    readonly sessionId?: SessionId;
    /** The PR this one is stacked on (`after #602`). */
    readonly after?: number;
}

/**
 * Everything keeping a PR from merging, each a short clause — the PR page joins them into one sentence
 * ("Blocked: 1 failing check, 2 open threads, Lint has not approved."). Empty when it can merge.
 */
export function pullBlockers(pr: Pick<PullRequest, 'state' | 'draft' | 'checks' | 'review' | 'mergeable'>): string[] {
    if (pr.state !== 'open') return [];
    const out: string[] = [];
    const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
    if (pr.draft) out.push('draft');
    if (pr.mergeable === false) out.push('conflicts with the base');
    const failing = pr.checks.filter((c) => c.state === 'failed').length;
    const pending = pr.checks.filter((c) => c.state === 'queued' || c.state === 'running').length;
    if (failing) out.push(count(failing, 'failing check', 'failing checks'));
    if (pending) out.push(count(pending, 'check running', 'checks running'));
    const open = pr.review.threads.filter((t) => t.state !== 'resolved').length;
    if (open) out.push(count(open, 'open thread', 'open threads'));
    if (pr.review.state === 'changes-requested') out.push('changes requested');
    else if (pr.review.state === 'requested') out.push(pr.review.reviewers.length ? `${pr.review.reviewers.join(', ')} has not approved` : 'review requested');
    return out;
}
