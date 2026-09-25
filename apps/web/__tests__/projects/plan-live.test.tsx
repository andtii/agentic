/**
 * The Plan views read and write the project's Plan actor live (#926): the list shows its items, Add item is `add`,
 * ticking done-when and commenting are `update`, a board drop is `assign`, New plan is `create`, the Overview card
 * reads the same plans, and a refusal shows as the page's note — on a real in-process host with the Plan actor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, PlanActor, PlanItem, ProjectId, ProjectRecord } from '@agentic/core';
import { definePlanActor, planKey, Workspace, workspaceKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { PlanBoard } from '../../src/pages/projects/features/plan/board/PlanBoard';
import { assignIndex, boardColumns } from '../../src/pages/projects/features/plan/board/model';
import { PlanGraph } from '../../src/pages/projects/features/plan/graph/PlanGraph';
import { PlanList } from '../../src/pages/projects/features/plan/list/PlanList';
import { planFailureNote } from '../../src/pages/projects/features/plan/shared/data';
import { PlanOverviewCard } from '../../src/pages/projects/features/plan/shared/parts';
import { saveProjectWith } from '../../src/pages/projects/live';
import { tick } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from '../pages/live-harness';

const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `#${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });

describe('assignIndex (#926)', () => {
    const forge: PlanActor = { kind: 'agent', agentId: 'forge' as AgentId };
    const items = [item(1, { assignee: forge, queueIndex: 0 }), item(2, { assignee: forge, queueIndex: 1 }), item(3, { assignee: forge, queueIndex: 2 }), item(4)];
    const cols = boardColumns(items, { agentIds: ['forge' as AgentId], coordinator: null }, 0);
    it('counts one place less when a card moves down its own queue', () => {
        expect(assignIndex(items[0]!, { column: 'agent:forge', index: 3 }, cols)).toBe(2);
        expect(assignIndex(items[2]!, { column: 'agent:forge', index: 0 }, cols)).toBe(0);
    });
    it('keeps the slot for a card from another column', () => {
        expect(assignIndex(items[3]!, { column: 'agent:forge', index: 1 }, cols)).toBe(1);
    });
    it('names the refusal without the actor prefix', () => {
        expect(planFailureNote('add the item', new Error('[plan] a plan title is too long'))).toBe('Could not add the item: a plan title is too long');
    });
});

describe('the Plan views on the live Plan store (#926)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan] });
    });
    afterEach(async () => {
        await h.stop();
    });

    const setUp = async () => {
        const forge = await h.agent('Forge', 'Manages the plan');
        const scout = await h.agent('Scout', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge, scout], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const projectId = id as ProjectId;
        const project = (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).projects()).find((p) => p.id === projectId)! as ProjectRecord;
        const store = h.app.as(owner).actor(Plan, planKey(WS, projectId));
        const plan = await store.create({ title: 'Mobile pass', phases: [{ title: 'Shell', items: [{ title: 'Collapse the rail', doneWhen: ['Rail hides under 720px'] }] }] });
        const first = plan.phases[0]!.items[0]!;
        const items = async (): Promise<PlanItem[]> => (await store.list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items));
        return { forge, scout, projectId, project, store, plan, first, items };
    };

    it('lists the items, adds one, ticks done-when, comments, and shows a refusal as the note', { timeout: 30_000 }, async () => {
        const { project, first, items } = await setUp();
        const dom = await mountLive(`/projects/${project.id}/plan`, h, <PlanList project={project} />);
        const titles = () => texts(dom.querySelectorAll('[data-plan-item-title]'));
        await until(() => titles().includes('Collapse the rail'), 'the plan item in the list', 10_000);
        expect(dom.querySelector('[data-plan-title]')?.textContent).toBe('Mobile pass');

        // Add item: the actor's `add`.
        const addButton = dom.querySelector<HTMLButtonElement>('[data-plan-add] button')!;
        expect(addButton.disabled).toBe(false);
        addButton.click();
        await tick();
        const type = async (value: string): Promise<void> => {
            const input = dom.querySelector<HTMLInputElement>('[data-plan-add-form] input')!;
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await tick();
            dom.querySelector<HTMLFormElement>('[data-plan-add-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        };
        await type('Swipe to close');
        await until(async () => (await items()).some((i) => i.title === 'Swipe to close'), 'the added item in the store', 10_000);
        await until(() => titles().includes('Swipe to close'), 'the added item in the list', 10_000);

        // A refusal from the actor shows as the note.
        dom.querySelector<HTMLButtonElement>('[data-plan-add] button')!.click();
        await tick();
        await type('x'.repeat(201));
        await until(() => dom.querySelector('[data-plan-note]') !== null, 'the refusal note', 10_000);
        expect(dom.querySelector('[data-plan-note]')!.textContent).toMatch(/^Could not add the item: /);

        // Tick done-when and comment: the actor's `update`.
        dom.querySelector<HTMLButtonElement>(`[data-plan-item="${first.id}"] [data-plan-row]`)!.click();
        await tick();
        const box = dom.querySelector<HTMLInputElement>('[data-plan-done-when] input[type="checkbox"]')!;
        expect(box.disabled).toBe(false);
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await until(async () => (await items()).find((i) => i.id === first.id)!.doneWhen[0]!.checked, 'the ticked line in the store', 10_000);

        const comment = dom.querySelector<HTMLInputElement>('[data-plan-comment] input')!;
        comment.value = 'Looks right on the phone';
        comment.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect(dom.querySelector<HTMLButtonElement>('[data-plan-comment] button[type="submit"]')!.disabled).toBe(false);
        dom.querySelector<HTMLFormElement>('[data-plan-comment]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => (await items()).find((i) => i.id === first.id)!.activity.some((a) => a.text.includes('Looks right on the phone')), 'the comment in the store', 10_000);
    });

    it('a board drop assigns the item in the store', { timeout: 30_000 }, async () => {
        const { scout, project, first, items } = await setUp();
        const dom = await mountLive(`/projects/${project.id}/plan?view=board`, h, <PlanBoard project={project} />);
        const card = () => dom.querySelector<HTMLElement>(`[data-plan-card="${first.id}"]`);
        await until(() => card() !== null, 'the card on the board', 10_000);
        const key = async (k: string): Promise<void> => {
            card()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
            await tick();
        };
        await key(' ');
        await key('ArrowRight');
        await key(' ');
        await until(async () => {
            const a = (await items()).find((i) => i.id === first.id)!.assignee;
            return a?.kind === 'agent' && a.agentId === scout;
        }, 'the item assigned to Scout', 10_000);
        await until(() => dom.querySelector(`[data-plan-board-column="agent:${scout}"] [data-plan-card="${first.id}"]`) !== null, 'the card in Scout’s column', 10_000);
    });

    it('New plan in the graph creates one, and the Overview card reads the plan', { timeout: 30_000 }, async () => {
        const { project, store } = await setUp();
        const dom = await mountLive(`/projects/${project.id}/plan?view=graph`, h, <PlanGraph project={project} />);
        await until(() => dom.querySelector('[data-plan-switcher-title]')?.textContent === 'Mobile pass', 'the live plan in the switcher', 10_000);
        (dom.querySelector('[data-plan-switcher]') as HTMLElement).click();
        await tick();
        const create = document.querySelector<HTMLButtonElement>('[data-plan-new]')!;
        expect(create.disabled).toBe(false);
        create.click();
        await until(async () => (await store.list()).plans.length === 2, 'the new plan in the store', 10_000);
        await until(() => dom.querySelector('[data-plan-switcher-title]')?.textContent === 'Untitled plan 2', 'the new plan picked', 10_000);

        const card = await mountLive(`/projects/${project.id}`, h, <PlanOverviewCard project={project} />);
        await until(() => card.querySelector('[data-plan-card-item]') !== null, 'the next item on the card', 10_000);
        expect(card.querySelector('[data-plan-card-done]')?.textContent).toBe('0 of 1 done');
    });
});
