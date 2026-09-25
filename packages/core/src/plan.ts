/**
 * Plan (#748, projects redesign #722, PRJ-11/PRJ-12): a project feature holding shared plans of phases and items that
 * people and agents work from together. An item is carried out by a task: plan → item → task
 * (docs/design/projects/HANDOFF.md, "Plan" and "Agent tools and refs"). Types and pure helpers only; the store and the
 * tool handlers live with the plan feature.
 */

import type { AgentId, ChatId, ProjectId, TaskId } from './ids.js';
import type { Ref } from './refs.js';

/** Who assigned, claimed or changed something on a plan: an agent member or a person. */
export type PlanActor = { readonly kind: 'agent'; readonly agentId: AgentId } | { readonly kind: 'user'; readonly userId: string };

export type PlanItemState = 'ready' | 'claimed' | 'needs-you' | 'blocked' | 'done' | 'stuck';
export const PLAN_ITEM_STATES: readonly PlanItemState[] = ['ready', 'claimed', 'needs-you', 'blocked', 'done', 'stuck'];

/** A claim's lease runs this long and renews on each `plan_*` call; when it runs out the item returns to the top of its assignee's queue. */
export const PLAN_LEASE_DEFAULT_MS = 30 * 60 * 1000;

/** The agent working an item now. */
export interface PlanClaim {
    readonly agentId: AgentId;
    /** ms epoch. */
    readonly leaseUntil: number;
    /** The task carrying the item out, once there is one. */
    readonly taskId?: TaskId;
}

/** One line of an item's done-when checklist. */
export interface PlanDoneWhen {
    readonly text: string;
    readonly checked: boolean;
}

/** One History line on an item: who did what, when. `text` may carry refs in the shared syntax (refs.ts). */
export interface PlanActivity {
    readonly at: number;
    readonly actor: PlanActor;
    readonly text: string;
}

/** A choice offered to a person when an item needs them ("Decide: keep a2a as its own kind? · 2 options"). */
export interface PlanOption {
    readonly label: string;
    readonly detail?: string;
}

export interface PlanItem {
    /** The item's number, unique per project across its plans: `#n`. */
    readonly id: number;
    readonly title: string;
    readonly state: PlanItemState;
    /** Whose queue the item is in; absent while it sits in the open pool. */
    readonly assignee?: PlanActor;
    /** Position in the assignee's queue, 0 first. */
    readonly queueIndex?: number;
    readonly assignedBy?: PlanActor;
    readonly claim?: PlanClaim;
    /** Items (by `#n`) that must be done first; an item with an unfinished one cannot be claimed. */
    readonly after: readonly number[];
    /** Paths the item will change; overlapping touches warn both agents. */
    readonly touches: readonly string[];
    readonly refs: readonly Ref[];
    readonly doneWhen: readonly PlanDoneWhen[];
    readonly activity: readonly PlanActivity[];
    readonly options?: readonly PlanOption[];
}

export interface PlanPhase {
    /** 1-based, the order phases show in. */
    readonly n: number;
    readonly title: string;
    readonly items: readonly PlanItem[];
}

export interface Plan {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly description?: string;
    /** The chat the plan was drafted in, if any. */
    readonly originChatId?: ChatId;
    readonly phases: readonly PlanPhase[];
}

/** The tools the Plan feature gives agents (MCP naming `<family>_<op>`). */
export const PLAN_TOOLS = ['plan_list', 'plan_next', 'plan_claim', 'plan_assign', 'plan_update', 'plan_ref', 'plan_add', 'plan_handoff'] as const;
export type PlanToolName = (typeof PLAN_TOOLS)[number];

/** Which plan tools only read. */
export const PLAN_READ_TOOLS: readonly PlanToolName[] = ['plan_list', 'plan_next'];

/** Every item of a plan, phase by phase. */
export function planItems(plan: Pick<Plan, 'phases'>): PlanItem[] {
    return plan.phases.flatMap((p) => p.items);
}

/** The `after` items of `item` that are not done yet (unknown numbers count as not done). */
export function planItemWaitsOn(item: Pick<PlanItem, 'after'>, items: readonly Pick<PlanItem, 'id' | 'state'>[]): number[] {
    const done = new Set(items.filter((i) => i.state === 'done').map((i) => i.id));
    return item.after.filter((n) => !done.has(n));
}

/** Whether a claim is still live at `now`. */
export function planClaimLive(claim: PlanClaim | undefined, now: number = Date.now()): boolean {
    return claim !== undefined && claim.leaseUntil > now;
}

/** Whether all done-when lines are ticked (an empty checklist is not "done" by itself — a person marks it). */
export function planDoneWhenMet(doneWhen: readonly PlanDoneWhen[]): boolean {
    return doneWhen.length > 0 && doneWhen.every((d) => d.checked);
}

/**
 * Whether two touch paths overlap: equal, or one is a directory prefix of the other (`packages/core/` and
 * `packages/core/src/plan.ts`). A trailing `/` or `/**` marks a directory.
 */
export function planTouchesOverlap(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/\*\*$/, '/').replace(/^\.\//, '');
    const x = norm(a);
    const y = norm(b);
    if (x === y) return true;
    const dir = (p: string) => (p.endsWith('/') ? p : `${p}/`);
    return y.startsWith(dir(x)) || x.startsWith(dir(y));
}
