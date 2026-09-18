/**
 * The Memory actor as a `MemoryPlugin` (MEM-01/02/03): `open(scope)` is a
 * `MemoryStore` whose every call is a method of the actor keyed
 * `{ws}:memory:{scope}`. `export()` walks the actor's id-ordered pages;
 * `import()` sends rows in batches and sums the fidelity reports.
 */

import { actorKey, type ImportReport, type MemoryEntry, type MemoryPlugin, type MemoryQuery, type MemoryScope, type MemoryStore, type NewMemoryEntry, type RankedMemory, type WorkspaceId } from '@agentic/core';
import { memoryPlugin } from '@agentic/memory';
import { actor, type ActorClientWith } from '@sigx/actors';
import { Memory } from './actor.js';

export type MemoryActorClient = ActorClientWith<typeof Memory>;

/** Rows per `importBatch` call and entries per `exportPage`. */
export const MEMORY_WIRE_BATCH = 100;

export function memoryActorKey(workspace: WorkspaceId, scope: MemoryScope): string {
    return actorKey(workspace, 'memory', scope);
}

/** A `MemoryStore` over one Memory actor client. */
export function actorMemoryStore(client: MemoryActorClient, batch = MEMORY_WIRE_BATCH): MemoryStore {
    const store: MemoryStore = {
        put: (entry: NewMemoryEntry): Promise<MemoryEntry> => client.put(entry),
        update: (id: string, patch: Partial<Omit<MemoryEntry, 'id'>>): Promise<MemoryEntry> => client.update(id, patch),
        retire: (id: string, why: string): Promise<void> => client.retire(id, why),
        delete: (id: string): Promise<boolean> => client.delete(id),
        get: (id: string): Promise<MemoryEntry | undefined> => client.get(id),
        query: (q: MemoryQuery): Promise<readonly RankedMemory[]> => client.query(q),
        async *export(): AsyncIterable<MemoryEntry> {
            let after: string | null = null;
            do {
                const page: Awaited<ReturnType<MemoryActorClient['exportPage']>> = await client.exportPage(after, batch);
                for (const e of page.entries) yield e;
                after = page.next;
            } while (after !== null);
        },
        async import(rows, options): Promise<ImportReport> {
            let imported = 0;
            let skipped = 0;
            const dropped = new Set<string>();
            let pending: MemoryEntry[] = [];
            const flush = async () => {
                if (!pending.length) return;
                const r = await client.importBatch(pending, options);
                imported += r.imported;
                skipped += r.skipped;
                for (const f of r.droppedFields) dropped.add(f);
                pending = [];
            };
            for await (const row of rows) {
                pending.push(row);
                if (pending.length >= batch) await flush();
            }
            await flush();
            return { imported, skipped, droppedFields: [...dropped].sort() };
        }
    };
    return store;
}

export interface MemoryActorPluginOptions {
    readonly workspace: WorkspaceId;
    /** How to reach an actor by key. Default: the ambient `actor()` client — in-process on the server, the wire elsewhere. */
    readonly client?: (key: string) => MemoryActorClient;
    readonly id?: string;
    readonly version?: string;
}

/** The default plugin backed by the Memory actor: the platform's MEM-01 implementation. */
export function memoryActorPlugin(options: MemoryActorPluginOptions): MemoryPlugin {
    const client = options.client ?? ((key: string) => actor(Memory, key));
    return memoryPlugin({
        id: options.id,
        version: options.version,
        open: (scope) => actorMemoryStore(client(memoryActorKey(options.workspace, scope)))
    });
}
