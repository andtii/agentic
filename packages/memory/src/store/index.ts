/**
 * `createMemoryStore` — the `MemoryStore` contract over a `MemoryState` and a
 * `commit` hook. The in-memory store commits by applying the log; the Memory
 * actor commits by applying it to `ctx.state` and persisting. Both share every
 * line of behaviour above the reducer: validation, id minting, the byte budget,
 * export order and the import fidelity report.
 */

import type { ImportReport, MemoryEntry, MemoryPlugin, MemoryQuery, MemoryScope, MemoryStore, NewMemoryEntry, PluginContext, RankedMemory } from '@agentic/core';
import { indexEntries, rankEntries, type MemoryIndex, type RankOptions } from '../rank/index.js';
import { allEntries, applyMemoryLog, coerceEntry, completeEntry, createMemoryState, isLive, liveEntries, type MemoryLogEntry, type MemoryState } from '../state/index.js';

export interface MemoryStoreOptions {
    /** The state to read and write. Default: a fresh one. */
    readonly state?: MemoryState;
    /** The clock. Default `Date.now`. */
    readonly now?: () => number;
    /**
     * Apply one log entry to `state` and make it durable. Default: apply only.
     * Runs for every mutation, in order, before the mutation's promise settles.
     */
    readonly commit?: (state: MemoryState, log: MemoryLogEntry) => void | Promise<void>;
    /** Ranking knobs (half-life, kind weights). `now` is taken from the clock. */
    readonly rank?: Omit<RankOptions, 'now'>;
    /** Rows per `export()` page — the streaming granularity, invisible to callers. */
    readonly exportPageSize?: number;
}

export class MemoryNotFoundError extends Error {
    override readonly name = 'MemoryNotFoundError';
    constructor(readonly id: string) {
        super(`memory entry not found: ${id}`);
    }
}

/**
 * What `import` would drop from an entry, without writing (MEM-09): the
 * fields the store's shape cannot hold, sorted, dotted for `provenance.*`;
 * `null` when the row is not an entry and would be skipped. Every store of
 * this package has it; `migrate` uses it for dry runs.
 */
export interface MemoryFidelity {
    fidelity(entry: MemoryEntry): readonly string[] | null;
}

export interface OpenMemoryStore extends MemoryStore, MemoryFidelity {
    readonly state: MemoryState;
    /** The page form of `export()`: entries ordered by id after `after`. */
    exportPage(after: string | null, size?: number): { readonly entries: readonly MemoryEntry[]; readonly next: string | null };
    /** The batch form of `import()`. */
    importBatch(rows: readonly unknown[], options?: { readonly onConflict?: 'skip' | 'replace' }): Promise<ImportReport>;
    /** Drop expired `working` entries now. Returns how many went. */
    compact(): Promise<number>;
}

const DEFAULT_EXPORT_PAGE = 200;

