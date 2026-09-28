/**
 * After and Touches on the Plan page, live (#1074): Add item sends them with the title (`Plan.add`) and the list
 * shows both; the item detail edits them (`Plan.after`, `Plan.touches`), writing only what changed — on a real
 * in-process host with the Plan actor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PlanItem, ProjectId, ProjectRecord } from '@agentic/core';
import { definePlanActor, planKey, Workspace, workspaceKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { PlanList } from '../../src/pages/projects/features/plan/list/PlanList';
import { saveProjectWith } from '../../src/pages/projects/live';
import { tick } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from '../pages/live-harness';

/** Type `value` into the field named `name` (an input or a textarea). */
async function type(root: ParentNode, name: string, value: string): Promise<void> {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`input[name="${name}"], textarea[name="${name}"]`);
    if (!el) throw new Error(`no field ${name}`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
}

describe('after and touches on the Plan page (#1074)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan] });
    });
    afterEach(async () => {
        await h.stop();
    });

    it('adds an item with after and touches, the list shows both, and the detail edits them', { timeout: 30_000 }, async () => {
        const forge = await h.agent('Forge', 'Manages the plan');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const projectId = id as ProjectId;
        const project = (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).projects()).find((p) => p.id === projectId)! as ProjectRecord;
        const store = h.app.as(owner).actor(Plan, planKey(WS, projectId));
        await store.create({ title: 'Mobile pass', phases: [{ title: 'Shell', items: [{ title: 'Collapse the rail' }, { title: 'Hide the header' }] }] });
        // #1 done, so the new item is not blocked and its row names both (a blocked row names what it waits on only); #2 keeps the phase open.
        await store.update(1, { state: 'done' });
        const items = async (): Promise<PlanItem[]> => (await store.list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items));

        const dom = await mountLive(`/projects/${project.id}/plan`, h, <PlanList project={project} />);
        const titles = () => texts(dom.querySelectorAll('[data-plan-item-title]'));
        await until(() => titles().includes('Hide the header'), 'the plan item in the list', 10_000);

        dom.querySelector<HTMLButtonElement>('[data-plan-add] button')!.click();
        await tick();
        const form = dom.querySelector<HTMLFormElement>('[data-plan-add-form]')!;
        expect(form.textContent).toContain('Leave empty and the item runs alone');
        await type(form, 'plan-item-title', 'Swipe to close');
        // A wrong After says so and holds the Add back.
        await type(form, 'plan-item-after', 'nope');
        expect(form.textContent).toContain('After takes #n or project#n');
        expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
        await type(form, 'plan-item-after', '#1');
        await type(form, 'plan-item-touches', 'apps/web/src/shell/\npackages/ui/src/rail.ts');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => (await items()).some((i) => i.title === 'Swipe to close'), 'the added item in the store', 10_000);
        const added = (await items()).find((i) => i.title === 'Swipe to close')!;
        expect(added.after).toEqual([1]);
        expect(added.touches).toEqual(['apps/web/src/shell/', 'packages/ui/src/rail.ts']);
        const meta = () => dom.querySelector(`[data-plan-item="${added.id}"] [data-plan-item-meta]`)?.textContent ?? '';
        await until(() => meta().includes('after #1') && meta().includes('touches 2 paths'), 'after and touches in the list', 10_000);

        // Edit them on the detail panel.
        dom.querySelector<HTMLButtonElement>(`[data-plan-item="${added.id}"] [data-plan-row]`)!.click();
        await tick();
        const editButton = [...dom.querySelectorAll<HTMLButtonElement>('[data-plan-links-edit] button')][0]!;
        editButton.click();
        await tick();
        const edit = dom.querySelector<HTMLFormElement>('[data-plan-links-form]')!;
        expect(edit.querySelector<HTMLInputElement>(`input[name="plan-item-${added.id}-after"]`)!.value).toBe('#1');
        expect(edit.querySelector<HTMLTextAreaElement>(`textarea[name="plan-item-${added.id}-touches"]`)!.value).toBe('apps/web/src/shell/\npackages/ui/src/rail.ts');
        await type(edit, `plan-item-${added.id}-after`, '');
        await type(edit, `plan-item-${added.id}-touches`, 'apps/web/src/shell/');
        edit.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => {
            const it = (await items()).find((i) => i.id === added.id)!;
            return it.after.length === 0 && it.touches.length === 1;
        }, 'the edit in the store', 10_000);
        await until(() => dom.querySelector('[data-plan-links-form]') === null, 'the edit closed', 10_000);
        await until(() => meta() === 'touches src/shell', 'the new touches in the list', 10_000);

        // Clearing touches: the item runs alone, and the detail says so.
        dom.querySelector<HTMLButtonElement>('[data-plan-links-edit] button')!.click();
        await tick();
        await type(dom, `plan-item-${added.id}-touches`, '');
        dom.querySelector<HTMLFormElement>('[data-plan-links-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => (await items()).find((i) => i.id === added.id)!.touches.length === 0, 'touches cleared in the store', 10_000);
        await until(() => (dom.querySelector('[data-plan-detail] [data-fact="touches"]')?.textContent ?? '').includes('runs alone'), 'runs alone on the detail', 10_000);
    });
});
