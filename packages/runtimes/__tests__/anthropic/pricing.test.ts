import { ANTHROPIC_PRICING, anthropicPricing, costOf, priceUsage, resolvePricing } from '../../src/index';

describe('pricing table', () => {
    it('lists the current claude ids with cache rates derived from input', () => {
        expect(ANTHROPIC_PRICING['claude-opus-5']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
        expect(ANTHROPIC_PRICING['claude-sonnet-4-6']).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
        expect(ANTHROPIC_PRICING['claude-haiku-4-5']).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
        // Fable 5.1 reads the cache at a flat $0.25, not 0.1× input.
        expect(ANTHROPIC_PRICING['claude-fable-5-1']).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    });
    it('resolves a known id as fact and a dated snapshot to its id', () => {
        expect(resolvePricing('claude-opus-5')).toEqual({ modelId: 'claude-opus-5', pricing: ANTHROPIC_PRICING['claude-opus-5'], estimated: false });
        expect(resolvePricing('claude-opus-4-6-20260101')).toEqual({ modelId: 'claude-opus-4-6-20260101', pricing: ANTHROPIC_PRICING['claude-opus-4-6'], estimated: false });
    });
    it('estimates an unknown id from its family and says so', () => {
        expect(resolvePricing('claude-haiku-9')).toEqual({ modelId: 'claude-haiku-9', pricing: ANTHROPIC_PRICING['claude-haiku-4-5'], estimated: true });
        expect(resolvePricing('claude-sonnet-9')).toMatchObject({ pricing: ANTHROPIC_PRICING['claude-sonnet-5'], estimated: true });
        expect(resolvePricing('claude-fable-9')).toMatchObject({ pricing: ANTHROPIC_PRICING['claude-fable-5'], estimated: true });
        expect(resolvePricing('claude-nova-1')).toMatchObject({ pricing: ANTHROPIC_PRICING['claude-opus-5'], estimated: true });
        expect(resolvePricing('mock')).toMatchObject({ estimated: true });
    });
});

describe('costOf / priceUsage', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 400_000 };
    it('sums the four counters at their own rates', () => {
        expect(costOf(usage, ANTHROPIC_PRICING['claude-opus-5']!)).toBeCloseTo(5 + 2.5 + 1 + 2.5, 10);
    });
    it('treats missing or bad counters as zero', () => {
        expect(costOf({ inputTokens: 10 }, ANTHROPIC_PRICING['claude-opus-5']!)).toBeCloseTo(0.00005, 12);
        expect(costOf({ inputTokens: Number.NaN, outputTokens: undefined }, ANTHROPIC_PRICING['claude-opus-5']!)).toBe(0);
        expect(costOf({}, ANTHROPIC_PRICING['claude-opus-5']!)).toBe(0);
    });
    it('priceUsage carries the estimated flag', () => {
        expect(priceUsage('claude-opus-5', { inputTokens: 200, outputTokens: 40 })).toEqual({ costUsd: 0.002, estimated: false });
        expect(priceUsage('claude-opus-9', { inputTokens: 200, outputTokens: 40 })).toEqual({ costUsd: 0.002, estimated: true });
    });
    it('anthropicPricing is the modelAgent hook for one model', () => {
        const price = anthropicPricing('claude-haiku-4-5');
        expect(price({ inputTokens: 1_000_000, outputTokens: 0 })).toBe(1);
    });
});
