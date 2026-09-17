/**
 * Ledger state and the entry reducer. Every mutation is one `LedgerEntry`
 * folded by the pure `applyLedgerEntry` — no clock, no ids — so the record
 * is snapshot + log either way: `ctx.append` where the runtime ships it,
 * the reducer plus `ctx.save()` where it does not.
 */

import type { AgentId, UsageRow } from '@agentic/core';

/** A row as the Ledger keeps it: the core `UsageRow` plus an idempotency `key` and the turn it belongs to. */
export interface LedgerRow extends UsageRow {
    /** Unique per row — `{sessionId}:{epoch}:{seq}` for a row born of a session event; a replay folds once. */
    readonly key: string;
    readonly turnId?: string;
}

export type CorrectionKind = 'wrong' | 'prefer' | 'never';

/** One correction counted for LRN-09 (the `@agentic/learning` `CorrectionTally`, structurally). */
export interface CorrectionTally {
    readonly agentId: AgentId;
    /** ISO 8601 week in UTC, e.g. `2026-W38`. */
    readonly week: string;
    readonly what: CorrectionKind;
    readonly at: number;
}

export type LedgerEntry = { readonly t: 'usage'; readonly row: LedgerRow } | { readonly t: 'correction'; readonly tally: CorrectionTally };

export interface LedgerState {
    /** In append order. */
    rows: LedgerRow[];
    /** Row keys already folded, for idempotent appends. */
    seen: Record<string, 1>;
    /** Corrections per `correctionKey(agentId, week, what)`. */
    corrections: Record<string, number>;
}

export function initialLedgerState(): LedgerState {
    return { rows: [], seen: {}, corrections: {} };
}

export function correctionKey(agentId: string, week: string, what: CorrectionKind): string {
    return `${agentId}|${week}|${what}`;
}

export function applyLedgerEntry(state: LedgerState, entry: unknown): void {
    const e = entry as LedgerEntry;
    switch (e.t) {
        case 'usage':
            if (Object.hasOwn(state.seen, e.row.key)) return;
            state.seen[e.row.key] = 1;
            state.rows.push(e.row);
            return;
        case 'correction': {
            const k = correctionKey(e.tally.agentId, e.tally.week, e.tally.what);
            state.corrections[k] = (state.corrections[k] ?? 0) + 1;
            return;
        }
    }
}
