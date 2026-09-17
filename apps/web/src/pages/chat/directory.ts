/**
 * The workspace's agents as identities (#34): one live read of the
 * Workspace index, then `Agent.get()` per id in one `useData` fetch, so
 * the pages resolve names, hues and environments synchronously through a
 * lookup — the same shape the mock `agentNamed` has.
 */
import { useData } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { AgentView } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { agentKeyOf, workspaceKeyOf } from '../../actors/keys';
import { identityOf, lookupOver, type AgentIdentity, type AgentLookup } from './live';

export interface AgentDirectory {
    readonly lookup: AgentLookup;
    /** Every loaded identity, in creation order. */
    all(): AgentIdentity[];
    /** The index is loading or the identities are. */
    readonly loading: boolean;
    readonly error: Error | null;
}

export function useAgentDirectory(defs: ActorDefs, viewer: ViewerState): AgentDirectory {
    const index = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const agents = useData(
        () => {
            const ws = viewer.workspaceId;
            const ids = index.value?.agents;
            return ws && ids ? (['agents', ws, ...ids] as const) : false;
        },
        async (key): Promise<Record<string, AgentIdentity>> => {
            const [, ws, ...ids] = key as readonly [string, string, ...string[]];
            const views = await Promise.all(
                ids.map(async (id): Promise<AgentView | null> => {
                    try {
                        return await actor(defs.AgentActor, agentKeyOf(ws, id)).get();
                    } catch {
                        // Not configured yet, or gone: the directory shows the id until it is.
                        return null;
                    }
                })
            );
            const out: Record<string, AgentIdentity> = {};
            views.forEach((view, i) => {
                if (view) out[view.id] = identityOf(view, i);
            });
            return out;
        }
    );
    return {
        lookup: (id) => lookupOver(agents.value ?? {})(id),
        all: () => Object.values(agents.value ?? {}),
        get loading() {
            return index.loading || agents.loading;
        },
        get error() {
            return index.error ?? agents.error;
        }
    };
}
