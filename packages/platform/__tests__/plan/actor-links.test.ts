/**
 * Cross-project `after` wired into the Plan actor (#822; PRJ-17): `add` / `split` / `after` take `project#n`, the
 * item stays blocked (views, `claim`, `next`) until the other project's item is done — read from that project's Plan
 * actor over a hop — and `workspaceLinks` builds the graph from every project's `linkItems`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, PlanItem, Principal, ProjectId, ProjectMembers, SessionId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey, workspaceLinks, type LinkProjectInfo } from '../../src/plan/index';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const AGENTIC = 'prj_agentic' as ProjectId;
const SIGNALX = 'prj_signalx' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });

const PROJECTS: LinkProjectInfo[] = [
    { id: AGENTIC, name: 'agentic', manager: PM },
    { id: SIGNALX, name: 'SignalX', manager: null }
];
const members: ProjectMembers = { agentIds: [PM, FORGE], coordinator: PM };

let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    Plan = definePlanActor({
        audit: capturingAuditPort(),
        projects: { project: async (_ctx, _ws, id) => (PROJECTS.some((p) => p.id === id) ? { id, members } : undefined) },
        links: { projects: async () => PROJECTS }
    });
    app = testActorApp([Plan]);
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const plan = (project: ProjectId, p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));
const items = async (project: ProjectId): Promise<PlanItem[]> => (await plan(project).list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items));
const item = async (project: ProjectId, n: number) => (await items(project)).find((i) => i.id === n)!;

async function seed() {
    await plan(SIGNALX).create({ title: 'SignalX 0.9', phases: [{ title: 'Core', items: [{ title: 'reactivity' }, { title: 'router' }] }] });
    await plan(AGENTIC).create({ title: 'agentic 0.5', phases: [{ title: 'Build', items: [{ title: 'store' }] }] });
}

describe('Plan actor: cross-project after', () => {
    it('add takes project#n; the item is blocked in every view and refused a claim until the other item is done', async () => {
        await seed();
        const [added] = await plan(AGENTIC).add('plan-1', 1, [{ title: 'wire the router', after: ['signalx#2', 1] }]);
        expect(added).toMatchObject({ id: 2, state: 'blocked', after: [1], afterRefs: [{ projectId: SIGNALX, n: 2 }] });
        await plan(AGENTIC).update(1, { state: 'done' });
        expect((await item(AGENTIC, 2)).state).toBe('blocked');
        expect((await plan(AGENTIC).openItems()).find((o) => o.item.id === 2)!.item.state).toBe('blocked');

        await expect(plan(AGENTIC, agentP(FORGE)).claim(2)).rejects.toThrow(/waits on SignalX#2/);
        expect(await statusOf(plan(AGENTIC, agentP(FORGE)).claim(2))).toBe(409);
        expect(await plan(AGENTIC, agentP(FORGE)).next()).toBeNull();

        await plan(SIGNALX).update(2, { state: 'done' });
        expect((await item(AGENTIC, 2)).state).toBe('ready');
        expect((await plan(AGENTIC, agentP(FORGE)).next())?.id).toBe(2);
        const { item: claimed } = await plan(AGENTIC, agentP(FORGE)).claim(2);
        expect(claimed.state).toBe('claimed');
    });

    it('refuses a project that does not exist, and keeps the add whole', async () => {
        await seed();
        expect(await statusOf(plan(AGENTIC).add('plan-1', 1, [{ title: 'x' }, { title: 'y', after: ['nowhere#1'] }]))).toBe(400);
        expect((await items(AGENTIC)).map((i) => i.id)).toEqual([1]);
    });

    it('after replaces what an item waits on, here and elsewhere; the manager and people only; no cycle', async () => {
        await seed();
        await plan(AGENTIC).add('plan-1', 1, [{ title: 'tools' }]);
        const set = await plan(AGENTIC, agentP(PM)).after(2, ['#1', 'SignalX#1']);
        expect(set).toMatchObject({ state: 'blocked', after: [1], afterRefs: [{ projectId: SIGNALX, n: 1 }] });
        expect(await statusOf(plan(AGENTIC, agentP(FORGE)).after(2, []))).toBe(403);
        expect(await statusOf(plan(AGENTIC).after(1, [2]))).toBe(400); // #2 waits on #1
        expect(await statusOf(plan(AGENTIC).after(2, [2]))).toBe(400);
        const cleared = await plan(AGENTIC).after(2, []);
        expect(cleared).toMatchObject({ state: 'ready', after: [], afterRefs: [] });
        expect(cleared.activity.map((a) => a.text).slice(-2)).toEqual(['waits on no item here', 'waits on no other project']);
    });

    it('split: each part keeps the original’s waits on other projects', async () => {
        await seed();
        await plan(AGENTIC).after(1, ['signalx#1']);
        const parts = await plan(AGENTIC).split(1, [{ title: 'a' }, { title: 'b', after: ['signalx#2'] }]);
        expect(parts.map((p) => [p.id, p.state, (p as PlanItem & { afterRefs: unknown }).afterRefs])).toEqual([
            [2, 'blocked', [{ projectId: SIGNALX, n: 1 }]],
            [3, 'blocked', [{ projectId: SIGNALX, n: 1 }, { projectId: SIGNALX, n: 2 }]]
        ]);
    });

    it('workspaceLinks reads every project’s linkItems into the graph', async () => {
        await seed();
        await plan(AGENTIC).after(1, ['signalx#2']);
        const source = { projects: async () => PROJECTS, items: (projectId: ProjectId) => plan(projectId).linkItems() };
        const open = await workspaceLinks(source);
        expect(open.counts).toEqual({ open: 1, done: 0 });
        expect(open.edges.filter((e) => e.cross)).toEqual([{ from: `${SIGNALX}#2`, to: `${AGENTIC}#1`, cross: true, state: 'open' }]);
        expect(open.lanes.map((l) => [l.name, l.nodes.map((n) => n.label)])).toEqual([
            ['agentic', ['agentic#1']],
            ['SignalX', ['SignalX#2']]
        ]);
        await plan(SIGNALX).update(2, { state: 'done' });
        expect((await workspaceLinks(source, 'done')).counts).toEqual({ open: 0, done: 1 });
    });

    it('another project’s items are read without touching its leases', async () => {
        await seed();
        expect(await plan(SIGNALX).itemStates([1, 2, 9])).toEqual({ 1: 'ready', 2: 'ready' });
    });
});
