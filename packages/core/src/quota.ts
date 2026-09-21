/**
 * Provider quota — how close an account is to its provider's limits (OPS-07, #261).
 * Not the Ledger: the Ledger records what was consumed; a quota snapshot says what
 * is left, as the provider reports it. Per-provider `QuotaSource` plugins produce
 * normalized snapshots; only these cross package boundaries and the wire.
 */

import type { AccountKey } from './account.js';
import type { RuntimeId } from './agent.js';
import type { EnvironmentId, MachineId } from './ids.js';
import type { PluginContext } from './memory.js';
import type { LocalEnvironment } from './runtime.js';

export type QuotaUnit = 'percent' | 'tokens' | 'requests' | 'usd' | 'credits';
export type QuotaStatus = 'ok' | 'warning' | 'exhausted' | 'unknown';

/** One limit window, e.g. Claude Code's "Current session" or "Current week (all models)". */
export interface QuotaWindow {
    /** Provider-stable: `'five_hour'`, `'seven_day'`, `'seven_day:fable'`. */
    readonly id: string;
    /** What the provider calls it: `'Current session'`, `'Current week (all models)'`. */
    readonly label: string;
    readonly period: 'minute' | 'session' | 'day' | 'week' | 'month' | 'other';
    readonly scope?: { readonly model?: string };
    /** 0..1; `null` when the provider gave no number. */
    readonly utilization: number | null;
    readonly used?: number;
    readonly limit?: number;
    readonly unit: QuotaUnit;
    /** ISO 8601; the UI formats it in the viewer's time zone. */
    readonly resetsAt?: string;
    readonly status: QuotaStatus;
}

/** Everything known about one account's limits at `observedAt`. */
export interface QuotaSnapshot {
    readonly sourceId: string;
    readonly runtime: RuntimeId;
    readonly environmentId: EnvironmentId;
    /** `'max'`, `'pro'`, … when known. */
    readonly plan?: string;
    readonly availability: 'reported' | 'partial' | 'not-reported';
    /** Why nothing is reported (PLG-09: say it, don't imply it). */
    readonly reason?: string;
    readonly windows: readonly QuotaWindow[];
    /** Epoch ms; readers compute staleness from it. */
    readonly observedAt: number;
    readonly via: 'probe' | 'stream' | 'headers';
}

/** A runtime event a source may read limits from — a zero-dependency stand-in for `AgentEvent` `ext` / `error`. */
export interface QuotaSignal {
    readonly ns: string;
    readonly name: string;
    readonly data: unknown;
}

/** What a runtime supplies to report its accounts' limits — not a plugin of its own: a runtime plugin that has one lists `USAGE_LIMITS_CAPABILITY` (#313). */
export interface QuotaSource {
    readonly id: string;
    readonly version: string;
    readonly runtime: RuntimeId;
    /** Ask the provider for a full snapshot of an idle account; `null` when it cannot (the caller stays passive). */
    probe?(env: LocalEnvironment, ctx: PluginContext): Promise<QuotaSnapshot | null>;
    /** A partial snapshot (typically one window) from a streamed signal; `null` when the signal carries no limits. */
    fromSignal?(signal: QuotaSignal, env: LocalEnvironment): QuotaSnapshot | null;
}

/** One account as the `usage_limits` tool reports it (MCP and agent tools alike): where it lives and its latest snapshot. */
export interface QuotaAccount {
    readonly machineId: MachineId;
    readonly machineName: string;
    readonly online: boolean;
    readonly environmentId: EnvironmentId;
    readonly runtime: RuntimeId;
    readonly account: { readonly label: string; readonly identity?: string };
    /** The account's key across machines (#414, `accountKeyOf`): the same login on two machines shares it. */
    readonly key?: AccountKey;
    /** `null` until the machine reports one. */
    readonly snapshot: QuotaSnapshot | null;
    /** How old the snapshot is, in ms; `null` without one. Weigh it with `resetsAt` before relying on a number. */
    readonly ageMs: number | null;
}

/** `usage_limits`: every account the caller may see, optionally narrowed to one machine or one runtime. */
export interface UsageLimitsQuery {
    readonly machineId?: MachineId;
    readonly runtime?: RuntimeId;
}

export interface UsageLimits {
    readonly accounts: readonly QuotaAccount[];
}

/**
 * Fold `next` into `prev`: `next`'s windows replace same-id windows, windows it does not
 * carry are kept (a stream update names one window), every other field comes from `next`.
 * A `not-reported` snapshot carries no windows and clears them.
 */
export function mergeQuota(prev: QuotaSnapshot | undefined, next: QuotaSnapshot): QuotaSnapshot {
    if (next.availability === 'not-reported') return { ...next, windows: [] };
    if (!prev || prev.availability === 'not-reported') return next;
    // Keyed by id: prev's order first, next's values win, windows only next has are appended.
    const byId = new Map<string, QuotaWindow>();
    for (const w of prev.windows) byId.set(w.id, w);
    for (const w of next.windows) byId.set(w.id, w);
    const windows = [...byId.values()];
    const availability = next.availability === 'partial' && prev.availability === 'reported' ? 'reported' : next.availability;
    return { ...prev, ...next, availability, windows };
}

/**
 * Whether a model-scoped window is `model`'s (#450). The provider scopes a window by display name (`Fable`, `Opus`), a
 * session names its model by id or alias (`claude-fable-5-1`, `opus`): the scope's first word must be one of the id's
 * words, case-insensitively. An unscoped window is every model's.
 */
export function windowMatchesModel(w: Pick<QuotaWindow, 'scope'>, model: string | undefined): boolean {
    const scoped = w.scope?.model?.trim().toLowerCase();
    if (!scoped) return true;
    if (!model) return false;
    const family = scoped.split(/[^a-z0-9]+/).find(Boolean);
    return !!family && model.toLowerCase().split(/[^a-z0-9]+/).includes(family);
}

const PERIOD_RANK: Readonly<Record<QuotaWindow['period'], number>> = { minute: 0, session: 1, day: 2, week: 3, month: 4, other: 5 };

/**
 * The windows that limit a member running `model` (#450): every window of the account's shared allowance plus the ones
 * scoped to that model — another model's exhausted week is not this member's limit. Shortest period first, the shared
 * window before the model's own (session → week → model week). Without a model, only the shared windows.
 */
export function memberWindows(s: Pick<QuotaSnapshot, 'windows'>, model?: string): readonly QuotaWindow[] {
    return s.windows
        .filter((w) => windowMatchesModel(w, model))
        .map((w, i) => ({ w, i }))
        .sort((a, b) => PERIOD_RANK[a.w.period] - PERIOD_RANK[b.w.period] || Number(!!a.w.scope?.model) - Number(!!b.w.scope?.model) || a.i - b.i)
        .map(({ w }) => w);
}

/** The window closest to its limit (highest utilization); for compact UI and AI hints. */
export function tightestWindow(s: Pick<QuotaSnapshot, 'windows'>): QuotaWindow | undefined {
    let best: QuotaWindow | undefined;
    for (const w of s.windows) {
        if (w.utilization === null) continue;
        if (!best || w.utilization > best.utilization!) best = w;
    }
    return best;
}