export function createMemoryStore(options: MemoryStoreOptions = {}): OpenMemoryStore {
    const state = options.state ?? createMemoryState();
    const now = options.now ?? Date.now;
    const commit = options.commit ?? applyMemoryLog;
    const pageSize = options.exportPageSize ?? DEFAULT_EXPORT_PAGE;
    let cache: { rev: number; now: number; index: MemoryIndex } | null = null;

    const indexFor = (at: number): MemoryIndex => {
        // Expiry depends on the clock, so the cache is keyed on both the
        // revision and the instant; a query within the same millisecond reuses it.
        if (!cache || cache.rev !== state.rev || cache.now !== at) cache = { rev: state.rev, now: at, index: indexEntries(liveEntries(state, at)) };
        return cache.index;
    };

    const must = (id: string): MemoryEntry => {
        const e = state.entries[id];
        if (!e) throw new MemoryNotFoundError(id);
        return e;
    };

    const store: OpenMemoryStore = {
        state,

        async put(input: NewMemoryEntry): Promise<MemoryEntry> {
            const at = now();
            const entry = completeEntry(input, at);
            await commit(state, { op: 'put', entry });
            const stored = state.entries[entry.id] ?? entry;
            if (entry.kind === 'working') {
                // Working context is temporary: a new item pays for sweeping the
                // expired ones — itself included, when it arrives already expired.
                await commit(state, { op: 'compact', now: at });
            }
            return stored;
        },

        async update(id: string, patch: Partial<Omit<MemoryEntry, 'id'>>): Promise<MemoryEntry> {
            must(id);
            await commit(state, { op: 'update', id, patch });
            return state.entries[id]!;
        },

        async retire(id: string, why: string): Promise<void> {
            must(id);
            await commit(state, { op: 'retire', id, why, at: now() });
        },

        async delete(id: string): Promise<boolean> {
            if (!state.entries[id]) return false;
            await commit(state, { op: 'delete', id });
            return true;
        },

        async get(id: string): Promise<MemoryEntry | undefined> {
            return state.entries[id];
        },

        fidelity(entry) {
            const coerced = coerceEntry(entry);
            return coerced ? [...coerced.dropped].sort() : null;
        },

        async query(q: MemoryQuery): Promise<readonly RankedMemory[]> {
            const at = now();
            return rankEntries(indexFor(at), q, { ...options.rank, now: at });
        },

        exportPage(after, size = pageSize) {
            const all = allEntries(state);
            let start = 0;
            if (after !== null) {
                // ids are sorted, so the page after `after` starts at the first id greater than it
                while (start < all.length && all[start]!.id <= after) start++;
            }
            const entries = all.slice(start, start + Math.max(1, size));
            const last = entries[entries.length - 1];
            const next = last && start + entries.length < all.length ? last.id : null;
            return { entries, next };
        },

        async *export(): AsyncIterable<MemoryEntry> {
            let after: string | null = null;
            do {
                const page = store.exportPage(after);
                for (const e of page.entries) yield e;
                after = page.next;
            } while (after !== null);
        },

        async importBatch(rows, opts) {
            const onConflict = opts?.onConflict ?? 'skip';
            let imported = 0;
            let skipped = 0;
            const dropped = new Set<string>();
            for (const row of rows) {
                const coerced = coerceEntry(row);
                if (!coerced) {
                    skipped++;
                    continue;
                }
                for (const f of coerced.dropped) dropped.add(f);
                if (state.entries[coerced.entry.id] && onConflict === 'skip') {
                    skipped++;
                    continue;
                }
                await commit(state, { op: 'put', entry: coerced.entry });
                imported++;
            }
            return { imported, skipped, droppedFields: [...dropped].sort() };
        },

        async import(rows, opts) {
            let imported = 0;
            let skipped = 0;
            const dropped = new Set<string>();
            let batch: unknown[] = [];
            const flush = async () => {
                if (!batch.length) return;
                const r = await store.importBatch(batch, opts);
                imported += r.imported;
                skipped += r.skipped;
                for (const f of r.droppedFields) dropped.add(f);
                batch = [];
            };
            for await (const row of rows) {
                batch.push(row);
                if (batch.length >= pageSize) await flush();
            }
            await flush();
            return { imported, skipped, droppedFields: [...dropped].sort() };
        },

        async compact() {
            const at = now();
            const before = Object.keys(state.entries).length;
            await commit(state, { op: 'compact', now: at });
            return before - Object.keys(state.entries).length;
        }
    };
    return store;
}

/** How many entries are live (not retired, not expired) right now. */
export function liveCount(state: MemoryState, now: number): number {
    let n = 0;
    for (const id in state.entries) if (isLive(state.entries[id]!, now)) n++;
    return n;
}

export const DEFAULT_MEMORY_PLUGIN_ID = 'agentic.memory.default';
export const DEFAULT_MEMORY_PLUGIN_VERSION = '0.1.0';

export interface MemoryPluginOptions {
    /**
     * Open the store behind a scope. Default: one in-memory store per scope,
     * kept for the plugin's lifetime — the dev/test backend. The platform
     * supplies the Memory-actor backend here.
     */
    readonly open?: (scope: MemoryScope, ctx: PluginContext) => MemoryStore;
    readonly id?: string;
    readonly version?: string;
}

/** The default MemoryPlugin (MEM-01/02): keyword + recency retrieval, full export. */
export function memoryPlugin(options: MemoryPluginOptions = {}): MemoryPlugin {
    const stores = new Map<MemoryScope, MemoryStore>();
    const open =
        options.open ??
        ((scope: MemoryScope, ctx: PluginContext): MemoryStore => {
            let s = stores.get(scope);
            if (!s) {
                s = createMemoryStore({ now: ctx.now });
                stores.set(scope, s);
            }
            return s;
        });
    return {
        id: options.id ?? DEFAULT_MEMORY_PLUGIN_ID,
        version: options.version ?? DEFAULT_MEMORY_PLUGIN_VERSION,
        capabilities: { semantic: false, export: 'full' },
        open
    };
}
