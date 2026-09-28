/**
 * The manager hears what changes the plan (#982): an item done (with its PR), set to needs-you (with the question), a
 * member going idle, and a member that has not started ready work within the lease — that last from the reminder,
 * with nobody calling. One wake per manager per turn, however many notices it carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineActor } from '@sigx/actors';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import { PLAN_LEASE_DEFAULT_MS, type TaskId, type AgentId, type Principal, type ProjectId, type ProjectMembers, type SessionId, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey } from '../../src/plan/index';
import type { PlanWake, PlanWakePort } from '../../src/plan/wake';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });

let members: ProjectMembers;
let wakes: PlanWake[];
let scheduler: ManualScheduler;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;
let Merges: ReturnType<typeof defineActor>;

const yieldTurns = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    members = { agentIds: [PM, FORGE, LINT], coordinator: PM };
    wakes = [];
    const wake: PlanWakePort = {
        async wake(w) {
            wakes.push(w);
            return true;
        }
    };
    scheduler = manualScheduler();
    Plan = definePlanActor({ audit: capturingAuditPort(), wake, projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members } : undefined) } });
    // The Pulls actor's hop, the only way `pullMerged` is reached.
    Merges = defineActor({
        type: 'merges',
        allowAnonymous: true,
        state: () => ({}),
        methods: (ctx) => ({
            async merged(number: number, taskId: TaskId) {
                return ctx.actor(Plan, planKey(ws, project)).pullMerged({ number, taskId });
            }
        })
    });
    app = testActorApp([Plan, Merges], { scheduler, defaults: { reminderTickMs: 60_000 } });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const plan = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));
/** The manager's wakes, as a manager: its own queue's `ready` is a member's notice (#981). */
const managerWakes = () => wakes.filter((w) => w.to.kind === 'agent' && w.to.agentId === PM).map((w) => ({ ...w, notices: w.notices.filter((n) => n.kind !== 'ready') })).filter((w) => w.notices.length);
const kinds = (w: PlanWake) => w.notices.map((n) => n.kind);

describe('the manager hears', () => {
    it('an item done, with its PR, and the member going idle — in one wake', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'Reconnect', doneWhen: ['works'], refs: ['pr:978'] }] }] });
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        await plan(agentP(FORGE)).claim(1);
        wakes = [];
        await plan(agentP(FORGE)).update(1, { tick: [{ index: 0, checked: true }] });
        expect(managerWakes()).toHaveLength(1);
        const [w] = managerWakes();
        expect(kinds(w!)).toEqual(['done', 'idle']);
        expect(w!.notices[0]!.text).toBe('#1 done (every done-when ticked), pr:978: Reconnect');
        expect(w!.notices[1]!.text).toContain(`@${FORGE} holds no item and its queue is empty`);
    });

    it('an item done by its pull request merging, naming the PR', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'Reconnect' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        await plan(agentP(FORGE)).claim(1, { taskId: 'task_a' as TaskId });
        await plan(agentP(FORGE)).handoff(1, null, 'PR open');
        wakes = [];
        await (app.as(user).actor(Merges, 'm') as unknown as { merged(n: number, t: TaskId): Promise<number[]> }).merged(1033, 'task_a' as TaskId);
        expect(managerWakes().map(kinds)).toEqual([['done']]);
        expect(managerWakes()[0]!.notices[0]!.text).toBe('#1 done (pull request #1033 merged): Reconnect');
    });

    it('an item an agent set to needs-you, with the question', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }, { title: 'b' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        await plan().assign(2, { kind: 'agent', agentId: FORGE });
        await plan(agentP(FORGE)).claim(1);
        wakes = [];
        await plan(agentP(FORGE)).update(1, { state: 'needs-you', note: 'commit the generated file, or build first?' });
        expect(managerWakes().map(kinds)).toEqual([['needs-you']]);
        expect(managerWakes()[0]!.notices[0]!.text).toBe(`@${FORGE} set #1 to needs-you: commit the generated file, or build first?`);
    });

    it('a member that has not started ready work within the lease — from the reminder, with nobody calling, once', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'Delete a chat' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: LINT });
        expect(managerWakes()).toEqual([]);
        const later = PLAN_LEASE_DEFAULT_MS + 60_000;
        vi.setSystemTime(1_000_000 + later);
        scheduler.advance(later);
        await yieldTurns(30);
        expect(managerWakes().map(kinds)).toEqual([['stalled']]);
        expect(managerWakes()[0]!.notices[0]).toMatchObject({ itemId: 1, text: expect.stringContaining(`@${LINT} has not started #1`) });
        vi.setSystemTime(1_000_000 + 3 * later);
        scheduler.advance(2 * later);
        await yieldTurns(30);
        expect(managerWakes()).toHaveLength(1);
    });

    it('nothing of a member that claims in time, and nothing about the manager itself', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }, { title: 'b' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: LINT });
        await plan().assign(2, { kind: 'agent', agentId: PM });
        await plan(agentP(LINT)).claim(1);
        // Lint keeps its lease alive, so nothing runs out either.
        vi.setSystemTime(1_000_000 + PLAN_LEASE_DEFAULT_MS / 2);
        await plan(agentP(LINT)).renew();
        const later = PLAN_LEASE_DEFAULT_MS + 60_000;
        vi.setSystemTime(1_000_000 + later);
        scheduler.advance(later);
        await yieldTurns(30);
        expect(managerWakes()).toEqual([]);
    });

    it('nothing when the project has no manager', async () => {
        members = { agentIds: [FORGE, LINT], coordinator: null };
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        await plan(agentP(FORGE)).claim(1);
        await plan().update(1, { state: 'done' });
        expect(wakes.flatMap((w) => w.notices).filter((n) => n.kind !== 'ready')).toEqual([]);
    });
});
