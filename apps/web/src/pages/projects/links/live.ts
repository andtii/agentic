/**
 * `/projects/links` and the projects index strip on the platform (#881): each project's `Plan.linkItems()` read
 * through `workspaceLinks` (#822), once for the Open view and once for Done, and the graph mapped onto the page's
 * view model. The items are fetched once per project for both views; a project whose plan cannot be read is left
 * out, as `workspaceLinks` does.
 *
 * Live (#942): each project's `linkItems` is also a subscription on the page's live channel, as the Plan views'
 * reads are, so an item finished or a wait added in any project redraws the graph without a reload. The fetch fills
 * in until a project's first frame comes; on the server nothing subscribes.
 */
import { effect, onMounted, onUnmounted, signal, useData } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorsContext, type ActorLiveChannel } from '@sigx/actors/app';
import { linkProjectInfo, links, workspaceLinks, type LinkGraph, type LinkItemInput, type LinkNode, type LinkProjectInfo } from '@agentic/platform';
import type { AgentId, PlanActor, ProjectId, ProjectRecord } from '@agentic/core';
import type { ActorDefs, ViewerState } from '../../../actors/defs';
import { planKeyOf } from '../../../actors/keys';
import type { OpenLinksData } from '../index/model';
import type { LinkActor, LinkItem, LinksData, LinksView } from './model';

/** An agent's tile by id (the directory's lookup). */
export type LinkAgentNames = (agentId: AgentId) => LinkActor;

/** A project's facts for the graph: its manager is the PM agent when one is set, else the coordinator. */
export const linkProjectOf = (p: ProjectRecord): LinkProjectInfo => ({ ...linkProjectInfo(p), manager: p.pm?.agentId ?? p.members.coordinator ?? null });

const actorOf = (a: PlanActor, names: LinkAgentNames): LinkActor => (a.kind === 'agent' ? names(a.agentId) : { name: 'You', person: true });

/**
 * One `LinkGraph` as the page's view: its lanes in order, and every node with its arrows as `after`. A node's ref is
 * its label (`agentic#16`) unless another node already has that label (two projects of one name), then its key.
 */
export function linksViewOf(graph: LinkGraph, names: LinkAgentNames): LinksView {
    const nodes: LinkNode[] = graph.lanes.flatMap((l) => l.nodes);
    const refs = new Map<string, string>();
    const used = new Set<string>();
    for (const n of nodes) {
        const ref = used.has(n.label) ? n.key : n.label;
        used.add(ref);
        refs.set(n.key, ref);
    }
    const refOf = (key: string): string => refs.get(key) ?? key;
    const upstream = new Map<string, string[]>();
    for (const e of graph.edges) (upstream.get(e.to) ?? upstream.set(e.to, []).get(e.to)!).push(e.from);
    const items: LinkItem[] = nodes.map((n) => {
        const after = (upstream.get(n.key) ?? []).filter((k) => refs.has(k)).map(refOf);
        const shown = n.waitsOn.filter((k) => refs.has(k)).map(refOf);
        const more = n.waitsOn.length - shown.length;
        const meta = n.state === 'done' ? `done · ${n.planTitle}` : !n.waitsOn.length ? n.planTitle : !shown.length ? `waits on ${more} ${more === 1 ? 'item' : 'items'}` : `waits on ${shown.join(', ')}${more ? ` and ${more} more` : ''}`;
        return {
            ref: refOf(n.key),
            projectId: n.projectId,
            state: n.state,
            title: n.title,
            meta,
            ...(n.owner ? { owner: actorOf(n.owner, names) } : {}),
            after,
            ...(n.milestone ? { milestone: true } : {})
        };
    });
    return {
        lanes: graph.lanes.map((l) => ({ projectId: l.projectId, name: l.name, ...(l.manager ? { manager: names(l.manager) } : {}) })),
        items
    };
}

/** The index strip: the open link count and each chain as `root waits on first step`; `undefined` with no open links. */
export function openLinksOf(graph: LinkGraph): OpenLinksData | undefined {
    if (!graph.counts.open) return undefined;
    const lines = graph.chains.flatMap((c) => {
        const first = c.steps[0];
        return first && first.key !== c.root ? [`${c.label} waits on ${first.label}`] : [];
    });
    return { count: graph.counts.open, summary: lines.join(' · ') };
}

/** Both views' graphs. */
export interface LiveLinkGraphs {
    readonly open: LinkGraph;
    readonly done: LinkGraph;
}

/** Read both graphs over `items` (one read per project, shared by the two views). */
export async function readLinkGraphs(projects: readonly LinkProjectInfo[], items: (projectId: ProjectId) => Promise<readonly LinkItemInput[]>): Promise<LiveLinkGraphs> {
    const cache = new Map<ProjectId, Promise<readonly LinkItemInput[]>>();
    const source = {
        projects: async () => projects,
        items: (id: ProjectId) => cache.get(id) ?? cache.set(id, items(id)).get(id)!
    };
    const [open, done] = await Promise.all([workspaceLinks(source, 'open'), workspaceLinks(source, 'done')]);
    return { open, done };
}

