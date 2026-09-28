/**
 * Dropping a plan item (#1041): terminal like done but not done — dependents stay blocked and the manager is told to
 * relink them; the item leaves every queue and the Work view; `ready` reopens it.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, PlanActor, ProjectId, WorkspaceId } from '@agentic/core';
import { assign, claim, claimRefusal, createPlan, dependentsOf, emptyBook, handoff, itemOf, itemView, nextFor, openItems, PlanRuleError, splitItem, takeNotices, update, viewState, type PlanBook, type PlanCall, type PlanItemInput } from '../../src/plan/rules';
import { planPatch } from '../../src/plan/port';

const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const person: PlanActor = { kind: 'user', userId: 'u1' };
const agent = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });
const T0 = 1_000_000;

function call(actor: PlanActor | null, over: Partial<PlanCall> = {}): PlanCall {
    return { now: T0, actor, manager: PM, members: [PM, FORGE], limitOf: () => 1, ...over };
}

/** #1 first cut, #2 after #1, #3 the replacement, #4 after #1 too. */
function book(items: PlanItemInput[] = [{ title: 'first cut' }, { title: 'uses it', after: [1] }, { title: 'second cut' }, { title: 'also uses it', after: [1] }]): PlanBook {
    const b = emptyBook('ws_1' as WorkspaceId, 'prj_1' as ProjectId);
    createPlan(b, call(person), { title: 'Plan', phases: [{ title: 'Phase 1', items }] });
    return b;
}

const code = (fn: () => unknown): string | undefined => {
    try {
        fn();
        return undefined;
    } catch (error) {
        if (error instanceof PlanRuleError) return error.code;
        throw error;
    }
};

describe('dropping an item (#1041)', () => {
    it('does not unblock the items after it', () => {
        const b = book();
        update(b, call(person), 1, { state: 'dropped', note: 'replaced', supersededBy: 3 });
        expect(viewState(b, itemOf(b, 1), T0)).toBe('dropped');
        expect(viewState(b, itemOf(b, 2), T0)).toBe('blocked');
        expect(code(() => claim(b, call(agent(FORGE)), 2))).toBe('blocked');
        expect(dependentsOf(b, 1).map((i) => i.id)).toEqual([2, 4]);
    });

    it('keeps who dropped it, the note and what supersedes it on the view', () => {
        const b = book();
        update(b, call(person), 1, { state: 'dropped', note: 'replaced', supersededBy: 3 });
        const view = itemView(b, itemOf(b, 1), T0);
        expect(view.state).toBe('dropped');
        expect(view.dropped).toEqual({ by: person, at: T0, note: 'replaced', supersededBy: 3 });
        expect(view.activity.at(-1)?.text).toBe('ready → dropped (superseded by #3)');
    });

    it('tells the manager which items to relink when someone else drops it', () => {
        const b = book();
        update(b, call(person), 1, { state: 'dropped', note: 'replaced', supersededBy: 3 });
        const [n] = takeNotices(b, agent(PM));
        expect(n).toMatchObject({ kind: 'dropped', itemId: 1 });
        expect(n!.text).toContain('#2, #4 wait on it');
        expect(n!.text).toContain('plan_update after');
    });

    it('the manager may drop alone, and is not told of its own drop', () => {
        const b = book();
        update(b, call(agent(PM)), 1, { state: 'dropped', note: 'not needed' });
        expect(itemOf(b, 1).state).toBe('dropped');
        expect(takeNotices(b, agent(PM))).toEqual([]);
    });

    it('a member agent may not drop, even its own item', () => {
        const b = book();
        assign(b, call(person), 1, agent(FORGE));
        expect(code(() => update(b, call(agent(FORGE)), 1, { state: 'dropped', note: 'meh' }))).toBe('forbidden');
    });

    it('ends a live claim, tells its holder and leaves every queue', () => {
        const b = book();
        assign(b, call(person), 3, agent(FORGE));
        claim(b, call(agent(FORGE)), 3);
        assign(b, call(person), 1, agent(FORGE));
        update(b, call(person), 3, { state: 'dropped', note: 'no longer wanted' });
        const item = itemOf(b, 3);
        expect(item.claim).toBeUndefined();
        expect(b.queues['agent:agent_forge']).toEqual([1]);
        expect(takeNotices(b, agent(FORGE)).map((n) => n.kind)).toContain('dropped');
    });

    it('is not claimable, assignable, splittable or handed off, and takes no ticks', () => {
        const b = book([{ title: 'a', doneWhen: ['x'] }, { title: 'b' }]);
        update(b, call(person), 1, { state: 'dropped' });
        expect(claimRefusal(b, call(agent(FORGE)), FORGE, itemOf(b, 1))?.code).toBe('done');
        expect(nextFor(b, call(agent(FORGE)), FORGE)?.id).toBe(2);
        expect(code(() => assign(b, call(person), 1, agent(FORGE)))).toBe('done');
        expect(code(() => splitItem(b, call(person), 1, [{ title: 'p' }, { title: 'q' }]))).toBe('done');
        expect(code(() => handoff(b, call(person), 1, agent(FORGE), 'take it'))).toBe('done');
        expect(code(() => update(b, call(person), 1, { tick: [{ index: 0, checked: true }] }))).toBe('done');
        expect(code(() => update(b, call(person), 1, { state: 'done' }))).toBe('done');
    });

    it('leaves the Work view (openItems)', () => {
        const b = book();
        update(b, call(person), 1, { state: 'dropped' });
        expect(openItems(b, T0).map((o) => o.item.id)).toEqual([2, 3, 4]);
    });

    it('a done item is not dropped', () => {
        const b = book();
        update(b, call(person), 3, { state: 'done' });
        expect(code(() => update(b, call(person), 3, { state: 'dropped' }))).toBe('done');
    });

    it('checks supersededBy', () => {
        const b = book();
        expect(code(() => update(b, call(person), 1, { state: 'dropped', supersededBy: 99 }))).toBe('invalid');
        expect(code(() => update(b, call(person), 1, { state: 'dropped', supersededBy: 1 }))).toBe('invalid');
        expect(code(() => update(b, call(person), 1, { state: 'stuck', supersededBy: 3 }))).toBe('invalid');
    });

    it('ready reopens it into its assignee’s queue and clears the drop; only the manager or a person may', () => {
        const b = book();
        assign(b, call(person), 1, agent(FORGE));
        update(b, call(person), 1, { state: 'dropped' });
        expect(code(() => update(b, call(agent(FORGE)), 1, { state: 'ready' }))).toBe('forbidden');
        update(b, call(agent(PM)), 1, { state: 'ready' });
        const item = itemOf(b, 1);
        expect(item.state).toBe('ready');
        expect(item.dropped).toBeUndefined();
        expect(b.queues['agent:agent_forge']).toEqual([1]);
    });
});

