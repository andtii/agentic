/**
 * `copilotCliQuota` — the usage-limits source for GitHub Copilot (#319).
 *
 * Copilot meters premium requests per month (plus chat and completions on the free plan). The probe asks
 * the environment's runtime — `account.getQuota`, the numbers `copilot` → `/usage` shows — which makes no
 * model call. An unlimited entitlement is a window with no utilization; a quota the account does not have
 * is left out. Any failure is `null`: the caller stays passive.
 */

import type { LocalEnvironment, PluginContext, QuotaSnapshot, QuotaSource, QuotaWindow } from '@agentic/core';
import { quotaStatusOf } from '../harness/quota.js';
import { COPILOT_CLI_QUOTA_ID, QUOTA_SOURCE_VERSION } from '../plugins.js';
import type { CopilotClientLike, CopilotQuotaSnapshot } from './sdk.js';

const RUNTIME = 'copilot-cli';
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/** Copilot's quota types, in the order they are shown. */
const WINDOWS: readonly (readonly [string, string])[] = [
    ['premium_interactions', 'Premium requests'],
    ['chat', 'Chat messages'],
    ['completions', 'Code completions']
];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function windowOf(id: string, label: string, q: CopilotQuotaSnapshot): QuotaWindow | undefined {
    if (q.hasQuota === false) return undefined;
    const resetsAt = q.resetDate && !Number.isNaN(Date.parse(q.resetDate)) ? { resetsAt: new Date(q.resetDate).toISOString() } : {};
    if (q.isUnlimitedEntitlement) return { id, label: `${label} (unlimited)`, period: 'month', utilization: null, used: q.usedRequests, unit: 'requests', ...resetsAt, status: 'ok' };
    const utilization = clamp01(1 - q.remainingPercentage / 100);
    return { id, label, period: 'month', utilization, used: q.usedRequests, limit: q.entitlementRequests, unit: 'requests', ...resetsAt, status: quotaStatusOf(utilization) };
}

/** `account.getQuota`'s answer as a snapshot. */
export function quotaFromCopilot(env: Pick<LocalEnvironment, 'id'>, snapshots: Readonly<Record<string, CopilotQuotaSnapshot | undefined>>, observedAt: number): QuotaSnapshot {
    const base = { sourceId: COPILOT_CLI_QUOTA_ID, runtime: RUNTIME, environmentId: env.id, observedAt, via: 'probe' } as const;
    const windows: QuotaWindow[] = [];
    for (const [id, label] of WINDOWS) {
        const q = snapshots[id];
        const w = q ? windowOf(id, label, q) : undefined;
        if (w) windows.push(w);
    }
    if (windows.length === 0) return { ...base, availability: 'not-reported', reason: 'Copilot reports no request allowance for this account', windows };
    return { ...base, availability: 'reported', windows };
}

export interface CopilotCliQuotaOptions {
    /** The environment's started client — the driver's, so a probe reuses the runtime a session would. */
    readonly client: (env: LocalEnvironment) => Promise<Pick<CopilotClientLike, 'getAuthStatus' | 'rpc'>>;
    /** A probe that has not answered by then is abandoned (`null`). Default 20 s. */
    readonly timeoutMs?: number;
}

export function copilotCliQuota(options: CopilotCliQuotaOptions): QuotaSource {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    return {
        id: COPILOT_CLI_QUOTA_ID,
        version: QUOTA_SOURCE_VERSION,
        runtime: RUNTIME,
        async probe(env: LocalEnvironment, ctx: PluginContext): Promise<QuotaSnapshot | null> {
            if (env.runtime !== RUNTIME) return null;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), timeoutMs);
            });
            const ask = async (): Promise<QuotaSnapshot | null> => {
                const client = await options.client(env);
                const auth = await client.getAuthStatus();
                if (!auth.isAuthenticated) {
                    return { sourceId: COPILOT_CLI_QUOTA_ID, runtime: RUNTIME, environmentId: env.id, availability: 'not-reported', reason: 'Not signed in to GitHub Copilot', windows: [], observedAt: ctx.now(), via: 'probe' };
                }
                const { quotaSnapshots } = await client.rpc.account.getQuota({});
                return quotaFromCopilot(env, quotaSnapshots, ctx.now());
            };
            try {
                return await Promise.race([ask(), timeout]);
            } catch (e) {
                ctx.log('warn', `[copilot-cli] usage probe failed for environment "${env.name}": ${e instanceof Error ? e.message : String(e)}`);
                return null;
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
    };
}
