/**
 * Ready work starts as a task per item (#1047), on a real in-process host with a fake wake port: the actor finds a chat
 * the agent is in, claims each item it can start for a new task, saves, then starts that task — so every task carries
 * its own item, linked as `claim.taskId`. A start that fails is undone; no chat means nothing is claimed and the
 * `ready` notice wakes the agent as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler } from '@sigx/actors/host';
import type { AgentId, ChatId, Principal, ProjectId, ProjectMembers, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey } from '../../src/plan/index';
import type { PlanStart, PlanStartPlace, PlanWake, PlanWakePort } from '../../src/plan/wake';
import { planStartText } from '../../src/plan/wake';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const CHAT = 'chat_1' as ChatId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };

let members: ProjectMembers;
let wakes: PlanWake[];
let places: PlanStartPlace[];
let starts: PlanStart[];
let chatFor: () => ChatId | undefined;
let startOk: (s: PlanStart) => boolean;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    members = { agentIds: [PM, FORGE], coordinator: PM, limits: { [FORGE]: 3 } };
    wakes = [];
    places = [];
    starts = [];
    chatFor = () => CHAT;
    startOk = () => true;
    const wake: PlanWakePort = {
        async wake(w) {
            if (w.to.kind === 'agent' && w.to.agentId === PM) return true;
            wakes.push(w);
            return false;
        },
        starts: {
            async chatFor(place) {
                places.push(place);
                return chatFor();
            },
            async start(s) {
                starts.push(s);
                return startOk(s);
            }
        }
    };
    Plan = definePlanActor({ audit: capturingAuditPort(), wake, projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members } : undefined) } });
    app = testActorApp([Plan], { scheduler: manualScheduler() });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const plan = () => app.as(user).actor(Plan, planKey(ws, project));
const items = async () => (await plan().get('plan-1')).phases[0]!.items;

async function seed() {
    await plan().create({
        title: 'Bugs',
        originChatId: CHAT,
        phases: [{ title: 'Fix', items: [{ title: 'login', touches: ['src/login/'], doneWhen: ['test'] }, { title: 'upload', touches: ['src/upload/'] }, { title: 'search', touches: ['src/search/'] }, { title: 'anything' }] }]
    });
}

describe('the plan wake starts a task per independent item (#1047)', () => {
    it('three independent ready items assigned to an idle agent with limit 3 start three tasks, each linked by claim.taskId', async () => {
        await seed();
        for (const n of [1, 2, 3]) await plan().assign(n, { kind: 'agent', agentId: FORGE });
        expect(starts.map((s) => s.item.id)).toEqual([1, 2, 3]);
        expect(new Set(starts.map((s) => s.taskId)).size).toBe(3);
        expect(starts[0]).toMatchObject({ workspaceId: ws, projectId: project, agentId: FORGE, chatId: CHAT, item: { id: 1, title: 'login', touches: ['src/login/'], doneWhen: ['test'] } });
        expect(places[0]).toMatchObject({ agentId: FORGE, chats: [CHAT] });
        const byId = new Map((await items()).map((i) => [i.id, i]));
        for (const s of starts) expect(byId.get(s.item.id)).toMatchObject({ state: 'claimed', claim: { agentId: FORGE, taskId: s.taskId } });
        // Nothing woke FORGE as a notice: the tasks are the wake.
        expect(wakes).toEqual([]);
    });

    it('an item without touches waits for the others: the fourth is not started beside them', async () => {
        await seed();
        for (const n of [1, 4]) await plan().assign(n, { kind: 'agent', agentId: FORGE });
        expect(starts.map((s) => s.item.id)).toEqual([1]);
        expect((await items())[3]).toMatchObject({ state: 'ready', queueIndex: 0 });
    });

    it('a start that fails is undone: the item is back at the top of the queue and the agent is woken as before', async () => {
        await seed();
        startOk = () => false;
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        expect(starts).toHaveLength(1);
        const item = (await items())[0]!;
        expect(item).toMatchObject({ state: 'ready', queueIndex: 0 });
        expect(item.claim).toBeUndefined();
        expect(wakes.map((w) => w.notices.map((n) => n.kind))).toEqual([['ready']]);
    });

    it('no chat the agent is in: nothing is claimed, and the ready notice wakes as before', async () => {
        await seed();
        chatFor = () => undefined;
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        expect(starts).toEqual([]);
        expect((await items())[0]!.claim).toBeUndefined();
        expect(wakes).toHaveLength(1);
    });

    it('the brief names its item and says the task carries it', () => {
        const text = planStartText({ id: 7, title: 'Fix login', touches: ['src/login/'], doneWhen: ['a test'] });
        expect(text).toContain('Plan #7: Fix login');
        expect(text).toContain('This task carries #7');
        expect(text).toContain('Touches: src/login/');
        expect(text).toContain('- a test');
    });
});
