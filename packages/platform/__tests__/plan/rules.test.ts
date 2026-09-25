/**
 * The Plan rules (#750; PRJ-11), table by table: who may change what, claims and leases, limits, `after`,
 * touches, done, split — each against a fresh book, no host.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_LEASE_DEFAULT_MS, type AgentId, type PlanActor, type ProjectId, type WorkspaceId } from '@agentic/core';
import {
    addItems,
    addPhase,
    addRef,
    assign,
    claim,
    claimRefusal,
    createPlan,
    emptyBook,
    expireLeases,
    handoff,
    itemOf,
    itemView,
    nextFor,
    nextLeaseEnd,
    openItems,
    PlanRuleError,
    renewLeases,
    splitItem,
    takeNotices,
    update,
    viewState,
    type PlanBook,
    type PlanCall,
    type PlanItemInput
} from '../../src/plan/rules';

const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const OUTSIDER = 'agent_out' as AgentId;
const person: PlanActor = { kind: 'user', userId: 'u1' };
const agent = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });

const T0 = 1_000_000;

function call(actor: PlanActor | null, over: Partial<PlanCall> = {}): PlanCall {
    return { now: T0, actor, manager: PM, members: [PM, FORGE, LINT], limitOf: (a) => (a === LINT ? 2 : 1), ...over };
}

/** A book with one plan: phase 1 holds #1..#n from `items`. */
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

describe('who may change a plan', () => {
    const cases: [string, PlanActor | null, (b: PlanBook, c: PlanCall) => unknown, string | undefined][] = [
        ['a person creates a plan', person, (b, c) => createPlan(b, c, { title: 'P2' }), undefined],
        ['the manager creates a plan', agent(PM), (b, c) => createPlan(b, c, { title: 'P2' }), undefined],
        ['a member agent may not create a plan', agent(FORGE), (b, c) => createPlan(b, c, { title: 'P2' }), 'forbidden'],
        ['the platform may not create a plan', null, (b, c) => createPlan(b, c, { title: 'P2' }), 'forbidden'],
        ['a member agent may not add a phase', agent(FORGE), (b, c) => addPhase(b, c, 'plan-1', 'Two'), 'forbidden'],
        ['the manager adds a phase', agent(PM), (b, c) => addPhase(b, c, 'plan-1', 'Two'), undefined],
        ['a member agent may not add items', agent(FORGE), (b, c) => addItems(b, c, 'plan-1', 1, [{ title: 'x' }]), 'forbidden'],
        ['the manager adds items', agent(PM), (b, c) => addItems(b, c, 'plan-1', 1, [{ title: 'x' }]), undefined],
        ['a member agent may not assign', agent(FORGE), (b, c) => assign(b, c, 1, agent(FORGE)), 'forbidden'],
        ['a person assigns', person, (b, c) => assign(b, c, 1, agent(FORGE)), undefined],
        ['the manager assigns', agent(PM), (b, c) => assign(b, c, 1, agent(FORGE)), undefined],
        ['a member agent may not split', agent(FORGE), (b, c) => splitItem(b, c, 1, [{ title: 'a' }, { title: 'b' }]), 'forbidden'],
        ['a person may not claim', person, (b, c) => claim(b, c, 1), 'forbidden'],
        ['an agent claims', agent(FORGE), (b, c) => claim(b, c, 1), undefined],
        ['an uninvolved agent may not update', agent(FORGE), (b, c) => update(b, c, 1, { note: 'hi' }), 'forbidden'],
        ['an agent may not mark done', agent(PM), (b, c) => update(b, c, 1, { state: 'done' }), 'forbidden'],
        ['a person marks done', person, (b, c) => update(b, c, 1, { state: 'done' }), undefined],
        ['anyone adds a ref', agent(FORGE), (b, c) => addRef(b, c, 1, 'pr:12'), undefined],
        ['an uninvolved agent may not hand off', agent(FORGE), (b, c) => handoff(b, c, 1, agent(LINT), 'yours'), 'forbidden'],
        ['the manager hands off', agent(PM), (b, c) => handoff(b, c, 1, agent(LINT), 'yours'), undefined]
    ];
    it.each(cases)('%s', (_name, actor, fn, expected) => {
        const b = book();
        expect(code(() => fn(b, call(actor)))).toBe(expected);
    });
});