export interface LiveLinks {
    /** `undefined` until the read lands. */
    graphs(): LiveLinkGraphs | undefined;
    /** The first read has not landed yet (the page shows skeletons, not its empty state). */
    readonly loading: boolean;
}

/** Both views' graphs over items already in hand; a project with none yet counts as having no items. */
export function linkGraphsOf(projects: readonly LinkProjectInfo[], itemsOf: (projectId: ProjectId) => readonly LinkItemInput[] | undefined): LiveLinkGraphs {
    const sources = projects.map((project) => ({ project, items: itemsOf(project.id) ?? [] }));
    return { open: links(sources, 'open'), done: links(sources, 'done') };
}

/** The Plan actor's type on the live channel (`PLAN_TYPE`), spelled here as `keys.ts` spells the keys. */
const PLAN_ACTOR_TYPE = 'plan';

/**
 * The workspace's link graphs: one fetch of every project's items, read again when the projects (or their names and
 * managers) change, and each project's `linkItems` subscribed live so another person's or agent's change lands here.
 */
export function useLiveLinks(defs: Pick<ActorDefs, 'Plan'>, viewer: Pick<ViewerState, 'workspaceId'>, projects: () => readonly ProjectRecord[]): LiveLinks {
    const infosOf = (): LinkProjectInfo[] => projects().map(linkProjectOf);
    const data = useData(
        () => {
            const ws = viewer.workspaceId;
            const list = projects();
            return ws && list.length ? (['project-link-items', ws, ...list.map((p) => p.id)] as const) : false;
        },
        async (key): Promise<Record<string, readonly LinkItemInput[]>> => {
            const [, ws, ...ids] = key as readonly [string, string, ...string[]];
            const out: Record<string, readonly LinkItemInput[]> = {};
            await Promise.all(ids.map(async (id) => {
                try {
                    out[id] = await actor(defs.Plan, planKeyOf(ws, id)).linkItems();
                } catch {
                    // A project whose plan cannot be read is left out, as `workspaceLinks` does.
                }
            }));
            return out;
        }
    );
    // Live items by actor key; a fetched project answers until its first frame.
    const live = signal<{ byKey: Record<string, readonly LinkItemInput[]> }>({ byKey: {} });
    const channel: ActorLiveChannel = useActorsContext().live;
    const subs = new Map<string, () => void>();
    let stop: (() => void) | undefined;
    // Client only: `onMounted` never runs in a server render.
    onMounted(() => {
        stop = effect(() => {
            const ws = viewer.workspaceId;
            const wanted = new Set(ws ? projects().map((p) => planKeyOf(ws, p.id)) : []);
            for (const [key, off] of subs) {
                if (wanted.has(key)) continue;
                off();
                subs.delete(key);
            }
            if (Object.keys(live.byKey).some((k) => !wanted.has(k))) live.byKey = Object.fromEntries(Object.entries(live.byKey).filter(([k]) => wanted.has(k)));
            for (const key of wanted) {
                if (subs.has(key)) continue;
                subs.set(
                    key,
                    channel.subscribe({ type: PLAN_ACTOR_TYPE, key, method: 'linkItems' }, (value: unknown) => {
                        if (Array.isArray(value) && subs.has(key)) live.byKey = { ...live.byKey, [key]: value as LinkItemInput[] };
                    })
                );
            }
        });
    });
    onUnmounted(() => {
        stop?.();
        for (const off of subs.values()) off();
        subs.clear();
    });
    // The graphs are rebuilt only when an input changes, not on every render.
    let memo: { infos: string; fetched: unknown; live: unknown; graphs: LiveLinkGraphs } | undefined;
    const graphs = (): LiveLinkGraphs | undefined => {
        const ws = viewer.workspaceId;
        const fetched = data.value;
        const byKey = live.byKey;
        if (!ws) return undefined;
        const infos = infosOf();
        const anyLive = infos.some((p) => byKey[planKeyOf(ws, p.id)]);
        if (!fetched && !anyLive) return undefined;
        const infoKey = JSON.stringify(infos);
        if (memo && memo.infos === infoKey && memo.fetched === fetched && memo.live === byKey) return memo.graphs;
        const out = linkGraphsOf(infos, (id) => byKey[planKeyOf(ws, id)] ?? fetched?.[id]);
        memo = { infos: infoKey, fetched, live: byKey, graphs: out };
        return out;
    };
    return {
        graphs,
        get loading() {
            return data.loading && !graphs();
        }
    };
}

/** The page's two views from the live graphs; empty until they land. */
export function liveLinksData(graphs: LiveLinkGraphs | undefined, names: LinkAgentNames): LinksData {
    if (!graphs) return { open: { lanes: [], items: [] }, done: { lanes: [], items: [] } };
    return { open: linksViewOf(graphs.open, names), done: linksViewOf(graphs.done, names) };
}
