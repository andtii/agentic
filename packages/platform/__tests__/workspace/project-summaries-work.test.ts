/**
 * `Workspace.projectSummaries` live counts (#934): per project the Work groups (your move, agents on it, waiting),
 * the next moves, the open plan items and the requests that need a person, read over hops from the TaskIndex and
 * each project's Plan, Pulls and Requests actors; the unassigned line's tasks. The sources here are fakes of the same
 * actor types, so the counts are checked against a known workspace. A source that cannot be read leaves its count
 * out, so nothing claims a project is quiet without knowing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineActor } from '@sigx/actors';
import type { AgentId, ChatId, PlanItem, ProjectId, PullRequest, TaskId, TaskStatus, WaitReason } from '@agentic/core';
import { AuditActor } from '../../src/audit/index';
import { AgentActor } from '../../src/agent/index';
import { workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage } from '../../src/chat/index';
import { PairingDirectory } from '../../src/pairing/index';
import { PLAN_TYPE, parsePlanKey } from '../../src/plan/key';
import { PULLS_TYPE, parsePullsKey } from '../../src/pulls/key';
import { defineRegistry } from '../../src/registry/index';
import { REQUESTS_TYPE, parseRequestsKey } from '../../src/requests/key';
import { TASK_INDEX_TYPE, type TaskIndexRow } from '../../src/task/task-index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { tallyProjectWork } from '../../src/workspace/project-work';
import { Workspace } from '../../src/workspace/index';

const owner = userPrincipal('u1');
const NOW = Date.now();
const AGENT = 'agent_forge' as AgentId;

/** What the fakes answer, by project id; a project missing from `pulls` makes the Pulls read fail. */
let tasks: TaskIndexRow[];
let plans: Record<string, PlanItem[]>;
let pulls: Record<string, PullRequest[]>;
let requests: Record<string, { state: string }[]>;

const FakeTaskIndex = defineActor({ type: TASK_INDEX_TYPE, state: () => ({}), methods: () => ({ list: async () => tasks }) });
const FakePlan = defineActor({
    type: PLAN_TYPE,
    state: () => ({}),
    methods: (ctx) => ({
        list: async () => ({ plans: [{ id: 'pl1', phases: [{ n: 1, title: 'P', items: plans[parsePlanKey(ctx.key)!.projectId] ?? [] }] }] })
    })
});
const FakePulls = defineActor({
    type: PULLS_TYPE,
    state: () => ({}),
    methods: (ctx) => ({
        get: async () => {
            const list = pulls[parsePullsKey(ctx.key)!.projectId];
            if (!list) throw new Error('no pulls here');
            return { pulls: list };
        }
    })
});
const FakeRequests = defineActor({ type: REQUESTS_TYPE, state: () => ({}), methods: (ctx) => ({ incoming: async () => requests[parseRequestsKey(ctx.key)!.projectId] ?? [] }) });

const row = (id: string, status: TaskStatus, extra: Partial<TaskIndexRow> = {}, wait?: WaitReason): TaskIndexRow => ({
    id: id as TaskId, objective: id, assignee: AGENT, owner: AGENT, status, ...(wait ? { wait } : {}), origin: 'user', depth: 0, createdAt: NOW - 10_000, updatedAt: NOW - 10_000, n: 1, ...extra
});
const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github', repo: 'o/r', number, title: `PR ${number}`, url: '', head: 'h', base: 'main', state: 'open', additions: 1, deletions: 0, files: 1, openedBy: 'x',
    openedAt: NOW - 3_600_000, checks: [{ name: 'ci', state: 'passed' }] as never, review: { state: 'none' as never, reviewers: [], threads: [] }, ...extra
});
const item = (id: number, state: PlanItem['state'], at = NOW - 5_000): PlanItem => ({ id, title: `#${id}`, state, after: [], touches: [], refs: [], doneWhen: [], activity: [{ at } as never] });

let app: TestActorApp;
beforeEach(async () => {
    tasks = [];
    plans = {};
    pulls = {};
    requests = {};
    app = testActorApp([Workspace, PairingDirectory, Chat, ChatPage, defineRegistry({ catalogue: [] }), AuditActor, AgentActor, FakeTaskIndex, FakePlan, FakePulls, FakeRequests]);
    await app.start();
});
afterEach(() => app.stop());

const ws = () => app.as(owner).actor(Workspace, workspaceKey('u1'));

