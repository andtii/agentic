/**
 * The workspace's agents as identities (#34): one live read of the
 * Workspace index, then `Agent.get()` per id in one `useData` fetch, so
 * the pages resolve names, hues and environments synchronously through a
 * lookup — the same shape the mock `agentNamed` has.
 *
 * Each agent is also a live `Agent.get` subscription on the page's live
 * channel (#258), so a config edit — a new default environment, a rename —
 * reaches every page without a reload; the fetch fills in until a frame
 * comes, and on the server nothing subscribes.
 */
import { effect, onMounted, onUnmounted, signal, useData } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState, useActorsContext, type ActorLiveChannel } from '@sigx/actors/app';
import type { AgentId } from '@agentic/core';
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
    // Live identities, by id; a fetched one answers until its first frame (#258).
    const live = signal<{ byId: Record<string, AgentIdentity> }>({ byId: {} });
    const channel: ActorLiveChannel = useActorsContext().live;
    const subs = new Map<string, () => void>();
    let stop: (() => void) | undefined;
    // Client only: `onMounted` never runs in a server render.
    onMounted(() => {
        stop = effect(() => {
            const ws = viewer.workspaceId;
            const ids = ws ? (index.value?.agents ?? []) : [];
            for (const [id, off] of subs) {
                if (ids.includes(id as AgentId)) continue;
                off();
                subs.delete(id);
            }
            ids.forEach((id, i) => {
                if (subs.has(id) || !ws) return;
                subs.set(
                    id,
                    channel.subscribe({ type: 'Agent', key: agentKeyOf(ws, id as AgentId), method: 'get' }, (value: unknown) => {
                        const view = value as AgentView | null;
                        if (view?.config) live.byId = { ...live.byId, [id]: identityOf(view, i) };
                    })
                );
            });
        });
    });
    onUnmounted(() => {
        stop?.();
        for (const off of subs.values()) off();
        subs.clear();
    });
    const merged = (): Record<string, AgentIdentity> => ({ ...agents.value, ...live.byId });
    return {
        lookup: (id) => lookupOver(merged())(id),
        all: () => Object.values(merged()),
        get loading() {
            return index.loading || agents.loading;
        },
        get error() {
            return index.error ?? agents.error;
        }
    };
}