describe('claim', () => {
    const cases: [string, (b: PlanBook) => void, AgentId, number, string | undefined][] = [
        ['an open ready item', () => {}, FORGE, 1, undefined],
        ['a done item', (b) => update(b, call(person), 1, { state: 'done' }), FORGE, 1, 'done'],
        ['an item waiting on an unfinished `after`', (b) => addItems(b, call(person), 'plan-1', 1, [{ title: 'later', after: [1] }]), FORGE, 4, 'blocked'],
        [
            'an item whose `after` is done',
            (b) => {
                addItems(b, call(person), 'plan-1', 1, [{ title: 'later', after: [1] }]);
                update(b, call(person), 1, { state: 'done' });
            },
            FORGE,
            4,
            undefined
        ],
        ['an item claimed by another agent', (b) => claim(b, call(agent(LINT)), 1), FORGE, 1, 'taken'],
        ['an item whose other claim lapsed (it stays that agent’s)', (b) => claim(b, call(agent(LINT), { now: T0 - PLAN_LEASE_DEFAULT_MS - 1 }), 1), FORGE, 1, 'assigned-elsewhere'],
        ['an item whose own claim lapsed', (b) => claim(b, call(agent(FORGE), { now: T0 - PLAN_LEASE_DEFAULT_MS - 1 }), 1), FORGE, 1, undefined],
        ['an item in another agent’s queue', (b) => assign(b, call(person), 1, agent(LINT)), FORGE, 1, 'assigned-elsewhere'],
        ['an item in a person’s queue', (b) => assign(b, call(person), 1, person), FORGE, 1, 'assigned-elsewhere'],
        ['an item in its own queue', (b) => assign(b, call(person), 1, agent(FORGE)), FORGE, 1, undefined],
        ['an item that needs a person', (b) => (assign(b, call(person), 1, agent(FORGE)), update(b, call(person), 1, { state: 'needs-you' })), FORGE, 1, 'needs-person'],
        ['a stuck item', (b) => (assign(b, call(person), 1, agent(FORGE)), update(b, call(person), 1, { state: 'stuck' })), FORGE, 1, undefined],
        ['over the default limit of 1', (b) => claim(b, call(agent(FORGE)), 2), FORGE, 1, 'over-limit'],
        ['within a limit of 2', (b) => claim(b, call(agent(LINT)), 2), LINT, 1, undefined],
        ['over a limit of 2', (b) => (claim(b, call(agent(LINT)), 2), claim(b, call(agent(LINT)), 3)), LINT, 1, 'over-limit'],
        ['re-claiming its own item (renews, no limit)', (b) => claim(b, call(agent(FORGE)), 1), FORGE, 1, undefined],
        ['an unknown item', () => {}, FORGE, 99, 'not-found']
    ];
    it.each(cases)('%s', (_name, setup, agentId, itemId, expected) => {
        const b = book();
        setup(b);
        expect(code(() => claim(b, call(agent(agentId)), itemId))).toBe(expected);
    });

    it('takes the item out of the queue, assigns an open one to the claimer, and leases it for 30 minutes', () => {
        const b = book();
        assign(b, call(person), 2, agent(FORGE));
        const { value } = claim(b, call(agent(FORGE)), 1);
        expect(value.item).toMatchObject({ state: 'claimed', assignee: agent(FORGE), claim: { agentId: FORGE, leaseUntil: T0 + PLAN_LEASE_DEFAULT_MS } });
        expect(b.queues[`agent:${FORGE}`]).toEqual([2]);
        expect(itemView(b, value.item, T0)).not.toHaveProperty('queueIndex');
        expect(nextLeaseEnd(b)).toBe(T0 + PLAN_LEASE_DEFAULT_MS);
    });

    it.each([
        [0, 'invalid'],
        [999, 'invalid'],
        [5 * 60 * 60_000, 'invalid'],
        [60_000, undefined]
    ] as const)('leaseMs %d → %s', (leaseMs, expected) => {
        expect(code(() => claim(book(), call(agent(FORGE)), 1, { leaseMs }))).toBe(expected);
    });

    it('claimRefusal answers the same as claim', () => {
        const b = book();
        claim(b, call(agent(LINT)), 1);
        expect(claimRefusal(b, call(agent(FORGE)), FORGE, itemOf(b, 1))?.code).toBe('taken');
        expect(claimRefusal(b, call(agent(FORGE)), FORGE, itemOf(b, 2))).toBeNull();
    });
});