describe('Workspace.projectSummaries — live counts (#934)', () => {
    it('counts each project’s work, plan and requests, and the tasks outside any project', async () => {
        const busy = await ws().upsertProject({ name: 'Busy' });
        const quiet = await ws().upsertProject({ name: 'Quiet' });
        const blind = await ws().upsertProject({ name: 'No pulls' });
        const { chatId: c1 } = await ws().createChat({ projectId: busy.id });
        const { chatId: loose } = await ws().createChat();
        tasks = [
            row('t_approve', 'waiting', { chatId: c1 as ChatId, updatedAt: NOW - 1_000 }, { kind: 'approval' } as WaitReason),
            row('t_work', 'active', { chatId: c1 as ChatId }),
            row('t_pr', 'active', { chatId: c1 as ChatId }),
            row('t_done', 'completed', { chatId: c1 as ChatId }),
            row('t_loose', 'active', { chatId: loose as ChatId }),
            row('t_loose_done', 'completed', { chatId: loose as ChatId }),
            row('t_child', 'active', { parentId: 't_work' as TaskId }),
            row('t_scheduled', 'queued', { origin: 'schedule' })
        ];
        pulls = {
            [busy.id]: [pr(7, { openedAt: NOW - 2_000 }), pr(8, { checks: [{ name: 'ci', state: 'running' }] as never, taskId: 't_pr' as TaskId }), pr(6, { state: 'merged', mergedAt: NOW })],
            [quiet.id]: []
        };
        plans = { [busy.id]: [item(3, 'needs-you', NOW - 3_000), item(4, 'ready'), item(5, 'done')], [blind.id]: [item(1, 'ready')] };
        requests = { [busy.id]: [{ state: 'needs-you' }, { state: 'accepted' }, { state: 'needs-you' }] };

        const s = await ws().projectSummaries();
        const [b, q, n] = s.projects;
        expect(b).toMatchObject({
            projectId: busy.id,
            work: { yourMove: 3, agentsOnIt: 1, waiting: 1, next: ['approve t_approve', 'merge #7', 'decide #3'] },
            openPlanItems: 2,
            requestsNeedYou: 2
        });
        expect(q).toMatchObject({ projectId: quiet.id, work: { yourMove: 0, agentsOnIt: 0, waiting: 0, next: [] }, openPlanItems: 0, requestsNeedYou: 0 });
        // Its pull requests cannot be read: no work counts, so the card shows no QUIET; the plan still counts.
        expect(n).not.toHaveProperty('work');
        expect(n).toMatchObject({ openPlanItems: 1 });
        // `t_loose` (a chat outside any project) and `t_scheduled` (no chat): not a child, not settled.
        expect(s.unassigned).toMatchObject({ openChats: 1, openTasks: 2 });
    });

    it('leaves every new count out when no source can be read', async () => {
        const app2 = testActorApp([Workspace, PairingDirectory, Chat, ChatPage, defineRegistry({ catalogue: [] }), AuditActor, AgentActor]);
        await app2.start();
        try {
            const w = app2.as(owner).actor(Workspace, workspaceKey('u1'));
            const p = await w.upsertProject({ name: 'P' });
            expect(await w.projectSummaries()).toEqual({ projects: [{ projectId: p.id as ProjectId, openChats: 0, archivedChats: 0 }], unassigned: { openChats: 0 } });
        } finally {
            await app2.stop();
        }
    });
});

describe('tallyProjectWork (#934)', () => {
    it('follows the Work view’s owners: autopilot fixes, reviewers wait, conflicts and failures are yours', () => {
        const t = tallyProjectWork(
            [row('t_fail', 'failed', { updatedAt: NOW - 100 }), row('t_ask', 'waiting', {}, { kind: 'input' } as WaitReason)],
            [
                pr(1, { mergeable: false, openedAt: NOW - 200 }),
                pr(2, { checks: [{ name: 'ci', state: 'failed' }] as never, autopilot: { agentId: AGENT, fixChecks: true, maxAttempts: 3 } as never }),
                pr(3, { review: { state: 'requested' as never, reviewers: ['lint'], threads: [] } }),
                pr(4, { review: { state: 'none' as never, reviewers: [], threads: [{ state: 'open' }] as never } }),
                pr(5, { state: 'closed' }),
                pr(9, { draft: true, openedAt: NOW - 300 })
            ],
            [item(10, 'stuck', NOW - 50), item(11, 'claimed'), item(12, 'blocked')],
            NOW
        );
        // Mine: #1 rebase, #4 answer, #9 finish, t_fail retry, t_ask answer, #10 unblock. Agents: #2 (its autopilot fixes the checks). Waiting: #3. #11 holds no live claim, #12 stays on the Plan.
        expect(t).toMatchObject({ yourMove: 6, agentsOnIt: 1, waiting: 1 });
        expect(t.next).toEqual(['unblock #10', 'retry t_fail', 'rebase #1']);
    });
});
