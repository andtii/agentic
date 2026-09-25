/**
 * The Plan actor (#750) on a real in-process host: the caller is the principal, the manager and limits come from
 * the project record, every change is audited with its actor, leases renew on any plan call and run out from the
 * actor's own reminder, and notices wait for their addressee.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import { PLAN_LEASE_DEFAULT_MS, type AgentId, type Principal, type ProjectId, type ProjectMembers, type SessionId, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, parsePlanKey, planKey, PLAN_BY } from '../../src/plan/index';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });
const machine: Principal = { kind: 'machine', workspaceId: ws, machineId: 'm1' as never };

let members: ProjectMembers;
let scheduler: ManualScheduler;
let audit: ReturnType<typeof capturingAuditPort>;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

const yieldTurns = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    members = { agentIds: [PM, FORGE, LINT], coordinator: PM, limits: { [LINT]: 2 } };
    audit = capturingAuditPort();
    scheduler = manualScheduler();
    Plan = definePlanActor({ audit, projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members } : undefined) } });
    app = testActorApp([Plan], { scheduler, defaults: { reminderTickMs: 60_000 } });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const plan = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));

async function seed() {
    return plan().create({ title: 'Ship plans', phases: [{ title: 'Build', items: [{ title: 'store', touches: ['packages/platform/src/plan/'], doneWhen: ['tests'] }, { title: 'tools', after: [1] }, { title: 'docs' }] }] });
}

describe('Plan actor', () => {
    it('keys: {ws}:plan:{project}', () => {
        expect(planKey(ws, project)).toBe('ws_1:plan:prj_1');
        expect(parsePlanKey('ws_1:plan:prj_1')).toEqual({ workspaceId: ws, projectId: project });
        expect(parsePlanKey('ws_1:pulls:prj_1')).toBeNull();
    });

    it('creates plans with numbered items, several per project, numbers unique across plans', async () => {
        const first = await seed();
        expect(first).toMatchObject({ id: 'plan-1', projectId: project, title: 'Ship plans' });
        expect(first.phases[0]!.items.map((i) => [i.id, i.state])).toEqual([
            [1, 'ready'],
            [2, 'blocked'],
            [3, 'ready']
        ]);
        const second = await plan(agentP(PM)).create({ title: 'Later', phases: [{ title: 'One', items: [{ title: 'x' }] }] });
        expect(second.phases[0]!.items[0]!.id).toBe(4);
        expect((await plan().list()).plans.map((p) => p.id)).toEqual(['plan-1', 'plan-2']);
    });

    it('the caller is the principal: a member agent may not add items, a machine may not change anything', async () => {
        await seed();
        expect(await statusOf(plan(agentP(FORGE)).add('plan-1', 1, [{ title: 'x' }]))).toBe(403);
        expect(await statusOf(plan(machine).update(1, { note: 'x' }))).toBe(403);
        expect(await statusOf(plan(user).claim(1))).toBe(403);
        expect(await statusOf(app.as(user).actor(Plan, 'ws_1:plan:').list())).toBe(400);
    });

    it('claim: refused with 409 when blocked, taken or over the limit; the limit comes from the project', async () => {
        await seed();
        expect(await statusOf(plan(agentP(FORGE)).claim(2))).toBe(409); // waits on #1
        await plan(agentP(FORGE)).claim(1);
        expect(await statusOf(plan(agentP(LINT)).claim(1))).toBe(409); // taken
        expect(await statusOf(plan(agentP(FORGE)).claim(3))).toBe(409); // limit 1
        await plan(agentP(LINT)).claim(3); // limit 2
        members = { ...members, limits: {} };
        await plan().add('plan-1', 1, [{ title: 'y' }]);
        expect(await statusOf(plan(agentP(LINT)).claim(4))).toBe(409); // limit back to 1
    });

    it('audits every change with its actor', async () => {
        await seed();
        await plan(agentP(PM)).assign(3, { kind: 'agent', agentId: FORGE });
        const { item } = await plan(agentP(FORGE)).claim(3);
        expect(item.state).toBe('claimed');
        await plan().update(3, { state: 'done' });
        expect(audit.events.map((e) => [e.kind, e.by, (e.data as { op: string }).op])).toEqual([
            ['plan.changed', 'user:u1', 'plan-created'],
            ['plan.changed', `agent:${PM}`, 'assigned'],
            ['plan.changed', `agent:${FORGE}`, 'claimed'],
            ['plan.changed', 'user:u1', 'done']
        ]);
        expect(new Set(audit.events.map((e) => e.key)).size).toBe(audit.events.length);
        expect(audit.events[2]).toMatchObject({ agentId: FORGE, data: { projectId: project, planId: 'plan-1', itemId: 3, actor: { kind: 'agent', agentId: FORGE } } });
    });

    it('any plan call by the agent renews its lease; a refused call still does', async () => {
        await seed();
        const t0 = Date.now();
        await plan(agentP(FORGE)).claim(1);
        vi.setSystemTime(t0 + 20 * 60_000);
        await plan(agentP(FORGE)).list();
        let item = (await plan().get('plan-1')).phases[0]!.items[0]!;
        expect(item.claim!.leaseUntil).toBe(t0 + 20 * 60_000 + PLAN_LEASE_DEFAULT_MS);
        vi.setSystemTime(t0 + 40 * 60_000);
        expect(await statusOf(plan(agentP(FORGE)).claim(3))).toBe(409);
        item = (await plan().get('plan-1')).phases[0]!.items[0]!;
        expect(item.claim!.leaseUntil).toBe(t0 + 40 * 60_000 + PLAN_LEASE_DEFAULT_MS);
    });

    it('a lease runs out from the reminder alone: back to the top of the queue, the manager is told, History has it', async () => {
        await seed();
        await plan().assign(3, { kind: 'agent', agentId: FORGE });
        await plan(agentP(FORGE)).claim(1);
        const t0 = Date.now();
        vi.setSystemTime(t0 + PLAN_LEASE_DEFAULT_MS + 60_000);
        scheduler.advance(PLAN_LEASE_DEFAULT_MS + 60_000);
        await yieldTurns(30);
        expect(audit.events.at(-1)).toMatchObject({ kind: 'plan.lease-expired', by: PLAN_BY, data: { itemId: 1, op: 'lease-expired' } });
        const item = (await plan().get('plan-1')).phases[0]!.items[0]!;
        expect(item).toMatchObject({ state: 'ready', assignee: { kind: 'agent', agentId: FORGE }, queueIndex: 0 });
        expect(item.claim).toBeUndefined();
        expect(await plan(agentP(PM)).takeNotices()).toMatchObject([{ kind: 'lease-expired', itemId: 1, to: { kind: 'agent', agentId: PM } }]);
        expect(await plan(agentP(PM)).takeNotices()).toEqual([]);
    });

    it('touches overlap warns both agents with a suggested order', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'A', items: [{ title: 'a', touches: ['src/x/'] }, { title: 'b', touches: ['src/x/y.ts'] }] }] });
        await plan(agentP(LINT)).claim(1);
        const { warnings } = await plan(agentP(FORGE)).claim(2);
        expect(warnings).toMatchObject([{ itemId: 2, otherItemId: 1, otherAgentId: LINT, order: [1, 2], paths: ['src/x/y.ts'] }]);
        expect(await plan(agentP(LINT)).takeNotices()).toMatchObject([{ kind: 'touches', itemId: 1, otherItemId: 2 }]);
        expect(await plan(agentP(FORGE)).takeNotices()).toMatchObject([{ kind: 'touches', itemId: 2, otherItemId: 1 }]);
    });

    it('next and openItems: the agent’s queue, then the open pool; the Work view’s rows', async () => {
        await seed();
        await plan().assign(3, { kind: 'agent', agentId: FORGE });
        expect((await plan(agentP(FORGE)).next())?.id).toBe(3);
        expect((await plan(agentP(LINT)).next())?.id).toBe(1);
        expect((await plan().next(LINT))?.id).toBe(1);
        expect(await statusOf(plan().next())).toBe(400);
        await plan(agentP(FORGE)).claim(1);
        await plan(agentP(FORGE)).update(1, { tick: [{ index: 0, checked: true }] });
        const open = await plan().openItems();
        expect(open.map((o) => [o.item.id, o.item.state, o.planTitle, o.phase.title])).toEqual([
            [2, 'ready', 'Ship plans', 'Build'],
            [3, 'ready', 'Ship plans', 'Build']
        ]);
    });
});
