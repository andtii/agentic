/**
 * Prices for `claude-*` models, USD per million tokens (OPS-07).
 *
 * The `LanguageModel` seam carries no price list, so this table is the
 * honest source — and an estimate is always flagged: a model the table does
 * not know is priced at its family's rate (or the Opus rate) with
 * `estimated: true`, never silently as fact. Dated snapshots of a known id
 * (`claude-opus-4-6-20260101`) resolve to that id.
 *
 * Rates as published by Anthropic on 2026-06-24. Cache writes are the
 * 5-minute rate (1.25× input); cache reads are 0.1× input except on
 * Fable 5.1, where they are $0.25.
 */

import type { Usage } from '@sigx/ai';

/** USD per million tokens. */
export interface ModelPricing {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
}

const tier = (input: number, output: number, cacheRead = input / 10): ModelPricing => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

const FABLE = tier(10, 50);
const OPUS = tier(5, 25);
const SONNET = tier(2, 10);
const HAIKU = tier(1, 5);

export const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricing>> = {
    'claude-fable-5-1': tier(10, 50, 0.25),
    'claude-mythos-5-1': FABLE,
    'claude-fable-5': FABLE,
    'claude-opus-5': OPUS,
    'claude-opus-4-8': OPUS,
    'claude-opus-4-7': OPUS,
    'claude-opus-4-6': OPUS,
    'claude-sonnet-5': SONNET,
    'claude-sonnet-4-6': tier(3, 15),
    'claude-haiku-4-5': HAIKU
};

export interface ResolvedPricing {
    readonly modelId: string;
    readonly pricing: ModelPricing;
    /** `true` when the rate is a guess for a model the table does not list. */
    readonly estimated: boolean;
}

/** The family a model id belongs to, for an estimate when the exact id is unknown. */
function familyOf(modelId: string): ModelPricing {
    const id = modelId.toLowerCase();
    if (id.includes('haiku')) return HAIKU;
    if (id.includes('sonnet')) return SONNET;
    if (id.includes('fable') || id.includes('mythos')) return FABLE;
    return OPUS;
}

export function resolvePricing(modelId: string): ResolvedPricing {
    const exact = ANTHROPIC_PRICING[modelId];
    if (exact) return { modelId, pricing: exact, estimated: false };
    // A dated snapshot or alias of a known id: the longest listed prefix wins.
    let best: string | undefined;
    for (const key of Object.keys(ANTHROPIC_PRICING)) {
        if (modelId.startsWith(`${key}-`) && (best === undefined || key.length > best.length)) best = key;
    }
    if (best !== undefined) return { modelId, pricing: ANTHROPIC_PRICING[best]!, estimated: false };
    return { modelId, pricing: familyOf(modelId), estimated: true };
}

/** A turn's cost from its usage at `pricing`, in USD. Missing counters count as zero. */
export function costOf(usage: Usage, pricing: ModelPricing): number {
    const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return (n(usage.inputTokens) * pricing.input + n(usage.outputTokens) * pricing.output + n(usage.cacheReadInputTokens) * pricing.cacheRead + n(usage.cacheCreationInputTokens) * pricing.cacheWrite) / 1_000_000;
}

export interface PricedUsage {
    readonly costUsd: number;
    readonly estimated: boolean;
}

/** Price `usage` for `modelId`; the flag says whether the rate was a guess. */
export function priceUsage(modelId: string, usage: Usage): PricedUsage {
    const { pricing, estimated } = resolvePricing(modelId);
    return { costUsd: costOf(usage, pricing), estimated };
}

/** The `pricing` hook `modelAgent` wants, bound to one model. */
export function anthropicPricing(modelId: string): (usage: Usage) => number {
    const { pricing } = resolvePricing(modelId);
    return (usage) => costOf(usage, pricing);
}
