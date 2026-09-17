/**
 * The Ledger port for LRN-09: learning counts corrections per agent per ISO
 * week so repeated mistakes are measurable. The platform Ledger (#45)
 * implements `CorrectionLedger` structurally; `memoryCorrectionLedger` is the
 * dev/test backend.
 */

import type { AgentId, Correction } from '@agentic/core';

export interface CorrectionTally {
    readonly agentId: AgentId;
    /** ISO 8601 week in UTC, e.g. `2026-W38`. */
    readonly week: string;
    readonly what: Correction['what'];
    readonly at: number;
}

export interface CorrectionLedger {
    /** Count one correction; resolve to the agent's total for that week. */
    recordCorrection(tally: CorrectionTally): number | Promise<number>;
}

/** ISO 8601 week (`YYYY-Www`) of an instant, in UTC. */
export function isoWeek(at: number): string {
    const d = new Date(at);
    const day = d.getUTCDay() || 7;
    // An ISO week belongs to the year of its Thursday.
    const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
    const year = new Date(thursday).getUTCFullYear();
    const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface MemoryCorrectionLedger extends CorrectionLedger {
    /** Corrections for an agent in a week, optionally of one kind. */
    count(agentId: AgentId, week: string, what?: Correction['what']): number;
}

const WHATS: readonly Correction['what'][] = ['wrong', 'prefer', 'never'];

/** In-memory counters keyed by agent, week and kind. */
export function memoryCorrectionLedger(): MemoryCorrectionLedger {
    const counts = new Map<string, number>();
    const key = (agentId: string, week: string, what: string) => JSON.stringify([agentId, week, what]);
    const ledger: MemoryCorrectionLedger = {
        recordCorrection(t) {
            const k = key(t.agentId, t.week, t.what);
            counts.set(k, (counts.get(k) ?? 0) + 1);
            return ledger.count(t.agentId, t.week);
        },
        count(agentId, week, what) {
            if (what) return counts.get(key(agentId, week, what)) ?? 0;
            return WHATS.reduce((n, w) => n + (counts.get(key(agentId, week, w)) ?? 0), 0);
        }
    };
    return ledger;
}
