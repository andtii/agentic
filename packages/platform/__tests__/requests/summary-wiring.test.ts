/**
 * The PM weekly summary and merge notices wired in (#868): `setProjectPmPolicy` / `upsertProject` keep the project's
 * summary Schedule entry in step with the policy, the default projects port reads the Workspace, the Pulls actor's
 * `merged` hook fires once per PR, and `pullMergeNotices` finds the plan items a PR finishes and tells their requesters
 * in their chats as the project's manager.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type ChatId, type Plan, type PlanItem, type PmPolicy, type Principal, type ProjectId, type PullRequest, type TaskId, type WorkspaceId } from '@agentic/core';
import { AgentActor } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { capturingAuditPort } from '../../src/audit/port';
import { workspaceKey } from '../../src/auth/index';
import { Chat } from '../../src/chat/index';
import { definePullsActor, pullsKey, type PullMergedPort, type PullSource } from '../../src/pulls/index';
import {
    chatRequesterPort,
    mergedPlanItems,
    pmSummaryScheduleId,
    pmSummaryScheduleKey,
    pullMergeNotices,
    PM_SUMMARY_PROMPT,
    workspaceSummaryProjects,
    type PmSummaryRequestsPort,
    type RequestView,
    type RequesterChatPort
} from '../../src/requests/index';
import { defineScheduleActor, type TriggerHop } from '../../src/schedule/index';
import { TaskActor } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const withSummary = (day = 1, time = '08:45'): PmPolicy => ({ ...PM_POLICY_DEFAULT, weeklySummary: { day, time } });

const Schedule = defineScheduleActor({ trigger: { fired: async () => undefined } });

describe('the weekly summary entry follows the policy', () => {
    let app: TestActorApp;
    beforeEach(async () => {
        app = testActorApp([Workspace, AgentActor, AuditActor, Schedule]);
        await app.start();
    });
    afterEach(() => app.stop());

    const ws = () => app.as(owner).actor(Workspace, workspaceKey('u1'));
    const entry = (projectId: ProjectId) => app.as(owner).actor(Schedule, pmSummaryScheduleKey(WS, projectId));

    it('setProjectPmPolicy creates, patches, switches off and back on the one entry', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        await expect(entry(project.id).get()).rejects.toThrow(/does not exist/);

        await ws().setProjectPmPolicy(project.id, withSummary());
        const created = await entry(project.id).get();
        expect(created).toMatchObject({ kind: 'recurring', title: 'Weekly summary · signalx', enabled: true, projectId: project.id, prompt: PM_SUMMARY_PROMPT, recurrence: { kind: 'cron', cron: '45 8 * * 1', tz: 'UTC' } });
        expect(created.agentId).toBeUndefined();
        expect((await ws().get()).schedules).toEqual([pmSummaryScheduleId(project.id)]);

        await ws().setProjectPmPolicy(project.id, withSummary(5, '17:05'));
        expect(await entry(project.id).get()).toMatchObject({ enabled: true, recurrence: { cron: '5 17 * * 5' } });

        await ws().setProjectPmPolicy(project.id, PM_POLICY_DEFAULT);
        expect((await entry(project.id).get()).enabled).toBe(false);

        await ws().setProjectPmPolicy(project.id, withSummary(2, '09:00'));
        expect(await entry(project.id).get()).toMatchObject({ enabled: true, recurrence: { cron: '0 9 * * 2' } });
        expect((await ws().get()).schedules).toEqual([pmSummaryScheduleId(project.id)]);
    });

    it('upsertProject with a policy creates the entry; a rename retitles it', async () => {
        const project = await ws().upsertProject({ name: 'signalx', pmPolicy: withSummary() });
        expect((await entry(project.id).get()).title).toBe('Weekly summary · signalx');
        await ws().upsertProject({ id: project.id, name: 'sigx' });
        expect((await entry(project.id).get()).title).toBe('Weekly summary · sigx');
    });

    it('a policy without a summary creates nothing', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        await ws().setProjectPmPolicy(project.id, PM_POLICY_DEFAULT);
        await expect(entry(project.id).get()).rejects.toThrow(/does not exist/);
        expect((await ws().get()).schedules).toEqual([]);
    });

    it('the default projects port reads the project off the Workspace', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        const hop: TriggerHop = { actor: (def, key) => app.as(owner).actor(def, key) };
        expect(await workspaceSummaryProjects.project(hop, WS, project.id)).toMatchObject({ id: project.id, name: 'signalx' });
        expect(await workspaceSummaryProjects.project(hop, WS, 'prj_none' as ProjectId)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Merge notices

const ws1 = 'ws_1' as WorkspaceId;
const SX = 'prj_sx' as ProjectId;
const nova = 'agent_nova' as AgentId;
const CHAT = 'chat_req' as ChatId;

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github',
    repo: 'andtii/agentic',
    number: 812,
    title: 'PR 812',
    url: 'https://github.com/andtii/agentic/pull/812',
    head: 'chat/1',
    base: 'main',
    state: 'merged',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [],
    review: { state: 'none', reviewers: [], threads: [] },
    ...over
});

const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `item ${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });
const plans = (...items: PlanItem[]): Pick<Plan, 'phases'>[] => [{ phases: [{ n: 1, title: 'one', items }] }];

describe('mergedPlanItems', () => {
    it('finds the items whose claim is the PR task, or that name the PR, once each', () => {
        const byTask = item(3, { claim: { agentId: nova, leaseUntil: 0, taskId: 'task_1' as TaskId } });
        const byRef = item(4, { refs: [{ kind: 'pr', n: 812 }] });
        const both = item(5, { claim: { agentId: nova, leaseUntil: 0, taskId: 'task_1' as TaskId }, refs: [{ kind: 'pr', n: 812 }] });
        const other = item(6, { refs: [{ kind: 'pr', n: 9 }], claim: { agentId: nova, leaseUntil: 0, taskId: 'task_2' as TaskId } });
        expect(mergedPlanItems(plans(byTask, byRef, both, other), pr({ taskId: 'task_1' as TaskId })).map((i) => i.id)).toEqual([3, 4, 5]);
        // A PR with no task matches by ref only — never an item whose claim has no task either.
        expect(mergedPlanItems(plans(byTask, byRef, item(7, { claim: { agentId: nova, leaseUntil: 0 } })), pr()).map((i) => i.id)).toEqual([4]);
    });
});

const request = (over: Partial<RequestView> & Pick<RequestView, 'id'>): RequestView => ({
    state: 'accepted',
    fromProject: 'prj_ag' as ProjectId,
    sender: { kind: 'agent', agentId: 'agent_forge' as never },
    toProject: SX,
    title: `title of ${over.id}`,
    body: 'body',
    refs: [],
    createdAt: 0,
    updatedAt: 0,
    ...over
});

describe('pullMergeNotices', () => {
    const hop: TriggerHop = { actor: () => { throw new Error('no hop in this test'); } };
    const requests: PmSummaryRequestsPort = {
        requests: async () => ({ incoming: [request({ id: 'req_1', resultItem: 3, fromChat: CHAT }), request({ id: 'req_2', resultItem: 4, fromChat: 'chat_b' as ChatId }), request({ id: 'req_3', resultItem: 9, fromChat: 'chat_c' as ChatId })], sent: [] })
    };
    const setup = (policy: PmPolicy = PM_POLICY_DEFAULT) => {
        const posted: [ChatId, string][] = [];
        const chat = (): RequesterChatPort => ({ post: async (_h, _w, chatId, text) => void posted.push([chatId, text]) });
        const port = pullMergeNotices({
            projects: { project: async (_h, _w, id) => (id === SX ? { id: SX, name: 'signalx', pm: { agentId: nova, policy } } : undefined) },
            plans: { plans: async () => plans(item(3, { claim: { agentId: nova, leaseUntil: 0, taskId: 'task_1' as TaskId } }), item(4, { refs: [{ kind: 'pr', n: 812 }] }), item(9)) },
            requests,
            chat
        });
        return { posted, port };
    };

    it('tells each requester whose request became an item the PR finishes', async () => {
        const { posted, port } = setup();
        await port.merged(hop, { workspaceId: ws1, projectId: SX, pr: pr({ taskId: 'task_1' as TaskId }) });
        expect(posted).toEqual([
            [CHAT, 'signalx#3 merged (agentic#812): your request "title of req_1" (req_1) is done.'],
            ['chat_b', 'signalx#4 merged (agentic#812): your request "title of req_2" (req_2) is done.']
        ]);
    });

    it('stays quiet when the policy says so, or the project is gone', async () => {
        const off = setup({ ...PM_POLICY_DEFAULT, notifyOnMerge: false });
        await off.port.merged(hop, { workspaceId: ws1, projectId: SX, pr: pr({ taskId: 'task_1' as TaskId }) });
        expect(off.posted).toEqual([]);
        const gone = setup();
        await gone.port.merged(hop, { workspaceId: ws1, projectId: 'prj_gone' as ProjectId, pr: pr() });
        expect(gone.posted).toEqual([]);
    });
});

describe('chatRequesterPort', () => {
    let app: TestActorApp;
    beforeEach(async () => {
        app = testActorApp([Chat]);
        await app.start();
    });
    afterEach(() => app.stop());

    const user: Principal = { kind: 'user', userId: ws1, workspaceId: ws1 };
    const hop: TriggerHop = { actor: () => { throw new Error('unused'); } };
    const messages = async () => (await app.as(user).actor(Chat, `${ws1}:chat:${CHAT}`).history(null, 10)).entries.map((e) => e.entry).filter((e) => e.t === 'msg');

    it('posts as the project manager, mentioning nobody', async () => {
        await chatRequesterPort({ id: SX, pm: { agentId: nova, policy: PM_POLICY_DEFAULT } }).post(hop, ws1, CHAT, 'signalx#3 merged', request({ id: 'req_1' }));
        expect(await messages()).toEqual([expect.objectContaining({ author: expect.objectContaining({ kind: 'agent', agentId: nova }), mentions: [], parts: [{ type: 'text', text: 'signalx#3 merged' }] })]);
    });

    it('posts as the workspace user when the project has no manager', async () => {
        await chatRequesterPort({ id: SX }).post(hop, ws1, CHAT, 'done', request({ id: 'req_1' }));
        expect(await messages()).toEqual([expect.objectContaining({ author: { kind: 'user' } })]);
    });
});

describe('Pulls `merged` hook', () => {
    class Source implements PullSource {
        readonly prs = new Map<number, PullRequest>();
        async get(_repo: string, n: number) {
            return this.prs.get(n);
        }
        async listOpen() {
            return [...this.prs.values()].filter((p) => p.state === 'open');
        }
    }

    it('fires once when a PR is first seen merged, never for an open or closed one, and a throw does not fail the poll', async () => {
        const source = new Source();
        const seen: number[] = [];
        let fail = true;
        const merged: PullMergedPort = {
            merged: async (_hop, e) => {
                seen.push(e.pr.number);
                expect(e).toMatchObject({ workspaceId: ws1, projectId: SX });
                if (fail) {
                    fail = false;
                    throw new Error('boom');
                }
            }
        };
        const Pulls = definePullsActor({ sources: { open: () => source }, audit: capturingAuditPort(), merged });
        const app = testActorApp([TaskActor, Pulls]);
        await app.start();
        try {
            const pulls = app.as({ kind: 'user', userId: 'u1', workspaceId: ws1 }).actor(Pulls, pullsKey(ws1, SX));
            source.prs.set(1, pr({ number: 1, state: 'open' }));
            source.prs.set(2, pr({ number: 2, state: 'open' }));
            await pulls.watch({ provider: 'github', repo: 'andtii/agentic' });
            expect(seen).toEqual([]);
            source.prs.set(1, pr({ number: 1, state: 'merged' }));
            source.prs.set(2, pr({ number: 2, state: 'closed' }));
            const view = await pulls.poll();
            expect(view.error).toBeUndefined();
            await pulls.poll();
            expect(seen).toEqual([1]);
        } finally {
            await app.stop();
        }
    });
});
