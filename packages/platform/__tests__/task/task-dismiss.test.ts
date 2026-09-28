/**
 * `Task.dismiss` (#1040): a person clears a settled task from the Work view for everyone — `dismissedAt` on the task
 * and its TaskIndex row, no transition, the history kept — and the Undo brings it back. A live task is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, Principal, TaskId, WorkspaceId } from '@agentic/core';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';
import { TaskActor, TaskIndex, taskIndexKey, taskKey } from '../../src/task/index';

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

describe('Task.dismiss (#1040)', () => {
    it('marks a failed task dismissed on the task and its index row, keeps its history, and undoes', async () => {
        await create();
        await task().start('router');
        await task().fail({ code: 'boom', message: 'it broke', recoverable: true }, 'router');
        const before = (await task().get()).transitions.length;
        const view = await task().dismiss('user');
        expect(view.dismissedAt).toBeTypeOf('number');
        expect(view.status).toBe('failed');
        expect(view.transitions).toHaveLength(before);
        expect((await row())!.dismissedAt).toBe(view.dismissedAt);
        // Dismissing again changes nothing.
        expect((await task().dismiss('user')).dismissedAt).toBe(view.dismissedAt);
        // The Undo.
        expect((await task().dismiss('user', false)).dismissedAt).toBeUndefined();
        expect((await row())!.dismissedAt).toBeUndefined();
    });

    it('refuses a live task: stop it first', async () => {
        await create();
        expect(await statusOf(task().dismiss('user'))).toBe(409);
        await task().start('router');
        expect(await statusOf(task().dismiss('user'))).toBe(409);
    });
});
