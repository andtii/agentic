/**
 * The TaskIndex inside workerd (#146): a task created and moved through
 * the HTTP mount writes its row to the workspace's index over a hop
 * between two Durable Objects, the row survives an eviction of either
 * object, and the index refuses a write over the wire.
 */
import { env, evictDurableObject } from 'cloudflare:test';
import type { AgentId, ChatId, MessageId, TaskId, WorkspaceId } from '@agentic/core';
import { TaskActor, TaskIndex, taskIndexKey, taskKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { overHttp, seen, signIn } from './http';

const userId = 'gh_1146';
const workspaceId = userId as WorkspaceId;

afterEach(() => {
    seen.length = 0;
});

describe('worker: the task index over Durable Objects', () => {
    it('a task created and moved over the mount lands on the index, hop by hop, and survives eviction', async () => {
        const cookie = await signIn(userId);
        const index = overHttp(TaskIndex, taskIndexKey(workspaceId), cookie);
        const taskId = 't_wk1' as TaskId;
        const task = overHttp(TaskActor, taskKey(workspaceId, taskId), cookie);
        await task.create({ objective: 'index me', origin: { kind: 'user', chatId: 'c1' as ChatId, messageId: 'm1' as MessageId }, assignee: 'ada' as AgentId, context: [], constraints: {} }, { owner: 'ada' as AgentId });
        expect((await index.list()).map((r) => [r.id, r.status, r.n])).toEqual([[taskId, 'queued', 0]]);

        await task.start('user:gh_1146');
        await task.reportWaiting({ kind: 'input', requestId: 'rq_1' }, 'agent:ada');
        const [waiting] = await index.list({ status: ['waiting'] });
        expect(waiting).toMatchObject({ id: taskId, status: 'waiting', wait: { kind: 'input', requestId: 'rq_1' }, n: 2, chatId: 'c1' });

        // Both objects gone from memory: the index re-reads its record, the task its log.
        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        await evictDurableObject(namespace.get(namespace.idFromName(durableObjectName({ type: 'task-index', key: taskIndexKey(workspaceId) }))));
        await evictDurableObject(namespace.get(namespace.idFromName(durableObjectName({ type: 'task', key: taskKey(workspaceId, taskId) }))));
        expect((await index.list()).map((r) => [r.id, r.status])).toEqual([[taskId, 'waiting']]);
        await task.resolveWaiting('user:gh_1146');
        await task.complete({ text: 'done', artifacts: [], verified: false }, 'agent:ada');
        expect((await index.list()).map((r) => [r.id, r.status, r.n])).toEqual([[taskId, 'completed', 4]]);
        expect((await task.get()).status).toBe('completed');
    });

    it('refuses a write over the wire and another workspace', async () => {
        const cookie = await signIn(userId);
        const index = overHttp(TaskIndex, taskIndexKey(workspaceId), cookie);
        const [row] = await index.list();
        expect(row).toBeDefined();
        await expect(index.upsert({ ...row!, status: 'failed' })).rejects.toMatchObject({ status: 403 });
        await expect(overHttp(TaskIndex, taskIndexKey('gh_2002'), cookie).list()).rejects.toMatchObject({ status: 403 });
    });
});
