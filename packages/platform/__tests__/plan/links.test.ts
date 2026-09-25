/**
 * Links across projects (#764; PRJ-17): `after` holding `project#n`, blocked following the other project's item,
 * and the link graph — lanes, open/done links, chains ending in a milestone or release.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, PlanActor, PlanItem, PlanItemState, ProjectId, WorkspaceId } from '@agentic/core';
import { claim, createPlan, emptyBook, itemOf, PlanRuleError, update, type PlanBook, type PlanCall, type PlanItemInput } from '../../src/plan/rules';
import {
    crossAfterOf,
    crossWaitsOn,
    isMilestoneTitle,
    linkedClaimRefusal,
    linkedItemView,
    links,
    linkSource,
    parseAfter,
    resolveProject,
    setCrossAfter,
    type CrossAfter,
    type ItemLookup,
    type LinkItemInput,
    type LinkProjectInfo,
    type LinkSource
} from '../../src/plan/links';

const AGENTIC = 'prj_agentic' as ProjectId;
const SIGNALX = 'prj_signalx' as ProjectId;
const ZERO = 'prj_zero' as ProjectId;
const PM = 'agent_atlas' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const person: PlanActor = { kind: 'user', userId: 'u1' };
const agent = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });
const T0 = 1_000_000;

const PROJECTS: LinkProjectInfo[] = [
    { id: AGENTIC, name: 'agentic', manager: PM },
    { id: SIGNALX, name: 'SignalX', manager: null },
    { id: ZERO, name: 'zero-wip', manager: PM }
];

function call(actor: PlanActor | null, over: Partial<PlanCall> = {}): PlanCall {
    return { now: T0, actor, manager: PM, members: [PM, FORGE], limitOf: () => 2, ...over };
}

function book(projectId: ProjectId, items: PlanItemInput[], title = 'Plan'): PlanBook {
    const b = emptyBook('ws_1' as WorkspaceId, projectId);
    createPlan(b, call(person), { title, phases: [{ title: 'Phase 1', items }] });
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

describe('parseAfter / resolveProject', () => {
    it('resolves a project by id, by name ignoring case, or by its name as a handle', () => {
        expect(resolveProject('prj_signalx', PROJECTS)).toBe(SIGNALX);
        expect(resolveProject('signalx', PROJECTS)).toBe(SIGNALX);
        expect(resolveProject('Zero-WIP', PROJECTS)).toBe(ZERO);
        expect(resolveProject('nope', PROJECTS)).toBeNull();
    });

    it('splits numbers, #n and project#n into local and cross-project waits', () => {
        const out = parseAfter([3, '#4', 'signalx#14', { kind: 'project-item', project: 'zero-wip', n: 7 }, 'agentic#5', 'signalx#14'], AGENTIC, PROJECTS);
        expect(out.local).toEqual([3, 4, 5]);
        expect(out.cross).toEqual([
            { projectId: SIGNALX, n: 14 },
            { projectId: ZERO, n: 7 }
        ]);
    });

    it('refuses an unknown project and anything that is not an item', () => {
        expect(code(() => parseAfter(['ghost#1'], AGENTIC, PROJECTS))).toBe('invalid');
        expect(code(() => parseAfter(['@lint'], AGENTIC, PROJECTS))).toBe('invalid');
        expect(code(() => parseAfter([0], AGENTIC, PROJECTS))).toBe('invalid');
    });
});

describe('setCrossAfter', () => {
    it('stores the waits, notes them and audits the change', () => {
        const b = book(AGENTIC, [{ title: 'Bump SignalX' }]);
        const out = setCrossAfter(b, call(person), 1, [{ projectId: SIGNALX, n: 14 }, { projectId: SIGNALX, n: 14 }], PROJECTS);
        expect(crossAfterOf(out.value)).toEqual([{ projectId: SIGNALX, n: 14 }]);
        expect(out.value.activity.at(-1)?.text).toBe('waits on SignalX#14');
        expect(out.changes[0]).toMatchObject({ op: 'updated', itemId: 1 });
        setCrossAfter(b, call(agent(PM)), 1, [], PROJECTS);
        expect(crossAfterOf(itemOf(b, 1))).toEqual([]);
    });

    it('is the manager’s and people’s; not on this project, an unknown one, or a done item', () => {
        const b = book(AGENTIC, [{ title: 'a' }]);
        const w: CrossAfter[] = [{ projectId: SIGNALX, n: 1 }];
        expect(code(() => setCrossAfter(b, call(agent(FORGE)), 1, w, PROJECTS))).toBe('forbidden');
        expect(code(() => setCrossAfter(b, call(person), 1, [{ projectId: AGENTIC, n: 1 }], PROJECTS))).toBe('invalid');
        expect(code(() => setCrossAfter(b, call(person), 1, [{ projectId: 'prj_x' as ProjectId, n: 1 }], PROJECTS))).toBe('invalid');
        update(b, call(person), 1, { state: 'done' });
        expect(code(() => setCrossAfter(b, call(person), 1, w, PROJECTS))).toBe('done');
    });
});

describe('blocked follows the other project’s item', () => {
    it('blocks the view and the claim until the other item is done, and again when it reopens', () => {
        const b = book(AGENTIC, [{ title: 'Bump SignalX' }]);
        setCrossAfter(b, call(person), 1, [{ projectId: SIGNALX, n: 14 }], PROJECTS);
        const states = new Map<string, PlanItemState>([['prj_signalx#14', 'claimed']]);
        const lookup: ItemLookup = (p, n) => states.get(`${p}#${n}`);
        const item = itemOf(b, 1);
        expect(linkedItemView(b, item, T0, lookup).state).toBe('blocked');
        const refusal = linkedClaimRefusal(b, call(agent(FORGE)), FORGE, item, lookup, PROJECTS);
        expect(refusal?.code).toBe('blocked');
        expect(refusal?.message).toContain('SignalX#14');

        states.set('prj_signalx#14', 'done');
        expect(crossWaitsOn(item, lookup)).toEqual([]);
        expect(linkedItemView(b, item, T0, lookup).state).toBe('ready');
        expect(linkedClaimRefusal(b, call(agent(FORGE)), FORGE, item, lookup)).toBeNull();

        states.set('prj_signalx#14', 'ready');
        expect(linkedItemView(b, item, T0, lookup).state).toBe('blocked');
    });

    it('counts an unknown item as not done and leaves a claimed or needs-you item as it is', () => {
        const b = book(AGENTIC, [{ title: 'a' }]);
        setCrossAfter(b, call(person), 1, [{ projectId: SIGNALX, n: 99 }], PROJECTS);
        expect(linkedItemView(b, itemOf(b, 1), T0, () => undefined).state).toBe('blocked');
        const c = book(AGENTIC, [{ title: 'b' }]);
        claim(c, call(agent(FORGE)), 1);
        setCrossAfter(c, call(person), 1, [{ projectId: SIGNALX, n: 99 }], PROJECTS);
        expect(linkedItemView(c, itemOf(c, 1), T0, () => undefined).state).toBe('claimed');
    });

    it('propagates down a chain across three projects as each link finishes', () => {
        // signalx#1 → agentic#1 → zero#1
        const sx = book(SIGNALX, [{ title: 'fix batch()' }]);
        const ag = book(AGENTIC, [{ title: 'bump' }]);
        const zr = book(ZERO, [{ title: 'adopt' }]);
        setCrossAfter(ag, call(person), 1, [{ projectId: SIGNALX, n: 1 }], PROJECTS);
        setCrossAfter(zr, call(person), 1, [{ projectId: AGENTIC, n: 1 }], PROJECTS);
        const graph = () => links([linkSource(ag, PROJECTS[0]!, T0), linkSource(sx, PROJECTS[1]!, T0), linkSource(zr, PROJECTS[2]!, T0)]);
        const stateOf = (key: string) => graph().lanes.flatMap((l) => l.nodes).find((n) => n.key === key)?.state;
        expect(stateOf('prj_signalx#1')).toBe('ready');
        expect(stateOf('prj_agentic#1')).toBe('blocked');
        expect(stateOf('prj_zero#1')).toBe('blocked');

        update(sx, call(person), 1, { state: 'done' });
        expect(graph().counts).toEqual({ open: 1, done: 1 });
        expect(stateOf('prj_agentic#1')).toBe('ready');
        expect(stateOf('prj_zero#1')).toBe('blocked');

        update(ag, call(person), 1, { state: 'done' });
        expect(graph().counts).toEqual({ open: 0, done: 2 });
        expect(graph().lanes).toEqual([]);
        const done = links([linkSource(ag, PROJECTS[0]!, T0), linkSource(sx, PROJECTS[1]!, T0), linkSource(zr, PROJECTS[2]!, T0)], 'done');
        expect(done.lanes.flatMap((l) => l.nodes).find((n) => n.key === 'prj_zero#1')?.state).toBe('ready');
    });
});

// The board: signalx#14 → agentic#16 → agentic#20 "Release: tag and publish" (agentic 0.5), which also waits on
// agentic#17..#19 inside agentic; signalx#14 → zero-wip#7; signalx#13 → zero-wip#8.
function item(id: number, title: string, over: Partial<PlanItem> = {}): PlanItem {
    return { id, title, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over };
}
const input = (i: PlanItem, afterRefs: CrossAfter[] = [], planTitle = 'Plan'): LinkItemInput => ({ item: i, planId: 'plan-1', planTitle, ...(afterRefs.length ? { afterRefs } : {}) });

function boardSources(): LinkSource[] {
    return [
        {
            project: PROJECTS[0]!,
            items: [
                input(item(16, 'Bump SignalX once batch() is fixed', { assignee: agent(FORGE) }), [{ projectId: SIGNALX, n: 14 }], 'agentic 0.5'),
                input(item(17, 'Docs'), [], 'agentic 0.5'),
                input(item(18, 'Changelog', { after: [17] }), [], 'agentic 0.5'),
                input(item(19, 'Smoke test'), [], 'agentic 0.5'),
                input(item(21, 'Old thing', { state: 'done' }), [], 'agentic 0.5'),
                input(item(20, 'Release: tag and publish', { after: [16, 18, 19, 21], assignee: person }), [], 'agentic 0.5')
            ]
        },
        {
            project: PROJECTS[1]!,
            items: [
                input(item(14, 'batch() keeps updates on throw', { state: 'claimed', claim: { agentId: FORGE, leaseUntil: T0 + 1 } })),
                input(item(13, 'Export the Signal type from root', { assignee: agent(FORGE) })),
                input(item(12, 'Shipped long ago', { state: 'done' }))
            ]
        },
        {
            project: PROJECTS[2]!,
            items: [
                input(item(7, 'Adopt the fixed batch()'), [{ projectId: SIGNALX, n: 14 }]),
                input(item(8, 'Use Signal type in props'), [{ projectId: SIGNALX, n: 13 }]),
                input(item(9, 'Old adoption', { state: 'done' }), [{ projectId: SIGNALX, n: 12 }])
            ]
        }
    ];
}

describe('links()', () => {
    it('counts open and done cross-project links and draws the open ones', () => {
        const g = links(boardSources());
        expect(g.counts).toEqual({ open: 3, done: 1 });
        expect(g.edges.filter((e) => e.cross).map((e) => `${e.from}>${e.to}`).sort()).toEqual(['prj_signalx#13>prj_zero#8', 'prj_signalx#14>prj_agentic#16', 'prj_signalx#14>prj_zero#7']);
    });

    it('gives a lane per project with a node, in source order, labelled with its manager', () => {
        const g = links(boardSources());
        expect(g.lanes.map((l) => [l.name, l.manager])).toEqual([
            ['agentic', PM],
            ['SignalX', null],
            ['zero-wip', PM]
        ]);
        const agentic = g.lanes[0]!.nodes;
        expect(agentic.map((n) => n.label)).toEqual(['agentic#16', 'agentic#20']);
        expect(agentic[0]).toMatchObject({ state: 'blocked', owner: agent(FORGE), waitsOn: ['prj_signalx#14'] });
        expect(agentic[1]).toMatchObject({ milestone: true, owner: person });
        expect(g.lanes[1]!.nodes.find((n) => n.n === 14)).toMatchObject({ state: 'claimed', owner: agent(FORGE) });
    });

    it('ends chains in the milestone or release, upstream first, counting the items inside', () => {
        const g = links(boardSources());
        const release = g.chains.find((c) => c.root === 'prj_agentic#20')!;
        expect(release.label).toBe('agentic 0.5');
        expect(release.steps.map((s) => s.label)).toEqual(['SignalX#14', 'agentic#16', 'agentic#20']);
        // #17, #18, #19 are open inside agentic; the done #21 holds nothing up.
        expect(release.inside).toBe(3);
        expect(g.edges).toContainEqual({ from: 'prj_agentic#16', to: 'prj_agentic#20', cross: false, state: 'open' });
        // Without a milestone downstream, the last waiting item is the root.
        expect(g.chains.map((c) => c.root).sort()).toEqual(['prj_agentic#20', 'prj_zero#7', 'prj_zero#8']);
        expect(g.chains.find((c) => c.root === 'prj_zero#8')!.steps.map((s) => s.label)).toEqual(['SignalX#13', 'zero-wip#8']);
    });

    it('shows the done links on their own', () => {
        const g = links(boardSources(), 'done');
        expect(g.show).toBe('done');
        expect(g.edges.filter((e) => e.cross)).toEqual([{ from: 'prj_signalx#12', to: 'prj_zero#9', cross: true, state: 'done' }]);
        expect(g.lanes.map((l) => l.name)).toEqual(['SignalX', 'zero-wip']);
    });

    it('survives a cycle across projects', () => {
        const g = links([
            { project: PROJECTS[0]!, items: [input(item(1, 'a'), [{ projectId: SIGNALX, n: 1 }])] },
            { project: PROJECTS[1]!, items: [input(item(1, 'b'), [{ projectId: AGENTIC, n: 1 }])] }
        ]);
        expect(g.counts.open).toBe(2);
        expect(g.lanes.flatMap((l) => l.nodes).every((n) => n.state === 'blocked')).toBe(true);
    });

    it('reads milestones and releases from the title unless the source says', () => {
        expect(isMilestoneTitle('Release: tag and publish')).toBe(true);
        expect(isMilestoneTitle('Milestone 2')).toBe(true);
        expect(isMilestoneTitle('Released notes cleanup')).toBe(false);
    });

    it('builds a source from a Plan book with its cross-project waits', () => {
        const b = book(AGENTIC, [{ title: 'Bump' }, { title: 'Release it', after: [1] }], 'agentic 0.5');
        setCrossAfter(b, call(person), 1, [{ projectId: SIGNALX, n: 14 }], PROJECTS);
        const src = linkSource(b, PROJECTS[0]!, T0);
        expect(src.items.map((i) => [i.item.id, i.afterRefs, i.planTitle])).toEqual([
            [1, [{ projectId: SIGNALX, n: 14 }], 'agentic 0.5'],
            [2, undefined, 'agentic 0.5']
        ]);
    });
});
