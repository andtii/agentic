/**
 * The flat MemoryPlugin (MEM-02/09): a deliberately narrower second
 * implementation — the migration counterpart of the default one. It keeps
 * the core of an entry (id, kind, text, tags, subject, provenance,
 * confidence, retired) and nothing that needs machinery it does not have:
 * no `conditions` (no conditions-as-tags), no `evidence`, no `supersedes`
 * (no per-task record compaction), no `ttl` (nothing expires). Retrieval is
 * plain substring matching over `text`, ties broken by recency. Every field
 * it cannot hold is reported — by `import`, by `fidelity` and, for a `put`
 * or `update` that carries one, through the plugin context's log — so a
 * migration into it says exactly what was lost (`capabilities.export:
 * 'partial'`).
 */

import type { ImportReport, MemoryEntry, MemoryPlugin, MemoryQuery, MemoryScope, MemoryStore, NewMemoryEntry, PluginContext, RankedMemory } from '@agentic/core';
import { applyBudget, DEFAULT_MAX_BYTES, DEFAULT_QUERY_LIMIT } from '../../rank/index.js';
import { coerceEntry, completeEntry } from '../../state/index.js';
import { MemoryNotFoundError, type MemoryFidelity } from '../../store/index.js';
import { normalizeTag, tokenize } from '../../tokenize/index.js';

export const FLAT_MEMORY_PLUGIN_ID = 'agentic.memory.flat';
export const FLAT_MEMORY_PLUGIN_VERSION = '0.1.0';

/** The `MemoryEntry` fields the flat plugin cannot hold — what a migration into it drops. */
export const FLAT_UNSUPPORTED_FIELDS = ['conditions', 'evidence', 'supersedes', 'ttl'] as const;
export type FlatUnsupportedField = (typeof FLAT_UNSUPPORTED_FIELDS)[number];

/** An entry as the flat plugin stores it. */
export type FlatMemoryEntry = Omit<MemoryEntry, FlatUnsupportedField>;

export interface FlatEntryReport {
    readonly entry: FlatMemoryEntry;
    /** The unsupported fields `entry` carried, in `FLAT_UNSUPPORTED_FIELDS` order. */
    readonly dropped: readonly FlatUnsupportedField[];
}

/** Strip the fields the flat shape cannot hold, reporting the ones that were present. */
export function toFlatEntry(entry: MemoryEntry): FlatEntryReport {
    const dropped: FlatUnsupportedField[] = [];
    const out: Record<string, unknown> = { ...entry };
    for (const f of FLAT_UNSUPPORTED_FIELDS) {
        if (!(f in out)) continue;
        if (out[f] !== undefined) dropped.push(f);
        delete out[f];
    }
    return { entry: out as FlatMemoryEntry, dropped };
}

export interface FlatMemoryStoreOptions {
    /** The clock. Default `Date.now`. */
    readonly now?: () => number;
    /** Where a `put` / `update` that had to drop a field is reported. Default: silent. */
    readonly log?: PluginContext['log'];
}

export interface FlatMemoryStore extends MemoryStore, MemoryFidelity {
    /** Entries stored, retired included. */
    readonly size: number;
    /** Why and when an entry was retired (MEM-08). */
    retirement(id: string): { readonly why: string; readonly at: number } | undefined;
}

