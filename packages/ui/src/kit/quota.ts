/**
 * Pure helpers for provider limits (#270, part of #261): how a `QuotaWindow`
 * reads — "76% used", "Resets Sep 22 at 8pm (Europe/Stockholm)" in the
 * viewer's time zone — its tone, and whether a snapshot is too old to trust.
 */
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from '@agentic/core';
import type { Tone } from './vocabulary.js';

/** A snapshot older than this is shown stale. */
export const QUOTA_STALE_MS = 30 * 60_000;

const TONE: Readonly<Record<QuotaStatus, Tone>> = { ok: 'live', warning: 'needs-you', exhausted: 'failed', unknown: 'muted' };

export function quotaTone(status: QuotaStatus): Tone {
    return TONE[status];
}

/** 0..1 → a whole percent (0..100), or `null` when the provider gave no number. */
export function quotaPercent(w: Pick<QuotaWindow, 'utilization'>): number | null {
    return w.utilization === null ? null : Math.round(Math.min(1, Math.max(0, w.utilization)) * 100);
}

/** The window's name in one word or two, for the one-line meter: `Session`, `Week`, `Week · Fable`; the full label otherwise. */
export function quotaShortLabel(w: Pick<QuotaWindow, 'label' | 'period' | 'scope'>): string {
    const base = w.period === 'session' ? 'Session' : w.period === 'week' ? 'Week' : w.period === 'day' ? 'Day' : w.period === 'month' ? 'Month' : undefined;
    if (!base) return w.label;
    return w.scope?.model ? `${base} · ${w.scope.model}` : base;
}

/** `76% used`; a window without a number says so. */
export function quotaUsedText(w: Pick<QuotaWindow, 'utilization'>): string {
    const p = quotaPercent(w);
    return p === null ? 'No number reported' : `${p}% used`;
}

/** `1:10pm` / `8pm`: the provider's own style, in `timeZone`. */
function clock(at: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const minute = get('minute');
    return `${get('hour')}${minute === '00' ? '' : `:${minute}`}${get('dayPeriod').toLowerCase()}`;
}

const dayKey = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(at);

/** `Resets 1:10pm (Europe/Stockholm)` today, `Resets Sep 22 at 8pm (Europe/Stockholm)` later; `undefined` without a reset time. */
export function resetsText(resetsAt: string | undefined, options: { readonly now?: number; readonly timeZone?: string } = {}): string | undefined {
    if (!resetsAt) return undefined;
    const at = new Date(resetsAt);
    if (Number.isNaN(at.getTime())) return undefined;
    const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date(options.now ?? Date.now());
    const time = clock(at, timeZone);
    if (dayKey(at, timeZone) === dayKey(now, timeZone)) return `Resets ${time} (${timeZone})`;
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(at);
    return `Resets ${day} at ${time} (${timeZone})`;
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export function ageText(ms: number): string {
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
    return `${Math.floor(ms / 86_400_000)} d ago`;
}

export function isQuotaStale(s: Pick<QuotaSnapshot, 'observedAt'>, now: number = Date.now(), staleMs: number = QUOTA_STALE_MS): boolean {
    return now - s.observedAt > staleMs;
}
