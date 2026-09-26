/**
 * The Plan actor enforcing the project's Plan settings and waking notice addressees (#938), on a real in-process host
 * with a fake wake port: a notice not addressed to the caller wakes its addressee once and leaves the actor; one that
 * reaches nobody waits for the addressee's next plan call; `pullMerged` is the Pulls actor's hop only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler } from '@sigx/actors/host';
import type { AgentId, ChatId, Principal, ProjectId, ProjectMembers, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { PLAN_FEATURE_ID } from '@agentic/plugins-plan';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey } from '../../src/plan/index';
import type { PlanWake, PlanWakePort } from '../../src/plan/wake';
import { planWakeRow, planWakeText } from '../../src/plan/wake';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const CHAT = 'chat_1' as ChatId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId, taskId?: TaskId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId, ...(taskId ? { taskId } : {}) });

let members: ProjectMembers;
let settings: Record<string, unknown>;
let wakes: PlanWake[];
let reachable: (w: PlanWake) => boolean;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    members = { agentIds: [PM, FORGE, LINT], coordinator: PM };
    settings = {};
    wakes = [];
    reachable = () => true;
    const wake: PlanWakePort = {
        async wake(w) {
            wakes.push(w);
            return reachable(w);
        }
    };
    Plan = definePlanActor({ audit: capturingAuditPort(), wake, projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members, features: { [PLAN_FEATURE_ID]: settings } } : undefined) } });
    app = testActorApp([Plan], { scheduler: manualScheduler() });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const plan = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));

describe('Plan actor: settings', () => {
    it('claimLimit, the project lease and agentsMayTick come from the Plan feature settings', async () => {
        settings = { claimLimit: 2, leaseMinutes: 45, agentsMayTick: false };
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a', doneWhen: ['x'] }, { title: 'b' }, { title: 'c' }] }] });
        const forge = plan(agentP(FORGE));
        expect((await forge.claim(1)).item.claim!.leaseUntil).toBe(1_000_000 + 45 * 60_000);
        await forge.claim(2);
        expect(await statusOf(forge.claim(3))).toBe(409);
        expect(await statusOf(forge.update(1, { tick: [{ index: 0, checked: true }] }))).toBe(403);
        expect((await plan().update(1, { tick: [{ index: 0, checked: true }] })).state).toBe('done');
    });

    it('a new plan given no phases starts from the starter template', async () => {
        settings = { starter: 'release' };
        const p = await plan().create({ title: 'v2' });
        expect(p.phases.map((ph) => ph.title)).toEqual(['Scope', 'Build', 'Check', 'Ship']);
    });
});

describe('Plan actor: waking addressees', () => {
    async function claimed() {
        await plan().create({ title: 'P', originChatId: CHAT, phases: [{ title: 'One', items: [{ title: 'a' }, { title: 'b' }] }] });
        await plan(agentP(FORGE)).claim(1, { taskId: 'task_forge' as TaskId });
    }

    it('a handoff wakes its target once, with the item’s task and the plan’s chat, and the notice leaves the actor', async () => {
        await claimed();
        await plan(agentP(FORGE, 'task_now' as TaskId)).handoff(1, { kind: 'agent', agentId: LINT }, 'tests pass');
        expect(wakes).toHaveLength(1);
        expect(wakes[0]).toMatchObject({ workspaceId: ws, projectId: project, to: { kind: 'agent', agentId: LINT }, chats: [CHAT] });
        // The task the item was handed off from first, then the caller's own.
        expect(wakes[0]!.tasks).toEqual(['task_forge', 'task_now']);
        expect(wakes[0]!.notices.map((n) => n.kind)).toEqual(['handoff']);
        expect(await plan(agentP(LINT)).takeNotices()).toEqual([]);
    });

    it('a notice that reaches nobody waits for the addressee’s next plan call', async () => {
        reachable = () => false;
        await claimed();
        await plan(agentP(FORGE)).handoff(1, { kind: 'agent', agentId: LINT }, 'tests pass');
        expect(wakes).toHaveLength(1);
        expect((await plan(agentP(LINT)).takeNotices()).map((n) => n.kind)).toEqual(['handoff']);
    });

    it('a board move wakes the owner and the target; the caller is never woken', async () => {
        await claimed();
        await plan(user).handoff(1, { kind: 'agent', agentId: LINT }, 'Lint takes over');
        expect(wakes.map((w) => (w.to.kind === 'agent' ? w.to.agentId : w.to.userId)).sort()).toEqual([FORGE, LINT].sort());
    });

    it('a handoff to a person wakes the person', async () => {
        await claimed();
        await plan(agentP(FORGE)).handoff(1, { kind: 'user', userId: 'u1' }, 'please review');
        expect(wakes.map((w) => w.to)).toEqual([{ kind: 'user', userId: 'u1' }]);
    });

    it('a wake that throws leaves the notice waiting and never fails the call', async () => {
        reachable = () => {
            throw new Error('chat is down');
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await claimed();
        await plan(agentP(FORGE)).handoff(1, { kind: 'agent', agentId: LINT }, 'tests pass');
        expect((await plan(agentP(LINT)).takeNotices()).map((n) => n.kind)).toEqual(['handoff']);
        warn.mockRestore();
    });
});

describe('Plan actor: done on merge', () => {
    it('pullMerged is not callable over the wire', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }] }] });
        expect(await statusOf(plan(user).pullMerged({ number: 1 }))).toBe(403);
    });
});

describe('wake texts', () => {
    const n = (itemId: number, text: string) => ({ seq: itemId, at: 0, to: { kind: 'agent', agentId: LINT } as const, kind: 'handoff' as const, itemId, text });
    it('one notice is one line; several are a list', () => {
        expect(planWakeText([n(1, 'x')])).toBe('Plan: x');
        expect(planWakeText([n(1, 'x'), n(2, 'y')])).toBe('Plan notices:\n- #1: x\n- #2: y');
    });
    it('a person’s row links the chat', () => {
        expect(planWakeRow([n(3, 'handed')], CHAT)).toEqual({ kind: 'input', title: 'Plan #3: handed off', body: 'handed', ref: { kind: 'chat', chatId: CHAT } });
    });
});
