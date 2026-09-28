/**
 * A task's plan item (#1073, `TaskContract.planItem`): the Task actor keeps it
 * from create to view, like `projectId`, and a delegated child does not
 * inherit it — the child is not the item's work, so it never lands in the
 * item's worktree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, Principal, ProjectId, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { testActorApp, type TestActorApp } from '../../src/testing/index';
import { TaskActor, taskKey } from '../../src/task/index';

const ws = 'ws_1' as WorkspaceId;
const a = 'agent_a' as AgentId;
const b = 'agent_b' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([TaskActor]);
    return app.start();
});
afterEach(() => app.stop());

const task = (taskId: string) => app.as(user).actor(TaskActor, taskKey(ws, taskId as TaskId));

describe('a task carrying a plan item (#1073)', () => {
    it('keeps planItem from create to view, and a delegated child does not inherit it (the project it does)', async () => {
        const root = task('root_p');
        const created = await root.create(
            { objective: 'Plan #7: do it', origin: { kind: 'user', chatId: 'chat_1' as ChatId, messageId: 'msg_1' as MessageId }, assignee: a, context: [], constraints: {}, projectId: 'proj_1' as ProjectId, planItem: 7 },
            { owner: a }
        );
        expect(created.planItem).toBe(7);
        expect((await root.get()).planItem).toBe(7);
        await root.start('user:u1', 'sess_r' as SessionId);
        const child = await task(await root.delegate({ callId: 'call_1', objective: 'sub', assignee: b })).get();
        expect(child.projectId).toBe('proj_1');
        expect(child).not.toHaveProperty('planItem');
    });

    it('a task without one has none', async () => {
        const created = await task('bare').create({ objective: 'x', origin: { kind: 'external', clientId: 'c1' }, assignee: a, context: [], constraints: {} }, { owner: a });
        expect(created).not.toHaveProperty('planItem');
    });
});
