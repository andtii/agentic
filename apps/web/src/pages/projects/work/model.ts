/**
 * The Work view's model (#738, PRJ-05): pure — no hooks, no DOM. `workItemsOf` derives a project's work items from
 * its tasks, pull requests and plan items (C1): the stages come from the enabled features (`workStagesFor`), the
 * owner is whoever acts next, and each item lands in one group — your move, agents on it, waiting on CI or a
 * reviewer, done this week (docs/design/projects/HANDOFF.md, "Work and pull requests").
 */
import { planClaimLive, workStagesFor } from '@agentic/core';
import type { AgentId, PlanItem, ProjectFeatureUi, PullRequest, TaskId, TaskStatus, WaitReason, WorkGroup, WorkItem, WorkOwner, WorkStageState } from '@agentic/core';

/** A task as the Work view reads it: a `TaskIndex` row live, a fixture on mock data. */
export interface WorkTask {
    readonly id: TaskId;
    readonly title: string;
    readonly status: TaskStatus;
    readonly wait?: WaitReason;
    readonly assignee: AgentId;
    /** The branch it works on, once it has one. */
    readonly branch?: string;
    /** What it is doing now, one line ("Writing tests"). */
    readonly activity?: string;
    readonly updatedAt: number;
}

/** The project's enabled features and each one's manifest `ui` block. */
export interface WorkFeatures {
    readonly enabled: readonly string[];
    readonly uiOf: (featureId: string) => ProjectFeatureUi | undefined;
}

export const WEEK_MS = 7 * 24 * 3_600_000;

/** The groups in the order the page draws them, with their headings; the last two start collapsed. */
export const WORK_GROUPS: readonly { readonly id: WorkGroup; readonly label: string; readonly note?: string; readonly collapsed?: boolean }[] = [
    { id: 'your-move', label: 'Your move', note: 'Nothing moves until you act' },
    { id: 'agents', label: 'Agents on it', note: 'Autopilot fixes and pushes; you see results' },
    { id: 'waiting', label: 'Waiting on CI or a reviewer', collapsed: true },
    { id: 'done', label: 'Done this week', note: 'merged or completed', collapsed: true }
];

const YOU: WorkOwner = { kind: 'you' };
const agent = (agentId: AgentId): WorkOwner => ({ kind: 'agent', agentId });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Where a named stage sits, or a fallback index when the project's stages do not have it. */
function stageIndex(stages: readonly string[], name: string, fallback: number): number {
    const i = stages.indexOf(name);
    return i >= 0 ? i : Math.min(Math.max(fallback, 0), stages.length - 1);
}

interface Placed {
    readonly stage: number;
    readonly stageState: WorkStageState;
    readonly owner: WorkOwner;
    readonly nextStep: string;
    readonly group: WorkGroup;
}

/** A pull request's place: merged is done, then conflicts, checks, review and merge in the order they block. */
/** How long a PR with no checks reported waits for CI before it is treated as a repo without CI. */
export const NO_CHECKS_GRACE_MS = 10 * 60_000;

