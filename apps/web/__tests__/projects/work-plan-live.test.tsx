/**
 * The Work view and the work item page read the project's Plan actor live (#882): a plan's items show as rows on
 * Work, and a plan-backed item's page carries its plan, phase and done-when checklist — on a real in-process host
 * with the Plan actor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PlanItem, ProjectId } from '@agentic/core';
import { definePlanActor, planKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { planItemsOf } from '../../src/pages/projects/work/live';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from '../pages/live-harness';

describe('planItemsOf (#882)', () => {
    it('flattens every plan, phase and item in order', () => {
        const item = (id: number): PlanItem => ({ id, title: `#${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [] });
        const plans = [
            { id: 'a', projectId: 'p' as ProjectId, title: 'A', phases: [{ n: 1, title: 'One', items: [item(1), item(2)] }, { n: 2, title: 'Two', items: [item(3)] }] },
            { id: 'b', projectId: 'p' as ProjectId, title: 'B', phases: [{ n: 1, title: 'One', items: [item(4)] }] }
        ];
        expect(planItemsOf(plans).map((i) => i.id)).toEqual([1, 2, 3, 4]);
        expect(planItemsOf([])).toEqual([]);
    });
});

describe('Work and the work item page on the live Plan (#882)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan] });
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    it('shows plan items as Work rows and a plan-backed item page with its plan, phase and done-when', { timeout: 30_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const { id: projectId } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const store = h.app.as(owner).actor(Plan, planKey(WS, projectId as ProjectId));
        const plan = await store.create({
            title: 'Mobile pass',
            phases: [
                { title: 'Shell', items: [{ title: 'Collapse the rail', doneWhen: ['Rail hides under 720px', 'Toggle keeps focus'] }] },
                { title: 'Drawer', items: [{ title: 'Swipe to close' }, { title: 'Still open' }] }
            ]
        });
        const [first, second] = plan.phases.flatMap((p) => p.items);
        // A decision for you and a stuck item show on Work; an open item stays on the Plan.
        await store.update(first!.id, { state: 'needs-you', note: 'Which breakpoint?' });
        await store.update(second!.id, { state: 'stuck', note: 'Gesture API missing' });

        const work = await mountLive(`/projects/${projectId}/work`, h);
        const rows = () => [...work.querySelectorAll<HTMLElement>('[data-work-row]')];
        await until(() => rows().length === 2, 'the plan items on Work', 10_000);
        expect(rows().map((r) => r.getAttribute('data-work-row')).sort()).toEqual([`item:${first!.id}`, `item:${second!.id}`].sort());
        expect(texts(rows().map((r) => r.querySelector('[data-work-ref]')!)).sort()).toEqual([`#${first!.id}`, `#${second!.id}`].sort());

        const dom = await mountLive(`/projects/${projectId}/work/item:${first!.id}`, h);
        const page = () => dom.querySelector<HTMLElement>('[data-page="project-work-item"]');
        await until(() => page()?.querySelector('[data-plan-backed="true"]') !== null && page()?.querySelector('[data-link="plan"]') !== null, 'the plan-backed item page', 10_000);
        expect(page()!.querySelector('[data-work-item-title]')?.textContent).toBe('Collapse the rail');
        expect(page()!.querySelector('[data-link="plan"]')?.textContent).toBe(`Mobile pass · Phase 1 · Shell · #${first!.id}`);
        expect(texts([...page()!.querySelectorAll('[data-checked]')])).toEqual(['Rail hides under 720px', 'Toggle keeps focus']);
    });
});
