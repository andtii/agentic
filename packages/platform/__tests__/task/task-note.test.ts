/**
 * `Task.note` (#937): the branch a task's chat worktree works on and a short current-activity line ride on the task
 * and its TaskIndex row, without a transition; every status change clears the activity, a settled task keeps none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, Principal, TaskId, WorkspaceId } from '@agentic/core';
import { testActorApp, type TestActorApp } from '../../src/testing/index';
import { TASK_ACTIVITY_MAX, TaskActor, TaskIndex, taskIndexKey, taskKey } from '../../src/task/index';

const ws = 'ws_1' as WorkspaceId;
const a = 'agent_a' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([TaskActor, TaskIndex]);
    return app.start();
});
afterEach(() => app.stop());

const task = () => app.as(user).actor(TaskActor, taskKey(ws, 't1' as TaskId));
const row = async () => (await app.as(user).actor(TaskIndex, taskIndexKey(ws)).list()).find((r) => r.id === 't1');
const create = () => task().create({ objective: 'do the thing', origin: { kind: 'user', chatId: 'chat_1' as ChatId, messageId: 'msg_1' as MessageId }, assignee: a, context: [], constraints: {} }, { owner: a });

describe('Task.note (#937)', () => {
    it('records the branch and the activity on the task and its index row, with no transition', async () => {
        await create();
        const view = await task().note({ branch: ' agentic/ab12cd34 ', activity: 'Waiting for\n  a slot' });
        expect(view).toMatchObject({ branch: 'agentic/ab12cd34', activity: 'Waiting for a slot', status: 'queued' });
        expect(view.transitions).toEqual([]);
        expect(await row()).toMatchObject({ branch: 'agentic/ab12cd34', activity: 'Waiting for a slot', n: 0 });
        // A field left out keeps its value.
        await task().note({ activity: 'Rebasing' });
        expect(await row()).toMatchObject({ branch: 'agentic/ab12cd34', activity: 'Rebasing' });
    });

    it('a status change clears the activity but keeps the branch; a settled task keeps no activity', async () => {
        await create();
        await task().note({ branch: 'agentic/ab12cd34', activity: 'Queued behind 2' });
        await task().start('router');
        expect(await row()).toMatchObject({ status: 'active', branch: 'agentic/ab12cd34' });
        expect((await row())!.activity).toBeUndefined();
        await task().complete({ text: 'done', artifacts: [], verified: false }, 'router');
        const after = await task().note({ activity: 'late line' });
        expect(after.activity).toBeUndefined();
        expect((await row())!.activity).toBeUndefined();
    });

    it('cuts a long activity line, and refuses a branch that is not a branch name', async () => {
        await create();
        const view = await task().note({ activity: 'x'.repeat(TASK_ACTIVITY_MAX + 20) });
        expect(view.activity).toHaveLength(TASK_ACTIVITY_MAX);
        expect(view.activity!.endsWith('…')).toBe(true);
        await expect(task().note({ branch: 'has space' })).rejects.toThrow(/branch/);
        await expect(task().note({ branch: '  ' })).rejects.toThrow(/branch/);
    });
});