function placePull(pr: PullRequest, stages: readonly string[], doer: AgentId | undefined, now: number): Placed {
    const last = stages.length - 1;
    const at = (name: string, fallback: number): number => stageIndex(stages, name, fallback);
    const pilot = pr.autopilot;
    const fixer = pilot?.agentId ?? doer;
    if (pr.state === 'merged') return { stage: last, stageState: 'done', owner: fixer ? agent(fixer) : YOU, nextStep: 'Merged', group: 'done' };
    if (pr.draft) return { stage: at('PR', 1), stageState: 'working', owner: fixer ? agent(fixer) : YOU, nextStep: 'Draft — finishing before review', group: fixer ? 'agents' : 'your-move' };
    if (pr.mergeable === false) {
        if (pilot?.rebase) return { stage: at('PR', 1), stageState: 'working', owner: agent(pilot.agentId), nextStep: 'Rebasing onto the base', group: 'agents' };
        const first = pr.after !== undefined ? `merge #${pr.after} first, or rebase` : 'resolve the conflicts, or rebase';
        return { stage: at('PR', 1), stageState: 'needs-you', owner: YOU, nextStep: `Decide — ${first}`, group: 'your-move' };
    }
    const failing = pr.checks.filter((c) => c.state === 'failed');
    if (failing.length) {
        if (pilot?.fixChecks && (pilot.attempt ?? 1) <= pilot.maxAttempts) {
            const attempt = pilot.attempt !== undefined ? ` · attempt ${pilot.attempt} of ${pilot.maxAttempts}` : '';
            return { stage: at('Checks', 1), stageState: 'failed', owner: agent(pilot.agentId), nextStep: `${pilot.activity ?? `Fixing ${failing[0]!.name}`}${attempt}`, group: 'agents' };
        }
        return { stage: at('Checks', 1), stageState: 'failed', owner: YOU, nextStep: `Fix — ${plural(failing.length, 'failing check', 'failing checks')}`, group: 'your-move' };
    }
    const pending = pr.checks.filter((c) => c.state === 'queued' || c.state === 'running').length;
    if (pending) return { stage: at('Checks', 1), stageState: 'working', owner: fixer ? agent(fixer) : YOU, nextStep: `Waiting on CI · ${plural(pending, 'check', 'checks')} running`, group: 'waiting' };
    // No checks reported yet is not green while CI may still start; past the grace it is a repo without CI.
    if (!pr.checks.length && now - pr.openedAt < NO_CHECKS_GRACE_MS) return { stage: at('Checks', 1), stageState: 'working', owner: fixer ? agent(fixer) : YOU, nextStep: 'Waiting on CI · no checks reported yet', group: 'waiting' };
    const open = pr.review.threads.filter((t) => t.state !== 'resolved').length;
    if (open || pr.review.state === 'changes-requested') {
        const what = open ? plural(open, 'review thread', 'review threads') : 'the requested changes';
        if (pilot?.answerThreads) return { stage: at('Review', 1), stageState: 'working', owner: agent(pilot.agentId), nextStep: pilot.activity ?? `Answering ${what}`, group: 'agents' };
        return { stage: at('Review', 1), stageState: 'needs-you', owner: YOU, nextStep: `Answer ${what}`, group: 'your-move' };
    }
    if (pr.review.state === 'requested') {
        const reviewers = pr.review.reviewers;
        if (reviewers.length) return { stage: at('Review', 1), stageState: 'working', owner: fixer ? agent(fixer) : YOU, nextStep: `Waiting on ${reviewers.join(', ')} to review`, group: 'waiting' };
        return { stage: at('Review', 1), stageState: 'needs-you', owner: YOU, nextStep: `Review — requested on ${plural(pr.files, 'file', 'files')}`, group: 'your-move' };
    }
    const approved = pr.review.state === 'approved' && pr.review.reviewers.length ? `, ${pr.review.reviewers.join(', ')} approved` : '';
    return { stage: at('Merge', last), stageState: 'needs-you', owner: YOU, nextStep: `Merge — green${approved}`, group: 'your-move' };
}

