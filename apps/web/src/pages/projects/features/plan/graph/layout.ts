/**
 * The Plan graph's layout (#756, PRJ-13): items as nodes, `after` as arrows, one plan at a time. Pure, so it is
 * unit-tested without a DOM.
 *
 * Columns are `after` depth across the whole plan — an item with nothing before it sits in column 0, any other one
 * column past the deepest item it waits on — so every arrow points right. Rows are phase lanes, one horizontal band
 * per phase in phase order; inside a lane the items of one column stack in the phase's own order, and a lane is as tall
 * as its tallest column. `after` numbers that are not items of this plan (another plan's, or unknown) draw no arrow and
 * add no depth; a cycle is cut where it closes so the layout always ends.
 */
import type { Plan, PlanItemState } from '@agentic/core';

export const GRAPH_NODE_W = 208;
export const GRAPH_NODE_H = 44;
/** Between two columns: room for the arrows. */
export const GRAPH_COL_GAP = 56;
/** Between two nodes stacked in one lane column. */
export const GRAPH_ROW_GAP = 10;
/** The lane's title band above its nodes. */
export const GRAPH_LANE_HEAD = 28;
/** Padding inside a lane, under its nodes, and around the whole graph. */
export const GRAPH_PAD = 16;

export interface GraphNode {
    readonly id: number;
    readonly title: string;
    readonly state: PlanItemState;
    /** The phase (`PlanPhase.n`) whose lane holds the node. */
    readonly phase: number;
    /** Column: 0 for no `after` in this plan, else 1 + the deepest `after`. */
    readonly depth: number;
    /** Position inside its lane column, 0 first. */
    readonly slot: number;
    readonly x: number;
    readonly y: number;
}

export interface GraphEdge {
    /** The item that must be done first. */
    readonly from: number;
    /** The item waiting on it. */
    readonly to: number;
    /** Whether `from` is done — the arrow no longer holds anything up. */
    readonly done: boolean;
    /** SVG path: from `from`'s right edge to `to`'s left edge. */
    readonly d: string;
}

export interface GraphLane {
    readonly phase: number;
    readonly title: string;
    readonly y: number;
    readonly height: number;
}

export interface PlanGraphLayout {
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly GraphEdge[];
    readonly lanes: readonly GraphLane[];
    readonly width: number;
    readonly height: number;
}

/** Each item's column: its `after` depth inside `plan` (see the module note). */
export function planDepths(plan: Pick<Plan, 'phases'>): Map<number, number> {
    const items = new Map(plan.phases.flatMap((p) => p.items.map((i) => [i.id, i] as const)));
    const depths = new Map<number, number>();
    const visiting = new Set<number>();
    const depthOf = (id: number): number => {
        const known = depths.get(id);
        if (known !== undefined) return known;
        // A cycle closes here: this edge adds no depth.
        if (visiting.has(id)) return -1;
        visiting.add(id);
        let d = 0;
        for (const a of items.get(id)?.after ?? []) {
            if (a !== id && items.has(a)) d = Math.max(d, depthOf(a) + 1);
        }
        visiting.delete(id);
        depths.set(id, d);
        return d;
    };
    for (const id of items.keys()) depthOf(id);
    return depths;
}

/** Lay `plan` out as lanes, nodes and arrows in px (see the module note). */
export function planGraphLayout(plan: Pick<Plan, 'phases'>): PlanGraphLayout {
    const depths = planDepths(plan);
    const phases = [...plan.phases].sort((a, b) => a.n - b.n);
    const colX = (depth: number): number => GRAPH_PAD + depth * (GRAPH_NODE_W + GRAPH_COL_GAP);

    const nodes: GraphNode[] = [];
    const lanes: GraphLane[] = [];
    let y = GRAPH_PAD;
    let maxDepth = -1;
    for (const phase of phases) {
        const slots = new Map<number, number>();
        for (const item of phase.items) {
            // An id repeated across phases keeps its first node; arrows stay unambiguous.
            if (nodes.some((n) => n.id === item.id)) continue;
            const depth = depths.get(item.id) ?? 0;
            const slot = slots.get(depth) ?? 0;
            slots.set(depth, slot + 1);
            maxDepth = Math.max(maxDepth, depth);
            nodes.push({ id: item.id, title: item.title, state: item.state, phase: phase.n, depth, slot, x: colX(depth), y: y + GRAPH_LANE_HEAD + slot * (GRAPH_NODE_H + GRAPH_ROW_GAP) });
        }
        const rows = Math.max(1, ...slots.values());
        const height = GRAPH_LANE_HEAD + rows * GRAPH_NODE_H + (rows - 1) * GRAPH_ROW_GAP + GRAPH_PAD;
        lanes.push({ phase: phase.n, title: phase.title, y, height });
        y += height;
    }

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: GraphEdge[] = [];
    for (const phase of phases) {
        for (const item of phase.items) {
            const to = byId.get(item.id);
            if (!to || to.phase !== phase.n) continue;
            for (const a of new Set(item.after)) {
                const from = byId.get(a);
                // Only rightward arrows: an `after` that closes a cycle (not in an earlier column) is the cut edge.
                if (!from || from.depth >= to.depth) continue;
                const x1 = from.x + GRAPH_NODE_W;
                const y1 = from.y + GRAPH_NODE_H / 2;
                const x2 = to.x;
                const y2 = to.y + GRAPH_NODE_H / 2;
                const bend = Math.max(GRAPH_COL_GAP / 2, (x2 - x1) / 2);
                edges.push({ from: a, to: item.id, done: from.state === 'done', d: `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}` });
            }
        }
    }

    return {
        nodes,
        edges,
        lanes,
        width: colX(Math.max(maxDepth, 0)) + GRAPH_NODE_W + GRAPH_PAD,
        height: y + GRAPH_PAD
    };
}
