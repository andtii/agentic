/**
 * The pull request page's view model (#744, PRJ-08/09): the stepper (Opened → Checks → Review → Approved → Merge),
 * the "what is happening now" callout, the merge box's one blocker sentence (from core `pullBlockers`) and the
 * autopilot switches. Pure: the mock fixtures and the live `Pulls.get` view render through the same helpers.
 */
import { formatAge } from '../../../../mock/workspace';
import { pullBlockers, type Autopilot, type PullCheck, type PullRequest, type PullReviewState, type PullThreadState } from '@agentic/core';

/** What the page links a PR to beyond the PR itself — the mock carries it, live shows the ids alone. */
export interface PullLinked {
    /** The task's objective, beside its id. */
    readonly taskTitle?: string;
    /** The issue the work is for: its number and how the Linked box names it (`agentic#47 mobile pass`). */
    readonly issue?: { readonly number: number; readonly label: string };
    readonly chatTitle?: string;
    /** Where the PR's agent runs: machine / runtime / account. */
    readonly environment?: { readonly machine: string; readonly runtime: string; readonly account: string };
}

export interface PullPageData {
    readonly pr: PullRequest;
    readonly linked?: PullLinked;
}

export type PullStepState = 'passed' | 'current' | 'later';
export type PullStepTone = 'working' | 'needs-you' | 'failed';

export interface PullStep {
    readonly name: 'Opened' | 'Checks' | 'Review' | 'Approved' | 'Merge';
    readonly state: PullStepState;
    readonly tone?: PullStepTone;
    /** The mono line under the name: `14:02`, `7 of 9`, `Lint`, `squash`. */
    readonly detail?: string;
}

const settled = (c: PullCheck): boolean => c.state === 'passed' || c.state === 'skipped';
const openThreads = (pr: Pick<PullRequest, 'review'>): number => pr.review.threads.filter((t) => t.state !== 'resolved').length;

/** `7 of 9` — passed checks of those that count (skipped ones do not). */
export function checksProgress(checks: readonly PullCheck[]): string {
    const counted = checks.filter((c) => c.state !== 'skipped');
    return `${counted.filter((c) => c.state === 'passed').length} of ${counted.length}`;
}

/**
 * The five steps. Each is met in turn — checks all passed, no open thread and no changes asked, approved, merged —
 * and the first unmet one is current, toned `failed` for a failing check or a closed PR, `needs-you` for changes
 * asked, `working` otherwise. A merged PR has every step passed.
 */
export function pullSteps(pr: PullRequest, clock: (ms: number) => string): PullStep[] {
    const reviewers = pr.review.reviewers.join(', ');
    const steps: { name: PullStep['name']; met: boolean; tone: PullStepTone; detail?: string }[] = [
        { name: 'Opened', met: true, tone: 'working', detail: clock(pr.openedAt) },
        { name: 'Checks', met: pr.checks.every(settled), tone: pr.checks.some((c) => c.state === 'failed') ? 'failed' : 'working', detail: pr.checks.length ? checksProgress(pr.checks) : 'none' },
        { name: 'Review', met: openThreads(pr) === 0 && pr.review.state !== 'changes-requested' && pr.review.state !== 'requested', tone: pr.review.state === 'changes-requested' ? 'needs-you' : 'working', ...(reviewers ? { detail: reviewers } : {}) },
        { name: 'Approved', met: pr.review.state === 'approved', tone: 'working' },
        { name: 'Merge', met: pr.state === 'merged', tone: pr.state === 'closed' ? 'failed' : 'working', detail: pr.state === 'closed' ? 'closed' : 'squash' }
    ];
    if (pr.state === 'merged') return steps.map(({ name, detail }) => ({ name, state: 'passed', ...(detail ? { detail } : {}) }));
    // A closed PR stops at Merge, whatever came before.
    const current = pr.state === 'closed' ? steps.length - 1 : steps.findIndex((s) => !s.met);
    return steps.map(({ name, tone, detail }, i) => ({
        name,
        state: current === -1 || i < current ? 'passed' : i === current ? 'current' : 'later',
        ...(i === current ? { tone } : {}),
        ...(detail ? { detail } : {})
    }));
}

/** The merge box's sentence: `Blocked: 1 failing check, 2 open threads, Lint has not approved.`, or ready / settled. */
export function blockerSentence(pr: PullRequest): string {
    if (pr.state === 'merged') return 'Merged.';
    if (pr.state === 'closed') return 'Closed without merging.';
    const blockers = pullBlockers(pr);
    if (pr.mergeable === undefined && !blockers.length) return 'Checking whether it merges cleanly.';
    return blockers.length ? `Blocked: ${blockers.join(', ')}.` : 'Ready to merge.';
}

/** Merge is offered only on an open PR with nothing in the way. */
export const canMerge = (pr: PullRequest): boolean => pr.state === 'open' && pr.mergeable === true && pullBlockers(pr).length === 0;

/** The approval rule the merge will go through (the only rule so far: `ask on merge`). */
export const APPROVAL_NOTE = 'Will ask for approval: rule ask on merge';

/** The review's state in words, for the Review section's head. */
export const REVIEW_LABEL: Readonly<Record<PullReviewState, string>> = {
    none: 'No review yet',
    requested: 'Review requested',
    'changes-requested': 'Changes asked',
    approved: 'Approved'
};

