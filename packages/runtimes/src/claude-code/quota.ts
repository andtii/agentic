/**
 * `claudeCodeQuota` — the `quota` source for Claude Code subscriptions (#269, part of #261).
 *
 * Two ways in, both normalized to core's `QuotaSnapshot`:
 * - `fromSignal`: the `rate_limit_event` a running session streams, which the adapter
 *   surfaces as `ext claude-code/rate-limit` (or, on a rejection, as `error rate_limited`
 *   with the `SDKRateLimitInfo` as its data). One window per event; utilization is a
 *   0..1 fraction and `resetsAt` epoch seconds (the CLI reads both from the
 *   `anthropic-ratelimit-unified-*` response headers).
 * - `probe`: the SDK's experimental usage call — what `claude` → `/usage` shows — on a
 *   query that is never prompted, so no model call is made. Utilization there is 0..100.
 *   Any failure is `null`: the caller stays on the stream.
 */

import { query as sdkQuery, type AccountInfo, type Options, type Query, type SDKControlGetUsageResponse, type SDKRateLimitInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { childEnv } from '@sigx/ai-agent-claude-code';
import type { LocalEnvironment, PluginContext, QuotaSignal, QuotaSnapshot, QuotaSource, QuotaStatus, QuotaWindow } from '@agentic/core';
import { CLAUDE_CODE_QUOTA_ID, QUOTA_SOURCE_VERSION } from '../plugins.js';
import { accountEnv } from './env.js';

const RUNTIME = 'claude-code';
/** From here a window reads as `warning` when the provider did not say. */
export const QUOTA_WARNING_AT = 0.8;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/** Just the part of `query` the probe uses; a fake in tests. */
export type QuotaQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET' | 'accountInfo' | 'close'>;

export interface ClaudeCodeQuotaOptions {
    /** The SDK's `query`; a fake in tests. */
    readonly query?: QuotaQueryFn;
    /** The daemon's own environment, whose account variables are kept out of the probe. Default `process.env`. */
    readonly parentEnv?: Readonly<Record<string, string | undefined>>;
    readonly pathToClaudeCodeExecutable?: string;
    /** A probe that has not answered by then is abandoned (`null`). Default 20 s. */
    readonly timeoutMs?: number;
}

type Limit = { readonly utilization: number | null; readonly resets_at: string | null } | null | undefined;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const statusOf = (utilization: number | null): QuotaStatus => (utilization === null ? 'unknown' : utilization >= 1 ? 'exhausted' : utilization >= QUOTA_WARNING_AT ? 'warning' : 'ok');
const weekOf = (model: string): Pick<QuotaWindow, 'id' | 'label' | 'period' | 'scope'> => ({ id: `seven_day:${model.toLowerCase()}`, label: `Current week (${model})`, period: 'week', scope: { model } });

/** A 0..100 window of the usage response; `undefined` when the provider sent none. */
function percentWindow(limit: Limit, shape: Pick<QuotaWindow, 'id' | 'label' | 'period' | 'scope'>): QuotaWindow | undefined {
    if (!limit) return undefined;
    const utilization = typeof limit.utilization === 'number' ? clamp01(limit.utilization / 100) : null;
    return { ...shape, utilization, unit: 'percent', ...(limit.resets_at ? { resetsAt: new Date(limit.resets_at).toISOString() } : {}), status: statusOf(utilization) };
}

/** Why an account reports no plan limits, from what `accountInfo()` says about it (PLG-09: say it, don't imply it). */
function notReportedReason(account: AccountInfo | undefined): string {
    if (account?.apiProvider && account.apiProvider !== 'firstParty') return `Signed in through ${account.apiProvider}: Claude Code reports no plan limits there`;
    if (account?.apiKeySource) return 'Signed in with an API key: Claude Code reports no plan limits for it';
    if (!account || account.tokenSource === 'none') return 'Not signed in to a Claude subscription';
    return 'Claude Code reports no plan limits for this account';
}

/** The `/usage` answer as a snapshot. */
export function quotaFromUsage(env: Pick<LocalEnvironment, 'id'>, usage: SDKControlGetUsageResponse, account: AccountInfo | undefined, observedAt: number): QuotaSnapshot {
    const base = { sourceId: CLAUDE_CODE_QUOTA_ID, runtime: RUNTIME, environmentId: env.id, ...(usage.subscription_type ? { plan: usage.subscription_type } : {}), observedAt, via: 'probe' } as const;
    const limits = usage.rate_limits;
    if (!usage.rate_limits_available || !limits) return { ...base, availability: 'not-reported', reason: notReportedReason(account), windows: [] };
    const windows: QuotaWindow[] = [];
    const add = (w: QuotaWindow | undefined) => {
        if (w && !windows.some((x) => x.id === w.id)) windows.push(w);
    };
    add(percentWindow(limits.five_hour, { id: 'five_hour', label: 'Current session', period: 'session' }));
    add(percentWindow(limits.seven_day, { id: 'seven_day', label: 'Current week (all models)', period: 'week' }));
    add(percentWindow(limits.seven_day_opus, weekOf('Opus')));
    add(percentWindow(limits.seven_day_sonnet, weekOf('Sonnet')));
    for (const m of limits.model_scoped ?? []) add(percentWindow(m, weekOf(m.display_name)));
    const extra = limits.extra_usage;
    if (extra?.is_enabled) {
        const utilization = typeof extra.utilization === 'number' ? clamp01(extra.utilization / 100) : null;
        add({ id: 'extra_usage', label: 'Extra usage', period: 'month', utilization, unit: 'usd', status: statusOf(utilization) });
    }
    return { ...base, availability: 'reported', windows };
}

const STREAM_WINDOWS: Readonly<Record<string, Pick<QuotaWindow, 'id' | 'label' | 'period' | 'scope'>>> = {
    five_hour: { id: 'five_hour', label: 'Current session', period: 'session' },
    seven_day: { id: 'seven_day', label: 'Current week (all models)', period: 'week' },
    seven_day_opus: weekOf('Opus'),
    seven_day_sonnet: weekOf('Sonnet'),
    overage: { id: 'extra_usage', label: 'Extra usage', period: 'month' }
};

/** One streamed `SDKRateLimitInfo` as a partial snapshot; `null` when it names no window this source knows. */
export function quotaFromRateLimit(env: Pick<LocalEnvironment, 'id'>, info: SDKRateLimitInfo, observedAt: number): QuotaSnapshot | null {
    const shape = info.rateLimitType ? STREAM_WINDOWS[info.rateLimitType] : undefined;
    if (!shape) return null;
    const utilization = typeof info.utilization === 'number' ? clamp01(info.utilization) : null;
    const status: QuotaStatus = info.status === 'rejected' ? 'exhausted' : info.status === 'allowed_warning' ? 'warning' : statusOf(utilization);
    const window: QuotaWindow = {
        ...shape,
        utilization,
        unit: shape.id === 'extra_usage' ? 'usd' : 'percent',
        ...(typeof info.resetsAt === 'number' ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}),
        status
    };
    return { sourceId: CLAUDE_CODE_QUOTA_ID, runtime: RUNTIME, environmentId: env.id, availability: 'partial', windows: [window], observedAt, via: 'stream' };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The `SDKRateLimitInfo` a signal carries: `ext claude-code/rate-limit` → `data.rate_limit_info`;
 * an `error` event (signalled as `{ ns: 'error', name: <code> }`) with code `rate_limited` → `data` itself.
 */
function rateLimitInfoOf(signal: QuotaSignal): SDKRateLimitInfo | undefined {
    if (signal.ns === 'claude-code' && signal.name === 'rate-limit' && isRecord(signal.data) && isRecord(signal.data.rate_limit_info)) return signal.data.rate_limit_info as SDKRateLimitInfo;
    if (signal.ns === 'error' && signal.name === 'rate_limited' && isRecord(signal.data) && typeof signal.data.status === 'string') return signal.data as SDKRateLimitInfo;
    return undefined;
}

export function claudeCodeQuota(options: ClaudeCodeQuotaOptions = {}): QuotaSource {
    const query: QuotaQueryFn = options.query ?? (sdkQuery as unknown as QuotaQueryFn);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    return {
        id: CLAUDE_CODE_QUOTA_ID,
        version: QUOTA_SOURCE_VERSION,
        runtime: RUNTIME,

        fromSignal(signal, env) {
            if (env.runtime !== RUNTIME) return null;
            const info = rateLimitInfoOf(signal);
            return info ? quotaFromRateLimit(env, info, Date.now()) : null;
        },

        async probe(env: LocalEnvironment, ctx: PluginContext): Promise<QuotaSnapshot | null> {
            if (env.runtime !== RUNTIME) return null;
            // Streaming input that never yields: the CLI starts, answers control requests, and is never prompted.
            let release: () => void = () => {};
            const idle = new Promise<void>((resolve) => (release = resolve));
            const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
                await idle;
            })();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let q: ReturnType<QuotaQueryFn> | undefined;
            try {
                const parent = options.parentEnv ?? process.env;
                q = query({
                    prompt,
                    options: {
                        env: childEnv(accountEnv(env, parent), parent as NodeJS.ProcessEnv),
                        settingSources: [],
                        ...(options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {})
                    }
                });
                const running = q;
                const answer = Promise.all([running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), running.accountInfo().catch(() => undefined)]);
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
                });
                const [usage, account] = await Promise.race([answer, timeout]);
                return quotaFromUsage(env, usage, account, ctx.now());
            } catch (e) {
                ctx.log('warn', 'claude-code quota probe failed; staying passive', { environmentId: env.id, error: e instanceof Error ? e.message : String(e) });
                return null;
            } finally {
                if (timer !== undefined) clearTimeout(timer);
                try {
                    q?.close();
                } catch {
                    // already closed
                }
                release();
            }
        }
    };
}
