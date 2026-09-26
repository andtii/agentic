/**
 * The Plan rules as the project's settings say (#938): `claimLimit` with `memberLimit` overriding it, the project's
 * lease, `agentsMayTick`, the starter plan, a board handoff's note to the current owner, and done on merge.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_LEASE_DEFAULT_MS, type AgentId, type PlanActor, type ProjectId, type ProjectMembers, type ProjectRecord, type TaskId, type WorkspaceId } from '@agentic/core';
import { PLAN_FEATURE_ID, RELEASE_TEMPLATE, planTemplateItemCount } from '@agentic/plugins-plan';
import { claim, createPlan, emptyBook, handoff, itemOf, PlanRuleError, pullMerged, takeNotices, update, type PlanBook, type PlanCall, type PlanItemInput } from '../../src/plan/rules';
import { planLimitOf, planSettings } from '../../src/plan/settings';

const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const person: PlanActor = { kind: 'user', userId: 'u1' };
const agent = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });
const T0 = 1_000_000;
const TASK = 'task_forge' as TaskId;

function call(actor: PlanActor | null, over: Partial<PlanCall> = {}): PlanCall {
    return { now: T0, actor, manager: PM, members: [PM, FORGE, LINT], limitOf: () => 1, ...over };
}

function book(items: PlanItemInput[] = [{ title: 'one' }, { title: 'two' }, { title: 'three' }]): PlanBook {
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

const project = (settings: Record<string, unknown> | undefined, limits?: ProjectMembers['limits']): Pick<ProjectRecord, 'id' | 'members' | 'features'> => ({
    id: 'prj_1' as ProjectId,
    members: { agentIds: [PM, FORGE, LINT], coordinator: PM, ...(limits ? { limits } : {}) },
    features: settings === undefined ? {} : { [PLAN_FEATURE_ID]: settings }
});

describe('planSettings: the Plan feature settings, defaults filled in', () => {
    const cases: [string, Record<string, unknown> | undefined, { claimLimit: number; leaseMs: number; agentsMayTick: boolean; starter?: string }][] = [
        ['no Plan feature: every default', undefined, { claimLimit: 1, leaseMs: PLAN_LEASE_DEFAULT_MS, agentsMayTick: true }],
        ['the settings as set', { claimLimit: 3, leaseMinutes: 45, agentsMayTick: false, starter: 'release' }, { claimLimit: 3, leaseMs: 45 * 60_000, agentsMayTick: false, starter: 'release' }],
        ['out of range or unknown: the defaults', { claimLimit: 99, leaseMinutes: 1, agentsMayTick: 'no', starter: 'nope' }, { claimLimit: 1, leaseMs: PLAN_LEASE_DEFAULT_MS, agentsMayTick: true }],
        ['starter none: no template', { starter: 'none' }, { claimLimit: 1, leaseMs: PLAN_LEASE_DEFAULT_MS, agentsMayTick: true }]
    ];
    it.each(cases)('%s', (_name, settings, want) => {
        const s = planSettings(project(settings));
        expect({ claimLimit: s.claimLimit, leaseMs: s.leaseMs, agentsMayTick: s.agentsMayTick, ...(s.starter ? { starter: s.starter.id } : {}) }).toEqual(want);
    });

    it('a member’s own limit overrides claimLimit', () => {
        const p = project({ claimLimit: 3 }, { [LINT]: 2 });
        expect(planLimitOf(p, FORGE)).toBe(3);
        expect(planLimitOf(p, LINT)).toBe(2);
        expect(planLimitOf(project(undefined), FORGE)).toBe(1);
    });
});

describe('claimLimit and the project lease', () => {
    it('an agent claims up to the project’s claimLimit; its own limit overrides it', () => {
        const p = project({ claimLimit: 2 }, { [LINT]: 1 });
        const c = (a: AgentId) => call(agent(a), { limitOf: (id) => planLimitOf(p, id) });
        const b = book();
        claim(b, c(FORGE), 1);
        claim(b, c(FORGE), 2);
        expect(code(() => claim(b, c(FORGE), 3))).toBe('over-limit');
        const b2 = book();
        claim(b2, c(LINT), 1);
        expect(code(() => claim(b2, c(LINT), 2))).toBe('over-limit');
    });

    it('a claim naming no lease gets the project’s; one naming a lease keeps it', () => {
        const b = book();
        claim(b, call(agent(FORGE), { leaseMs: 45 * 60_000, limitOf: () => 2 }), 1);
        expect(itemOf(b, 1).claim).toMatchObject({ leaseUntil: T0 + 45 * 60_000, leaseMs: 45 * 60_000 });
        claim(b, call(agent(FORGE), { leaseMs: 45 * 60_000, limitOf: () => 2 }), 2, { leaseMs: 10 * 60_000 });
        expect(itemOf(b, 2).claim).toMatchObject({ leaseUntil: T0 + 10 * 60_000 });
    });

    it('a project lease longer than an agent may ask for (up to 8 hours) still claims', () => {
        const b = book();
        const lease = planSettings(project({ leaseMinutes: 480 })).leaseMs;
        claim(b, call(agent(FORGE), { leaseMs: lease }), 1);
        expect(itemOf(b, 1).claim).toMatchObject({ leaseUntil: T0 + 8 * 60 * 60_000 });
        expect(code(() => claim(b, call(agent(LINT), { leaseMs: lease }), 2, { leaseMs: lease }))).toBe('invalid');
    });
});

describe('agentsMayTick, and done by an agent', () => {
    const twoLines = (): PlanBook => {
        const b = book([{ title: 'store', doneWhen: ['tests', 'docs'] }]);
        claim(b, call(agent(FORGE)), 1);
        return b;
    };
    const cases: [string, PlanActor, boolean, Parameters<typeof update>[3], string | undefined, string][] = [
        ['agents may tick: an agent ticks', agent(FORGE), true, { tick: [{ index: 0, checked: true }] }, undefined, 'claimed'],
        ['agents may not tick: an agent is refused', agent(FORGE), false, { tick: [{ index: 0, checked: true }] }, 'forbidden', 'claimed'],
        ['agents may not tick: an agent may still note', agent(FORGE), false, { note: 'tests pass, please tick' }, undefined, 'claimed'],
        ['agents may not tick: a person ticks', person, false, { tick: [{ index: 0, checked: true }, { index: 1, checked: true }] }, undefined, 'done'],
        ['an agent marks done with every line ticked in the same call', agent(FORGE), true, { tick: [{ index: 0, checked: true }, { index: 1, checked: true }], state: 'done' }, undefined, 'done'],
        ['an agent may not mark done with a line unticked', agent(FORGE), true, { tick: [{ index: 0, checked: true }], state: 'done' }, 'forbidden', 'claimed'],
        ['an agent may not mark done where agents may not tick', agent(FORGE), false, { state: 'done' }, 'forbidden', 'claimed'],
        ['a person marks done whatever is ticked', person, false, { state: 'done' }, undefined, 'done']
    ];
    it.each(cases)('%s', (_name, actor, mayTick, patch, want, state) => {
        const b = twoLines();
        expect(code(() => update(b, call(actor, { agentsMayTick: mayTick }), 1, patch))).toBe(want);
        expect(itemOf(b, 1).state).toBe(state);
    });

    it('an agent marks an item done once every line was ticked earlier', () => {
        const b = twoLines();
        const it1 = itemOf(b, 1);
        it1.doneWhen = it1.doneWhen.map((d) => ({ ...d, checked: true }));
        update(b, call(agent(FORGE)), 1, { state: 'done' });
        expect(it1.state).toBe('done');
    });

    it('an agent may not mark done an item with no done-when lines', () => {
        const b = book();
        claim(b, call(agent(FORGE)), 1);
        expect(code(() => update(b, call(agent(FORGE)), 1, { state: 'done' }))).toBe('forbidden');
    });
});

describe('the starter plan', () => {
    it('a plan given no phases starts from the starter template; one given phases (even none) does not', () => {
        const b = emptyBook('ws_1' as WorkspaceId, 'prj_1' as ProjectId);
        const seeded = createPlan(b, call(person, { starter: RELEASE_TEMPLATE }), { title: 'v2' }).value;
        expect(seeded.phases.map((p) => p.title)).toEqual(RELEASE_TEMPLATE.phases.map((p) => p.title));
        expect(Object.keys(b.items)).toHaveLength(planTemplateItemCount(RELEASE_TEMPLATE));
        expect(itemOf(b, 1).title).toBe(RELEASE_TEMPLATE.phases[0]!.items[0]);
        expect(createPlan(b, call(person, { starter: RELEASE_TEMPLATE }), { title: 'blank', phases: [] }).value.phases).toEqual([]);
        expect(createPlan(b, call(person), { title: 'no starter' }).value.phases).toEqual([]);
    });
});

describe('handoff notes', () => {
    const taken = (): PlanBook => {
        const b = book();
        claim(b, call(agent(FORGE)), 1, { taskId: TASK });
        return b;
    };
    it('the agent working it hands off: the target gets the note', () => {
        const b = taken();
        handoff(b, call(agent(FORGE)), 1, agent(LINT), 'tests pass');
        expect(takeNotices(b, agent(LINT)).map((n) => n.text)).toEqual(['@agent_forge handed #1 to you: tests pass']);
        expect(takeNotices(b, agent(FORGE))).toEqual([]);
    });
    it('a person moves it on the board: the current owner gets the note, and the target is told', () => {
        const b = taken();
        handoff(b, call(person), 1, agent(LINT), 'Lint takes this over');
        expect(takeNotices(b, agent(FORGE)).map((n) => [n.kind, n.text])).toEqual([['handoff', '@u1 moved #1 from you to @agent_lint: Lint takes this over']]);
        expect(takeNotices(b, agent(LINT)).map((n) => n.text)).toEqual(['@u1 handed #1 to you: Lint takes this over']);
    });
    it('the owner of a queued item gets the note when a person moves it', () => {
        const b = book();
        handoff(b, call(person), 2, agent(FORGE), 'first');
        takeNotices(b, agent(FORGE));
        handoff(b, call(person), 2, agent(LINT), 'Lint instead');
        expect(takeNotices(b, agent(FORGE)).map((n) => n.text)).toEqual(['@u1 moved #2 from you to @agent_lint: Lint instead']);
    });
});

describe('done on merge', () => {
    it('an item handed off from the merged PR’s task is done, and keeps the task it finished under', () => {
        const b = taken();
        handoff(b, call(agent(FORGE)), 1, person, 'PR is up');
        const out = pullMerged(b, call(null), { number: 604, taskId: TASK });
        expect(out.value.map((i) => i.id)).toEqual([1]);
        expect(out.changes.map((c) => c.op)).toEqual(['done']);
        expect(itemOf(b, 1)).toMatchObject({ state: 'done', finishedClaim: { agentId: FORGE, taskId: TASK } });
        expect(itemOf(b, 1).handedOff).toBeUndefined();
        expect(pullMerged(b, call(null), { number: 604, taskId: TASK }).value).toEqual([]);
    });
    it('the caller’s own task counts over the claim’s', () => {
        const b = taken();
        handoff(b, call(agent(FORGE)), 1, null, 'PR is up', { taskId: 'task_later' as TaskId });
        expect(pullMerged(b, call(null), { number: 1, taskId: TASK }).value).toEqual([]);
        expect(pullMerged(b, call(null), { number: 1, taskId: 'task_later' as TaskId }).value.map((i) => i.id)).toEqual([1]);
    });
    it('a handed-off item naming the PR among its refs is done; one never handed off is not', () => {
        const b = book([{ title: 'a', refs: ['pr:9'] }, { title: 'b', refs: ['pr:9'] }]);
        claim(b, call(agent(FORGE)), 1, { taskId: TASK });
        handoff(b, call(agent(FORGE)), 1, agent(LINT), 'review it');
        expect(pullMerged(b, call(null), { number: 9 }).value.map((i) => i.id)).toEqual([1]);
        expect(itemOf(b, 2).state).toBe('ready');
    });
    it('a merge of another PR or task changes nothing', () => {
        const b = taken();
        handoff(b, call(agent(FORGE)), 1, agent(LINT), 'review it');
        expect(pullMerged(b, call(null), { number: 5, taskId: 'task_other' as TaskId }).value).toEqual([]);
        expect(itemOf(b, 1).state).toBe('ready');
    });
    function taken(): PlanBook {
        const b = book();
        claim(b, call(agent(FORGE)), 1, { taskId: TASK });
        return b;
    }
});