/** A task without a pull request: queued is Ready, running is the doing stage, a question or approval is your move. */
function placeTask(t: WorkTask, stages: readonly string[]): Placed | null {
    const last = stages.length - 1;
    const doing = Math.min(1, last);
    const me = agent(t.assignee);
    switch (t.status) {
        case 'cancelled':
            return null;
        case 'completed':
            return { stage: last, stageState: 'done', owner: me, nextStep: 'Completed', group: 'done' };
        case 'failed':
            return { stage: doing, stageState: 'failed', owner: YOU, nextStep: 'Failed — look at the task and retry', group: 'your-move' };
        case 'queued':
            return { stage: 0, stageState: 'working', owner: me, nextStep: t.activity ?? 'Queued — starts when its environment is free', group: 'agents' };
        case 'waiting': {
            const w = t.wait;
            // With no code stages, an approval is the Review stage: the agent did the work and asks to send it.
            const review = stages.includes('PR') ? doing : stageIndex(stages, 'Review', doing);
            if (w?.kind === 'approval') return { stage: review, stageState: 'needs-you', owner: YOU, nextStep: t.activity ?? 'Approve what the agent asked to do', group: 'your-move' };
            if (w?.kind === 'input') return { stage: doing, stageState: 'needs-you', owner: YOU, nextStep: t.activity ?? 'Answer the agent’s question', group: 'your-move' };
            if (w?.kind === 'pull-request') return { stage: stageIndex(stages, 'PR', doing), stageState: 'working', owner: me, nextStep: `Waiting on #${w.number}`, group: 'waiting' };
            return { stage: doing, stageState: 'working', owner: me, nextStep: t.activity ?? 'Waiting', group: 'agents' };
        }
        default:
            return { stage: doing, stageState: 'working', owner: me, nextStep: t.activity ?? 'Working', group: 'agents' };
    }
}

/** A plan item no task carries out yet: a decision for you, or a claim an agent holds. Open or blocked items stay on the Plan. */
function placeItem(item: PlanItem, stages: readonly string[], now: number): Placed | null {
    const doing = Math.min(1, stages.length - 1);
    if (item.state === 'needs-you') {
        const options = item.options?.length ? ` · ${plural(item.options.length, 'option', 'options')}` : '';
        return { stage: 0, stageState: 'needs-you', owner: YOU, nextStep: `Decide${options}`, group: 'your-move' };
    }
    if (item.state === 'stuck') return { stage: doing, stageState: 'failed', owner: YOU, nextStep: 'Stuck — unblock or reassign it', group: 'your-move' };
    if (item.state === 'claimed' && item.claim && planClaimLive(item.claim, now)) return { stage: 0, stageState: 'working', owner: agent(item.claim.agentId), nextStep: 'Claimed — starting', group: 'agents' };
    if (item.state === 'done') return { stage: stages.length - 1, stageState: 'done', owner: YOU, nextStep: 'Done', group: 'done' };
    return null;
}

/** When a plan item last changed: its newest History line, else `now` so it neither sorts as oldest nor drops off when done. */
const itemUpdatedAt = (item: PlanItem, now: number): number => (item.activity.length ? item.activity.reduce((at, a) => Math.max(at, a.at), 0) : now);

/**
 * Every work item of a project, newest first: one per open or recently merged pull request (its task folded in), one
 * per task without a pull request, and one per plan item no task carries out yet that needs a person or holds a claim.
 * Done items older than a week and cancelled or closed work are left out.
 */
