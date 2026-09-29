/**
 * The workspace's agents as identities (#34), read through the app's agent
 * store (#1119, `@agentic/client`): one live read of the Workspace index (the
 * workspace store), `Agent.get()` per id in one SSR-seeded fetch, and a live
 * `Agent.get` subscription per agent (#258) — opened once per app, not per
 * page, so a route change redials nothing. The pages resolve names, hues and
 * environments synchronously through a lookup — the same shape the mock
 * `agentNamed` has.
 */
import { computed } from 'sigx';
import { useAgentStore } from '@agentic/client';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { identityOf, lookupOver, type AgentIdentity, type AgentLookup } from './live';

export interface AgentDirectory {
    readonly lookup: AgentLookup;
    /** Every loaded identity, in creation order. */
    all(): AgentIdentity[];
    /** The index is loading or the identities are. */
    readonly loading: boolean;
    readonly error: Error | null;
}

/** Called in a component's setup. The arguments are kept for the call sites; the store reads the app's own definitions and viewer. */
export function useAgentDirectory(_defs: ActorDefs, _viewer: ViewerState): AgentDirectory {
    const store = useAgentStore();
    const identities = computed((): Record<string, AgentIdentity> => {
        const out: Record<string, AgentIdentity> = {};
        for (const [id, entry] of Object.entries(store.agents)) out[id] = identityOf(entry.view, entry.index);
        return out;
    });
    return {
        lookup: (id) => lookupOver(identities.value)(id),
        all: () => Object.values(identities.value),
        get loading() {
            return store.loading;
        },
        get error() {
            return (store.error as Error | null) ?? null;
        }
    };
}
