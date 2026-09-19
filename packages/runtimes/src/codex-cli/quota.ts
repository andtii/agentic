/**
 * `codexCliQuota` — the usage limits of a Codex account signed in with ChatGPT (#320).
 *
 * - `probe`: a short-lived app-server for the environment's profile, asked `account/read` and
 *   `account/rateLimits/read` — no thread, no model call. `primary` is the 5-hour window Codex
 *   calls the session limit, `secondary` the weekly one; `usedPercent` is 0..100, `resetsAt`
 *   epoch seconds. An API-key or Bedrock login has no plan limits, and says so (PLG-09).
 * - `fromSignal`: `account/rateLimits/updated`, which the adapter re-emits on its sessions as
 *   `ext codex-cli/rate-limits`, as a partial snapshot.
 */

import type { LocalEnvironment, PluginContext, QuotaSignal, QuotaSnapshot, QuotaSource, QuotaWindow } from '@agentic/core';
import { quotaStatusOf as statusOf } from '../harness/quota.js';
import { CODEX_CLI_PLUGIN_ID, CODEX_CLI_QUOTA_ID, QUOTA_SOURCE_VERSION } from '../plugins.js';
import { notReportedQuota } from '../quota.js';
import { CODEX_CLI_NS } from './agent.js';
import { authFromAccount } from './auth.js';
import type { CodexConnect } from './client.js';
import type { Account, GetAccountRateLimitsResponse, GetAccountResponse, RateLimitSnapshot, RateLimitWindow } from './protocol.js';

const RUNTIME = CODEX_CLI_PLUGIN_ID;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

type Shape = Pick<QuotaWindow, 'id' | 'label' | 'period'>;
const PRIMARY: Shape = { id: 'primary', label: 'Current session', period: 'session' };
const SECONDARY: Shape = { id: 'secondary', label: 'Current week', period: 'week' };

function windowOf(limit: RateLimitWindow | null, shape: Shape): QuotaWindow | undefined {
    if (!limit) return undefined;
    const utilization = typeof limit.usedPercent === 'number' ? clamp01(limit.usedPercent / 100) : null;
    return { ...shape, utilization, unit: 'percent', ...(typeof limit.resetsAt === 'number' ? { resetsAt: new Date(limit.resetsAt * 1000).toISOString() } : {}), status: statusOf(utilization) };
}

function windowsOf(limits: RateLimitSnapshot): QuotaWindow[] {
    return [windowOf(limits.primary, PRIMARY), windowOf(limits.secondary, SECONDARY)].filter((w): w is QuotaWindow => w !== undefined);
}

/** Why an account reports no plan limits (PLG-09: say it, don't imply it). */
export function codexNotReportedReason(account: Account | null): string {
    if (!account) return 'Not signed in to ChatGPT';
    if (account.type === 'apiKey') return 'Signed in with an API key: Codex reports no plan limits for it';
    if (account.type === 'amazonBedrock') return 'Signed in through Amazon Bedrock: Codex reports no plan limits there';
    return 'Codex reports no plan limits for this account';
}

/** `account/rateLimits/read` (for a ChatGPT login) as a snapshot. */
export function quotaFromRateLimits(env: Pick<LocalEnvironment, 'id'>, response: GetAccountRateLimitsResponse, account: Account | null, observedAt: number): QuotaSnapshot {
    const limits = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
    const plan = (account?.type === 'chatgpt' ? account.planType : undefined) ?? limits.planType ?? undefined;
    const base = { sourceId: CODEX_CLI_QUOTA_ID, runtime: RUNTIME, environmentId: env.id, ...(plan ? { plan } : {}), observedAt, via: 'probe' } as const;
    const windows = windowsOf(limits);
    if (windows.length === 0) return { ...base, availability: 'not-reported', reason: codexNotReportedReason(account), windows: [] };
    return { ...base, availability: 'reported', windows };
}

/** One streamed rate-limit snapshot as a partial snapshot; `null` when it carries no window. */
export function quotaFromRateLimitUpdate(env: Pick<LocalEnvironment, 'id'>, limits: RateLimitSnapshot, observedAt: number): QuotaSnapshot | null {
    const windows = windowsOf(limits);
    if (windows.length === 0) return null;
    return { sourceId: CODEX_CLI_QUOTA_ID, runtime: RUNTIME, environmentId: env.id, ...(limits.planType ? { plan: limits.planType } : {}), availability: 'partial', windows, observedAt, via: 'stream' };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export interface CodexCliQuotaOptions {
    /** Opens a short-lived app-server for an environment; the driver's `connect`. */
    readonly connect: CodexConnect;
    /** A probe that has not answered by then is abandoned (`null`). Default 20 s. */
    readonly timeoutMs?: number;
}

export function codexCliQuota(options: CodexCliQuotaOptions): QuotaSource {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    return {
        id: CODEX_CLI_QUOTA_ID,
        version: QUOTA_SOURCE_VERSION,
        runtime: RUNTIME,

        fromSignal(signal: QuotaSignal, env: LocalEnvironment) {
            if (env.runtime !== RUNTIME || signal.ns !== CODEX_CLI_NS || signal.name !== 'rate-limits' || !isRecord(signal.data)) return null;
            return quotaFromRateLimitUpdate(env, signal.data as unknown as RateLimitSnapshot, Date.now());
        },

        async probe(env: LocalEnvironment, ctx: PluginContext): Promise<QuotaSnapshot | null> {
            if (env.runtime !== RUNTIME) return null;
            let connection: Awaited<ReturnType<CodexConnect>> | undefined;
            try {
                connection = await options.connect(env);
                const account = authFromAccount(await connection.peer.request<GetAccountResponse>('account/read', { refreshToken: false }, { timeoutMs })).account;
                if (account?.type !== 'chatgpt') return notReportedQuota({ sourceId: CODEX_CLI_QUOTA_ID, runtime: RUNTIME, environmentId: env.id, reason: codexNotReportedReason(account), observedAt: ctx.now() });
                const limits = await connection.peer.request<GetAccountRateLimitsResponse>('account/rateLimits/read', undefined, { timeoutMs });
                return quotaFromRateLimits(env, limits, account, ctx.now());
            } catch (e) {
                ctx.log('warn', 'codex-cli quota probe failed; staying passive', { environmentId: env.id, error: e instanceof Error ? e.message : String(e) });
                return null;
            } finally {
                await connection?.close().catch(() => undefined);
            }
        }
    };
}
