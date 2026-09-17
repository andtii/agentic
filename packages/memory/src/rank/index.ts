/**
 * Retrieval without embeddings (MEM-07, architecture §8): BM25 over the
 * entry's text, tags, subject and `conditions`, multiplied by a kind weight
 * (preference > lesson > fact > working > record > assumption), a confidence
 * weight and a recency decay, then cut to the query's `limit` and byte budget.
 *
 * Pure: an index is built from a list of entries and queried with a clock.
 * The store layers decide WHICH entries are live (not retired, not expired);
 * this module ranks whatever it is handed.
 */

import type { MemoryEntry, MemoryKind, MemoryQuery, RankedMemory } from '@agentic/core';
import { normalizeTag, termFrequencies, tokenize } from '../tokenize/index.js';

export const KIND_WEIGHTS: Readonly<Record<MemoryKind, number>> = {
    preference: 1.3,
    lesson: 1.2,
    fact: 1.1,
    working: 1.0,
    record: 0.9,
    assumption: 0.8
};

export const CONFIDENCE_WEIGHTS: Readonly<Record<MemoryEntry['confidence'], number>> = {
    verified: 1.1,
    stated: 1.0,
    assumed: 0.9
};

/** Default retrieval block: 20 entries / 4 KB of text (architecture §8). */
export const DEFAULT_QUERY_LIMIT = 20;
export const DEFAULT_MAX_BYTES = 4096;
/** Recency half-life: an entry loses half its recency bonus after 30 days. */
export const DEFAULT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export interface RankOptions {
    /** The clock the recency decay measures age against. */
    readonly now: number;
    readonly halfLifeMs?: number;
    readonly k1?: number;
    readonly b?: number;
    readonly kindWeights?: Partial<Record<MemoryKind, number>>;
}

export interface IndexedEntry {
    readonly entry: MemoryEntry;
    /** Term → frequency over text + tags + subject + conditions. */
    readonly terms: ReadonlyMap<string, number>;
    readonly length: number;
    /** Normalized tags plus every token of `conditions` (LRN-04: conditions match as tags). */
    readonly tags: ReadonlySet<string>;
    readonly subject: string | undefined;
}

export interface MemoryIndex {
    readonly docs: readonly IndexedEntry[];
    /** Term → number of documents containing it. */
    readonly df: ReadonlyMap<string, number>;
    readonly avgLength: number;
}

/** The searchable tags of an entry: its tags plus the tokens of `conditions`. */
export function entryTags(entry: MemoryEntry): Set<string> {
    const tags = new Set<string>();
    for (const t of entry.tags) {
        const n = normalizeTag(t);
        if (n) tags.add(n);
    }
    if (entry.conditions) for (const t of tokenize(entry.conditions)) tags.add(t);
    return tags;
}

export function indexEntry(entry: MemoryEntry): IndexedEntry {
    const tokens = [
        ...tokenize(entry.text),
        ...entry.tags.flatMap((t) => tokenize(t)),
        ...(entry.subject ? tokenize(entry.subject) : []),
        ...(entry.conditions ? tokenize(entry.conditions) : [])
    ];
    return {
        entry,
        terms: termFrequencies(tokens),
        length: tokens.length,
        tags: entryTags(entry),
        subject: entry.subject?.trim().toLowerCase() || undefined
    };
}

export function indexEntries(entries: Iterable<MemoryEntry>): MemoryIndex {
    const docs: IndexedEntry[] = [];
    const df = new Map<string, number>();
    let total = 0;
    for (const entry of entries) {
        const doc = indexEntry(entry);
        docs.push(doc);
        total += doc.length;
        for (const term of doc.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    return { docs, df, avgLength: docs.length ? total / docs.length : 0 };
}

/** Okapi BM25 for one document against the query terms; 0 when nothing matches. */
export function bm25(doc: IndexedEntry, queryTerms: readonly string[], index: MemoryIndex, k1 = 1.2, b = 0.75): number {
    if (!queryTerms.length || !index.docs.length) return 0;
    const n = index.docs.length;
    const norm = k1 * (1 - b + (b * doc.length) / (index.avgLength || 1));
    let score = 0;
    for (const term of queryTerms) {
        const tf = doc.terms.get(term);
        if (!tf) continue;
        const df = index.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + norm));
    }
    return score;
}

/** 1 for a fresh entry, decaying towards 0.5 — old memories stay findable, just behind fresh ones. */
export function recencyWeight(at: number, now: number, halfLifeMs = DEFAULT_HALF_LIFE_MS): number {
    const age = Math.max(0, now - at);
    return 0.5 + 0.5 * Math.pow(2, -age / halfLifeMs);
}

export function scoreEntry(doc: IndexedEntry, queryTerms: readonly string[], index: MemoryIndex, options: RankOptions): number {
    const kind = options.kindWeights?.[doc.entry.kind] ?? KIND_WEIGHTS[doc.entry.kind];
    const confidence = CONFIDENCE_WEIGHTS[doc.entry.confidence] ?? 1;
    const recency = recencyWeight(doc.entry.provenance.at, options.now, options.halfLifeMs);
    return (1 + bm25(doc, queryTerms, index, options.k1, options.b)) * kind * confidence * recency;
}

/** True when the entry passes every filter the query states (text is ranking, not a filter). */
export function matchesQuery(doc: IndexedEntry, q: MemoryQuery): boolean {
    if (q.kinds && q.kinds.length && !q.kinds.includes(doc.entry.kind)) return false;
    if (q.since !== undefined && doc.entry.provenance.at < q.since) return false;
    if (q.subject !== undefined) {
        const wanted = q.subject.trim().toLowerCase();
        if (wanted && doc.subject !== wanted) return false;
    }
    if (q.tags && q.tags.length) {
        let hit = false;
        for (const t of q.tags) {
            if (doc.tags.has(normalizeTag(t))) {
                hit = true;
                break;
            }
        }
        if (!hit) return false;
    }
    return true;
}

const encoder = new TextEncoder();

/** UTF-8 size of a string — the unit of the byte budget. */
export function byteLength(text: string): number {
    return encoder.encode(text).byteLength;
}

/**
 * Cut a ranked list to at most `limit` entries whose `text` totals at most
 * `maxBytes`. An entry that does not fit is skipped, not a stop: a smaller
 * one further down may still fit. Never returns more than either bound.
 */
export function applyBudget(ranked: readonly RankedMemory[], limit: number, maxBytes: number): RankedMemory[] {
    const out: RankedMemory[] = [];
    let bytes = 0;
    for (const r of ranked) {
        if (out.length >= limit) break;
        const size = byteLength(r.entry.text);
        if (bytes + size > maxBytes) continue;
        bytes += size;
        out.push(r);
    }
    return out;
}

/** Filter, score, sort (score desc, newest first, id asc), then budget. */
export function rankEntries(index: MemoryIndex, q: MemoryQuery, options: RankOptions): RankedMemory[] {
    const queryTerms = q.text ? tokenize(q.text) : [];
    const ranked: RankedMemory[] = [];
    for (const doc of index.docs) {
        if (!matchesQuery(doc, q)) continue;
        ranked.push({ entry: doc.entry, score: scoreEntry(doc, queryTerms, index, options) });
    }
    ranked.sort((a, b) => b.score - a.score || b.entry.provenance.at - a.entry.provenance.at || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
    const limit = Math.max(0, Math.min(q.limit ?? DEFAULT_QUERY_LIMIT, Number.MAX_SAFE_INTEGER));
    return applyBudget(ranked, limit, q.maxBytes ?? DEFAULT_MAX_BYTES);
}
