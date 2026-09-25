/**
 * A plan-backed work item page on the live Plan actor shows the item's refs and its History (#890): refs added through
 * `ref` appear as chips, and every change the store recorded appears as a History line, newest first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectId } from '@agentic/core';
import { definePlanActor, planKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from '../pages/live-harness';

describe('the work item page refs and History on the live Plan (#890)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan] });
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    it('renders the refs added to a plan item and its History lines', { timeout: 30_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const { id: projectId } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const store = h.app.as(owner).actor(Plan, planKey(WS, projectId as ProjectId));
        const plan = await store.create({ title: 'Mobile pass', phases: [{ title: 'Shell', items: [{ title: 'Collapse the rail' }] }] });
        const item = plan.phases[0]!.items[0]!;
        await store.ref(item.id, 'pr:604');
        await store.ref(item.id, 'https://example.com/spec');
        // A decision for you puts the item on Work, so the page finds it.
        await store.update(item.id, { state: 'needs-you', note: 'Which breakpoint?' });
        const history = (await store.get(plan.id)).phases[0]!.items[0]!.activity;
        expect(history.length).toBeGreaterThanOrEqual(3);

        const dom = await mountLive(`/projects/${projectId}/work/item:${item.id}`, h);
        const page = () => dom.querySelector<HTMLElement>('[data-page="project-work-item"]');
        await until(() => page()?.querySelector('[data-work-item-refs]') !== null, 'the plan-backed item page with its refs', 10_000);
        const refs = [...page()!.querySelectorAll<HTMLElement>('[data-work-item-ref]')];
        expect(refs.map((r) => r.dataset['workItemRef'])).toEqual(['pr', 'url']);
        expect(refs[0]!.querySelector('a')?.getAttribute('href')).toBe(`/projects/${projectId}/work/pr:604`);
        expect(refs[1]!.querySelector('a')?.getAttribute('href')).toBe('https://example.com/spec');
        const lines = texts([...page()!.querySelectorAll('[data-work-item-activity] [data-activity-line]')]);
        expect(lines).toHaveLength(history.length);
        expect(lines.some((l) => l.includes('ref pr:604'))).toBe(true);
        expect(lines.at(-1)).toContain(history[0]!.text);
    });
});