export function workItemsOf(tasks: readonly WorkTask[], pulls: readonly PullRequest[], planItems: readonly PlanItem[], features: WorkFeatures, now: number = Date.now()): WorkItem[] {
    const stages = workStagesFor(features.enabled, features.uiOf);
    const taskById = new Map(tasks.map((t) => [t.id as string, t]));
    const itemOfTask = new Map<string, PlanItem>();
    for (const item of planItems) if (item.claim?.taskId) itemOfTask.set(item.claim.taskId, item);
    const out: WorkItem[] = [];
    const usedTasks = new Set<string>();
    const recent = (at: number): boolean => now - at <= WEEK_MS;

    for (const pr of pulls) {
        if (pr.state === 'closed') continue;
        const task = pr.taskId ? taskById.get(pr.taskId) : undefined;
        if (pr.taskId) usedTasks.add(pr.taskId);
        const updatedAt = pr.state === 'merged' ? (pr.mergedAt ?? pr.openedAt) : Math.max(pr.openedAt, task?.updatedAt ?? 0);
        if (pr.state === 'merged' && !recent(updatedAt)) continue;
        const item = pr.taskId ? itemOfTask.get(pr.taskId) : undefined;
        out.push({
            id: `pr:${pr.number}`,
            title: pr.title,
            ...(pr.taskId ? { taskId: pr.taskId } : {}),
            ...(item ? { itemRef: `#${item.id}` } : {}),
            pull: pr.number,
            stages,
            ...placePull(pr, stages, task?.assignee, now),
            updatedAt
        });
    }
    for (const t of tasks) {
        if (usedTasks.has(t.id)) continue;
        const placed = placeTask(t, stages);
        if (!placed || (placed.group === 'done' && !recent(t.updatedAt))) continue;
        const item = itemOfTask.get(t.id);
        out.push({ id: `task:${t.id}`, title: t.title, taskId: t.id, ...(item ? { itemRef: `#${item.id}` } : {}), stages, ...placed, updatedAt: t.updatedAt });
    }
    for (const item of planItems) {
        if (item.claim?.taskId && taskById.has(item.claim.taskId)) continue;
        const placed = placeItem(item, stages, now);
        const updatedAt = itemUpdatedAt(item, now);
        if (!placed || (placed.group === 'done' && !recent(updatedAt))) continue;
        out.push({ id: `item:${item.id}`, title: item.title, itemRef: `#${item.id}`, stages, ...placed, updatedAt });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The agent a row shows: whoever acts next, else the agent doing the work. */
export function workAgentOf(item: WorkItem, tasks: readonly WorkTask[], pulls: readonly PullRequest[]): AgentId | undefined {
    if (item.owner.kind === 'agent') return item.owner.agentId;
    const task = item.taskId ? tasks.find((t) => t.id === item.taskId) : undefined;
    if (task) return task.assignee;
    return item.pull !== undefined ? pulls.find((p) => p.number === item.pull)?.autopilot?.agentId : undefined;
}

export interface WorkFilter {
    /** An agent id, or `''` for all. */
    readonly agent: string;
    /** A stage name, or `''` for all. */
    readonly stage: string;
    readonly q: string;
}

export const NO_WORK_FILTER: WorkFilter = { agent: '', stage: '', q: '' };

/** What a row is found by: title, task id, `#PR`, branch and plan item. */
export function workSearchText(item: WorkItem, tasks: readonly WorkTask[], pulls: readonly PullRequest[]): string {
    const task = item.taskId ? tasks.find((t) => t.id === item.taskId) : undefined;
    const pr = item.pull !== undefined ? pulls.find((p) => p.number === item.pull) : undefined;
    return [item.title, item.taskId, item.pull !== undefined ? `#${item.pull}` : '', pr?.head ?? task?.branch, item.itemRef].filter(Boolean).join(' ').toLowerCase();
}

/** The rows a filter keeps: the agent is the row's agent, the stage the current one, the search any substring. */
export function filterWork(items: readonly WorkItem[], filter: WorkFilter, tasks: readonly WorkTask[], pulls: readonly PullRequest[]): WorkItem[] {
    const q = filter.q.trim().toLowerCase();
    return items.filter((i) =>
        (!filter.agent || workAgentOf(i, tasks, pulls) === filter.agent)
        && (!filter.stage || i.stages[i.stage] === filter.stage)
        && (!q || workSearchText(i, tasks, pulls).includes(q)));
}

/** The items of each group, in `WORK_GROUPS` order. */
export function groupWork(items: readonly WorkItem[]): Record<WorkGroup, WorkItem[]> {
    const out: Record<WorkGroup, WorkItem[]> = { 'your-move': [], agents: [], waiting: [], done: [] };
    for (const i of items) out[i.group].push(i);
    return out;
}

/** An item waiting on you this long is stale: its age turns `needs-you`. */
export const STALE_MS = 24 * 3_600_000;

export const isStale = (item: WorkItem, now: number): boolean => item.group === 'your-move' && now - item.updatedAt >= STALE_MS;
