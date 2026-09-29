/**
 * The agent store (#1119): the one owner of the agent directory. The ids come
 * from the workspace store's `view` (`Workspace.get().agents`); one `useData`
 * fetch reads `Agent.get()` per id (SSR-seeded under the key
 * `['agents', ws, ...ids]`), and each agent is a live `Agent.get` subscription
 * on the app's live channel, so a config edit — a new default environment, a
 * rename — reaches every page without a reload. The fetched view answers until
 * the agent's first frame.
 *
 * The subscriptions live as long as the app: a change of the id set subscribes
 * the new agents and closes the removed ones, a workspace switch closes them all,
 * and `ctx.onDeactivated` tears everything down. A route change opens nothing.
 *
 * The store holds views, not identities: the web's `useAgentDirectory` turns an
 * entry into its `AgentIdentity` (a hue comes from `@agentic/ui`).
 *
 * With no actor definitions or viewer provided (a render on mock data), the
 * store reads nothing and answers empty.
 */
import { actor } from '@sigx/actors';
import { useActorsContext, type ActorLiveChannel } from '@sigx/actors/app';
import { computed, effect, signal, untrack } from '@sigx/reactivity';
import { useData } from '@sigx/runtime-core';
import { actorKey, type WorkspaceId } from '@agentic/core';
import type { AgentView } from '@agentic/platform';
import { useActorDefs } from '../defs';
import { useViewer } from '../viewer';
import { defineAppStore } from './define';
import { useWorkspaceStore } from './workspace';

/** One agent of the directory: its view and its position in the Workspace index (what its hue follows). */
export interface AgentEntry {
    readonly view: AgentView;
    readonly index: number;
}

/** The Agent actor's key — the platform's `agentKey`, spelled here from core so the bundle never imports the platform for a string. */
const agentKeyOf = (ws: string, id: string): string => actorKey(ws as WorkspaceId, 'agent', id);

/** An injectable the app may not provide (a render on mock data): `null` then. */
function optional<T>(use: () => T): T | null {
    try {
        return use();
    } catch {
        return null;
    }
}

export const useAgentStore = defineAppStore('agents', (ctx) => {
    const defs = optional(useActorDefs);
    const viewer = defs ? optional(() => useViewer()()) : null;
    const workspace = useWorkspaceStore();
    /** The index's agent ids for the viewer's workspace; empty without one. */
    const ids = (): readonly string[] => (viewer?.workspaceId ? (workspace.view?.agents ?? []) : []);

    const fetched = useData(
        () => {
            const ws = viewer?.workspaceId;
            const list = workspace.view?.agents;
            return defs && ws && list ? (['agents', ws, ...list] as const) : false;
        },
        async (key): Promise<Record<string, AgentEntry>> => {
            const [, ws, ...list] = key as readonly [string, string, ...string[]];
            const views = await Promise.all(
                list.map(async (id): Promise<AgentView | null> => {
                    try {
                        return await actor(defs!.AgentActor, agentKeyOf(ws, id)).get();
                    } catch {
                        // Not configured yet, or gone: the directory shows the id until it is.
                        return null;
                    }
                })
            );
            const out: Record<string, AgentEntry> = {};
            views.forEach((view, index) => {
                if (view) out[view.id] = { view, index };
            });
            return out;
        }
    );

    // Live entries, by id; a fetched one answers until its first frame (#258).
    const live = signal<{ byId: Record<string, AgentEntry> }>({ byId: {} });
    const subs = new Map<string, () => void>();
    const channel: ActorLiveChannel | null = defs && viewer ? useActorsContext().live : null;
    const runner = channel
        ? effect(() => {
              const ws = viewer!.workspaceId;
              const list = ids();
              untrack(() => {
                  // Keyed by actor key, not id: a workspace switch drops every old subscription and its entry.
                  const wanted = new Map(list.map((id, index) => [agentKeyOf(ws!, id), { id, index }] as const));
                  for (const [key, off] of subs) {
                      if (wanted.has(key)) continue;
                      off();
                      subs.delete(key);
                  }
                  const keep = new Set<string>(list);
                  if (Object.keys(live.byId).some((id) => !keep.has(id))) live.byId = Object.fromEntries(Object.entries(live.byId).filter(([id]) => keep.has(id)));
                  for (const [key, { id, index }] of wanted) {
                      if (subs.has(key)) continue;
                      subs.set(
                          key,
                          channel.subscribe({ type: 'Agent', key, method: 'get' }, (value: unknown) => {
                              const view = value as AgentView | null;
                              if (view?.config && subs.has(key)) live.byId = { ...live.byId, [id]: { view, index } };
                          })
                      );
                  }
              });
          })
        : null;
    ctx.onDeactivated(() => {
        runner?.stop();
        for (const off of subs.values()) off();
        subs.clear();
    });

    /** Every loaded agent by id, in the index's order: the live view once one arrived, else the fetched one. */
    const agents = computed((): Record<string, AgentEntry> => {
        const out: Record<string, AgentEntry> = {};
        const got = fetched.value ?? {};
        // The index is the id's current position: a removal before it moves its hue, as a refetch would.
        ids().forEach((id, index) => {
            const entry = live.byId[id] ?? got[id];
            if (entry) out[id] = entry.index === index ? entry : { view: entry.view, index };
        });
        return out;
    });
    /** The index is loading or the views are. */
    const loading = computed(() => workspace.indexRead.loading || fetched.loading);
    const error = computed((): unknown => workspace.indexRead.error ?? fetched.error ?? null);

    return { agents, loading, error };
});
