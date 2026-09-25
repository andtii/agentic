import type { AgentId, PlanItem } from '../src/index';
import { PLAN_LEASE_DEFAULT_MS, PLAN_READ_TOOLS, PLAN_TOOLS, planClaimLive, planDoneWhenMet, planItems, planItemWaitsOn, planTouchesOverlap } from '../src/index';

const item = (id: number, state: PlanItem['state'], after: number[] = []): PlanItem => ({
    id,
    title: `item ${id}`,
    state,
    after,
    touches: [],
    refs: [],
    doneWhen: [],
    activity: [],
});

describe('plan (#748)', () => {
    it('names the eight plan tools and a 30 minute lease', () => {
        expect(PLAN_TOOLS).toEqual(['plan_list', 'plan_next', 'plan_claim', 'plan_assign', 'plan_update', 'plan_ref', 'plan_add', 'plan_handoff']);
        expect(PLAN_READ_TOOLS.every((t) => PLAN_TOOLS.includes(t))).toBe(true);
        expect(PLAN_LEASE_DEFAULT_MS).toBe(30 * 60 * 1000);
    });

    it('flattens items phase by phase', () => {
        const plan = { phases: [{ n: 1, title: 'a', items: [item(1, 'done'), item(2, 'ready')] }, { n: 2, title: 'b', items: [item(3, 'ready')] }] };
        expect(planItems(plan).map((i) => i.id)).toEqual([1, 2, 3]);
    });

    it('lists the after items still open', () => {
        const items = [item(8, 'done'), item(9, 'claimed')];
        expect(planItemWaitsOn(item(11, 'blocked', [8, 9, 99]), items)).toEqual([9, 99]);
        expect(planItemWaitsOn(item(10, 'ready', [8]), items)).toEqual([]);
    });

    it('checks a claim lease against now', () => {
        const claim = { agentId: 'a' as AgentId, leaseUntil: 1000 };
        expect(planClaimLive(claim, 999)).toBe(true);
        expect(planClaimLive(claim, 1000)).toBe(false);
        expect(planClaimLive(undefined, 0)).toBe(false);
    });

    it('is done when every done-when line is ticked', () => {
        expect(planDoneWhenMet([{ text: 'a', checked: true }, { text: 'b', checked: true }])).toBe(true);
        expect(planDoneWhenMet([{ text: 'a', checked: true }, { text: 'b', checked: false }])).toBe(false);
        expect(planDoneWhenMet([])).toBe(false);
    });

    it('finds overlapping touches', () => {
        expect(planTouchesOverlap('plugins/model.ts', 'plugins/model.ts')).toBe(true);
        expect(planTouchesOverlap('packages/core/', 'packages/core/src/plan.ts')).toBe(true);
        expect(planTouchesOverlap('packages/core/**', 'packages/core/src/plan.ts')).toBe(true);
        expect(planTouchesOverlap('./a\\b.ts', 'a/b.ts')).toBe(true);
        expect(planTouchesOverlap('packages/core', 'packages/core-x/a.ts')).toBe(false);
        expect(planTouchesOverlap('a/b.ts', 'a/c.ts')).toBe(false);
    });
});
