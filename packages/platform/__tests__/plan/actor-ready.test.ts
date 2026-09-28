/**
 * Ready work wakes an idle agent (#981): assigning into an idle agent's queue, finishing the item another waits on, or
 * finishing one's own item with more ready work left tells the agent once (`ready`), so a queue drains without a nudge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineActor } from '@sigx/actors';
import { manualScheduler } from '@sigx/actors/host';
import type { AgentId, ChatId, Principal, ProjectId, ProjectMembers, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { Chat } from '../../src/chat/index';
import { Inbox } from '../../src/notify/index';
import { definePlanActor, planKey } from '../../src/plan/index';
import { assign, claim, createPlan, emptyBook, takeNotices, watchMembers, type PlanCall } from '../../src/plan/rules';
import { chatPlanWake, type PlanWake, type PlanWakePort } from '../../src/plan/wake';
import { TaskActor, taskKey } from '../../src/task/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const CHAT = 'chat_1' as ChatId;
const user: Principal = { kind: 'user', userId: ws, workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });
const members: ProjectMembers = { agentIds: [PM, FORGE, LINT], coordinator: PM };
const projects = { project: async (_ctx: unknown, _ws: WorkspaceId, id: ProjectId) => (id === project ? { id: project, members } : undefined) };
const to = (w: PlanWake) => (w.to.kind === 'agent' ? w.to.agentId : w.to.userId);

describe('ready work, woken through the chat (chatPlanWake)', () => {
    let ran: TaskId[];
    const Routing = defineActor({
        type: 'routing',
        allowAnonymous: true,
        state: () => ({}),
        methods: () => ({
            async run(taskId: TaskId) {
                ran.push(taskId);
                return { status: 'active' };
            }
        })
    });
    const Plan = definePlanActor({ audit: capturingAuditPort(), projects, wake: chatPlanWake({ routing: () => Routing, inbox: () => Inbox }) });
    let app: TestActorApp;
    beforeEach(() => {
        ran = [];
        app = testActorApp([Plan, Chat, TaskActor, Routing, Inbox]);
        return app.start();
    });
    afterEach(() => app.stop());

    it('assigning into an idle agent’s queue posts to it in the plan’s chat and routes a turn that works the queue', async () => {
        const chat = app.as(user).actor(Chat, `${ws}:chat:${CHAT}`);
        await chat.addAgent(FORGE);
        const plan = app.as(user).actor(Plan, planKey(ws, project));
        await plan.create({ title: 'P', originChatId: CHAT, phases: [{ title: 'One', items: [{ title: 'Reconnect' }] }] });
        await plan.assign(1, { kind: 'agent', agentId: FORGE });

        const msg = (await chat.history(null, 10)).entries.map((e) => e.entry).find((e) => e.t === 'msg');
        expect(msg).toMatchObject({ mentions: [FORGE] });
        const text = (msg as unknown as { parts: readonly { text: string }[] }).parts[0]!.text;
        expect(text).toContain('#1 is ready for you: Reconnect');
        expect(text).toMatch(/plan_next → plan_claim .* repeat until plan_next returns nothing/);
        for (let i = 0; i < 20 && ran.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
        expect(ran).toHaveLength(1);
        expect(await app.as(user).actor(TaskActor, taskKey(ws, ran[0]!)).get()).toMatchObject({ owner: FORGE, assignee: FORGE, origin: { kind: 'user', chatId: CHAT } });
    });
});

describe('ready work, the rules (a fake wake port)', () => {
    let wakes: PlanWake[];
    let app: TestActorApp;
    let Plan: ReturnType<typeof definePlanActor>;
    let Merges: ReturnType<typeof defineActor>;
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        wakes = [];
        const wake: PlanWakePort = {
            async wake(w) {
                wakes.push(w);
                return true;
            }
        };
        Plan = definePlanActor({ audit: capturingAuditPort(), projects, wake });
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
        app = testActorApp([Plan, Merges], { scheduler: manualScheduler() });
        return app.start();
    });
    afterEach(async () => {
        await app.stop();
        vi.useRealTimers();
    });
    const plan = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));
    const readyWakes = () => wakes.filter((w) => w.notices.some((n) => n.kind === 'ready'));

    it('an idle agent is woken once however much lands in its queue, and again only after it has worked', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a', doneWhen: ['x'] }, { title: 'b' }, { title: 'c' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        await plan().assign(2, { kind: 'agent', agentId: FORGE });
        expect(readyWakes().map(to)).toEqual([FORGE]);
        expect(readyWakes()[0]!.notices).toMatchObject([{ kind: 'ready', itemId: 1 }]);
        // Claiming ends the idle spell; finishing leaves #2 ready, told in-band (the caller is never woken).
        await plan(agentP(FORGE)).claim(1);
        await plan(agentP(FORGE)).update(1, { tick: [{ index: 0, checked: true }] });
        expect(readyWakes()).toHaveLength(1);
        expect(await plan(agentP(FORGE)).takeNotices()).toMatchObject([{ kind: 'ready', itemId: 2 }]);
        // Only once: nothing more on the next calls, its own or anyone else's.
        await plan().assign(3, { kind: 'agent', agentId: FORGE });
        expect(await plan(agentP(FORGE)).takeNotices()).toEqual([]);
        expect(readyWakes()).toHaveLength(1);
    });

    it('marking #a done wakes the assignee of #b, which waits on #a', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }, { title: 'b', after: [1] }] }] });
        await plan().assign(2, { kind: 'agent', agentId: LINT });
        expect(readyWakes()).toEqual([]);
        await plan(agentP(FORGE)).claim(1);
        await plan().update(1, { state: 'done' });
        expect(readyWakes().map(to)).toEqual([LINT]);
        expect(readyWakes()[0]!.notices).toMatchObject([{ kind: 'ready', itemId: 2 }]);
    });

    it('a merge that marks #a done wakes the assignee of #b', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }, { title: 'b', after: [1] }] }] });
        await plan().assign(2, { kind: 'agent', agentId: LINT });
        await plan(agentP(FORGE)).claim(1, { taskId: 'task_a' as TaskId });
        await plan(agentP(FORGE)).handoff(1, null, 'PR open');
        wakes = [];
        await (app.as(user).actor(Merges, 'm') as unknown as { merged(n: number, t: TaskId): Promise<number[]> }).merged(7, 'task_a' as TaskId);
        expect(readyWakes().map(to)).toEqual([LINT]);
    });

    it('no wake for an agent that holds a claim at its limit', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }, { title: 'b' }] }] });
        await plan(agentP(FORGE)).claim(1);
        await plan().assign(2, { kind: 'agent', agentId: FORGE });
        expect(readyWakes()).toEqual([]);
    });

    it('no wake while the head of the queue is blocked or needs a person', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }, { title: 'b', after: [1] }, { title: 'c' }] }] });
        await plan().update(3, { state: 'needs-you' });
        await plan().assign(2, { kind: 'agent', agentId: LINT });
        await plan().assign(3, { kind: 'agent', agentId: LINT });
        expect(readyWakes()).toEqual([]);
    });
});

describe('ready work, watchMembers on a book', () => {
    const call = (actor: PlanCall['actor']): PlanCall => ({ now: 1_000, actor, manager: PM, members: [PM, FORGE, LINT], limitOf: () => 1 });
    it('an unread notice of another kind about the same item does not stand in for the telling', () => {
        const b = emptyBook(ws, project);
        createPlan(b, call({ kind: 'user', userId: 'u1' }), { title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }] }] });
        claim(b, call({ kind: 'agent', agentId: FORGE }), 1);
        // Moved off Forge (an unread `reassigned` about #1), then back into its queue.
        assign(b, call({ kind: 'user', userId: 'u1' }), 1, { kind: 'agent', agentId: LINT });
        assign(b, call({ kind: 'user', userId: 'u1' }), 1, { kind: 'agent', agentId: FORGE });
        watchMembers(b, call(null));
        expect(takeNotices(b, { kind: 'agent', agentId: FORGE }).map((n) => n.kind)).toEqual(['reassigned', 'ready']);
    });
});
