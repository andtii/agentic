/**
 * Aggregation over ledger rows (OPS-07). Pure, so the rules are testable
 * without an actor. Every figure says what it is: a cost is the sum of the
 * rows that CARRY one (`null` when none does — never 0 for unreported data),
 * the estimated share is broken out, and `quality` names the mix.
 */

import { ZERO_USAGE, addUsage, type Usage } from '@agentic/core';
import type { LedgerRow } from './state.js';

export type SummaryBy = 'agent' | 'task' | 'session' | 'turn' | 'day';

/**
 * How much of a figure is provider fact:
 * - `reported` — every row carries a cost the runtime reported or priced at a known rate;
 * - `estimated` — every row carries a cost, all at a guessed rate;
 * - `partly-estimated` — some rows are estimates or carry no cost at all;
 * - `not-reported` — no row carries a cost (the provider gave none and nothing could price it).
 */
export type DataQuality = 'reported' | 'partly-estimated' | 'estimated' | 'not-reported';

export interface LedgerTotals {
    readonly rows: number;
    readonly usage: Usage;
    /** Sum over the rows that carry a cost; `null` when none does. */
    readonly costUsd: number | null;
    /** The part of `costUsd` that came from estimated rates. */
    readonly estimatedCostUsd: number;
    /** Rows priced at a guessed rate. */
    readonly estimatedRows: number;
    /** Rows with no cost at all — provider data unavailable. */
    readonly unpricedRows: number;
    readonly quality: DataQuality;
    /** Earliest and latest `at`; `0` when there are no rows. */
    readonly from: number;
    readonly to: number;
}

export interface LedgerGroup extends LedgerTotals {
    /** The agent / task / session / turn id, or the `yyyy-mm-dd` day. */
    readonly key: string;
}

export interface LedgerSummary {
    readonly by: SummaryBy;
    readonly total: LedgerTotals;
    /** Sorted by `key`. */
    readonly groups: readonly LedgerGroup[];
}

export interface SummaryOptions {
    readonly by: SummaryBy;
    /** IANA zone the `day` grouping uses; default UTC. */
    readonly timeZone?: string;
    readonly agentId?: string;
    readonly taskId?: string;
    readonly sessionId?: string;
}

/** The group key of a row that lacks the dimension (a session row with no task, a row with no turn). */
export const UNATTRIBUTED = '(none)';

/** The `yyyy-mm-dd` an instant falls on in `timeZone` (default UTC). */
export function dayOf(at: number, timeZone = 'UTC'): string {
    // en-CA renders numeric dates as ISO `yyyy-mm-dd`.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

interface Acc {
    rows: number;
    usage: Usage;
    priced: number;
    costUsd: number;
    estimatedCostUsd: number;
    estimatedRows: number;
    from: number;
    to: number;
}

const acc = (): Acc => ({ rows: 0, usage: ZERO_USAGE, priced: 0, costUsd: 0, estimatedCostUsd: 0, estimatedRows: 0, from: 0, to: 0 });

function fold(a: Acc, row: LedgerRow): void {
    a.rows++;
    a.usage = addUsage(a.usage, row.usage);
    if (typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) {
        a.priced++;
        a.costUsd += row.costUsd;
        if (row.estimated) {
            a.estimatedRows++;
            a.estimatedCostUsd += row.costUsd;
        }
    }
    a.from = a.rows === 1 ? row.at : Math.min(a.from, row.at);
    a.to = Math.max(a.to, row.at);
}

export function qualityOf(t: { readonly rows: number; readonly priced: number; readonly estimatedRows: number }): DataQuality {
    if (t.rows === 0 || t.priced === 0) return 'not-reported';
    if (t.priced === t.rows && t.estimatedRows === 0) return 'reported';
    if (t.priced === t.rows && t.estimatedRows === t.rows) return 'estimated';
    return 'partly-estimated';
}

function totals(a: Acc): LedgerTotals {
    return {
        rows: a.rows,
        usage: a.usage,
        costUsd: a.priced === 0 ? null : a.costUsd,
        estimatedCostUsd: a.estimatedCostUsd,
        estimatedRows: a.estimatedRows,
        unpricedRows: a.rows - a.priced,
        quality: qualityOf(a),
        from: a.from,
        to: a.to
    };
}

function keyOf(row: LedgerRow, by: SummaryBy, timeZone: string | undefined): string {
    switch (by) {
        case 'agent':
            return row.agentId;
        case 'task':
            return row.taskId ?? UNATTRIBUTED;
        case 'session':
            return row.sessionId;
        case 'turn':
            return row.turnId ?? UNATTRIBUTED;
        case 'day':
            return dayOf(row.at, timeZone);
    }
}

/** Group `rows` (after the option filters) by `options.by`; the total spans the same rows. */
export function summarize(rows: readonly LedgerRow[], options: SummaryOptions): LedgerSummary {
    const { by, timeZone } = options;
    if (timeZone !== undefined) dayOf(0, timeZone); // an unknown zone throws here, before any row is read
    const all = acc();
    const groups = new Map<string, Acc>();
    for (const row of rows) {
        if (options.agentId !== undefined && row.agentId !== options.agentId) continue;
        if (options.taskId !== undefined && row.taskId !== options.taskId) continue;
        if (options.sessionId !== undefined && row.sessionId !== options.sessionId) continue;
        fold(all, row);
        const key = keyOf(row, by, timeZone);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = acc()));
        fold(g, row);
    }
    const out: LedgerGroup[] = [];
    for (const [key, g] of groups) out.push({ key, ...totals(g) });
    out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    return { by, total: totals(all), groups: out };
}
