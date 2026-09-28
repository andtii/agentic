/**
 * `Task.dismiss` / `undismiss` (#1040): a person clears a settled task off the Work view for every viewer. The task
 * keeps its record and history; the dismissal rides on the task (it survives a reload) and on its TaskIndex row as
 * `dismissedAt`. A task still in flight is refused; both calls are idempotent. `tallyProjectWork` skips dismissed
 * tasks and failed ones older than a week, as the Work view does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, Principal, TaskId, WorkspaceId } from '@agentic/core';
import { testActorApp, type TestActorApp } from '../../src/testing/index';
import { TaskActor, TaskIndex, taskIndexKey, taskKey, type TaskIndexRow } from '../../src/task/index';
import { tallyProjectWork } from '../../src/workspace/project-work';

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
    it('records the dismissal on a failed task and its index row; undismiss takes it back', async () => {
        await create();
        await task().start('router');
        await task().fail({ code: 'runtime', message: 'boom', recoverable: false }, 'router');
        const view = await task().dismiss('user');
        expect(view.status).toBe('failed');
        expect(typeof view.dismissedAt).toBe('number');
        expect((await row())!.dismissedAt).toBe(view.dismissedAt);
        // Idempotent: a second dismiss keeps the first time.
        expect((await task().dismiss('user')).dismissedAt).toBe(view.dismissedAt);
        // The history stays: no transition was added.
        expect(view.transitions.map((t) => t.to)).toEqual(['active', 'failed']);

        const back = await task().undismiss('user');
        expect(back.dismissedAt).toBeUndefined();
        expect((await row())!.dismissedAt).toBeUndefined();
        expect((await task().undismiss('user')).dismissedAt).toBeUndefined();
    });

    it('survives a reload of the task actor', async () => {
        await create();
        await task().cancel('user', { timeoutMs: 10 });
        await task().dismiss('user');
        const storage = app.storage;
        await app.stop();
        // A fresh host on the same storage replays the log.
        app = testActorApp([TaskActor, TaskIndex], { storage });
        await app.start();
        expect(typeof (await task().get()).dismissedAt).toBe('number');
        expect(typeof (await row())!.dismissedAt).toBe('number');
    });

    it('refuses a task still in flight', async () => {
        await create();
        await expect(task().dismiss('user')).rejects.toMatchObject({ code: 'wrong-state' });
        await task().start('router');
        await expect(task().dismiss('user')).rejects.toMatchObject({ code: 'wrong-state' });
        expect((await row())!.dismissedAt).toBeUndefined();
    });
});

describe('tallyProjectWork skips cleared failures (#1040)', () => {
    const NOW = 1_000_000_000_000;
    const DAY = 24 * 3_600_000;
    const failed = (id: string, more: Partial<TaskIndexRow> = {}): TaskIndexRow => ({
        id: id as TaskId, objective: id, assignee: a, owner: a, status: 'failed', origin: 'user', depth: 0, createdAt: NOW - DAY, updatedAt: NOW - DAY, n: 2, ...more
    });

    it('counts a fresh failure, not a dismissed one nor one older than a week', () => {
        const tally = tallyProjectWork([failed('t_fresh'), failed('t_gone', { dismissedAt: NOW }), failed('t_old', { updatedAt: NOW - 8 * DAY })], [], [], NOW);
        expect(tally.yourMove).toBe(1);
        expect(tally.next).toEqual(['retry t_fresh']);
    });
});
