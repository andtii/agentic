/**
 * What the other actors say about an agent, read live (#153): its tasks from
 * the workspace's `TaskIndex` (presence, sessions), the entries of its private
 * Memory scope, the week's corrections from the Ledger, and the oldest pending
 * instruction proposal. The hooks only read; `./live` folds the results.
 */
import { useData } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { AgentId, MemoryEntry } from '@agentic/core';
import type { AgentView, PendingProposal, TaskIndexRow } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { agentKeyOf, ledgerKeyOf, memoryKeyOf, registryKeyOf, taskIndexKeyOf, taskKeyOf } from '../../actors/keys';
import { activeTasks, isoWeekOf, weekMonths, type AgentActivity } from './live';

/** Entries read per `Memory.exportPage` call. */
export const MEMORY_PAGE = 200;
/** Most entries the Memory tab lists; a scope past it shows its first `MEMORY_LIMIT` by id. */
export const MEMORY_LIMIT = 2000;

/** The flat memory plugin's id (`FLAT_MEMORY_PLUGIN_ID`; a literal, so `@agentic/memory` stays out of the client bundle). */
export const FLAT_MEMORY_PLUGIN = 'agentic.memory.flat';

export interface ActiveMemory {
    /** The flat plugin is the workspace's active memory: its FlatMemory actors hold what the agents remember. */
    flat(): boolean;
    /** The active memory plugin's name; `undefined` until the Registry answers. */
    name(): string | undefined;
}

/**
 * Which store the agent pages read (#281): the workspace's ACTIVE memory plugin's — the FlatMemory actor of the scope
 * while the flat plugin is active, the Memory actor otherwise (and until the Registry answers). The two share the key
 * and the method table, so only the definition differs.
 */
export function useActiveMemory(defs: Pick<ActorDefs, 'Registry'>, viewer: Pick<ViewerState, 'workspaceId'>): ActiveMemory {
    const overview = useActorState(defs.Registry, () => { const ws = viewer.workspaceId; return ws && ([registryKeyOf(ws), 'overview'] as const); }, { live: true });
    const active = (): string | undefined => overview.value?.active.memory;
    return {
        flat: () => active() === FLAT_MEMORY_PLUGIN,
        name: () => { const id = active(); return id ? overview.value?.plugins.find((p) => p.manifest.id === id)?.manifest.name : undefined; }
    };
}

/** A scope's live `stats` from whichever store is active: one read per store, the idle one never asked. */
function useMemoryStats(defs: Pick<ActorDefs, 'Memory' | 'FlatMemory'>, active: ActiveMemory, key: () => string | null | undefined) {
    const main = useActorState(defs.Memory, () => { const k = key(); return !!k && !active.flat() && ([k, 'stats'] as const); }, { live: true });
    const flat = useActorState(defs.FlatMemory, () => { const k = key(); return !!k && active.flat() && ([k, 'stats'] as const); }, { live: true });
    return () => (active.flat() ? flat.value : main.value);
}

export interface AgentCorrections {
    /** Corrections in the current ISO week. */
    week(): number;
    /** Of those, the `wrong` ones — a mistake made again. */
    wrong(): number;
}

/**
 * The week's corrections of one agent. A correction is tallied in the ledger
 * of the month it happened in, so a week across a month boundary sums two
 * ledgers; the week is the one the page opened in.
 */
export function useAgentCorrections(defs: ActorDefs, viewer: ViewerState, agentId: () => string): AgentCorrections {
    const now = Date.now();
    const week = isoWeekOf(now);
    const [first, second] = weekMonths(now);
    const read = (month: string | undefined, what?: 'wrong') =>
        useActorState(
            defs.Ledger,
            () => {
                const ws = viewer.workspaceId;
                if (!ws || !month) return false;
                return what ? ([ledgerKeyOf(ws, month), 'corrections', agentId() as AgentId, week, what] as const) : ([ledgerKeyOf(ws, month), 'corrections', agentId() as AgentId, week] as const);
            },
            { live: true }
        );
    const all = [read(first), read(second)];
    const wrong = [read(first, 'wrong'), read(second, 'wrong')];
    const sum = (reads: readonly { readonly value: number | null | undefined }[]): number => reads.reduce((n, r) => n + (r.value ?? 0), 0);
    return { week: () => sum(all), wrong: () => sum(wrong) };
}

/** How many entries of the agent's private scope are live, in the active memory plugin's store — the roster's count. */
export function useMemoryCount(defs: ActorDefs, viewer: ViewerState, agentId: () => string): () => number {
    const active = useActiveMemory(defs, viewer);
    const stats = useMemoryStats(defs, active, () => viewer.workspaceId && memoryKeyOf(viewer.workspaceId, `agent:${agentId()}`));
    return () => stats()?.live ?? 0;
}

