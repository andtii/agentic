/**
 * `/projects/links` (#765, PRJ-17): the view model and the layout of links across projects. Pure, so it is unit-tested
 * without a DOM.
 *
 * A view (Open or Done) is the lanes — one per project that has a link, in the given order, labelled with its
 * manager — and the items with a cross-project `after`, each naming the refs (`project#n`) it waits on. Layout: one
 * 150px lane per project, 230px nodes; an item's column is one past the deepest item it waits on, and when its lane
 * already holds a node in that column it moves right to the next free one, so the columns of every arrow still point
 * right. Arrows run from the right edge of the item waited on to the left edge of the waiting item (a bezier and a
 * chevron head). A milestone or release selects its chain: itself and everything it transitively waits on.
 */
import type { AgentHue, ItemGlyphState } from '@agentic/ui';

/** Who is on an item, or a project's manager: an agent tile (square, in its hue) or a person (circle). */
export interface LinkActor {
    readonly name: string;
    readonly hue?: AgentHue;
    readonly person?: boolean;
    readonly monogram?: string;
}

/** A project with at least one link: its lane's label. */
export interface LinkLane {
    readonly projectId: string;
    readonly name: string;
    readonly manager?: LinkActor;
}

/** How a chain step's line reads: someone is on it, it is up to you, or it just waits. */
export type LinkStepTone = 'working' | 'needs-you' | 'muted';

export interface LinkItem {
    /** `project#n` (or a milestone's name, `agentic 0.5`): unique in the view, and what `after` names. */
    readonly ref: string;
    readonly projectId: string;
    readonly state: ItemGlyphState;
    readonly title: string;
    /** The node's one meta line (`waits on signalx#14`, `PR #88 · checks running`). */
    readonly meta: string;
    readonly owner?: LinkActor;
    /** The refs this item waits on. Refs not in the view draw nothing. */
    readonly after: readonly string[];
    /** A milestone or release: selecting it highlights its chain. */
    readonly milestone?: boolean;
    /** The chain panel's line for this step; the meta line when absent. */
    readonly step?: { readonly text: string; readonly tone?: LinkStepTone };
}

export interface LinksView {
    readonly lanes: readonly LinkLane[];
    readonly items: readonly LinkItem[];
}

/** Both toggles of the page. */
export interface LinksData {
    readonly open: LinksView;
    readonly done: LinksView;
}

export const LINKS_LANE_H = 150;
export const LINKS_NODE_W = 230;
/** A node's height, for the canvas; its content sets the drawn height. */
export const LINKS_NODE_H = 84;
/** A node's top inside its lane. */
export const LINKS_NODE_TOP = 30;
/** Column 0's left edge: the lane label sits before it. */
export const LINKS_COL_X = 200;
/** Between two columns: room for the arrows. */
export const LINKS_COL_GAP = 70;
/** Where arrows meet a node, down from its top (its header row). */
export const LINKS_ANCHOR_Y = 32;
/** The arrow head's length. */
export const LINKS_HEAD = 8;
/** Right padding after the last column. */
export const LINKS_PAD = 40;

export interface LinksNode {
    readonly ref: string;
    readonly lane: number;
    readonly col: number;
    readonly x: number;
    readonly y: number;
}

export interface LinksEdge {
    /** The item waited on. */
    readonly from: string;
    /** The item waiting. */
    readonly to: string;
    /** The bezier, from `from`'s right edge to just before `to`'s left edge. */
    readonly d: string;
    /** The chevron head ending on `to`'s left edge. */
    readonly head: string;
    /** Both ends on the highlighted chain. */
    readonly highlighted: boolean;
}

export interface LinksLaneBox extends LinkLane {
    readonly y: number;
}

export interface LinksLayout {
    readonly lanes: readonly LinksLaneBox[];
    readonly nodes: readonly LinksNode[];
    readonly edges: readonly LinksEdge[];
    readonly width: number;
    readonly height: number;
}

/** The view's items that have a lane, keyed by ref (a repeated ref keeps its first item). */
export function itemsOf(view: LinksView): Map<string, LinkItem> {
    const lanes = new Set(view.lanes.map((l) => l.projectId));
    const items = new Map<string, LinkItem>();
    for (const i of view.items) if (lanes.has(i.projectId) && !items.has(i.ref)) items.set(i.ref, i);
    return items;
}

/** The distinct refs `item` waits on that are items of the view, never itself. */
const waitsOn = (item: LinkItem, items: ReadonlyMap<string, LinkItem>): string[] => [...new Set(item.after)].filter((a) => a !== item.ref && items.has(a));

/** How many links (arrows) the view has — the toggle's count. */
export function linkCount(view: LinksView): number {
    const items = itemsOf(view);
    let n = 0;
    for (const i of items.values()) n += waitsOn(i, items).length;
    return n;
}

