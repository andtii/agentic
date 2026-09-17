/**
 * Budget enforcement (COL-11, OPS-08): is a task's spend still inside its
 * limits? Pure over `Limits` and the task's `Spent`, so the Task actor asks
 * it before a delegation and after every usage row, and the Session driver
 * acts on the verdict the Task hands back. Estimated costs count in full —
 * a budget is a ceiling, and a guess never lowers it.
 */

import type { Limits, TaskError, TaskSnapshot } from '@agentic/core';
import { BUDGET_KEYS, type BudgetKey, type Spent } from '../task/limits.js';

/** The `TaskError.code` of a task that ended because its budget ran out — `failed {budget}`. */
export const BUDGET_ERROR_CODE = 'budget';

export type BudgetVerdict = { readonly ok: true } | { readonly ok: false; readonly limit: BudgetKey; readonly max: number; readonly spent: number };

/** The first budget that is exhausted (`spent >= max`), in `BUDGET_KEYS` order; a limit the task does not carry never trips. */
export function checkBudget(limits: Limits, spent: Spent): BudgetVerdict {
    for (const limit of BUDGET_KEYS) {
        const max = limits[limit];
        if (max === undefined) continue;
        const used = spent[limit] ?? 0;
        if (used >= max) return { ok: false, limit, max, spent: used };
    }
    return { ok: true };
}

/** What is left of one budget, or `undefined` when the task does not carry it. Never below zero. */
export function remainingBudget(limits: Limits, spent: Spent, limit: BudgetKey): number | undefined {
    const max = limits[limit];
    return max === undefined ? undefined : Math.max(0, max - (spent[limit] ?? 0));
}

/** The error an over-budget task fails with. */
export function budgetError(verdict: Exclude<BudgetVerdict, { ok: true }>): TaskError {
    return {
        code: BUDGET_ERROR_CODE,
        message: `budget exhausted: ${verdict.limit} ${verdict.max} reached (spent ${verdict.spent})`,
        recoverable: false
    };
}

/** `true` for a task that ended `failed {budget}`. */
export function isBudgetFailure(task: Pick<TaskSnapshot, 'status' | 'error'>): boolean {
    return task.status === 'failed' && task.error?.code === BUDGET_ERROR_CODE;
}
