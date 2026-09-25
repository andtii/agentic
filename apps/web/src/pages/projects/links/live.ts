/**
 * `/projects/links` and the projects index strip on the platform (#881): each project's `Plan.linkItems()` read
 * through `workspaceLinks` (#822), once for the Open view and once for Done, and the graph mapped onto the page's
 * view model. The items are fetched once per project for both views; a project whose plan cannot be read is left
 * out, as `workspaceLinks` does.
 */
import { useData } from 'sigx';
import { actor } from '@sigx/actors';
import { linkProjectInfo, workspaceLinks, type LinkGraph, type LinkItemInput, type LinkNode, type LinkProjectInfo } from '@agentic/platform';
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
    readonly loading: boolean;
}

/** The workspace's link graphs, read again whenever the projects (or their names and managers) change. */
export function useLiveLinks(defs: Pick<ActorDefs, 'Plan'>, viewer: Pick<ViewerState, 'workspaceId'>, projects: () => readonly ProjectRecord[]): LiveLinks {
    const data = useData(
        () => {
            const ws = viewer.workspaceId;
            const list = projects();
            return ws && list.length ? (['project-links', ws, JSON.stringify(list.map(linkProjectOf))] as const) : false;
        },
        async (key): Promise<LiveLinkGraphs> => {
            const [, ws, infos] = key as readonly [string, string, string];
            return readLinkGraphs(JSON.parse(infos) as LinkProjectInfo[], (id) => actor(defs.Plan, planKeyOf(ws, id)).linkItems());
        }
    );
    return {
        graphs: () => data.value ?? undefined,
        get loading() {
            return data.loading;
        }
    };
}

/** The page's two views from the live graphs; empty until they land. */
export function liveLinksData(graphs: LiveLinkGraphs | undefined, names: LinkAgentNames): LinksData {
    if (!graphs) return { open: { lanes: [], items: [] }, done: { lanes: [], items: [] } };
    return { open: linksViewOf(graphs.open, names), done: linksViewOf(graphs.done, names) };
}
