import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CONCURRENT_CHILDREN, DEFAULT_MAX_DEPTH, checkConcurrency, checkDepth, remaining, splitBudget } from '../../src/task/index';

describe('limits', () => {
    it('depth: inherits the default and rejects past the cap', () => {
        expect(checkDepth(0, {})).toBe(1);
        expect(checkDepth(DEFAULT_MAX_DEPTH - 1, {})).toBe(DEFAULT_MAX_DEPTH);
        expect(() => checkDepth(DEFAULT_MAX_DEPTH, {})).toThrow(/exceeds maxDepth/);
        expect(() => checkDepth(2, { maxDepth: 2 })).toThrow(/depth 3 exceeds maxDepth 2/);
    });

    it('concurrency: counts unsettled children against the cap', () => {
        expect(() => checkConcurrency(0, {})).not.toThrow();
        expect(() => checkConcurrency(DEFAULT_MAX_CONCURRENT_CHILDREN, {})).toThrow(/maxConcurrentChildren/);
        expect(() => checkConcurrency(2, { maxConcurrentChildren: 2 })).toThrow('2 unsettled child tasks already running (maxConcurrentChildren 2)');
        expect(() => checkConcurrency(1, { maxConcurrentChildren: 1 })).toThrow('1 unsettled child task already running (maxConcurrentChildren 1)');
    });

    it('remaining subtracts spend and live reservations', () => {
        expect(remaining({ maxCostUsd: 10 }, { maxCostUsd: 3 }, [{ maxCostUsd: 2 }, {}], 'maxCostUsd')).toBe(5);
        expect(remaining({}, { maxCostUsd: 3 }, [], 'maxCostUsd')).toBeUndefined();
    });

    it('split: clamps to the remaining, inherits the rest, throws when exhausted', () => {
        const child = splitBudget({ maxCostUsd: 10, maxTokens: 1000, maxDepth: 4 }, { maxCostUsd: 4 }, [{ maxTokens: 300 }], { maxCostUsd: 50, maxDepth: 2, maxTurns: 7 });
        expect(child).toEqual({ maxCostUsd: 6, maxTokens: 700, maxDepth: 2, maxTurns: 7 });
        expect(() => splitBudget({ maxCostUsd: 10 }, { maxCostUsd: 10 }, [])).toThrow(/no maxCostUsd left/);
        expect(splitBudget({}, {}, [], { maxWallMs: 5 })).toEqual({ maxWallMs: 5 });
    });
});
