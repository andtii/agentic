/**
 * The live usage page's view model (#146, OPS-07): pure adapters from what
 * the Ledger returns — `Ledger.summary({ by })` over one UTC month — to the
 * stat cards, the cost-per-day bars and the table rows the mock page
 * draws. Every figure says what it is: the reported part of a cost and
 * its estimated part are two numbers (never folded), and a group no
 * provider priced prints `n/a` in the dim ink, never 0 or blank.
 */
import type { DataQuality, LedgerGroup, LedgerSummary, LedgerTotals } from '@agentic/platform';
import type { AgentHue, Tone } from '@agentic/ui';
import type { AgentLookup } from '../chat/live';

/** The artboard's column template (`docs/design/HANDOFF.md` → tables) — the mock page's and the live page's. */
export const USAGE_COLS = '1fr 120px 120px 130px 150px';

export type LiveUsageBy = 'agent' | 'task' | 'day';

export const USAGE_BY: readonly { readonly value: LiveUsageBy; readonly label: string; readonly column: string }[] = [
    { value: 'agent', label: 'By agent', column: 'Agent' },
    { value: 'task', label: 'By task', column: 'Task' },
    { value: 'day', label: 'By day', column: 'Day' }
];

/** The Ledger's `(none)` group key — rows with no task. */
export const UNATTRIBUTED = '(none)';

/** A cost as two figures: what a provider reported (or priced at a known rate) and what was guessed. `null` when no row carries a cost. */
export interface CostParts {
    readonly reported: number;
    readonly estimated: number;
}

export function costPartsOf(t: LedgerTotals): CostParts | null {
    if (t.costUsd === null || t.quality === 'not-reported') return null;
    return { reported: Math.max(0, t.costUsd - t.estimatedCostUsd), estimated: t.estimatedCostUsd };
}

export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** `$1.20`, `$1.20 + ~$0.30`, `~$0.30` — or `n/a`. The tilde marks the estimated part and only that part. */
export function costText(parts: CostParts | null): string {
    if (!parts) return 'n/a';
    const bits: string[] = [];
    if (parts.reported > 0 || parts.estimated === 0) bits.push(usd(parts.reported));
    if (parts.estimated > 0) bits.push(`~${usd(parts.estimated)}`);
    return bits.join(' + ');
}

export function tokensOf(t: LedgerTotals): number | null {
    if (t.rows === 0) return null;
    return t.usage.totalTokens ?? t.usage.inputTokens + t.usage.outputTokens;
}

export function tokensText(tokens: number | null): string {
    if (tokens === null) return 'n/a';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return String(tokens);
}

/** One row of the table. */
export interface UsageLiveRow {
    readonly id: string;
    readonly label: string;
    readonly agent?: { readonly id: string; readonly name: string; readonly hue: AgentHue; readonly runtime: string };
    readonly sub: string;
    /** Ledger rows — one per turn. */
    readonly turns: number;
    readonly tokens: number | null;
    readonly cost: CostParts | null;
    readonly quality: DataQuality;
}

export function usageRowOf(group: LedgerGroup, by: LiveUsageBy, lookup: AgentLookup): UsageLiveRow {
    const base = { id: group.key, turns: group.rows, tokens: tokensOf(group), cost: costPartsOf(group), quality: group.quality };
    switch (by) {
        case 'agent': {
            const agent = lookup(group.key);
            return { ...base, label: agent.name, agent: { id: agent.id, name: agent.name, hue: agent.hue, runtime: agent.environment.runtime }, sub: agent.environment.runtime };
        }
        case 'task':
            return group.key === UNATTRIBUTED ? { ...base, label: 'No task (chat turns)', sub: '—' } : { ...base, label: group.key, sub: `${group.rows} ${group.rows === 1 ? 'turn' : 'turns'}` };
        case 'day':
            return { ...base, label: group.key, sub: `${group.rows} ${group.rows === 1 ? 'turn' : 'turns'}` };
    }
}