describe('leases', () => {
    it('any plan call by the agent renews its live leases, not others', () => {
        const b = book();
        claim(b, call(agent(FORGE)), 1);
        claim(b, call(agent(LINT)), 2);
        expect(renewLeases(b, call(agent(FORGE), { now: T0 + 10_000 }))).toBe(1);
        expect(itemOf(b, 1).claim!.leaseUntil).toBe(T0 + 10_000 + PLAN_LEASE_DEFAULT_MS);
        expect(itemOf(b, 2).claim!.leaseUntil).toBe(T0 + PLAN_LEASE_DEFAULT_MS);
        expect(renewLeases(b, call(person))).toBe(0);
    });

    it('a lease that ran out goes back to the top of the assignee’s queue and the manager is told', () => {
        const b = book();
        assign(b, call(person), 2, agent(FORGE));
        assign(b, call(person), 1, agent(FORGE));
        claim(b, call(agent(FORGE)), 1);
        expect(b.queues[`agent:${FORGE}`]).toEqual([2]);
        const later = T0 + PLAN_LEASE_DEFAULT_MS;
        expect(expireLeases(b, call(agent(FORGE), { now: later - 1 }))).toEqual([]);
        const changes = expireLeases(b, call(null, { now: later }));
        expect(changes).toMatchObject([{ op: 'lease-expired', actor: null, itemId: 1 }]);
        expect(itemOf(b, 1)).toMatchObject({ state: 'ready', assignee: agent(FORGE) });
        expect(itemOf(b, 1).claim).toBeUndefined();
        expect(b.queues[`agent:${FORGE}`]).toEqual([1, 2]);
        expect(takeNotices(b, agent(PM))).toMatchObject([{ kind: 'lease-expired', itemId: 1 }]);
        expect(takeNotices(b, agent(PM))).toEqual([]);
        expect(nextLeaseEnd(b)).toBeUndefined();
    });

    it('with no manager the agent whose lease ran out is told', () => {
        const b = book();
        claim(b, call(agent(FORGE)), 1);
        expireLeases(b, call(null, { now: T0 + PLAN_LEASE_DEFAULT_MS, manager: null }));
        expect(takeNotices(b, agent(FORGE))).toMatchObject([{ kind: 'lease-expired', itemId: 1 }]);
    });

    it('an item whose lease is past reads ready before the sweep', () => {
        const b = book();
        claim(b, call(agent(FORGE)), 1);
        expect(viewState(b, itemOf(b, 1), T0 + PLAN_LEASE_DEFAULT_MS)).toBe('ready');
    });
});

describe('after and blocked', () => {
    it('an item waiting on an unfinished item reads blocked until that one is done', () => {
        const b = book();
        addItems(b, call(person), 'plan-1', 1, [{ title: 'later', after: [1, 2] }]);
        expect(viewState(b, itemOf(b, 4), T0)).toBe('blocked');
        update(b, call(person), 1, { state: 'done' });
        expect(viewState(b, itemOf(b, 4), T0)).toBe('blocked');
        update(b, call(person), 2, { state: 'done' });
        expect(viewState(b, itemOf(b, 4), T0)).toBe('ready');
    });

    it('after names items of the project or earlier items of the same call, nothing later', () => {
        const b = book();
        expect(code(() => addItems(b, call(person), 'plan-1', 1, [{ title: 'x', after: [42] }]))).toBe('invalid');
        expect(code(() => addItems(b, call(person), 'plan-1', 1, [{ title: 'x', after: [5] }, { title: 'y' }]))).toBe('invalid');
        const { value } = addItems(b, call(person), 'plan-1', 1, [{ title: 'x', after: [1] }, { title: 'y', after: [4] }]);
        expect(value.map((i) => [i.id, i.after])).toEqual([
            [4, [1]],
            [5, [4]]
        ]);
    });
});