/** A `MemoryStore` over a map — the flat plugin's only backend. */
export function createFlatMemoryStore(options: FlatMemoryStoreOptions = {}): FlatMemoryStore {
    const now = options.now ?? Date.now;
    const log = options.log;
    const entries = new Map<string, FlatMemoryEntry>();
    const retirements = new Map<string, { readonly why: string; readonly at: number }>();

    const must = (id: string): FlatMemoryEntry => {
        const e = entries.get(id);
        if (!e) throw new MemoryNotFoundError(id);
        return e;
    };

    const keep = (entry: MemoryEntry, op: 'put' | 'update'): FlatMemoryEntry => {
        const flat = toFlatEntry(entry);
        if (flat.dropped.length) log?.('warn', `flat memory: ${op} dropped ${flat.dropped.join(', ')}`, { id: entry.id, dropped: flat.dropped });
        entries.set(flat.entry.id, flat.entry);
        return flat.entry;
    };

    const store: FlatMemoryStore = {
        get size() {
            return entries.size;
        },

        retirement: (id) => retirements.get(id),

        fidelity(entry) {
            const coerced = coerceEntry(entry);
            if (!coerced) return null;
            return [...coerced.dropped, ...toFlatEntry(coerced.entry).dropped].sort();
        },

        async put(input: NewMemoryEntry): Promise<MemoryEntry> {
            return keep(completeEntry(input, now()), 'put');
        },

        async update(id, patch): Promise<MemoryEntry> {
            const old = must(id);
            // `completeEntry` re-stamps the merged entry: same id, normalized tags, no `undefined` members.
            return keep(completeEntry({ ...old, ...patch }, old.provenance.at, old.id), 'update');
        },

        async retire(id, why): Promise<void> {
            const old = must(id);
            entries.set(id, { ...old, retired: true });
            retirements.set(id, { why, at: now() });
        },

        async delete(id): Promise<boolean> {
            retirements.delete(id);
            return entries.delete(id);
        },

        async get(id): Promise<MemoryEntry | undefined> {
            return entries.get(id);
        },

        async query(q: MemoryQuery): Promise<readonly RankedMemory[]> {
            const terms = q.text ? tokenize(q.text) : [];
            const tags = q.tags?.map(normalizeTag).filter(Boolean) ?? [];
            const subject = q.subject?.trim().toLowerCase();
            const ranked: RankedMemory[] = [];
            for (const entry of entries.values()) {
                if (entry.retired) continue;
                if (q.kinds && q.kinds.length && !q.kinds.includes(entry.kind)) continue;
                if (q.since !== undefined && entry.provenance.at < q.since) continue;
                if (subject && (entry.subject?.trim().toLowerCase() ?? '') !== subject) continue;
                if (tags.length && !tags.some((t) => entry.tags.includes(t))) continue;
                ranked.push({ entry, score: 1 + substringHits(entry.text, terms) });
            }
            ranked.sort((a, b) => b.score - a.score || b.entry.provenance.at - a.entry.provenance.at || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
            return applyBudget(ranked, Math.max(0, q.limit ?? DEFAULT_QUERY_LIMIT), q.maxBytes ?? DEFAULT_MAX_BYTES);
        },

        async *export(): AsyncIterable<MemoryEntry> {
            for (const id of [...entries.keys()].sort()) {
                const e = entries.get(id);
                if (e) yield e;
            }
        },

        async import(rows, opts): Promise<ImportReport> {
            const onConflict = opts?.onConflict ?? 'skip';
            let imported = 0;
            let skipped = 0;
            const dropped = new Set<string>();
            for await (const row of rows) {
                const coerced = coerceEntry(row);
                if (!coerced) {
                    skipped++;
                    continue;
                }
                const flat = toFlatEntry(coerced.entry);
                for (const f of coerced.dropped) dropped.add(f);
                for (const f of flat.dropped) dropped.add(f);
                if (entries.has(flat.entry.id) && onConflict === 'skip') {
                    skipped++;
                    continue;
                }
                entries.set(flat.entry.id, flat.entry);
                imported++;
            }
            return { imported, skipped, droppedFields: [...dropped].sort() };
        }
    };
    return store;
}

/** How many of the query terms occur, case-insensitively, anywhere in the text. */
function substringHits(text: string, terms: readonly string[]): number {
    if (!terms.length) return 0;
    const hay = text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (hay.includes(t)) hits++;
    return hits;
}

export interface FlatMemoryPluginOptions {
    readonly id?: string;
    readonly version?: string;
}

/** The flat MemoryPlugin: one map-backed store per scope, partial export. */
export function flatMemoryPlugin(options: FlatMemoryPluginOptions = {}): MemoryPlugin {
    const stores = new Map<MemoryScope, FlatMemoryStore>();
    return {
        id: options.id ?? FLAT_MEMORY_PLUGIN_ID,
        version: options.version ?? FLAT_MEMORY_PLUGIN_VERSION,
        capabilities: { semantic: false, export: 'partial' },
        open(scope, ctx) {
            let s = stores.get(scope);
            if (!s) {
                s = createFlatMemoryStore({ now: ctx.now, log: ctx.log });
                stores.set(scope, s);
            }
            return s;
        }
    };
}