export const THREAD_LABEL: Readonly<Record<PullThreadState, string>> = { open: 'OPEN', replying: 'replying', resolved: 'RESOLVED' };

/** A check's duration, `41s` / `4m 10s`. */
export function durationText(ms: number | undefined): string {
    if (ms === undefined) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** `+184 -41 · 6 files`. */
export const diffText = (pr: Pick<PullRequest, 'additions' | 'deletions' | 'files'>): string =>
    `+${pr.additions} -${pr.deletions} · ${pr.files} ${pr.files === 1 ? 'file' : 'files'}`;

/** `25m ago`, `3h ago`, or `on 15 Sep` past a day (`formatAge` as the input). */
export function openedAgo(openedAt: number, now: number, age: (ms: number, now: number) => string = formatAge): string {
    const a = age(openedAt, now);
    return a === 'now' ? 'just now' : /^\d+[mh]$/.test(a) ? `${a} ago` : `on ${a}`;
}

/** `from task t_91a0 · issue #47` — what the PR came from, or `''`. */
export function originText(pr: Pick<PullRequest, 'taskId'>, linked: Pick<PullLinked, 'issue'> | undefined): string {
    return [pr.taskId ? `from task ${pr.taskId}` : '', linked?.issue ? `issue #${linked.issue.number}` : ''].filter(Boolean).join(' · ');
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export interface PullNow {
    /** `Forge is fixing size-limit`. */
    readonly title: string;
    /** The failing check's detail, when that is what the agent is on. */
    readonly body?: string;
    /** `attempt 2 of 3`. */
    readonly attempt?: string;
}

/**
 * What is happening now: the autopilot's activity on an open PR (`Forge is fixing size-limit · attempt 2 of 3`),
 * with the first failing check's detail under it. `undefined` when nothing is running on the PR.
 */
export function pullNow(pr: PullRequest, agentName: (id: string) => string): PullNow | undefined {
    const a = pr.autopilot;
    if (pr.state !== 'open' || !a?.activity) return undefined;
    const failing = pr.checks.find((c) => c.state === 'failed');
    return {
        title: `${agentName(a.agentId)} is ${lowerFirst(a.activity)}`,
        ...(failing ? { body: `${failing.name} failed${failing.detail ? `: ${failing.detail}` : ''}` } : {}),
        ...(a.attempt !== undefined ? { attempt: `attempt ${a.attempt} of ${a.maxAttempts}` } : {})
    };
}

export type AutopilotSwitch = 'fixChecks' | 'answerThreads' | 'rebase' | 'mergeWhenGreen';

export interface AutopilotRow {
    readonly key: AutopilotSwitch;
    readonly label: string;
    readonly caption: string;
}

/** The four switches, in the board's order, with what each lets the agent do. */
export function autopilotRows(a: Pick<Autopilot, 'maxAttempts'>, base: string): AutopilotRow[] {
    return [
        { key: 'fixChecks', label: 'Fix failing checks', caption: `up to ${a.maxAttempts} ${a.maxAttempts === 1 ? 'attempt' : 'attempts'}, then asks you` },
        { key: 'answerThreads', label: 'Answer review threads', caption: 'replies and pushes; you see every change' },
        { key: 'rebase', label: `Rebase when ${base} moves`, caption: 'stops on conflicts' },
        { key: 'mergeWhenGreen', label: 'Merge when green and approved', caption: 'asks you first: rule ask on merge' }
    ];
}

/** Autopilot with every switch off — what Take over and Stop autopilot leave behind. */
export const autopilotOff = (a: Autopilot): Autopilot => {
    const { activity: _activity, attempt: _attempt, ...rest } = a;
    return { ...rest, fixChecks: false, answerThreads: false, rebase: false, mergeWhenGreen: false };
};

/** The switches `Pulls.setAutopilot` takes: the autopilot without what the run fills. */
export type PullSwitches = Omit<Autopilot, 'attempt' | 'activity'>;

export const switchesOf = (a: Autopilot): PullSwitches => {
    const { activity: _activity, attempt: _attempt, ...rest } = a;
    return rest;
};

/** Where the PR's autopilot run stands, live (`PullsView.runs`, #858): paused (off or stopped) and asking to merge. */
export interface PullRunState {
    readonly paused?: string;
    readonly askingMerge?: true;
}

/** The autopilot's activity while a merge waits on your answer. */
export const ASKING_TO_MERGE = 'Asking to merge';

/** Whether the PR's autopilot waits on your Approve / Decline of its merge: the run says so, else its activity. */
export const asksToMerge = (pr: PullRequest, run: PullRunState | undefined): boolean =>
    pr.state === 'open' && !!pr.autopilot && (run ? run.askingMerge === true : pr.autopilot.activity === ASKING_TO_MERGE);

/** The page's writes, live (#858): the Pulls actor's autopilot methods for this PR. */
export interface PullActions {
    setAutopilot(switches: PullSwitches | null): Promise<unknown>;
    takeOver(): Promise<unknown>;
    stopAutopilot(): Promise<unknown>;
    resumeAutopilot(): Promise<unknown>;
    answerMerge(approve: boolean): Promise<unknown>;
}

/** The PR a route's number names. */
export const findPull = <T extends { readonly pr: Pick<PullRequest, 'number'> }>(list: readonly T[], n: number): T | undefined => list.find((d) => d.pr.number === n);
