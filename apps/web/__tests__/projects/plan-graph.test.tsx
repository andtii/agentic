/**
 * The Plan graph (#756, PRJ-13): `planDepths` / `planGraphLayout` — columns by `after` depth, phase lanes, arrows —
 * and the view on mock data with its plan switcher.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Plan, PlanItem, ProjectId } from '@agentic/core';
import { setDataMode } from '../../src/data-mode';
import { GRAPH_COL_GAP, GRAPH_LANE_HEAD, GRAPH_NODE_H, GRAPH_NODE_W, GRAPH_PAD, GRAPH_ROW_GAP, planDepths, planGraphLayout } from '../../src/pages/projects/features/plan/graph/layout';
import { PlanGraph } from '../../src/pages/projects/features/plan/graph/PlanGraph';
import { PROJECTS } from '../../src/mock/workspace';
import { mountAt } from '../pages/helpers';
import { mountRoute, tick } from '../pages/mount';

const item = (id: number, after: number[] = [], state: PlanItem['state'] = 'ready'): PlanItem => ({ id, title: `Item ${id}`, state, after, touches: [], refs: [], doneWhen: [], activity: [] });
const plan = (...phases: PlanItem[][]): Plan => ({ id: 'p', projectId: 'p_x' as ProjectId, title: 'P', phases: phases.map((items, i) => ({ n: i + 1, title: `Phase ${i + 1}`, items })) });

describe('planDepths (#756)', () => {
    it('puts an item one column past the deepest item it waits on', () => {
        const d = planDepths(plan([item(1), item(2, [1]), item(3, [1, 2]), item(4)]));
        expect(Object.fromEntries(d)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 0 });
    });

    it('counts `after` across phases and ignores numbers not in the plan', () => {
        const d = planDepths(plan([item(1)], [item(2, [1, 99])]));
        expect(d.get(2)).toBe(1);
        expect(planDepths(plan([item(5, [99])])).get(5)).toBe(0);
    });

    it('ends on a cycle and on a self-reference', () => {
        const d = planDepths(plan([item(1, [2]), item(2, [1]), item(3, [3])]));
        expect(d.size).toBe(3);
        expect(d.get(3)).toBe(0);
        expect(new Set([d.get(1), d.get(2)])).toEqual(new Set([0, 1]));
    });
});

describe('planGraphLayout (#756)', () => {
    it('places nodes by column and lane slot, lanes stacked in phase order', () => {
        const g = planGraphLayout(plan([item(1), item(2), item(3, [1])], [item(4, [3])]));
        const at = (id: number) => g.nodes.find((n) => n.id === id)!;
        expect(at(1)).toMatchObject({ phase: 1, depth: 0, slot: 0, x: GRAPH_PAD, y: GRAPH_PAD + GRAPH_LANE_HEAD });
        expect(at(2)).toMatchObject({ depth: 0, slot: 1, y: GRAPH_PAD + GRAPH_LANE_HEAD + GRAPH_NODE_H + GRAPH_ROW_GAP });
        expect(at(3)).toMatchObject({ depth: 1, slot: 0, x: GRAPH_PAD + GRAPH_NODE_W + GRAPH_COL_GAP });
        expect(at(4)).toMatchObject({ phase: 2, depth: 2, slot: 0 });

        const lane1 = GRAPH_LANE_HEAD + 2 * GRAPH_NODE_H + GRAPH_ROW_GAP + GRAPH_PAD;
        expect(g.lanes).toEqual([
            { phase: 1, title: 'Phase 1', y: GRAPH_PAD, height: lane1 },
            { phase: 2, title: 'Phase 2', y: GRAPH_PAD + lane1, height: GRAPH_LANE_HEAD + GRAPH_NODE_H + GRAPH_PAD }
        ]);
        expect(at(4).y).toBe(GRAPH_PAD + lane1 + GRAPH_LANE_HEAD);
        expect(g.width).toBe(GRAPH_PAD + 2 * (GRAPH_NODE_W + GRAPH_COL_GAP) + GRAPH_NODE_W + GRAPH_PAD);
        expect(g.height).toBe(GRAPH_PAD + lane1 + g.lanes[1]!.height + GRAPH_PAD);
    });

    it('draws one arrow per `after` inside the plan, right edge to left edge, marked done when the first item is', () => {
        const g = planGraphLayout(plan([item(1, [], 'done'), item(2, [1, 1, 99]), item(3, [2])]));
        expect(g.edges.map((e) => [e.from, e.to, e.done])).toEqual([[1, 2, true], [2, 3, false]]);
        const n1 = g.nodes.find((n) => n.id === 1)!;
        const n2 = g.nodes.find((n) => n.id === 2)!;
        expect(g.edges[0]!.d.startsWith(`M${n1.x + GRAPH_NODE_W} ${n1.y + GRAPH_NODE_H / 2} `)).toBe(true);
        expect(g.edges[0]!.d.endsWith(` ${n2.x} ${n2.y + GRAPH_NODE_H / 2}`)).toBe(true);
    });

    it('cuts a cycle where it closes: no arrow points left or stays in its column', () => {
        const g = planGraphLayout(plan([item(1, [2]), item(2, [1]), item(3, [3])]));
        expect(g.edges).toHaveLength(1);
        const [e] = g.edges;
        const depth = (id: number) => g.nodes.find((n) => n.id === id)!.depth;
        expect(depth(e!.from)).toBeLessThan(depth(e!.to));
    });

    it('sorts lanes by phase number, gives an empty phase a lane and draws an empty plan as nothing', () => {
        const p: Plan = { id: 'p', projectId: 'p_x' as ProjectId, title: 'P', phases: [{ n: 2, title: 'B', items: [item(2)] }, { n: 1, title: 'A', items: [] }] };
        const g = planGraphLayout(p);
        expect(g.lanes.map((l) => l.phase)).toEqual([1, 2]);
        expect(g.nodes[0]).toMatchObject({ id: 2, phase: 2 });
        expect(planGraphLayout(plan()).nodes).toEqual([]);
    });
});

describe('the Plan graph view (#756)', () => {
    afterEach(() => setDataMode('mock'));

    const nodes = (dom: ParentNode): string[] => [...dom.querySelectorAll('[data-plan-graph-node]')].map((n) => n.getAttribute('data-plan-graph-node')!);

    it('draws the first plan of the project on mock data: lanes, nodes with state glyphs, arrows', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan?view=graph');
        expect(dom.querySelector('[data-plan-switcher-title]')?.textContent).toBe('Projects redesign');
        expect(dom.querySelectorAll('[data-plan-graph-lane]')).toHaveLength(3);
        expect(nodes(dom)).toContain('47');
        const blocked = dom.querySelector('[data-plan-graph-node="46"]')!;
        expect(blocked.getAttribute('data-state')).toBe('blocked');
        expect(blocked.querySelector('[data-ag-project="item-glyph"]')?.getAttribute('aria-label')).toBe('Blocked');
        expect(blocked.querySelector('[data-plan-graph-node-after]')?.textContent).toBe('after #45');
        expect(dom.querySelector('[data-plan-graph-edge="45-47"]')).not.toBeNull();
        expect(dom.querySelector('[data-plan-graph-edge="41-42"]')?.hasAttribute('data-done')).toBe(true);
    });

    it('switches plans and makes a new one from the switcher', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan?view=graph');
        (dom.querySelector('[data-plan-switcher]') as HTMLElement).click();
        await tick();
        const options = [...document.querySelectorAll<HTMLElement>('[data-plan-option]')];
        expect(options.map((o) => o.textContent?.trim())).toEqual(['Projects redesign', 'Release 0.4']);
        expect(options[0]!.getAttribute('aria-current')).toBe('true');
        options[1]!.click();
        await tick();
        expect(dom.querySelector('[data-plan-switcher-title]')?.textContent).toBe('Release 0.4');
        expect(nodes(dom)).toEqual(['60', '61']);

        (dom.querySelector('[data-plan-switcher]') as HTMLElement).click();
        await tick();
        (document.querySelector('[data-plan-new]') as HTMLButtonElement).click();
        await tick();
        expect(dom.querySelector('[data-plan-switcher-title]')?.textContent).toBe('Untitled plan 1');
        expect(dom.querySelector('[data-plan-graph-empty]')?.textContent).toBe('No items in this plan yet.');
    });

    it('says there are no plans live, where there is no plan store yet, and cannot make one', async () => {
        setDataMode('live');
        const dom = await mountAt('/projects/p_agentic/plan?view=graph', <PlanGraph project={PROJECTS[0]!} />);
        expect(dom.querySelector('[data-plan-graph-empty]')?.textContent).toBe('No plans yet.');
        expect(dom.querySelector('[data-plan-switcher-title]')?.textContent).toBe('No plan');
        (dom.querySelector('[data-plan-switcher]') as HTMLElement).click();
        await tick();
        expect((document.querySelector('[data-plan-new]') as HTMLButtonElement).disabled).toBe(true);
    });
});
