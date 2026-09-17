import type { MemoryEntry } from '@agentic/core';
import { applyBudget, bm25, byteLength, entryTags, indexEntries, KIND_WEIGHTS, rankEntries, recencyWeight, tokenize } from '../src/index';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function entry(id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
    return { id, kind: 'fact', text, tags: [], confidence: 'stated', provenance: { source: 'agent', at: NOW }, ...extra };
}

describe('tokenize', () => {
    it('lowercases, splits on non-alphanumerics, drops stop words and single characters', () => {
        expect(tokenize('The Build runs on Windows-11, a first-class target!')).toEqual(['build', 'runs', 'windows', '11', 'first', 'class', 'target']);
    });

    it('keeps unicode letters', () => {
        expect(tokenize('Ångström ärende')).toEqual(['ångström', 'ärende']);
    });
});

describe('entryTags', () => {
    it('normalizes tags and adds the tokens of conditions', () => {
        const tags = entryTags(entry('a', 'x', { tags: [' Windows ', 'CI'], conditions: 'when deploying to Cloudflare' }));
        expect([...tags].sort()).toEqual(['ci', 'cloudflare', 'deploying', 'when', 'windows']);
    });
});

describe('bm25', () => {
    it('scores a matching document above a non-matching one and 0 for no query', () => {
        const index = indexEntries([entry('a', 'cloudflare worker deploy'), entry('b', 'daemon pairing code')]);
        const [a, b] = index.docs;
        expect(bm25(a!, ['cloudflare'], index)).toBeGreaterThan(0);
        expect(bm25(b!, ['cloudflare'], index)).toBe(0);
        expect(bm25(a!, [], index)).toBe(0);
    });

    it('prefers the shorter document for the same term (length normalization)', () => {
        const index = indexEntries([entry('short', 'cloudflare deploy'), entry('long', 'cloudflare deploy with many many other words in the sentence')]);
        const [s, l] = index.docs;
        expect(bm25(s!, ['cloudflare'], index)).toBeGreaterThan(bm25(l!, ['cloudflare'], index));
    });
});

describe('recencyWeight', () => {
    it('is 1 now, 0.75 after one half-life, never below 0.5', () => {
        expect(recencyWeight(NOW, NOW, DAY)).toBe(1);
        expect(recencyWeight(NOW - DAY, NOW, DAY)).toBeCloseTo(0.75);
        expect(recencyWeight(NOW - 1000 * DAY, NOW, DAY)).toBeCloseTo(0.5);
        expect(recencyWeight(NOW + DAY, NOW, DAY)).toBe(1);
    });
});

describe('applyBudget', () => {
    const ranked = (...texts: string[]) => texts.map((text, i) => ({ entry: entry(String(i), text), score: 10 - i }));

    it('caps the count', () => {
        expect(applyBudget(ranked('a', 'b', 'c'), 2, 1000).map((r) => r.entry.id)).toEqual(['0', '1']);
    });

    it('skips an entry that does not fit and keeps going', () => {
        const out = applyBudget(ranked('aaaa', 'bbbbbbbbbb', 'cc'), 10, 7);
        expect(out.map((r) => r.entry.id)).toEqual(['0', '2']);
        expect(out.reduce((n, r) => n + byteLength(r.entry.text), 0)).toBeLessThanOrEqual(7);
    });

    it('measures bytes, not characters', () => {
        expect(byteLength('ä')).toBe(2);
        expect(applyBudget(ranked('äää'), 10, 5)).toEqual([]);
        expect(applyBudget(ranked('äää'), 10, 6)).toHaveLength(1);
    });
});

describe('rankEntries', () => {
    it('applies kind weights on a text tie and defaults limit and budget', () => {
        const kinds = Object.keys(KIND_WEIGHTS) as MemoryEntry['kind'][];
        const index = indexEntries(kinds.map((kind) => entry(kind, 'same text', { kind })));
        const ids = rankEntries(index, { text: 'same text', limit: 10 }, { now: NOW }).map((r) => r.entry.id);
        expect(ids).toEqual(['preference', 'lesson', 'fact', 'working', 'record', 'assumption']);
    });

    it('breaks a full tie deterministically: newest first, then id', () => {
        const index = indexEntries([entry('b', 'x'), entry('a', 'x'), entry('c', 'x', { provenance: { source: 'agent', at: NOW + 1 } })]);
        expect(rankEntries(index, { limit: 10 }, { now: NOW + 1 }).map((r) => r.entry.id)).toEqual(['c', 'a', 'b']);
    });

    it('still ranks without query text — filters alone yield a kind/recency order', () => {
        const index = indexEntries([entry('old', 'x', { tags: ['t'], provenance: { source: 'agent', at: NOW - 90 * DAY } }), entry('new', 'x', { tags: ['t'] }), entry('other', 'x')]);
        expect(rankEntries(index, { tags: ['t'], limit: 10 }, { now: NOW }).map((r) => r.entry.id)).toEqual(['new', 'old']);
    });
});