describe('undoing a drop (#1041)', () => {
    it('reopens straight to needs-you with the agent’s question, or to stuck in its queue', () => {
        const b = book();
        assign(b, call(person), 1, agent(FORGE));
        claim(b, call(agent(FORGE), { taskId: 't_1' as never }), 1, { taskId: 't_1' as never });
        update(b, call(agent(FORGE)), 1, { state: 'needs-you', note: 'Which breakpoint?' });
        const asked = itemOf(b, 1).ask;
        update(b, call(person), 1, { state: 'dropped' });
        update(b, call(person), 1, { state: 'needs-you' });
        expect(itemOf(b, 1).state).toBe('needs-you');
        expect(itemOf(b, 1).ask).toEqual(asked);
        expect(asked).toMatchObject({ by: agent(FORGE), text: 'Which breakpoint?', taskId: 't_1' });

        update(b, call(person), 3, { state: 'stuck' });
        update(b, call(person), 3, { state: 'dropped' });
        expect(code(() => update(b, call(agent(FORGE)), 3, { state: 'stuck' }))).toBe('forbidden');
        update(b, call(person), 3, { state: 'stuck' });
        expect(itemOf(b, 3).state).toBe('stuck');
    });
});

describe('the tools’ patch (#1041)', () => {
    it('carries dropped and supersededBy to the actor', () => {
        expect(planPatch({ state: 'dropped', note: 'replaced', supersededBy: 18 })).toEqual({ note: 'replaced', state: 'dropped', supersededBy: 18 });
    });
});

describe('settling a stuck item (#1041)', () => {
    it('ready puts a stuck item back in the same queue slot', () => {
        const b = book([{ title: 'a' }, { title: 'b' }]);
        assign(b, call(person), 1, agent(FORGE));
        assign(b, call(person), 2, agent(FORGE));
        claim(b, call(agent(FORGE)), 1);
        update(b, call(agent(FORGE)), 1, { state: 'stuck', note: 'cannot build' });
        expect(b.queues['agent:agent_forge']).toEqual([1, 2]);
        update(b, call(person), 1, { state: 'ready' });
        expect(itemOf(b, 1).state).toBe('ready');
        expect(b.queues['agent:agent_forge']).toEqual([1, 2]);
    });
});
