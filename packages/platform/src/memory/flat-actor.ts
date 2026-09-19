/**
 * The FlatMemory actor (#281, architecture §8): the flat memory plugin's durable backend. One per scope, under the
 * SAME key as the Memory actor — `{ws}:memory:{scope}` — but its own type, so it is its own object: the two plugins'
 * stores never mix, and `memoryAuthorize` (a static check on the key) guards both unchanged.
 *
 * The state is the flat store's (`createFlatMemoryState`) plus a revision the pages follow. Every method is the
 * `MemoryStore` contract over that state, the same method table as the Memory actor, so a client (the plugin, a
 * page, the workspace export) reaches either the same way.
 *
 * Access: who may touch a SHARED scope is the scope's, not the plugin's (MEM-11) — its ACL lives on the Memory actor of
 * that scope and this actor reads it from there, as the workspace owner, when an agent asks. Switching the active
 * memory plugin therefore never changes who reads a shared scope, and there is no second ACL to keep in step. The
 * owner and a private scope's own agent are decided without the hop.
 *
 * Persistence: `persistence: 'explicit'` and a `ctx.save()` at the end of every mutating turn — on Cloudflare
 * `onDeactivate` never runs.
 */

import type { ImportReport, MemoryEntry, MemoryQuery, NewMemoryEntry, Principal, RankedMemory } from '@agentic/core';
import { createFlatMemoryState, createFlatMemoryStore, type FlatMemoryState } from '@agentic/memory';
import { actor, defineActor } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { asPrincipal } from '../auth/agent-token.js';
import { userPrincipal } from '../auth/principal.js';
import { Memory, type ExportPage, type MemoryStats } from './actor.js';
import { aclAllows, isMemoryOwner, memoryAuthorize, parseMemoryKey, scopeAgent, type MemoryAccess, type MemoryAcl } from './authorize.js';

export const FLAT_MEMORY_ACTOR_TYPE = 'FlatMemory';

export interface FlatMemoryActorState {
    v: 1;
    /** Bumped by every write; what a page's live `stats` read follows. */
    rev: number;
    flat: FlatMemoryState;
}

export function createFlatMemoryActorState(): FlatMemoryActorState {
    return { v: 1, rev: 0, flat: createFlatMemoryState() };
}

const forbidden = (what: string) => new ServerFnError(403, `memory: ${what}`);

async function* fromArray<T>(rows: readonly T[]): AsyncIterable<T> {
    yield* rows;
}

export const FlatMemory = defineActor({
    type: FLAT_MEMORY_ACTOR_TYPE,
    authorize: memoryAuthorize,
    persistence: 'explicit',
    methodReentrancy: { get: 'always', query: 'always', exportPage: 'always', getAcl: 'always', stats: 'always' },
    state: (): FlatMemoryActorState => createFlatMemoryActorState(),
    methods: (ctx) => {
        const parsed = parseMemoryKey(ctx.key);
        if (!parsed) throw new Error(`memory: not a memory key: ${ctx.key}`);
        const { workspace, scope } = parsed;
        const store = createFlatMemoryStore({ state: ctx.state.flat, now: Date.now });

        const principal = (): Principal | null => (ctx.principal as Principal | null | undefined) ?? null;
        /** The scope's ACL, from its Memory actor, read as the workspace owner (the workspace id is its owner's user id). */
        const acl = (): Promise<MemoryAcl | null> => actor(Memory, ctx.key).with({ context: asPrincipal(userPrincipal(workspace, workspace)) }).getAcl();
        const guard = async (access: MemoryAccess): Promise<void> => {
            const p = principal();
            // Only an agent on a shared scope needs the ACL; everyone else is decided by the key and the principal.
            const needsAcl = p?.kind === 'agent' && !isMemoryOwner(p) && scopeAgent(scope) === null;
            if (!aclAllows(p, scope, needsAcl ? await acl() : null, access)) throw forbidden(`${access} access to ${scope} denied`);
        };
        const commit = async (): Promise<void> => {
            ctx.state.rev++;
            await ctx.save();
        };

        return {
            async put(entry: NewMemoryEntry): Promise<MemoryEntry> {
                await guard('write');
                const stored = await store.put(entry);
                await commit();
                return ctx.snapshot(stored);
            },
            async update(id: string, patch: Partial<Omit<MemoryEntry, 'id'>>): Promise<MemoryEntry> {
                await guard('write');
                const stored = await store.update(id, patch);
                await commit();
                return ctx.snapshot(stored);
            },
            async retire(id: string, why: string): Promise<void> {
                await guard('write');
                await store.retire(id, why);
                await commit();
            },
            /** Removes the entry for good; `false` when there is none. `retire` keeps the history. */
            async delete(id: string): Promise<boolean> {
                await guard('write');
                const deleted = await store.delete(id);
                if (deleted) await commit();
                return deleted;
            },
            async get(id: string): Promise<MemoryEntry | undefined> {
                await guard('read');
                const e = await store.get(id);
                return e && ctx.snapshot(e);
            },
            async query(q: MemoryQuery): Promise<readonly RankedMemory[]> {
                await guard('read');
                return ctx.snapshot(await store.query(q));
            },
            /** Entries ordered by id, `size` at a time; `next` is the cursor for the following page. */
            async exportPage(after: string | null, size?: number): Promise<ExportPage> {
                await guard('read');
                return ctx.snapshot(store.exportPage(after, size));
            },
            /** Rows the flat shape cannot hold in full are kept without those fields, and `droppedFields` names them (MEM-09). */
            async importBatch(rows: readonly unknown[], options?: { readonly onConflict?: 'skip' | 'replace' }): Promise<ImportReport> {
                await guard('write');
                // `import` coerces every row itself (a malformed one is skipped), so the cast only satisfies its signature.
                const report = await store.import(fromArray(rows as readonly MemoryEntry[]), options);
                if (report.imported) await commit();
                return report;
            },
            /** Nothing expires in the flat plugin (no `ttl`): always `0`. Here so a client of either actor may call it. */
            async compact(): Promise<number> {
                await guard('write');
                return 0;
            },
            /** The scope's ACL — the Memory actor's; set it there (`Memory.setAcl`). */
            async getAcl(): Promise<MemoryAcl | null> {
                await guard('read');
                return acl();
            },
            async stats(): Promise<MemoryStats> {
                await guard('read');
                const entries = Object.values(ctx.state.flat.entries);
                // A private scope has no ACL; a shared one's is the Memory actor's.
                const shared = scopeAgent(scope) === null ? await acl() : null;
                return { entries: entries.length, live: entries.filter((e) => !e.retired).length, rev: ctx.state.rev, acl: shared };
            }
        };
    }
});
