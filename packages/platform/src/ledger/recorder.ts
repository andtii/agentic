/**
 * The seam between a session's `usage` events and the books (architecture
 * §5a): the Session driver hands every turn-scoped usage row to a
 * `UsageRecorder`; `ledgerRecorder()` writes it to the month's Ledger
 * (one-way — the books never stall a turn) and, when the session works a
 * task, charges the Task, which fails itself `{budget}` once its limits are
 * spent. The verdict goes back to the driver so it cancels the turn (OPS-08).
 */

import type { TaskError, TaskId, WorkspaceId } from '@agentic/core';
import type { ActorClientWith, AnyActorDefinition } from '@sigx/actors';
import { TaskActor } from '../task/actor.js';
import { taskKey } from '../task/key.js';
import { isBudgetFailure } from './budget.js';
import { LedgerActor } from './actor.js';
import { ledgerKey, ledgerMonth } from './key.js';
import type { CorrectionTally, LedgerRow } from './state.js';

/** The slice of an `ActorContext` a recorder needs: the hop to another actor. */
export interface ActorHops {
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D>;
}

/** What the driver learns back: carry on, or stop — the task ended `failed {budget}`. */
export type UsageVerdict = { readonly ok: true } | { readonly ok: false; readonly error: TaskError };

export interface UsageRecorder {
    /** Record one row for `workspaceId`; resolves the budget verdict for the task the row belongs to (`ok` when it has none). */
    record(hops: ActorHops, workspaceId: WorkspaceId, row: LedgerRow): Promise<UsageVerdict>;
}

export interface LedgerRecorderOptions {
    /** Charge rows to their task and enforce its budget; default `true`. `false` keeps the books only. */
    readonly charge?: boolean;
}

/** The production recorder: Ledger append (one-way) + `Task.recordUsage` (awaited, for the verdict). */
export function ledgerRecorder(options: LedgerRecorderOptions = {}): UsageRecorder {
    const charge = options.charge ?? true;
    return {
        async record(hops, workspaceId, row) {
            await hops
                .actor(LedgerActor, ledgerKey(workspaceId, ledgerMonth(row.at)))
                .with({ oneWay: true })
                .append(row);
            if (!charge || row.taskId === undefined) return { ok: true };
            const view = await hops.actor(TaskActor, taskKey(workspaceId, row.taskId as TaskId)).recordUsage(row.usage, row.costUsd ?? 0);
            return isBudgetFailure(view) ? { ok: false, error: view.error! } : { ok: true };
        }
    };
}

/** The `@agentic/learning` `CorrectionLedger` over the month's Ledger (LRN-09). A week straddling two months counts in the month of each correction. */
export function ledgerCorrectionLedger(hops: ActorHops, workspaceId: WorkspaceId): { recordCorrection(tally: CorrectionTally): Promise<number> } {
    return {
        recordCorrection: (tally) => hops.actor(LedgerActor, ledgerKey(workspaceId, ledgerMonth(tally.at))).recordCorrection(tally)
    };
}
