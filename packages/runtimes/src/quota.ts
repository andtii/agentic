/**
 * Quota for runtimes that report no plan limits (#269, part of #261). Edge-safe.
 *
 * The Anthropic API meters by the minute per request (rate-limit response headers), not by a plan
 * allowance an account can plan against, so its snapshot says so instead of implying zero or unknown
 * (PLG-09). The Claude Code source is on `@agentic/runtimes/claude-code`.
 */

import type { EnvironmentId, QuotaSnapshot, QuotaSource, RuntimeId } from '@agentic/core';
import { ANTHROPIC_API_PLUGIN_ID } from './plugins.js';

export const ANTHROPIC_API_QUOTA_ID = 'agentic.quota.anthropic-api';
export const ANTHROPIC_API_QUOTA_REASON = 'The Anthropic API has per-minute rate limits, not a plan allowance to report';

/** A snapshot that states why a provider reports nothing. */
export function notReportedQuota(input: { readonly sourceId: string; readonly runtime: RuntimeId; readonly environmentId: EnvironmentId; readonly reason: string; readonly observedAt: number }): QuotaSnapshot {
    return { sourceId: input.sourceId, runtime: input.runtime, environmentId: input.environmentId, availability: 'not-reported', reason: input.reason, windows: [], observedAt: input.observedAt, via: 'probe' };
}

/** `anthropic-api`'s honest answer: not reported, and why. */
export function anthropicApiQuota(): QuotaSource {
    return {
        id: ANTHROPIC_API_QUOTA_ID,
        version: '0.1.0',
        runtime: ANTHROPIC_API_PLUGIN_ID,
        probe: async (env, ctx) =>
            env.runtime === ANTHROPIC_API_PLUGIN_ID ? notReportedQuota({ sourceId: ANTHROPIC_API_QUOTA_ID, runtime: ANTHROPIC_API_PLUGIN_ID, environmentId: env.id, reason: ANTHROPIC_API_QUOTA_REASON, observedAt: ctx.now() }) : null
    };
}
