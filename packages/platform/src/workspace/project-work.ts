/**
 * What `Workspace.projectSummaries` counts of a project's work (#934; PRJ-02/05): the index cards' `N YOUR MOVE` and
 * `N AGENTS ON IT` pills and their `Next:` line, the project menu's Work count and needs-you badge, the Plan section's
 * open items and the Requests that wait on a person.
 *
 * The groups follow the Work view's rules (`apps/web/src/pages/projects/work/model.ts`, HANDOFF "Work and pull
 * requests"): one item per open pull request (its task, or a merged one's, folded in), one per task without a pull
 * request, one per plan item no task carries out yet that needs a person or holds a live claim; the owner is whoever
 * acts next. Done work is not counted. Only the group and, for your move, a short verb are kept, so the index stays cheap. Pure.
 */
import { isTerminal, planClaimLive, type PlanItem, type PullRequest } from '@agentic/core';
import type { TaskIndexRow } from '../task/task-index.js';

/** A project's work, counted. */
export interface ProjectWorkTally {
    /** Items waiting on the person. */
    readonly yourMove: number;
    /** Items an agent is working on. */
    readonly agentsOnIt: number;
    /** Items waiting on CI or a reviewer. */
    readonly waiting: number;
    /** The newest your-move items as short moves (`merge #602`, `decide #14`), at most `NEXT_MOVES_MAX`. */
    readonly next: readonly string[];
}

/** How many moves `next` carries: the card's `Next:` line. */
export const NEXT_MOVES_MAX = 3;

/** As the Work view: a PR with no checks reported waits this long for CI before it is treated as a repo without CI. */
const NO_CHECKS_GRACE_MS = 10 * 60_000;

type Group = 'your-move' | 'agents' | 'waiting' | 'done';
interface Placed {
    readonly group: Group;
    /** For your move: what the person does, one short verb phrase. */
    readonly move?: string;
}

const you = (move: string): Placed => ({ group: 'your-move', move });

/** A pull request's place, in the order its blockers bite: draft, conflicts, checks, review, then merge. */
function placePull(pr: PullRequest, hasDoer: boolean, now: number): Placed {
    const ref = `#${pr.number}`;
    const pilot = pr.autopilot;
    const fixer = pilot !== undefined || hasDoer;
    if (pr.draft) return fixer ? { group: 'agents' } : you(`finish ${ref}`);
    if (pr.mergeable === false) return pilot?.rebase ? { group: 'agents' } : you(`rebase ${ref}`);
    if (pr.checks.some((c) => c.state === 'failed')) return pilot?.fixChecks && (pilot.attempt ?? 1) <= pilot.maxAttempts ? { group: 'agents' } : you(`fix ${ref}`);
    if (pr.checks.some((c) => c.state === 'queued' || c.state === 'running')) return { group: 'waiting' };
    if (!pr.checks.length && now - pr.openedAt < NO_CHECKS_GRACE_MS) return { group: 'waiting' };
    if (pr.review.threads.some((t) => t.state !== 'resolved') || pr.review.state === 'changes-requested') return pilot?.answerThreads ? { group: 'agents' } : you(`answer ${ref}`);
    if (pr.review.state === 'requested') return pr.review.reviewers.length ? { group: 'waiting' } : you(`review ${ref}`);
    return you(`merge ${ref}`);
}

function placeTask(t: TaskIndexRow): Placed | null {
    switch (t.status) {
        case 'cancelled':
            return null;
        case 'completed':
            return { group: 'done' };
        case 'failed':
            return you(`retry ${t.id}`);
        case 'queued':
            return { group: 'agents' };
        case 'waiting': {
            const w = t.wait;
            if (w?.kind === 'approval') return you(`approve ${t.id}`);
            if (w?.kind === 'input') return you(`answer ${t.id}`);
            if (w?.kind === 'pull-request') return { group: 'waiting' };
            return { group: 'agents' };
        }
        default:
            return { group: 'agents' };
    }
}

function placeItem(item: PlanItem, now: number): Placed | null {
    if (item.state === 'needs-you') return you(`decide #${item.id}`);
    if (item.state === 'stuck') return you(`unblock #${item.id}`);
    if (item.state === 'claimed' && item.claim && planClaimLive(item.claim, now)) return { group: 'agents' };
    if (item.state === 'done') return { group: 'done' };
    return null;
}

const itemUpdatedAt = (item: PlanItem, now: number): number => (item.activity.length ? item.activity.reduce((at, a) => Math.max(at, a.at), 0) : now);

/** Count a project's work: `tasks` are the TaskIndex rows of its chats, `pulls` its Pulls actor's, `planItems` every item of its plans. */
export function tallyProjectWork(tasks: readonly TaskIndexRow[], pulls: readonly PullRequest[], planItems: readonly PlanItem[], now: number): ProjectWorkTally {
    const taskById = new Map(tasks.map((t) => [t.id as string, t]));
    const usedTasks = new Set<string>();
    const placed: { readonly placed: Placed; readonly updatedAt: number }[] = [];

    for (const pr of pulls) {
        if (pr.state === 'closed') continue;
        const task = pr.taskId ? taskById.get(pr.taskId) : undefined;
        if (pr.taskId) usedTasks.add(pr.taskId);
        // A merged PR is done: it only keeps its task out of the count.
        if (pr.state === 'merged') continue;
        placed.push({ placed: placePull(pr, task !== undefined, now), updatedAt: Math.max(pr.openedAt, task?.updatedAt ?? 0) });
    }
    for (const t of tasks) {
        if (usedTasks.has(t.id)) continue;
        const p = placeTask(t);
        if (!p || p.group === 'done') continue;
        placed.push({ placed: p, updatedAt: t.updatedAt });
    }
    for (const item of planItems) {
        if (item.claim?.taskId && taskById.has(item.claim.taskId)) continue;
        const p = placeItem(item, now);
        if (!p || p.group === 'done') continue;
        placed.push({ placed: p, updatedAt: itemUpdatedAt(item, now) });
    }
    placed.sort((a, b) => b.updatedAt - a.updatedAt);
    const count = (g: Group): number => placed.filter((p) => p.placed.group === g).length;
    return {
        yourMove: count('your-move'),
        agentsOnIt: count('agents'),
        waiting: count('waiting'),
        next: placed.flatMap((p) => (p.placed.move ? [p.placed.move] : [])).slice(0, NEXT_MOVES_MAX)
    };
}

/** Plan items still to do: every one that is not done. */
export const openPlanItemCount = (planItems: readonly PlanItem[]): number => planItems.filter((i) => i.state !== 'done').length;

/** A task still in flight: neither completed, failed nor cancelled. */
export const isOpenTask = (t: Pick<TaskIndexRow, 'status'>): boolean => !isTerminal(t.status);