describe('touches', () => {
    const cases: [string, string[], string[], boolean][] = [
        ['same file', ['a/b.ts'], ['a/b.ts'], true],
        ['a directory and a file in it', ['packages/core/'], ['packages/core/src/plan.ts'], true],
        ['a /** glob and a file in it', ['packages/core/**'], ['packages/core/src/x.ts'], true],
        ['sibling files', ['a/b.ts'], ['a/c.ts'], false],
        ['a prefix that is not a directory', ['packages/core'], ['packages/core-x/y.ts'], false],
        ['no touches', [], ['a/b.ts'], false]
    ];
    it.each(cases)('%s → warn: %s', (_name, mine, theirs, warns) => {
        const b = book([
            { title: 'theirs', touches: theirs },
            { title: 'mine', touches: mine }
        ]);
        claim(b, call(agent(LINT)), 1);
        const { value } = claim(b, call(agent(FORGE)), 2);
        expect(value.warnings.length > 0).toBe(warns);
        if (warns) {
            expect(value.warnings[0]).toMatchObject({ itemId: 2, otherItemId: 1, otherAgentId: LINT, order: [1, 2] });
            expect(takeNotices(b, agent(FORGE))).toMatchObject([{ kind: 'touches', itemId: 2, otherItemId: 1, order: [1, 2] }]);
            expect(takeNotices(b, agent(LINT))).toMatchObject([{ kind: 'touches', itemId: 1, otherItemId: 2, order: [1, 2] }]);
        } else expect(b.notices).toEqual([]);
    });

    it('does not warn about the agent’s own items', () => {
        const b = book([
            { title: 'a', touches: ['x.ts'] },
            { title: 'b', touches: ['x.ts'] }
        ]);
        claim(b, call(agent(LINT)), 1);
        expect(claim(b, call(agent(LINT)), 2).value.warnings).toEqual([]);
    });
});

describe('done', () => {
    const cases: [string, (b: PlanBook) => void, string][] = [
        ['every done-when ticked', (b) => update(b, call(agent(FORGE)), 1, { tick: [{ index: 0, checked: true }, { index: 1, checked: true }] }), 'done'],
        ['one of two ticked', (b) => update(b, call(agent(FORGE)), 1, { tick: [{ index: 0, checked: true }] }), 'claimed'],
        ['a person marks it', (b) => update(b, call(person), 1, { state: 'done' }), 'done']
    ];
    it.each(cases)('%s → %s', (_name, act, state) => {
        const b = book([{ title: 'x', doneWhen: ['tests', 'docs'] }]);
        claim(b, call(agent(FORGE)), 1);
        act(b);
        expect(itemOf(b, 1).state).toBe(state);
        if (state === 'done') expect(itemOf(b, 1).claim).toBeUndefined();
    });

    it('an empty checklist is never done by ticking; a done item takes no ticks or claims', () => {
        const b = book([{ title: 'x', doneWhen: ['a'] }]);
        update(b, call(person), 1, { state: 'done' });
        expect(code(() => update(b, call(person), 1, { tick: [{ index: 0, checked: true }] }))).toBe('done');
        expect(code(() => claim(b, call(agent(FORGE)), 1))).toBe('done');
        expect(code(() => update(b, call(person), 1, { tick: [{ index: 5, checked: true }] }))).toBe('invalid');
    });

    it('only a person reopens a done item', () => {
        const b = book();
        update(b, call(person), 1, { state: 'done' });
        expect(code(() => update(b, call(agent(PM)), 1, { state: 'ready' }))).toBe('forbidden');
        update(b, call(person), 1, { state: 'ready' });
        expect(itemOf(b, 1).state).toBe('ready');
    });
});

describe('update states', () => {
    it.each(['needs-you', 'stuck'] as const)('%s releases the claim and waits at the top of the queue', (state) => {
        const b = book();
        assign(b, call(person), 2, agent(FORGE));
        claim(b, call(agent(FORGE)), 1);
        const { changes } = update(b, call(agent(FORGE)), 1, { state });
        expect(changes).toMatchObject([{ op: 'released' }]);
        expect(itemOf(b, 1)).toMatchObject({ state, assignee: agent(FORGE) });
        expect(itemOf(b, 1).claim).toBeUndefined();
        expect(b.queues[`agent:${FORGE}`]).toEqual([1, 2]);
    });

    it('refuses states that are not set by hand', () => {
        const b = book();
        expect(code(() => update(b, call(person), 1, { state: 'blocked' as never }))).toBe('invalid');
        expect(code(() => update(b, call(person), 1, { state: 'claimed' as never }))).toBe('invalid');
    });

    it('only the claimer sets the task', () => {
        const b = book();
        claim(b, call(agent(FORGE)), 1);
        expect(code(() => update(b, call(person), 1, { taskId: 't_1' as never }))).toBe('forbidden');
        update(b, call(agent(FORGE)), 1, { taskId: 't_1' as never });
        expect(itemOf(b, 1).claim!.taskId).toBe('t_1');
    });
});

