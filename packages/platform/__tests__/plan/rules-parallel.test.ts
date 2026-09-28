/**
 * Independent plan items in parallel (#1047): the limit is the ceiling of items an agent works at once, a second claim
 * must be independent of the ones it holds (touches named and disjoint), an item without touches runs alone, a task
 * carries one item, and `startItems` claims what an agent can start now, each for a task of its own.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, PlanActor, ProjectId, TaskId, WorkspaceId } from '@agentic/core';
import { assign, claim, createPlan, emptyBook, itemOf, PlanRuleError, startItems, takeNotices, unstart, update, watchMembers, type PlanBook, type PlanCall, type PlanItemInput } from '../../src/plan/rules';

const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const person: PlanActor = { kind: 'user', userId: 'u1' };
const agent = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });
const T0 = 1_000_000;

function call(actor: PlanActor | null, limit = 3, over: Partial<PlanCall> = {}): PlanCall {
    return { now: T0, actor, manager: PM, members: [PM, FORGE, LINT], limitOf: (a) => (a === FORGE ? limit : 1), ...over };
}

function book(items: PlanItemInput[], limit = 3): PlanBook {
    const b = emptyBook('ws_1' as WorkspaceId, 'prj_1' as ProjectId);
    createPlan(b, call(person, limit), { title: 'Plan', phases: [{ title: 'Phase 1', items }] });
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

const ITEMS: PlanItemInput[] = [
    { title: 'one', touches: ['packages/a/'] },
    { title: 'two', touches: ['packages/b/'] },
    { title: 'three', touches: ['packages/c/x.ts'] },
    { title: 'four', touches: ['packages/d/'] },
    { title: 'overlaps one', touches: ['packages/a/src/y.ts'] },
    { title: 'no touches' },
    { title: 'waits', touches: ['packages/e/'], after: [1] }
];

describe('claims in parallel (#1047)', () => {
    it('with limit 3: three disjoint items; a fourth is over the limit; an overlapping one and one without touches are refused', () => {
        const b = book(ITEMS);
        const forge = call(agent(FORGE));
        for (const n of [1, 2, 3]) claim(b, forge, n);
        expect(code(() => claim(b, forge, 4))).toBe('over-limit');
        const b2 = book(ITEMS);
        claim(b2, forge, 1);
        expect(code(() => claim(b2, forge, 5))).toBe('not-independent');
        expect(code(() => claim(b2, forge, 6))).toBe('not-independent');
        expect(code(() => claim(b2, forge, 7))).toBe('blocked');
        // A clash with its own item is refused, not warned: nobody is told.
        expect(b2.notices).toEqual([]);
    });

    it('an item without touches runs alone: nothing joins it', () => {
        const b = book(ITEMS);
        claim(b, call(agent(FORGE)), 6);
        expect(code(() => claim(b, call(agent(FORGE)), 1))).toBe('not-independent');
    });

    it('another agent’s overlapping claim still only warns', () => {
        const b = book(ITEMS);
        claim(b, call(agent(LINT)), 1);
        expect(claim(b, call(agent(FORGE)), 5).value.warnings).toMatchObject([{ otherItemId: 1, otherAgentId: LINT }]);
    });

    it('limit 1 is unchanged: a second item is over the limit whatever its touches', () => {
        const b = book(ITEMS, 1);
        claim(b, call(agent(FORGE), 1), 1);
        expect(code(() => claim(b, call(agent(FORGE), 1), 2))).toBe('over-limit');
        expect(code(() => claim(b, call(agent(FORGE), 1), 6))).toBe('over-limit');
    });

    it('a task carries one item: a claim or a task link naming a task that already holds one is refused', () => {
        const b = book(ITEMS);
        const task = 'task_a' as TaskId;
        claim(b, call(agent(FORGE)), 1, { taskId: task });
        // Renewing its own item from its own task is fine.
        claim(b, call(agent(FORGE)), 1, { taskId: task });
        expect(code(() => claim(b, call(agent(FORGE)), 2, { taskId: task }))).toBe('task-busy');
        claim(b, call(agent(FORGE)), 2);
        expect(code(() => update(b, call(agent(FORGE)), 2, { taskId: task }))).toBe('task-busy');
        // Once its item is done, the task may carry the next one.
        update(b, call(person), 1, { state: 'done' });
        claim(b, call(agent(FORGE)), 3, { taskId: task });
        expect(itemOf(b, 3).claim?.taskId).toBe(task);
    });
});

describe('startItems: what the wake starts (#1047)', () => {
    const ids = () => {
        let n = 0;
        return () => `task_${++n}` as TaskId;
    };

    it('claims the queue’s independent ready items up to the limit, in queue order, each for a new task', () => {
        const b = book(ITEMS);
        for (const n of [5, 1, 2, 7, 3, 4]) assign(b, call(person), n, agent(FORGE));
        const { value, changes } = startItems(b, call(null), FORGE, ids());
        // #5 first; #1 overlaps it; #2 and #3 fill the slots; #7 waits on #1 and #4 is over the limit.
        expect(value.map((s) => [s.item.id, s.taskId])).toEqual([
            [5, 'task_1'],
            [2, 'task_2'],
            [3, 'task_3']
        ]);
        expect([5, 2, 3].map((n) => itemOf(b, n).claim)).toMatchObject([{ agentId: FORGE, taskId: 'task_1' }, { taskId: 'task_2' }, { taskId: 'task_3' }]);
        expect(changes.map((c) => c.op)).toEqual(['claimed', 'claimed', 'claimed']);
        expect(b.queues[`agent:${FORGE}`]).toEqual([1, 7, 4]);
    });

    it('limit 1: an idle agent starts its first ready item, a busy one nothing', () => {
        const b = book(ITEMS, 1);
        for (const n of [1, 2]) assign(b, call(person, 1), n, agent(FORGE));
        expect(startItems(b, call(null, 1), FORGE, ids()).value.map((s) => s.item.id)).toEqual([1]);
        expect(startItems(b, call(null, 1), FORGE, ids()).value).toEqual([]);
    });

    it('unstart puts an item whose task never began back at the top of the queue', () => {
        const b = book(ITEMS);
        for (const n of [1, 2]) assign(b, call(person), n, agent(FORGE));
        const started = startItems(b, call(null), FORGE, ids()).value;
        for (const s of [...started].reverse()) unstart(b, call(null), s.item.id, s.taskId);
        expect(b.queues[`agent:${FORGE}`]).toEqual([1, 2]);
        expect(itemOf(b, 1)).toMatchObject({ state: 'ready' });
        expect(itemOf(b, 1).claim).toBeUndefined();
        // A claim that moved on is left alone.
        claim(b, call(agent(FORGE)), 1, { taskId: 'task_other' as TaskId });
        expect(unstart(b, call(null), 1, 'task_1' as TaskId)).toEqual([]);
        expect(itemOf(b, 1).claim?.taskId).toBe('task_other');
    });
});

describe('watchMembers: room for more (#1047)', () => {
    it('a busy agent under its limit is told of an independent queued item once; at the limit, or with limit 1, it is not', () => {
        const b = book(ITEMS);
        claim(b, call(agent(FORGE)), 1);
        for (const n of [5, 2]) assign(b, call(person), n, agent(FORGE));
        watchMembers(b, call(null));
        expect(takeNotices(b, agent(FORGE))).toMatchObject([{ kind: 'ready', itemId: 2 }]);
        watchMembers(b, call(null));
        expect(takeNotices(b, agent(FORGE))).toEqual([]);
        const one = book(ITEMS, 1);
        claim(one, call(agent(FORGE), 1), 1);
        assign(one, call(person, 1), 2, agent(FORGE));
        watchMembers(one, call(null, 1));
        expect(takeNotices(one, agent(FORGE))).toEqual([]);
    });
});
