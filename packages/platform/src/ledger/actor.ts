/**
 * The Ledger actor — `{ws}:ledger:{yyyy-mm}` (architecture §4, OPS-07/08):
 * one usage row per turn-scoped `usage` event, priced by the runtime that
 * saw it and flagged when the price was a guess; aggregated on read by
 * agent, task, session, turn or day; plus the LRN-09 correction counters.
 * Every mutation is one entry folded by `applyLedgerEntry` and made durable
 * inside the turn (Workers never run `onDeactivate`).
 */

import { defineActor, type ActorContext, type ActorDefinition, type ActorOptions } from '@sigx/actors';
import type { AgentId } from '@agentic/core';
import { sameWorkspace } from '../auth/index.js';
import { LEDGER_TYPE, ledgerMonth, parseLedgerKey } from './key.js';
import { applyLedgerEntry, correctionKey, initialLedgerState, type CorrectionKind, type CorrectionTally, type LedgerEntry, type LedgerRow, type LedgerState } from './state.js';
import { summarize, type LedgerSummary, type SummaryOptions } from './summary.js';

export interface RowsQuery {
    readonly agentId?: string;
    readonly taskId?: string;
    readonly sessionId?: string;
    /** Newest first; default all. */
    readonly limit?: number;
}

/** A type alias, not an interface: `ActorMethodTable` needs the implicit index signature only aliases carry. */
export type LedgerMethods = {
    /** Record one row. Idempotent by `row.key`; resolves `true` when the row was new. A row of another month is refused. */
    append(row: LedgerRow): Promise<boolean>;
    /** Rows matching the filter, newest first. */
    rows(query?: RowsQuery): LedgerRow[];
    /** Totals by agent / task / session / turn / day; estimates and unreported data are flagged, never folded into fact (OPS-07). */
    summary(options: SummaryOptions): LedgerSummary;
    /** Count one correction (LRN-09, the `CorrectionLedger` port); resolves to the agent's total for that week. */
    recordCorrection(tally: CorrectionTally): Promise<number>;
    /** Corrections for an agent in an ISO week, optionally of one kind. */
    corrections(agentId: AgentId, week: string, what?: CorrectionKind): number;
};

type Ctx = ActorContext<LedgerState>;

const KINDS: readonly CorrectionKind[] = ['wrong', 'prefer', 'never'];

/** Make one entry durable: `ctx.append` (@sigx/actors #312) where the runtime has it, the reducer plus a full `ctx.save()` otherwise. */
async function commit(ctx: Ctx, entry: LedgerEntry): Promise<void> {
    const append = (ctx as Partial<{ append(entry: unknown): Promise<void> }>).append;
    if (typeof append === 'function') {
        await append.call(ctx, entry);
        return;
    }
    applyLedgerEntry(ctx.state, entry);
    await ctx.save();
}

function count(state: LedgerState, agentId: string, week: string, what?: CorrectionKind): number {
    if (what) return state.corrections[correctionKey(agentId, week, what)] ?? 0;
    let n = 0;
    for (const k of KINDS) n += state.corrections[correctionKey(agentId, week, k)] ?? 0;
    return n;
}

const options: ActorOptions<LedgerState, LedgerMethods, Record<never, never>> & { applyEntry(state: LedgerState, entry: unknown): void } = {
    type: LEDGER_TYPE,
    authorize: [sameWorkspace],
    state: initialLedgerState,
    applyEntry: applyLedgerEntry,
    reads: { rows: { maxAge: 0 }, summary: { maxAge: 0 }, corrections: { maxAge: 0 } },
    methods: (ctx): LedgerMethods => {
        const s = ctx.state;
        const month = (): string => {
            const parsed = parseLedgerKey(ctx.key);
            if (!parsed) throw new Error(`ledger: not a ledger key: ${ctx.key}`);
            return parsed.month;
        };
        return {
            async append(row) {
                const m = month();
                const rowMonth = ledgerMonth(row.at);
                if (rowMonth !== m) throw new Error(`ledger ${ctx.key}: row ${row.key} belongs to ${rowMonth}`);
                if (Object.hasOwn(s.seen, row.key)) return false;
                await commit(ctx, { t: 'usage', row });
                return true;
            },
            rows(query = {}) {
                let out = ctx.snapshot(s.rows);
                if (query.agentId !== undefined) out = out.filter((r) => r.agentId === query.agentId);
                if (query.taskId !== undefined) out = out.filter((r) => r.taskId === query.taskId);
                if (query.sessionId !== undefined) out = out.filter((r) => r.sessionId === query.sessionId);
                out.reverse();
                return query.limit !== undefined ? out.slice(0, query.limit) : out;
            },
            summary(opts) {
                return summarize(ctx.snapshot(s.rows), opts);
            },
            async recordCorrection(tally) {
                await commit(ctx, { t: 'correction', tally });
                return count(s, tally.agentId, tally.week);
            },
            corrections(agentId, week, what) {
                return count(s, agentId, week, what);
            }
        };
    }
};

export const LedgerActor: ActorDefinition<LedgerState, LedgerMethods, Record<never, never>> = defineActor(options);
