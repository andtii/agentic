/**
 * The Memory actor (architecture §4, §8): one per scope, keyed
 * `{ws}:memory:{scope}` with `scope` = `agent:{id}` or `shared:{name}`. The
 * state is the `@agentic/memory` core state plus the shared-scope ACL; every
 * method is the `MemoryStore` contract over that state, guarded by the ACL.
 *
 * Persistence: `persistence: 'explicit'` and a `ctx.save()` at the end of
 * every mutating turn — on Cloudflare `onDeactivate` never runs, so nothing
 * is ever left unsaved. Each mutation is already a `MemoryLogEntry` folded
 * by `applyMemoryActorEntry`, the reducer `ctx.append` / `applyEntry` will
 * take once `@sigx/actors` ships that seam (signalxjs/actors#312, unreleased
 * at 0.9.2); until then a save is the compaction and the log is implicit.
 */

import type { ImportReport, MemoryEntry, MemoryQuery, NewMemoryEntry, Principal, RankedMemory } from '@agentic/core';
import { applyMemoryLog, createMemoryState, createMemoryStore, liveCount, type MemoryLogEntry, type MemoryState } from '@agentic/memory';
import { defineActor } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { aclAllows, isMemoryOwner, memoryAuthorize, parseMemoryKey, type MemoryAccess, type MemoryAcl } from './authorize.js';

export const MEMORY_ACTOR_TYPE = 'Memory';

export interface MemoryActorState {
    v: 1;
    memory: MemoryState;
    /** Grants on a `shared:*` scope; unused on `agent:*`. `null` = nobody but the owner. */
    acl: MemoryAcl | null;
}

export type MemoryActorEntry = { readonly op: 'memory'; readonly log: MemoryLogEntry } | { readonly op: 'acl'; readonly acl: MemoryAcl | null };

/** The reducer: fold one entry into the actor state, in place (the future `applyEntry`). */
export function applyMemoryActorEntry(state: MemoryActorState, entry: MemoryActorEntry): void {
    if (entry.op === 'memory') applyMemoryLog(state.memory, entry.log);
    else state.acl = entry.acl;
}

export function createMemoryActorState(): MemoryActorState {
    return { v: 1, memory: createMemoryState(), acl: null };
}

export interface MemoryStats {
    readonly entries: number;
    readonly live: number;
    readonly rev: number;
    readonly acl: MemoryAcl | null;
}

export interface ExportPage {
    readonly entries: readonly MemoryEntry[];
    readonly next: string | null;
}

const forbidden = (what: string) => new ServerFnError(403, `memory: ${what}`);

export const Memory = defineActor({
    type: MEMORY_ACTOR_TYPE,
    authorize: memoryAuthorize,
    persistence: 'explicit',
    methodReentrancy: { get: 'always', query: 'always', exportPage: 'always', getAcl: 'always', stats: 'always' },
    state: (): MemoryActorState => createMemoryActorState(),
    methods: (ctx) => {
        const parsed = parseMemoryKey(ctx.key);
        if (!parsed) throw new Error(`memory: not a memory key: ${ctx.key}`);
        const { scope } = parsed;
        const store = createMemoryStore({ state: ctx.state.memory, now: Date.now });

        const principal = (): Principal | null => (ctx.principal as Principal | null | undefined) ?? null;
        const guard = (access: MemoryAccess): void => {
            if (!aclAllows(principal(), scope, ctx.state.acl, access)) throw forbidden(`${access} access to ${scope} denied`);
        };
        const ownerOnly = (): void => {
            const p = principal();
            if (!p || !isMemoryOwner(p)) throw forbidden(`only the workspace owner may change the ACL of ${scope}`);
        };

        return {
            async put(entry: NewMemoryEntry): Promise<MemoryEntry> {
                guard('write');
                const stored = await store.put(entry);
                await ctx.save();
                return ctx.snapshot(stored);
            },
            async update(id: string, patch: Partial<Omit<MemoryEntry, 'id'>>): Promise<MemoryEntry> {
                guard('write');
                const stored = await store.update(id, patch);
                await ctx.save();
                return ctx.snapshot(stored);
            },
            async retire(id: string, why: string): Promise<void> {
                guard('write');
                await store.retire(id, why);
                await ctx.save();
            },
            async get(id: string): Promise<MemoryEntry | undefined> {
                guard('read');
                const e = await store.get(id);
                return e && ctx.snapshot(e);
            },
            async query(q: MemoryQuery): Promise<readonly RankedMemory[]> {
                guard('read');
                return ctx.snapshot(await store.query(q));
            },
            /** Entries ordered by id, `size` at a time; `next` is the cursor for the following page. */
            async exportPage(after: string | null, size?: number): Promise<ExportPage> {
                guard('read');
                return ctx.snapshot(store.exportPage(after, size));
            },
            async importBatch(rows: readonly unknown[], options?: { readonly onConflict?: 'skip' | 'replace' }): Promise<ImportReport> {
                guard('write');
                const report = await store.importBatch(rows, options);
                await ctx.save();
                return report;
            },
            /** Drop expired `working` entries; returns how many went. */
            async compact(): Promise<number> {
                guard('write');
                const dropped = await store.compact();
                await ctx.save();
                return dropped;
            },
            async setAcl(acl: MemoryAcl | null): Promise<void> {
                ownerOnly();
                applyMemoryActorEntry(ctx.state, { op: 'acl', acl });
                await ctx.save();
            },
            async getAcl(): Promise<MemoryAcl | null> {
                guard('read');
                return ctx.snapshot(ctx.state.acl);
            },
            async stats(): Promise<MemoryStats> {
                guard('read');
                return { entries: Object.keys(ctx.state.memory.entries).length, live: liveCount(ctx.state.memory, Date.now()), rev: ctx.state.memory.rev, acl: ctx.snapshot(ctx.state.acl) };
            }
        };
    }
});
