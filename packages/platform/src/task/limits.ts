/**
 * Delegation limits (COL-11): depth, concurrency and the budget split. Pure
 * functions over `Limits`, so the rules are testable without an actor.
 */

import type { Limits } from '@agentic/core';
import { TaskLimitError } from './errors.js';

/** Levels below the root a chain may reach when the contract sets no `maxDepth`. */
export const DEFAULT_MAX_DEPTH = 5;
/** Unsettled children one task may hold when the contract sets no `maxConcurrentChildren`. */
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 8;

/** The limits a child inherits a share of. `maxDepth` and `maxConcurrentChildren` are inherited whole. */
export const BUDGET_KEYS = ['maxCostUsd', 'maxTokens', 'maxWallMs', 'maxTurns', 'maxSteps'] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

/** What the parent has already used of each budget. */
export type Spent = Partial<Record<BudgetKey, number>>;

export function checkDepth(parentDepth: number, limits: Limits): number {
    const depth = parentDepth + 1;
    const max = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (depth > max) throw new TaskLimitError('depth', `delegation depth ${depth} exceeds maxDepth ${max}`, 'maxDepth');
    return depth;
}

export function checkConcurrency(liveChildren: number, limits: Limits): void {
    const max = limits.maxConcurrentChildren ?? DEFAULT_MAX_CONCURRENT_CHILDREN;
    if (liveChildren >= max) {
        throw new TaskLimitError('concurrency', `${liveChildren} unsettled children reach maxConcurrentChildren ${max}`, 'maxConcurrentChildren');
    }
}

/** What is left of one parent budget after its own spend and the live children's reservations. */
export function remaining(parent: Limits, spent: Spent, reserved: readonly Limits[], key: BudgetKey): number | undefined {
    const limit = parent[key];
    if (limit === undefined) return undefined;
    let left = limit - (spent[key] ?? 0);
    for (const r of reserved) left -= r[key] ?? 0;
    return left;
}

/**
 * The child's limits: every budget the parent carries is clamped to what the
 * parent has left (never widened; exhausted → throws), a budget the parent does
 * not carry passes through as requested, and the structural limits are
 * inherited whole unless the request tightens them.
 */
export function splitBudget(parent: Limits, spent: Spent, reserved: readonly Limits[], requested: Limits = {}): Limits {
    const out: Record<string, number> = {};
    for (const key of BUDGET_KEYS) {
        const left = remaining(parent, spent, reserved, key);
        const asked = requested[key];
        if (left === undefined) {
            if (asked !== undefined) out[key] = asked;
            continue;
        }
        if (left <= 0) throw new TaskLimitError('budget', `no ${key} left to delegate (remaining ${left})`, key);
        out[key] = asked === undefined ? left : Math.min(asked, left);
    }
    const depth = tighter(parent.maxDepth, requested.maxDepth);
    if (depth !== undefined) out.maxDepth = depth;
    const concurrency = tighter(parent.maxConcurrentChildren, requested.maxConcurrentChildren);
    if (concurrency !== undefined) out.maxConcurrentChildren = concurrency;
    return out as Limits;
}

function tighter(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(a, b);
}
