/**
 * Settling plan items from Work (#1041), pure: which rows offer Reopen, Reassign, Drop and Decide; a stuck item never
 * ages out (it turns stale); a dropped item leaves Work and reads as dropped on the Plan; the actions over fake writes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanItem, PlanItemState, ProjectId } from '@agentic/core';
import { closeWorkNotice, runPlanItemAction, undoWorkAction, workHidden, workNotice, type PlanItemWrites } from '../../src/pages/projects/work/actions';
import { WEEK_MS, isStale, planItemActionsOf, workItemsOf, type WorkFeatures } from '../../src/pages/projects/work/model';
import { droppedMeta, isOpen, itemMeta, ownerStatus, phaseProgress, planOf, type PlanDoc } from '../../src/pages/projects/features/plan/shared/model';

const NOW = 1_800_000_000_000;
const FEATURES: WorkFeatures = { enabled: [], uiOf: () => undefined };
const item = (id: number, state: PlanItemState, over: Partial<PlanItem> = {}): PlanItem => ({
    id,
    title: `item ${id}`,
    state,
    after: [],
    touches: [],
    refs: [],
    doneWhen: [],
    activity: [{ at: NOW - 60_000, actor: { kind: 'user', userId: 'u1' }, text: 'x' }],
    ...over
});
const rowsOf = (items: PlanItem[], now = NOW) => workItemsOf([], [], items, FEATURES, now);

describe('plan item rows on Work (#1041)', () => {
    it('stuck offers Reopen, Reassign and Drop; needs-you Decide and Drop; others none', () => {
        const items = [item(1, 'stuck'), item(2, 'needs-you'), item(3, 'claimed', { claim: { agentId: 'a' as never, leaseUntil: NOW + 60_000 } })];
        const rows = rowsOf(items);
        const of = (id: string) => planItemActionsOf(rows.find((r) => r.id === id)!, items);
        expect(of('item:1')).toEqual(['reopen', 'reassign', 'drop']);
        expect(of('item:2')).toEqual(['decide', 'drop']);
        expect(of('item:3')).toEqual([]);
    });

    it('a dropped item is not in Work', () => {
        expect(rowsOf([item(1, 'dropped'), item(2, 'stuck')]).map((r) => r.id)).toEqual(['item:2']);
    });

    it('a stuck item stuck for over a week stays, marked stale', () => {
        const old = item(1, 'stuck', { activity: [{ at: NOW - 2 * WEEK_MS, actor: { kind: 'user', userId: 'u1' }, text: 'stuck' }] });
        const [row] = rowsOf([old]);
        expect(row?.id).toBe('item:1');
        expect(isStale(row!, NOW)).toBe(true);
    });
});

describe('dropped on the Plan page (#1041)', () => {
    const dropped = item(9, 'dropped', { dropped: { by: { kind: 'user', userId: 'u1' }, at: NOW, note: 'first cut', supersededBy: 18 } });

    it('reads as dropped with what supersedes it and why', () => {
        expect(droppedMeta(dropped).map((m) => m.text)).toEqual(['dropped', 'superseded by #18', 'first cut']);
        expect(itemMeta(dropped, [dropped], () => 'x').map((m) => m.text)).toEqual(['dropped', 'superseded by #18', 'first cut']);
        expect(ownerStatus(dropped)).toEqual({ text: 'dropped', tone: 'dim' });
    });

    it('is not open and not counted in progress', () => {
        expect(isOpen(dropped)).toBe(false);
        expect(phaseProgress({ items: [dropped, item(1, 'done'), item(2, 'ready')] })).toEqual({ done: 1, total: 2, pct: 50 });
    });

    it('?item= alone opens the plan that holds it', () => {
        const doc = (id: string, items: PlanItem[]): PlanDoc => ({ plan: { id, projectId: 'p' as ProjectId, title: id, phases: [{ n: 1, title: 'One', items }] } });
        const docs = [doc('a', [item(1, 'ready')]), doc('b', [dropped])];
        expect(planOf(docs, undefined, '9')?.plan.id).toBe('b');
        expect(planOf(docs, 'a', '9')?.plan.id).toBe('a');
        expect(planOf(docs, undefined, undefined)?.plan.id).toBe('a');
    });
});

describe('the plan item actions (#1041)', () => {
    const calls: string[] = [];
    let fail = false;
    const writes: PlanItemWrites = {
        setState: async (n, state, note) => {
            if (fail) throw new Error('[plan] only the project manager and people drop #1');
            calls.push(`${n} ${state}${note !== undefined ? ` "${note}"` : ''}`);
        },
        assign: async (n, to) => void calls.push(`${n} → ${to.kind === 'agent' ? to.agentId : to.userId}`)
    };
    afterEach(() => {
        closeWorkNotice();
        workHidden.ids = [];
        calls.length = 0;
        fail = false;
    });

    it('Reopen sets it ready', async () => {
        await runPlanItemAction(writes, 'reopen', { itemId: 1, title: 'one', state: 'stuck' });
        expect(calls).toEqual(['1 ready']);
        expect(workNotice).toMatchObject({ text: 'Reopened #1 “one”', undo: false });
        expect(workHidden.ids).toEqual([]);
    });

    it('Reassign reopens it into the member’s queue', async () => {
        await runPlanItemAction(writes, 'reassign', { itemId: 1, title: 'one', state: 'stuck' }, { to: { kind: 'agent', agentId: 'agent_lint' as never }, toName: 'Lint' });
        expect(calls).toEqual(['1 ready', '1 → agent_lint']);
        expect(workNotice.text).toBe('Reassigned #1 to Lint');
    });

    it('Drop sends the reason, hides the row while Undo is offered; Undo reopens it to the state it had', async () => {
        await runPlanItemAction(writes, 'drop', { itemId: 1, title: 'one', state: 'stuck' }, { note: ' superseded by #18 ' });
        expect(calls).toEqual(['1 dropped "superseded by #18"']);
        expect(workNotice).toMatchObject({ text: 'Dropped #1 “one”', undo: true });
        expect(workHidden.ids).toEqual(['item:1']);
        await undoWorkAction();
        expect(calls).toEqual(['1 dropped "superseded by #18"', '1 stuck']);
        expect(workHidden.ids).toEqual([]);
    });

    it('a refusal shows as the error and the row comes back', async () => {
        fail = true;
        expect(await runPlanItemAction(writes, 'drop', { itemId: 1, title: 'one', state: 'needs-you' })).toBe(false);
        expect(workNotice.error).toBe('Could not drop #1: only the project manager and people drop #1');
        expect(workHidden.ids).toEqual([]);
    });
});
