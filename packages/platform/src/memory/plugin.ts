/**
 * The Memory actor as a `MemoryPlugin` (MEM-01/02/03): `open(scope)` is a
 * `MemoryStore` whose every call is a method of the actor keyed
 * `{ws}:memory:{scope}`. `export()` walks the actor's id-ordered pages;
 * `import()` sends rows in batches and sums the fidelity reports.
 */

import { actorKey, type ImportReport, type MemoryEntry, type MemoryPlugin, type MemoryQuery, type MemoryScope, type MemoryStore, type NewMemoryEntry, type PluginContext, type RankedMemory, type WorkspaceId } from '@agentic/core';
import { memoryPlugin } from '@agentic/memory';
import { actor, type ActorClientWith } from '@sigx/actors';
import { asPrincipal } from '../auth/agent-token.js';
import type { MemoryPluginImpl, RetrievalBudget } from '../task/driver.js';
import { Memory } from './actor.js';
import { scopeAgent } from './authorize.js';

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

/** What the platform hands a plugin's `open`. */
const PLUGIN_CONTEXT: PluginContext = {
    now: () => Date.now(),
    log: (level, message, data) => console[level](`[memory] ${message}`, ...(data ? [data] : []))
};

/**
 * The default memory plugin as the platform runs it (#242): the Memory actor of each scope, reached AS the principal
 * the caller names — so `memoryAuthorize` and the shared-scope ACL decide for the agent, not for whoever opened the
 * session (MEM-11). Its config's `retrievalLimit` is the session-start budget.
 */
export function memoryActorImpl(): MemoryPluginImpl {
    return (config) => {
        const retrieval = retrievalFromConfig(config);
        return {
            open: (scope, principal) =>
                memoryActorPlugin({
                    workspace: principal.workspaceId,
                    // `actorMemoryStore` only calls methods; a bound client is one minus `with`.
                    client: (key) => actor(Memory, key).with({ context: asPrincipal(principal) }) as MemoryActorClient
                }).open(scope, PLUGIN_CONTEXT),
            ...(retrieval ? { retrieval } : {})
        };
    };
}

/**
 * A memory plugin with no access control and no durable backend of its own — the flat plugin (#242) — as the platform
 * runs it: one instance per workspace, held in this isolate's memory. An agent reaches its OWN scope only: a shared
 * scope needs the ACL the Memory actor enforces, so it is refused (retrieval lists it as skipped). What it holds is
 * lost when the isolate goes — a plugin for trying the migration path, not for keeping memories.
 */
export function isolateMemoryImpl(make: () => MemoryPlugin): MemoryPluginImpl {
    const byWorkspace = new Map<WorkspaceId, MemoryPlugin>();
    return (config) => {
        const retrieval = retrievalFromConfig(config);
        return {
            open: (scope, principal) => {
                if (principal.kind === 'agent' && scopeAgent(scope) !== principal.agentId) {
                    throw new Error(`[memory] the "${scope}" scope needs the default memory plugin: this one has no access control`);
                }
                let plugin = byWorkspace.get(principal.workspaceId);
                if (!plugin) {
                    plugin = make();
                    byWorkspace.set(principal.workspaceId, plugin);
                }
                return plugin.open(scope, PLUGIN_CONTEXT);
            },
            ...(retrieval ? { retrieval } : {})
        };
    };
}

/** The config key the memory plugins share (#242): entries retrieved at session start (MEM-07); `0` retrieves none. */
export const RETRIEVAL_LIMIT_KEY = 'retrievalLimit';

/** The retrieval budget a memory plugin's config asks for; nothing when it names none. */
export function retrievalFromConfig(config: Readonly<Record<string, unknown>>): RetrievalBudget | undefined {
    const limit = config[RETRIEVAL_LIMIT_KEY];
    return typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 ? { limit } : undefined;
}