describe('assign and queues', () => {
    it('keeps an ordered queue per agent; index places and reorders', () => {
        const b = book();
        assign(b, call(person), 1, agent(FORGE));
        assign(b, call(person), 2, agent(FORGE));
        assign(b, call(person), 3, agent(FORGE), 0);
        expect(b.queues[`agent:${FORGE}`]).toEqual([3, 1, 2]);
        assign(b, call(person), 2, agent(FORGE), 1);
        expect(b.queues[`agent:${FORGE}`]).toEqual([3, 2, 1]);
        expect(itemView(b, itemOf(b, 1), T0).queueIndex).toBe(2);
        assign(b, call(person), 3, null);
        expect(b.queues[`agent:${FORGE}`]).toEqual([2, 1]);
        expect(itemOf(b, 3).assignee).toBeUndefined();
    });

    it('refuses an agent that is not a member, and a done item', () => {
        const b = book();
        expect(code(() => assign(b, call(person), 1, agent(OUTSIDER)))).toBe('invalid');
        update(b, call(person), 1, { state: 'done' });
        expect(code(() => assign(b, call(person), 1, agent(FORGE)))).toBe('done');
    });

    it('moving a claimed item to another agent ends the claim and tells its holder', () => {
        const b = book();
        claim(b, call(agent(FORGE)), 1);
        assign(b, call(agent(PM)), 1, agent(LINT));
        expect(itemOf(b, 1)).toMatchObject({ state: 'ready', assignee: agent(LINT) });
        expect(itemOf(b, 1).claim).toBeUndefined();
        expect(takeNotices(b, agent(FORGE))).toMatchObject([{ kind: 'reassigned', itemId: 1 }]);
    });
});

describe('handoff', () => {
    it('the holder hands an item to the top of another queue with a note', () => {
        const b = book();
        assign(b, call(person), 2, agent(LINT));
        claim(b, call(agent(FORGE)), 1);
        handoff(b, call(agent(FORGE)), 1, agent(LINT), 'tests need you');
        expect(itemOf(b, 1)).toMatchObject({ state: 'ready', assignee: agent(LINT), assignedBy: agent(FORGE) });
        expect(b.queues[`agent:${LINT}`]).toEqual([1, 2]);
        expect(takeNotices(b, agent(LINT))).toMatchObject([{ kind: 'handoff', itemId: 1 }]);
    });

    it('to the open pool tells the manager', () => {
        const b = book();
        claim(b, call(agent(FORGE)), 1);
        handoff(b, call(agent(FORGE)), 1, null, 'cannot do it');
        expect(itemOf(b, 1).assignee).toBeUndefined();
        expect(takeNotices(b, agent(PM))).toMatchObject([{ kind: 'handoff', itemId: 1 }]);
    });
});

describe('split', () => {
    it('replaces an item in place; dependants wait on every part; parts keep the queue slot', () => {
        const b = book([{ title: 'base' }, { title: 'big', after: [1], touches: ['src/'] }, { title: 'after big', after: [2] }]);
        assign(b, call(person), 3, agent(FORGE));
        assign(b, call(person), 2, agent(FORGE), 0);
        const { value } = splitItem(b, call(person), 2, [{ title: 'part a' }, { title: 'part b', touches: ['docs/'] }]);
        expect(value.map((i) => i.id)).toEqual([4, 5]);
        expect(b.plans['plan-1']!.phases[0]!.items).toEqual([1, 4, 5, 3]);
        expect(b.items['2']).toBeUndefined();
        expect(itemOf(b, 4)).toMatchObject({ after: [1], touches: ['src/'], assignee: agent(FORGE) });
        expect(itemOf(b, 5)).toMatchObject({ after: [1], touches: ['docs/'] });
        expect(itemOf(b, 3).after).toEqual([4, 5]);
        expect(b.queues[`agent:${FORGE}`]).toEqual([4, 5, 3]);
    });

    it.each([
        ['a claimed item', (b: PlanBook) => claim(b, call(agent(FORGE)), 1), [{ title: 'a' }, { title: 'b' }], 'taken'],
        ['a done item', (b: PlanBook) => update(b, call(person), 1, { state: 'done' }), [{ title: 'a' }, { title: 'b' }], 'done'],
        ['into one part', () => {}, [{ title: 'a' }], 'invalid'],
        ['a part waiting on the original', () => {}, [{ title: 'a', after: [1] }, { title: 'b' }], 'invalid']
    ] as const)('refuses %s', (_name, setup, parts, expected) => {
        const b = book();
        setup(b);
        expect(code(() => splitItem(b, call(person), 1, parts as unknown as PlanItemInput[]))).toBe(expected);
    });
});

