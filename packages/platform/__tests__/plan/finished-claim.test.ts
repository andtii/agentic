/**
 * A done item keeps the task it finished under (#906): the merge notice (`mergedPlanItems`) still finds an item
 * marked done before its PR's merge was seen; reopening forgets it.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, PlanActor, ProjectId, PullRequest, TaskId, WorkspaceId } from '@agentic/core';
import { claim, createPlan, emptyBook, expireLeases, itemOf, itemView, update, type PlanBook, type PlanCall } from '../../src/plan/rules';
import { mergedPlanItems } from '../../src/requests/index';

const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const TASK = 'task_1' as TaskId;
const person: PlanActor = { kind: 'user', userId: 'u1' };
const forge: PlanActor = { kind: 'agent', agentId: FORGE };
const T0 = 1_000_000;

const call = (actor: PlanActor, now = T0): PlanCall => ({ now, actor, manager: PM, members: [PM, FORGE], limitOf: () => 1 });

function book(): PlanBook {
    const b = emptyBook('ws_1' as WorkspaceId, 'prj_1' as ProjectId);
    createPlan(b, call(person), { title: 'Plan', phases: [{ title: 'Phase 1', items: [{ title: 'one', doneWhen: ['tests'] }, { title: 'two' }] }] });
    return b;
}

const view = (b: PlanBook, now: number) => [{ phases: [{ n: 1, title: 'Phase 1', items: [1, 2].map((n) => itemView(b, itemOf(b, n), now)) }] }];
const pr = (taskId?: TaskId): Pick<PullRequest, 'number' | 'taskId'> => ({ number: 812, ...(taskId ? { taskId } : {}) });

describe('a done item keeps its finishing task', () => {
    it('marked done by a person: the merge seen later still finds it by its task', () => {
        const b = book();
        claim(b, call(forge), 1, { taskId: TASK });
        update(b, call(person, T0 + 10), 1, { state: 'done' });
        expect(itemOf(b, 1).claim).toBeUndefined();
        const later = T0 + 60 * 60_000;
        const done = itemView(b, itemOf(b, 1), later);
        expect(done).toMatchObject({ state: 'done', claim: { agentId: FORGE, taskId: TASK, leaseUntil: T0 + 10 } });
        expect(mergedPlanItems(view(b, later), pr(TASK)).map((i) => i.id)).toEqual([1]);
        expect(mergedPlanItems(view(b, later), pr('task_other' as TaskId))).toEqual([]);
    });

    it('finished by its done-when lines: the task stays too', () => {
        const b = book();
        claim(b, call(forge), 1, {});
        update(b, call(forge), 1, { taskId: TASK });
        update(b, call(forge, T0 + 5), 1, { tick: [{ index: 0, checked: true }] });
        expect(itemView(b, itemOf(b, 1), T0 + 10)).toMatchObject({ state: 'done', claim: { taskId: TASK } });
    });

    it('is no live claim: the lease sweep leaves it, and a claim without a task records nothing', () => {
        const b = book();
        claim(b, call(forge), 1, { taskId: TASK });
        update(b, call(person), 1, { state: 'done' });
        claim(b, call(forge), 2, {});
        update(b, call(person), 2, { state: 'done' });
        expect(expireLeases(b, call(person, T0 + 24 * 60 * 60_000))).toEqual([]);
        expect(itemOf(b, 1).finishedClaim).toEqual({ agentId: FORGE, taskId: TASK, at: T0 });
        expect(itemView(b, itemOf(b, 2), T0).claim).toBeUndefined();
    });

    it('reopening forgets it', () => {
        const b = book();
        claim(b, call(forge), 1, { taskId: TASK });
        update(b, call(person), 1, { state: 'done' });
        update(b, call(person), 1, { state: 'ready' });
        expect(itemView(b, itemOf(b, 1), T0).claim).toBeUndefined();
        expect(mergedPlanItems(view(b, T0), pr(TASK))).toEqual([]);
    });
});
