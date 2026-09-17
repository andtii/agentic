/**
 * @agentic/memory — the default MemoryPlugin (MEM-01..09, MEM-12): a pure,
 * storage-agnostic core — state + reducer, BM25-ish ranking with kind weights
 * and recency decay, the byte budget, versioned NDJSON export/import — and the
 * in-memory store built on it. The Memory actor in `@agentic/platform` is the
 * same core over `@sigx/actors` persistence. The conformance suite lives in
 * `@agentic/memory/testing`.
 */
export const PACKAGE = '@agentic/memory';

export { tokenize, normalizeTag, termFrequencies } from './tokenize/index.js';

export type { IndexedEntry, MemoryIndex, RankOptions } from './rank/index.js';
export {
    KIND_WEIGHTS,
    CONFIDENCE_WEIGHTS,
    DEFAULT_QUERY_LIMIT,
    DEFAULT_MAX_BYTES,
    DEFAULT_HALF_LIFE_MS,
    entryTags,
    indexEntry,
    indexEntries,
    bm25,
    recencyWeight,
    scoreEntry,
    matchesQuery,
    byteLength,
    applyBudget,
    rankEntries
} from './rank/index.js';

export type { MemoryState, MemoryLogEntry, Retirement, CoercedEntry } from './state/index.js';
export { MEMORY_STATE_VERSION, MEMORY_KINDS, createMemoryState, memoryId, isExpired, isLive, liveEntries, allEntries, completeEntry, applyMemoryLog, coerceEntry } from './state/index.js';

export type { MemoryStoreOptions, OpenMemoryStore, MemoryPluginOptions } from './store/index.js';
export { createMemoryStore, liveCount, memoryPlugin, MemoryNotFoundError, DEFAULT_MEMORY_PLUGIN_ID, DEFAULT_MEMORY_PLUGIN_VERSION } from './store/index.js';

export type { MemoryExportHeader } from './export/index.js';
export { MEMORY_EXPORT_FORMAT, MEMORY_EXPORT_VERSION, MemoryExportError, memoryExportHeader, toNdjson, exportToString, ndjsonLines, parseExportHeader, fromNdjson } from './export/index.js';