describe('next and open items', () => {
    it('own queue first, then the open pool in plan order, skipping what cannot be claimed or clashes', () => {
        const b = book([{ title: 'one', touches: ['a.ts'] }, { title: 'two', after: [1] }, { title: 'three', touches: ['a.ts'] }, { title: 'four' }]);
        assign(b, call(person), 4, agent(FORGE));
        expect(nextFor(b, call(agent(FORGE)), FORGE)?.id).toBe(4);
        assign(b, call(person), 4, agent(LINT));
        expect(nextFor(b, call(agent(FORGE)), FORGE)?.id).toBe(1);
        claim(b, call(agent(LINT)), 1);
        // #2 waits on #1, #3 touches what LINT works on, #4 is LINT's.
        expect(nextFor(b, call(agent(FORGE)), FORGE)).toBeNull();
    });

    it('openItems lists every item not done with its plan and phase', () => {
        const b = book();
        update(b, call(person), 2, { state: 'done' });
        expect(openItems(b, T0).map((o) => [o.planId, o.phase.n, o.item.id])).toEqual([
            ['plan-1', 1, 1],
            ['plan-1', 1, 3]
        ]);
    });
});

describe('validation and history', () => {
    it.each([
        ['an empty title', { title: ' ' }],
        ['a too-long title', { title: 'x'.repeat(201) }],
        ['an absolute touches path', { title: 'x', touches: ['/etc/passwd'] }],
        ['a parent touches path', { title: 'x', touches: ['../x'] }],
        ['a bad ref', { title: 'x', refs: ['not a ref at all'] }],
        ['a non-list doneWhen', { title: 'x', doneWhen: 'tests' }]
    ])('refuses %s', (_name, input) => {
        expect(code(() => addItems(book(), call(person), 'plan-1', 1, [input as unknown as PlanItemInput]))).toBe('invalid');
    });

    it('refs are stored canonical and once', () => {
        const b = book();
        addRef(b, call(agent(FORGE)), 1, 'src/a.ts:3-4');
        addRef(b, call(agent(FORGE)), 1, { kind: 'file', path: 'src/a.ts', from: 3, to: 4 });
        addRef(b, call(agent(FORGE)), 1, { kind: 'url', url: 'https://x.dev/a', title: 'A' });
        expect(itemOf(b, 1).refs).toEqual([
            { kind: 'file', path: 'src/a.ts', from: 3, to: 4 },
            { kind: 'url', url: 'https://x.dev/a', title: 'A' }
        ]);
        expect(code(() => addRef(b, call(agent(FORGE)), 1, { kind: 'pr', n: -1 } as never))).toBe('invalid');
    });

    it('every change adds an activity line with its actor', () => {
        const b = book([{ title: 'x', doneWhen: ['a'] }]);
        assign(b, call(agent(PM)), 1, agent(FORGE));
        claim(b, call(agent(FORGE)), 1);
        update(b, call(agent(FORGE)), 1, { note: 'half way' });
        update(b, call(agent(FORGE)), 1, { tick: [{ index: 0, checked: true }] });
        expect(itemOf(b, 1).activity.map((a) => [a.actor, a.text])).toEqual([
            [person, 'added'],
            [agent(PM), `assigned to @${FORGE}`],
            [agent(FORGE), 'claimed'],
            [agent(FORGE), 'half way'],
            [agent(FORGE), 'ticked "a"'],
            [agent(FORGE), 'every done-when ticked']
        ]);
    });
});