/** The `by` grouping's rows: the Ledger sorts by key; agents keep that, tasks and days read newest first. */
export function usageRowsOf(summary: LedgerSummary | null, by: LiveUsageBy, lookup: AgentLookup): UsageLiveRow[] {
    if (!summary) return [];
    const rows = summary.groups.map((g) => usageRowOf(g, by, lookup));
    return by === 'agent' ? rows : rows.reverse();
}

export interface UsageStat {
    readonly label: string;
    readonly value: string;
    readonly caption: string;
    readonly tone: Tone;
}

/** The month's `yyyy-mm` as a heading: `September 2026`. */
export function monthLabel(month: string): string {
    const [y, m] = month.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, (m ?? 1) - 1, 1)));
}

/** The four cards over the month's totals. */
export function statsOf(total: LedgerTotals | null, month: string): UsageStat[] {
    const t = total ?? null;
    const parts = t ? costPartsOf(t) : null;
    const turns = t?.rows ?? 0;
    return [
        {
            label: `${monthLabel(month)} spend`,
            value: parts ? usd(parts.reported + parts.estimated) : 'n/a',
            caption: parts ? (parts.estimated > 0 ? `${usd(parts.reported)} reported + ${usd(parts.estimated)} estimated` : 'every turn reported by its provider') : turns ? 'no provider reported a cost' : 'nothing recorded yet',
            tone: parts ? 'live' : 'muted'
        },
        {
            label: 'Estimated share',
            value: parts && parts.estimated > 0 ? `~${usd(parts.estimated)}` : '$0.00',
            caption: t && t.estimatedRows > 0 ? `${t.estimatedRows} ${t.estimatedRows === 1 ? 'turn' : 'turns'} priced at a guessed rate` : 'no turn priced at a guessed rate',
            tone: t && t.estimatedRows > 0 ? 'needs-you' : 'muted'
        },
        {
            label: 'Not reported',
            value: `${t?.unpricedRows ?? 0} ${(t?.unpricedRows ?? 0) === 1 ? 'turn' : 'turns'}`,
            caption: t && t.unpricedRows > 0 ? 'the runtime gave no cost data' : 'every turn carries a cost',
            tone: 'muted'
        },
        {
            label: 'Turns recorded',
            value: String(turns),
            caption: t ? `${tokensText(tokensOf(t))} tokens` : 'no usage yet',
            tone: 'live'
        }
    ];
}

/** The `yyyy-mm-dd` of the last day of a UTC month. */
export function daysInMonth(month: string): number {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y!, m ?? 1, 0)).getUTCDate();
}

export interface UsageDays {
    readonly from: string;
    readonly to: string;
    /** One value per day from the 1st to `to`; a day without a priced row is 0. */
    readonly values: readonly number[];
    /** The last bar's cost, as text. */
    readonly today: string;
}

/**
 * The cost-per-day bars: one per day of the month up to `today` (the
 * workspace zone's `yyyy-mm-dd`), from the `by: 'day'` summary. Unpriced
 * days are 0 — the bars show what was reported or estimated, the table
 * says which.
 */
export function daysOf(byDay: LedgerSummary | null, month: string, today: string): UsageDays {
    const last = today.startsWith(month) ? Number(today.slice(8, 10)) : daysInMonth(month);
    const costs = new Map<string, number>();
    for (const g of byDay?.groups ?? []) costs.set(g.key, g.costUsd ?? 0);
    const values: number[] = [];
    for (let d = 1; d <= last; d++) values.push(costs.get(`${month}-${String(d).padStart(2, '0')}`) ?? 0);
    const short = (day: number): string => `${day} ${new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}`;
    return { from: short(1), to: short(last), values, today: usd(values[values.length - 1] ?? 0) };
}

/** The `yyyy-mm-dd` an instant falls on in `timeZone` (default UTC) — the Ledger's own `dayOf`. */
export function dayOf(at: number, timeZone = 'UTC'): string {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
    } catch {
        return new Date(at).toISOString().slice(0, 10);
    }
}
