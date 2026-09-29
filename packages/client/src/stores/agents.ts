/**
 * The agent store (#1119, #1125): the one owner of the agent directory. Every
 * agent's summary — name, role, description, execution binding — comes from the
 * workspace store's `view` (`Workspace.get().agentSummaries`, in the order of
 * `agents`), so the directory opens no `Agent` read or socket of its own: the
 * Agent actor writes its summary onto the Workspace index with every config
 * version, and the index's one live read carries a rename or a new default
 * environment to every page without a reload.
 *
 * An agent the index lists without a summary yet (the Workspace backfills older
 * records on read) is left out until it has one.
 *
 * The store holds summaries, not identities: the web's `useAgentDirectory` turns
 * an entry into its `AgentIdentity` (a hue comes from `@agentic/ui`).
 *
 * With no actor definitions or viewer provided (a render on mock data), the
 * workspace store reads nothing and this one answers empty.
 */
import { computed } from '@sigx/reactivity';
import type { AgentSummary } from '@agentic/core';
import { defineAppStore } from './define';
import { useWorkspaceStore } from './workspace';

/** One agent of the directory: its summary and its position in the Workspace index (what its hue follows). */
export interface AgentEntry {
    readonly view: AgentSummary;
    readonly index: number;
}

export const useAgentStore = defineAppStore('agents', () => {
    const workspace = useWorkspaceStore();

    /** Every summarised agent by id, in the index's order; the index is the id's current position. */
    const agents = computed((): Record<string, AgentEntry> => {
        const out: Record<string, AgentEntry> = {};
        const view = workspace.view;
        const summaries = view?.agentSummaries ?? {};
        (view?.agents ?? []).forEach((id, index) => {
            const summary = summaries[id];
            if (summary) out[id] = { view: summary, index };
        });
        return out;
    });
    /** The index is loading. */
    const loading = computed(() => workspace.indexRead.loading);
    const error = computed((): unknown => workspace.indexRead.error ?? null);

    return { agents, loading, error };
});