/**
 * The workspace's task index, read live. A live read's arguments are part of
 * its key and must be JSON primitives, so the query object stays out: the
 * whole index (capped at `TASK_INDEX_CAP` rows) is read once — the roster and
 * the agent page share the read — and filtered here.
 */
export function useWorkspaceTasks(defs: ActorDefs, viewer: ViewerState): () => TaskIndexRow[] {
    const rows = useActorState(defs.TaskIndex, () => viewer.workspaceId && ([taskIndexKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
    return () => rows.value ?? [];
}

export interface AgentActivityRead {
    /** The folded reads; absent parts read as idle / empty / zero. */
    activity(): AgentActivity;
    /** The workspace's active memory plugin — the store the Memory tab lists and acts on (#281). */
    memory: ActiveMemory;
    /** A read the tabs copy at mount (the pending proposal) has not answered yet. */
    pending(): boolean;
}

/** Everything `profileOf` takes about one agent. `view` is the live `Agent.get()`. */
export function useAgentActivity(defs: ActorDefs, viewer: ViewerState, agentId: () => string, view: () => AgentView | null | undefined): AgentActivityRead {
    const index = useWorkspaceTasks(defs, viewer);
    const tasks = (): TaskIndexRow[] => index().filter((r) => r.assignee === agentId());
    const corrections = useAgentCorrections(defs, viewer, agentId);

    // The list follows the scope's revision in the active memory plugin's store (#281): any write (ours, the agent's,
    // another tab's) bumps it, and so does switching the active plugin.
    const memory = useActiveMemory(defs, viewer);
    const memoryKey = (): string | null => (viewer.workspaceId ? memoryKeyOf(viewer.workspaceId, `agent:${agentId()}`) : null);
    const stats = useMemoryStats(defs, memory, memoryKey);
    const memories = useData(
        () => { const k = memoryKey(); const s = stats(); return k && s ? (['agent-memories', memory.flat() ? 'flat' : 'default', k, s.rev] as const) : false; },
        async (key): Promise<MemoryEntry[]> => {
            const [, store, k] = key as readonly [string, 'flat' | 'default', string, number];
            const client = store === 'flat' ? actor(defs.FlatMemory, k) : actor(defs.Memory, k);
            const out: MemoryEntry[] = [];
            let after: string | null = null;
            do {
                const page: { readonly entries: readonly MemoryEntry[]; readonly next: string | null } = await client.exportPage(after, MEMORY_PAGE);
                out.push(...page.entries);
                after = page.next;
            } while (after !== null && out.length < MEMORY_LIMIT);
            return out;
        }
    );
    // The last list survives a re-read, so the tab never flashes empty between two revisions.
    let lastMemories: readonly MemoryEntry[] = [];

    // AGT-07: tasks in flight that were created on an older config version keep it.
    const older = useData(
        () => {
            const ws = viewer.workspaceId;
            const v = view();
            const ids = activeTasks(tasks()).map((r) => r.id);
            return ws && v && ids.length ? (['agent-older', ws, v.configVersion, ...ids] as const) : false;
        },
        async (key): Promise<number> => {
            const [, ws, current, ...ids] = key as readonly [string, string, number, ...string[]];
            const versions = await Promise.all(ids.map((id) => actor(defs.TaskActor, taskKeyOf(ws, id)).get().then((t) => t.configVersion ?? current, () => current)));
            return versions.filter((v) => v < current).length;
        }
    );

    const proposals = useData(
        () => {
            const ws = viewer.workspaceId;
            const v = view();
            return ws && v && v.pendingProposals > 0 ? (['agent-proposals', ws, v.id, v.pendingProposals, v.configVersion] as const) : false;
        },
        (key): Promise<readonly PendingProposal[]> => {
            const [, ws, id] = key as readonly [string, string, string, number, number];
            return actor(defs.AgentActor, agentKeyOf(ws, id)).listProposals('pending');
        }
    );
    let lastProposal: PendingProposal | undefined;

    return {
        memory,
        activity() {
            if (memories.value) lastMemories = memories.value;
            const waiting = (view()?.pendingProposals ?? 0) > 0;
            if (proposals.value) lastProposal = proposals.value[0];
            if (!waiting) lastProposal = undefined;
            return {
                tasks: tasks(),
                memories: lastMemories,
                correctionsThisWeek: corrections.week(),
                repeatedMistakes: corrections.wrong(),
                activeOnOlder: older.value ?? 0,
                ...(lastProposal ? { proposal: lastProposal } : {})
            };
        },
        pending: () => (view()?.pendingProposals ?? 0) > 0 && !proposals.value && !lastProposal
    };
}
