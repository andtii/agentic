/**
 * `chatAutopilotPort` (#820): a turn is a post in the PR's chat addressed to the agent, a task from that message
 * and a hand-off to the router; a stop and a merge ask are Inbox rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, Principal, PullRequest, TaskId, WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { Chat } from '../../src/chat/index';
import { Inbox, inboxKey } from '../../src/notify/index';
import { ASK_ON_MERGE, autopilotMergeRow, autopilotStopRow, chatAutopilotPort } from '../../src/pulls/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const user: Principal = { kind: 'user', userId: ws, workspaceId: ws };
const forge = 'agent_forge' as AgentId;
const chatId = 'chat_9' as ChatId;

const pr: PullRequest = {
    provider: 'github',
    repo: 'o/r',
    number: 9,
    title: 'PR 9',
    url: 'https://github.com/o/r/pull/9',
    head: 'chat/9',
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [],
    review: { state: 'none', reviewers: [], threads: [] },
    chatId,
    taskId: 'task_9' as TaskId
};

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

let app: TestActorApp;
beforeEach(() => {
    ran = [];
    app = testActorApp([Chat, TaskActor, Routing, Inbox]);
    return app.start();
});
afterEach(() => app.stop());

const port = () => chatAutopilotPort({ workspaceId: ws, routing: () => Routing, inbox: () => Inbox });
const chat = () => app.as(user).actor(Chat, `${ws}:chat:${chatId}`);

describe('startTurn', () => {
    it('posts in the chat addressed to the agent and routes a task from that message', async () => {
        await chat().addAgent(forge);
        await port().startTurn({ agentId: forge, chatId, text: 'Autopilot: fix it', pr });
        const { entries } = await chat().history(null, 10);
        const msg = entries.map((e) => e.entry).find((e) => e.t === 'msg');
        expect(msg).toMatchObject({ mentions: [forge], parts: [{ type: 'text', text: 'Autopilot: fix it' }] });
        for (let i = 0; i < 20 && ran.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
        expect(ran).toHaveLength(1);
        const task = await app.as(user).actor(TaskActor, taskKey(ws, ran[0]!)).get();
        expect(task).toMatchObject({ owner: forge, objective: 'Autopilot: fix it', assignee: forge, origin: { kind: 'user', chatId } });
    });

    it('an agent that is not a member throws, and nothing is routed', async () => {
        await expect(port().startTurn({ agentId: forge, chatId, text: 'x', pr })).rejects.toThrow(/not a member/);
        expect(ran).toEqual([]);
        expect((await chat().history(null, 10)).entries.filter((e) => e.entry.t === 'msg')).toEqual([]);
    });
});

describe('Inbox rows', () => {
    it('a stop and a merge ask reach the inbox, deep-linked to the task', async () => {
        const stop = { reason: 'gave-up' as const, detail: 'Gave up on size after 3 attempts — your move.', at: 1 };
        expect(autopilotStopRow(pr, stop)).toEqual({ kind: 'input', title: 'r#9 needs you', body: stop.detail, ref: { kind: 'task', taskId: 'task_9' } });
        expect(autopilotMergeRow({ agentId: forge, rule: ASK_ON_MERGE, pr }).title).toBe('r#9: agent_forge asks to merge');
        await port().yourMove!({ pr, stop });
        await port().askMerge!({ agentId: forge, rule: ASK_ON_MERGE, pr });
        const inbox = app.as(user).actor(Inbox, inboxKey(ws));
        for (let i = 0; i < 20 && (await inbox.list()).length < 2; i++) await new Promise((r) => setTimeout(r, 5));
        expect((await inbox.list()).map((n) => n.title).sort()).toEqual(['r#9 needs you', 'r#9: agent_forge asks to merge']);
    });
});
