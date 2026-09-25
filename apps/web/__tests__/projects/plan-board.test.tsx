/**
 * The Plan board (#755, PRJ-13): the column and drop rules as pure functions, and the board on mock data — columns
 * by agent with limits, done hidden, keyboard and pointer drag, and the handoff note when a worked card moves.
 */
import { describe, it, expect } from 'vitest';
import type { AgentId, PlanActor, PlanItem, ProjectMembers } from '@agentic/core';
import { boardColumns, cardMeta, columnOf, doneCount, isNoop, moveItem, needsHandoff, startSlot, stepSlot } from '../../src/pages/projects/features/plan/board/model';
import { boardFixture } from '../../src/pages/projects/features/plan/board/fixture';
import { mountRoute, tick } from '../pages/mount';

const agent = (id: string): PlanActor => ({ kind: 'agent', agentId: id as AgentId });
const YOU: PlanActor = { kind: 'user', userId: 'me' };
const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `Item ${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });
const members: ProjectMembers = { agentIds: ['forge', 'lint', 'atlas'] as AgentId[], coordinator: 'atlas' as AgentId, limits: { ['lint' as AgentId]: 2 } };
const ids = (xs: readonly PlanItem[]): number[] => xs.map((i) => i.id);

const sample = (): PlanItem[] => [
    item(1, { state: 'done' }),
    item(2, { queueIndex: 1 }),
    item(3, { queueIndex: 0 }),
    item(4, { state: 'claimed', assignee: agent('forge'), claim: { agentId: 'forge' as AgentId, leaseUntil: 10 * 60_000 } }),
    item(5, { assignee: agent('forge'), queueIndex: 0 }),
    item(6, { assignee: agent('forge'), queueIndex: 1 }),
    item(7, { assignee: agent('scout'), queueIndex: 0 }),
    item(8, { state: 'needs-you', assignee: YOU, queueIndex: 0 })
];

describe('the Plan board rules (#755)', () => {
    it('columns are Not assigned, each member but an idle coordinator, other assignees, then You; done left out', () => {
        const cols = boardColumns(sample(), members);
        expect(cols.map((c) => c.key)).toEqual(['open', 'agent:forge', 'agent:lint', 'agent:scout', 'you']);
        const forge = cols[1]!;
        expect(ids(forge.working)).toEqual([4]);
        expect(ids(forge.queue)).toEqual([5, 6]);
        expect(forge.limit).toBe(1);
        expect(cols[2]!.limit).toBe(2);
        expect(ids(cols[0]!.queue)).toEqual([3, 2]);
        expect(cols[0]!.limit).toBeNull();
        expect(ids(cols[4]!.queue)).toEqual([8]);
        expect(doneCount(sample())).toBe(1);
        const busyAtlas = boardColumns([...sample(), item(9, { assignee: agent('atlas'), queueIndex: 0 })], members);
        expect(busyAtlas.map((c) => c.key)).toContain('agent:atlas');
    });

    it('a drop reorders within a queue and renumbers it', () => {
        const next = moveItem(sample(), 6, { column: 'agent:forge', index: 0 }, { you: YOU, at: 1 });
        expect(ids(boardColumns(next, members)[1]!.queue)).toEqual([6, 5]);
        expect(next.find((i) => i.id === 5)!.queueIndex).toBe(1);
    });

    it('a drop into another column assigns the item there and closes the gap it left', () => {
        const next = moveItem(sample(), 3, { column: 'agent:lint', index: 0 }, { you: YOU, at: 1 });
        const moved = next.find((i) => i.id === 3)!;
        expect(columnOf(moved)).toBe('agent:lint');
        expect(moved.assignedBy).toEqual(YOU);
        expect(next.find((i) => i.id === 2)!.queueIndex).toBe(0);
        const back = moveItem(next, 3, { column: 'open', index: 5 }, { you: YOU, at: 2 });
        expect(back.find((i) => i.id === 3)!.assignee).toBeUndefined();
        expect(back.find((i) => i.id === 3)!.assignedBy).toBeUndefined();
        expect(ids(boardColumns(back, members)[0]!.queue)).toEqual([2, 3]);
    });

    it('taking a worked item off its agent needs a handoff: the claim goes, it is ready, the note is in its history', () => {
        const items = sample();
        const worked = items.find((i) => i.id === 4)!;
        expect(needsHandoff(worked, { column: 'agent:scout', index: 0 })).toBe(true);
        expect(needsHandoff(items.find((i) => i.id === 5)!, { column: 'agent:scout', index: 0 })).toBe(false);
        const next = moveItem(items, 4, { column: 'agent:scout', index: 0 }, { you: YOU, at: 7, note: ' half done, see branch ' });
        const moved = next.find((i) => i.id === 4)!;
        expect(moved.claim).toBeUndefined();
        expect(moved.state).toBe('ready');
        expect(moved.activity).toEqual([{ at: 7, actor: YOU, text: 'Handoff: half done, see branch' }]);
        expect(ids(boardColumns(next, members)[3]!.queue)).toEqual([4, 7]);
    });

    it('a drop on the card’s own place, or a worked card in its own column, changes nothing', () => {
        const items = sample();
        const cols = boardColumns(items, members);
        const five = items.find((i) => i.id === 5)!;
        expect(isNoop(five, { column: 'agent:forge', index: 0 }, cols)).toBe(true);
        expect(isNoop(five, { column: 'agent:forge', index: 1 }, cols)).toBe(true);
        expect(isNoop(five, { column: 'agent:forge', index: 2 }, cols)).toBe(false);
        expect(isNoop(items.find((i) => i.id === 4)!, { column: 'agent:forge', index: 2 }, cols)).toBe(true);
    });

    it('arrow keys step the slot: the card’s own place counts once; sideways keeps the position where it fits', () => {
        const items = sample();
        const cols = boardColumns(items, members);
        const five = items.find((i) => i.id === 5)!;
        const start = startSlot(five, cols);
        expect(start).toEqual({ column: 'agent:forge', index: 0 });
        const down = stepSlot(five, start, 'down', cols);
        expect(down).toEqual({ column: 'agent:forge', index: 2 });
        expect(stepSlot(five, down, 'down', cols)).toEqual(down);
        expect(stepSlot(five, down, 'up', cols)).toEqual(start);
        expect(stepSlot(five, start, 'up', cols)).toEqual(start);
        expect(stepSlot(five, down, 'right', cols)).toEqual({ column: 'agent:lint', index: 0 });
        expect(stepSlot(five, start, 'left', cols)).toEqual({ column: 'open', index: 0 });
        expect(stepSlot(five, { column: 'open', index: 0 }, 'left', cols)).toEqual({ column: 'open', index: 0 });
        expect(stepSlot(five, { column: 'agent:scout', index: 1 }, 'right', cols)).toEqual({ column: 'you', index: 1 });
    });

    it('a card says its lease, overlaps, what it waits on and what it asks', () => {
        const plan = boardFixture('p_agentic', 0)!;
        const byId = (n: number) => plan.items.find((i) => i.id === n)!;
        const name = (a: PlanActor) => (a.kind === 'user' ? 'You' : a.agentId === 'atlas' ? 'Atlas' : a.agentId);
        expect(cardMeta(byId(9), plan.items, 0, name)).toEqual(['lease 16m · t_93d1']);
        expect(cardMeta(byId(10), plan.items, 0, name)).toEqual(['lease 22m · t_93d4', 'overlaps #9 · waits to rebase']);
        expect(cardMeta(byId(15), plan.items, 0, name)).toEqual(['waits on #10, #11']);
        expect(cardMeta(byId(12), plan.items, 0, name)).toEqual(['Atlas asks · 2 options']);
        expect(boardFixture('p_docs', 0)).toBeNull();
    });
});

const column = (root: ParentNode, key: string): HTMLElement => root.querySelector<HTMLElement>(`[data-plan-board-column="${key}"]`)!;
const cardIds = (root: ParentNode, key: string, group: 'working' | 'queue'): number[] =>
    [...column(root, key).querySelectorAll<HTMLElement>(`[data-plan-board-group="${group}"] [data-plan-card]`)].map((c) => Number(c.dataset.planCard));
const card = (root: ParentNode, id: number): HTMLElement => root.querySelector<HTMLElement>(`[data-plan-card="${id}"]`)!;
const key = async (el: HTMLElement, k: string): Promise<void> => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    await tick();
};
const drag = (el: Element, type: string, clientY = 0): void => {
    const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { clientY: number };
    Object.defineProperty(e, 'clientY', { value: clientY });
    el.dispatchEvent(e);
};

describe('the Plan board on mock data (#755)', () => {
    it('shows a column per agent with limits, WORKING then QUEUE, done hidden with a note', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan?view=board');
        expect(dom.querySelector('[data-stub]')).toBeNull();
        expect([...dom.querySelectorAll<HTMLElement>('[data-plan-board-column]')].map((c) => c.dataset.planBoardColumn)).toEqual(['open', 'agent:forge', 'agent:lint', 'agent:scout', 'you']);
        expect(cardIds(dom, 'open', 'queue')).toEqual([15, 17]);
        expect(cardIds(dom, 'agent:forge', 'working')).toEqual([9]);
        expect(cardIds(dom, 'agent:forge', 'queue')).toEqual([11, 14, 16]);
        expect(cardIds(dom, 'agent:scout', 'queue')).toEqual([13]);
        expect(cardIds(dom, 'you', 'queue')).toEqual([12]);
        const forge = column(dom, 'agent:forge');
        expect(forge.querySelector('[data-plan-board-who]')!.textContent).toBe('ForgeDeveloper');
        expect(forge.querySelector('[data-plan-board-limit-text]')!.textContent).toBe('1/1 working');
        expect(forge.querySelectorAll('[data-segment="used"]').length).toBe(1);
        expect(column(dom, 'agent:scout').querySelector('[data-plan-board-limit-text]')!.textContent).toBe('0/1 working');
        expect(column(dom, 'open').textContent).toContain('Atlas assigns, or drag');
        expect(column(dom, 'you').textContent).toContain('no limit');
        expect(forge.querySelector('[data-plan-board-group="queue"] h3')!.textContent).toBe('QUEUE · 3');
        expect(card(dom, 16).querySelector('[data-plan-card-ref]')!.textContent).toBe('signalx#14');
        expect(dom.querySelector('[data-plan-card="1"]')).toBeNull();
        const foot = dom.querySelector('[data-plan-board-done]')!;
        expect(foot.textContent).toContain('7 done');
        expect(foot.querySelector('a')!.getAttribute('href')).toBe('/projects/p_agentic/plan?view=list');
    });

    it('drags with the keyboard: Space picks up, arrows move a dashed slot, Space drops; Escape cancels', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan?view=board');
        await key(card(dom, 17), ' ');
        expect(card(dom, 17).hasAttribute('data-lifted')).toBe(true);
        expect(dom.querySelector('[data-plan-board-live]')!.textContent).toContain('Picked up #17');
        await key(card(dom, 17), 'ArrowRight');
        await key(card(dom, 17), 'ArrowRight');
        await key(card(dom, 17), 'ArrowRight');
        expect(column(dom, 'agent:scout').querySelector('[data-plan-board-slot]')).not.toBeNull();
        expect(card(dom, 17).querySelector('[data-plan-card-meta]')!.textContent).toBe('moving to Scout');
        await key(card(dom, 17), 'ArrowDown');
        expect(dom.querySelector('[data-plan-board-live]')!.textContent).toBe('#17: Scout, queue position 2.');
        await key(card(dom, 17), ' ');
        expect(cardIds(dom, 'agent:scout', 'queue')).toEqual([13, 17]);
        expect(cardIds(dom, 'open', 'queue')).toEqual([15]);
        expect(dom.querySelector('[data-plan-board-slot]')).toBeNull();
        expect(dom.querySelector('[data-lifted]')).toBeNull();

        await key(card(dom, 16), ' ');
        await key(card(dom, 16), 'ArrowUp');
        await key(card(dom, 16), 'Escape');
        expect(cardIds(dom, 'agent:forge', 'queue')).toEqual([11, 14, 16]);
        await key(card(dom, 16), ' ');
        await key(card(dom, 16), 'ArrowUp');
        await key(card(dom, 16), 'ArrowUp');
        await key(card(dom, 16), 'Enter');
        expect(cardIds(dom, 'agent:forge', 'queue')).toEqual([16, 11, 14]);
    });

    it('drags with the pointer: the source fades, the column shows the drop slot, a drop assigns', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan?view=board');
        drag(card(dom, 15), 'dragstart');
        await tick();
        expect(card(dom, 15).hasAttribute('data-lifted')).toBe(true);
        const lint = column(dom, 'agent:lint');
        drag(lint.querySelector('[data-plan-board-group="queue"] h3')!, 'dragover');
        await tick();
        expect(lint.querySelector('[data-plan-board-slot]')).not.toBeNull();
        drag(lint, 'drop');
        await tick();
        expect(cardIds(dom, 'agent:lint', 'queue')).toEqual([18, 15]);
        expect(dom.querySelector('[data-lifted]')).toBeNull();
    });

    it('dropping a card an agent is working asks for a handoff note first', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan?view=board');
        await key(card(dom, 9), ' ');
        await key(card(dom, 9), 'ArrowRight');
        await key(card(dom, 9), ' ');
        expect(cardIds(dom, 'agent:forge', 'working')).toEqual([9]);
        const form = document.querySelector<HTMLFormElement>('[data-plan-board-handoff]')!.closest('form')!;
        expect(form.textContent).toContain('Hand #9 to Lint?');
        expect(form.textContent).toContain('Forge is working on it now');
        const note = form.querySelector<HTMLTextAreaElement>('textarea')!;
        note.value = 'Registry half moved';
        note.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        expect(cardIds(dom, 'agent:forge', 'working')).toEqual([]);
        expect(cardIds(dom, 'agent:lint', 'queue')).toEqual([9, 18]);
        expect(document.querySelector('[data-plan-board-handoff]')).toBeNull();
        expect(dom.querySelector('[data-plan-board-live]')!.textContent).toContain('handoff note');
    });
});