/** Lay `view` out (see the module note); `highlighted` refs draw their arrows as the chain. */
export function linksLayout(view: LinksView, highlighted: ReadonlySet<string> = new Set()): LinksLayout {
    const items = itemsOf(view);
    const lanes = view.lanes.filter((l, i) => view.lanes.findIndex((m) => m.projectId === l.projectId) === i && [...items.values()].some((it) => it.projectId === l.projectId));
    const laneOf = new Map(lanes.map((l, i) => [l.projectId, i]));

    const cols = new Map<string, number>();
    const taken = new Set<string>();
    const visiting = new Set<string>();
    const place = (ref: string): number => {
        const known = cols.get(ref);
        if (known !== undefined) return known;
        // A cycle closes here: this edge adds no column.
        if (visiting.has(ref)) return -1;
        visiting.add(ref);
        const item = items.get(ref)!;
        let col = 0;
        for (const a of waitsOn(item, items)) col = Math.max(col, place(a) + 1);
        const lane = laneOf.get(item.projectId)!;
        while (taken.has(`${lane}:${col}`)) col += 1;
        taken.add(`${lane}:${col}`);
        visiting.delete(ref);
        cols.set(ref, col);
        return col;
    };
    for (const ref of items.keys()) place(ref);

    const nodes: LinksNode[] = [...items.values()].map((i) => {
        const lane = laneOf.get(i.projectId)!;
        const col = cols.get(i.ref)!;
        return { ref: i.ref, lane, col, x: LINKS_COL_X + col * (LINKS_NODE_W + LINKS_COL_GAP), y: lane * LINKS_LANE_H + LINKS_NODE_TOP };
    });
    const at = new Map(nodes.map((n) => [n.ref, n]));

    const edges: LinksEdge[] = [];
    for (const item of items.values()) {
        const to = at.get(item.ref)!;
        for (const a of waitsOn(item, items)) {
            const from = at.get(a)!;
            const x1 = from.x + LINKS_NODE_W;
            const y1 = from.y + LINKS_ANCHOR_Y;
            const x2 = to.x;
            const y2 = to.y + LINKS_ANCHOR_Y;
            const mid = (x1 + x2) / 2;
            edges.push({
                from: a,
                to: item.ref,
                d: `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2 - LINKS_HEAD + 2} ${y2}`,
                head: `M${x2 - LINKS_HEAD} ${y2 - 4} L${x2} ${y2} L${x2 - LINKS_HEAD} ${y2 + 4}`,
                highlighted: highlighted.has(a) && highlighted.has(item.ref)
            });
        }
    }

    const maxCol = Math.max(0, ...nodes.map((n) => n.col));
    return {
        lanes: lanes.map((l, i) => ({ ...l, y: i * LINKS_LANE_H })),
        nodes,
        edges,
        width: LINKS_COL_X + (maxCol + 1) * (LINKS_NODE_W + LINKS_COL_GAP) - LINKS_COL_GAP + LINKS_PAD,
        height: lanes.length * LINKS_LANE_H
    };
}

/** The view's milestones and releases, in order — what can be selected. */
export const milestonesOf = (view: LinksView): LinkItem[] => [...itemsOf(view).values()].filter((i) => i.milestone);

/**
 * `ref`'s chain: every item it transitively waits on, then itself, in the order they unblock — by column, then lane.
 * Empty when `ref` is not in the view.
 */
export function chainOf(view: LinksView, ref: string): LinkItem[] {
    const items = itemsOf(view);
    if (!items.has(ref)) return [];
    const seen = new Set<string>();
    const walk = (r: string): void => {
        if (seen.has(r)) return;
        seen.add(r);
        for (const a of waitsOn(items.get(r)!, items)) walk(a);
    };
    walk(ref);
    const layout = linksLayout(view);
    const order = new Map(layout.nodes.map((n) => [n.ref, n]));
    return [...seen]
        .sort((a, b) => order.get(a)!.col - order.get(b)!.col || order.get(a)!.lane - order.get(b)!.lane)
        .map((r) => items.get(r)!);
}

/** The view as a stacked list (below 768px): one chain per item nothing in the view waits on, in view order. */
export function linkChains(view: LinksView): { readonly end: LinkItem; readonly steps: LinkItem[] }[] {
    const items = itemsOf(view);
    const waitedOn = new Set([...items.values()].flatMap((i) => waitsOn(i, items)));
    return [...items.values()].filter((i) => !waitedOn.has(i.ref)).map((end) => ({ end, steps: chainOf(view, end.ref) }));
}

/** The toggle's labels: `Open 4`, `Done 11`. */
export const toggleLabel = (which: 'open' | 'done', view: LinksView): string => `${which === 'open' ? 'Open' : 'Done'} ${linkCount(view)}`;
