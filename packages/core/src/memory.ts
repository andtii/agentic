/** Memory seams (MEM-01..12). Implementations live in @agentic/memory. */

import type { AgentId, MessageId, SessionId, TaskId } from './ids.js';

export type MemoryKind = 'working' | 'fact' | 'preference' | 'assumption' | 'lesson' | 'record';

export type MemoryScope = `agent:${AgentId}` | `shared:${string}`;

export interface Provenance {
    readonly source: 'user' | 'agent' | 'verification' | 'import';
    readonly at: number;
    readonly sessionId?: SessionId;
    readonly taskId?: TaskId;
    readonly messageId?: MessageId;
}

export interface MemoryEntry {
    readonly id: string;
    readonly kind: MemoryKind;
    readonly text: string;
    readonly tags: readonly string[];
    readonly subject?: string;
    readonly provenance: Provenance;
    /** Verified fact, stated preference, or assumption (MEM-06). */
    readonly confidence: 'verified' | 'stated' | 'assumed';
    /** For lessons: when the lesson applies (LRN-04). */
    readonly conditions?: string;
    readonly evidence?: readonly string[];
    readonly supersedes?: string;
    readonly retired?: boolean;
    readonly ttl?: number;
}

export type NewMemoryEntry = Omit<MemoryEntry, 'id' | 'provenance'> & { readonly provenance: Omit<Provenance, 'at'> & { readonly at?: number } };

export interface MemoryQuery {
    readonly text?: string;
    readonly tags?: readonly string[];
    readonly kinds?: readonly MemoryKind[];
    readonly subject?: string;
    readonly limit: number;
    /** Upper bound on the bytes of `text` returned in total (MEM-07). */
    readonly maxBytes?: number;
    readonly since?: number;
}

export interface RankedMemory {
    readonly entry: MemoryEntry;
    readonly score: number;
}

export interface ImportReport {
    readonly imported: number;
    readonly skipped: number;
    /** Fields the target could not represent (MEM-09). */
    readonly droppedFields: readonly string[];
}

export interface MemoryStore {
    put(entry: NewMemoryEntry): Promise<MemoryEntry>;
    update(id: string, patch: Partial<Omit<MemoryEntry, 'id'>>): Promise<MemoryEntry>;
    retire(id: string, why: string): Promise<void>;
    /** Remove an entry for good (MEM-05, MEM-08); `false` when there is no such entry. `retire` keeps the history instead. */
    delete(id: string): Promise<boolean>;
    get(id: string): Promise<MemoryEntry | undefined>;
    query(q: MemoryQuery): Promise<readonly RankedMemory[]>;
    export(): AsyncIterable<MemoryEntry>;
    import(rows: AsyncIterable<MemoryEntry>, options?: { readonly onConflict?: 'skip' | 'replace' }): Promise<ImportReport>;
}

export interface PluginContext {
    readonly now: () => number;
    readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

export interface MemoryPlugin {
    readonly id: string;
    readonly version: string;
    readonly capabilities: { readonly semantic: boolean; readonly export: 'full' | 'partial' };
    open(scope: MemoryScope, ctx: PluginContext): MemoryStore;
}
