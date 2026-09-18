/**
 * The TaskIndex (#146): the Task actor writes one row per task over a hop
 * on create and after every status or wait change; `list` filters and
 * orders them newest first; a late row never overwrites a newer one; a
 * task on a host without the index still works.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, Principal, SessionId, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';
import { sameWorkspace } from '../../src/auth/index';
import { TaskActor, TaskIndex, taskIndexKey, taskIndexRowOf, taskKey, trimIndex, type TaskIndexRow } from '../../src/task/index';
import { initialTaskState, applyTaskEntry } from '../../src/task/entries';

const ws = 'ws_1' as WorkspaceId;
const a = 'agent_a' as AgentId;
const b = 'agent_b' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const other: Principal = { kind: 'user', userId: 'u2', workspaceId: 'ws_2' as WorkspaceId };

let app: TestActorApp;
afterEach(() => app.stop());

const id = (s: string) => s as TaskId;
const task = (taskId: TaskId) => app.as(user).actor(TaskActor, taskKey(ws, taskId));
const index = (principal: Principal | null = user) => app.as(principal).actor(TaskIndex, taskIndexKey(ws));
const contract = (extra: Partial<TaskContract> = {}): TaskContract => ({
    objective: 'do the thing',
    origin: { kind: 'user', chatId: 'chat_1' as ChatId, messageId: 'msg_1' as MessageId },
    assignee: a,
    context: [],
    constraints: {},
    ...extra
});

describe('TaskIndex with the Task actor', () => {
    beforeEach(() => {
        app = testActorApp([TaskActor, TaskIndex]);
        return app.start();
    });

    it('create writes a row, every transition updates it, and list is newest first', async () => {
        await task(id('t1')).create(contract({ objective: 'first' }), { owner: a });
        await new Promise((r) => setTimeout(r, 2));
        await task(id('t2')).create(contract({ objective: 'second', assignee: b }), { owner: b });
        let rows = await index().list();
        expect(rows.map((r) => [r.id, r.status, r.origin, r.chatId, r.n])).toEqual([
            ['t2', 'queued', 'user', 'chat_1', 0],
            ['t1', 'queued', 'user', 'chat_1', 0]
        ]);
        expect(rows[1]!.createdAt).toBeLessThan(rows[0]!.createdAt);

        await task(id('t1')).start('user:u1', 'sess_1' as SessionId);
        await task(id('t1')).reportWaiting({ kind: 'input', requestId: 'rq_1' }, 'agent:agent_a');
        rows = await index().list({ status: ['waiting'] });
        expect(rows.map((r) => [r.id, r.status, r.wait?.kind, r.sessionId, r.n])).toEqual([['t1', 'waiting', 'input', 'sess_1', 2]]);

        await task(id('t1')).resolveWaiting('user:u1');
        await task(id('t1')).complete({ text: 'done', artifacts: [], verified: false }, 'agent:agent_a');
        rows = await index().list();
        const t1 = rows.find((r) => r.id === 't1')!;
        expect(t1.status).toBe('completed');
        expect(t1.wait).toBeUndefined();
        expect(t1.n).toBe(4);
        expect(await index().list({ assignee: b })).toHaveLength(1);
        expect(await index().list({ status: ['queued'], limit: 0 })).toEqual([]);
        expect(await index().size()).toBe(2);
    });

    it('a delegated child is indexed under its parent, whose wait row follows the children', async () => {
        const t = task(id('p'));
        await t.create(contract(), { owner: a });
        await t.start('agent:agent_a', 'sess_p' as SessionId);
        const child = await t.delegate({ callId: 'c1', objective: 'sub', assignee: b });
        const rows = await index().list();
        expect(rows.map((r) => [r.id, r.status, r.parentId ?? null, r.depth, r.origin])).toEqual([
            [child, 'queued', 'p', 1, 'agent'],
            ['p', 'waiting', null, 0, 'user']
        ]);
        expect(await index().list({ parentId: null })).toHaveLength(1);
        expect(await index().list({ parentId: id('p') })).toHaveLength(1);
        const second = await t.delegate({ callId: 'c2', objective: 'sub 2', assignee: b });
        expect((await index().list({ parentId: null }))[0]!.wait).toEqual({ kind: 'child', childTaskIds: [child, second] });
        await app.as(user).actor(TaskActor, taskKey(ws, child)).start('agent:agent_b');
        await app.as(user).actor(TaskActor, taskKey(ws, child)).complete({ text: 'ok', artifacts: [], verified: false }, 'agent:agent_b');
        // One child settled: the parent still waits, on the other one.
        expect((await index().list({ parentId: null }))[0]!.wait).toEqual({ kind: 'child', childTaskIds: [second] });
    });

    it('is read by the workspace only and never written over the wire', async () => {
        await task(id('t1')).create(contract(), { owner: a });
        expect(await statusOf(index(other).list())).toBe(403);
        const row = (await index().list())[0]!;
        expect(await statusOf(index().upsert({ ...row, status: 'failed' }))).toBe(403);
        expect((await index().list())[0]!.status).toBe('queued');
    });
});

/** What the Task actor is to the index: a hop, which runs no policy. */
const Hopper = defineActor({
    type: 'hopper',
    authorize: [sameWorkspace],
    state: () => ({}),
    methods: (ctx) => ({
        upsert: (row: TaskIndexRow) => ctx.actor(TaskIndex, taskIndexKey(ws)).upsert(row)
    })
});

describe('TaskIndex alone', () => {
    beforeEach(() => {
        app = testActorApp([TaskIndex, Hopper]);
        return app.start();
    });

    /** A row as the Task would write it, through the same builder. */
    function rowOf(taskId: string, n: number, at: number, status: TaskIndexRow['status'] = 'queued'): TaskIndexRow {
        const state = initialTaskState(taskKey(ws, id(taskId)));
        applyTaskEntry(state, { t: 'created', at, contract: contract(), owner: a, depth: 0, configVersion: 0 });
        state.status = status;
        for (let i = 0; i < n; i++) applyTaskEntry(state, { t: 'transition', from: 'queued', to: status, at: at + i + 1, by: 'x', why: 'y' });
        return taskIndexRowOf(state, at + n + 1);
    }

    it('keeps the newest row per task: a lower transition count or an older write of the same count is ignored', async () => {
        const hop = app.as(user).actor(Hopper, `${ws}:hopper`);
        expect(await hop.upsert(rowOf('t', 2, 1_000, 'active'))).toBe(true);
        expect(await hop.upsert(rowOf('t', 1, 5_000, 'queued'))).toBe(false);
        expect((await index().list())[0]!.status).toBe('active');
        expect(await hop.upsert({ ...rowOf('t', 2, 1_000, 'active'), updatedAt: 500, status: 'waiting' })).toBe(false);
        expect(await hop.upsert(rowOf('t', 3, 2_000, 'completed'))).toBe(true);
        const row = (await index().list())[0]!;
        expect(row.status).toBe('completed');
        // The first `createdAt` stays whatever a later row says.
        expect(row.createdAt).toBe(1_001);
    });

    it('drops the oldest settled rows past the cap, never a live one', () => {
        const rows: Record<string, TaskIndexRow> = {};
        rows['live-old'] = rowOf('live-old', 0, 1);
        for (let i = 0; i < 6; i++) rows[`done-${i}`] = rowOf(`done-${i}`, 1, 10 + i, i % 2 ? 'completed' : 'failed');
        expect(trimIndex(rows, 4)).toEqual(['done-2', 'done-1', 'done-0']);
        expect(Object.keys(rows).sort()).toEqual(['done-3', 'done-4', 'done-5', 'live-old']);
        expect(trimIndex(rows, 4)).toEqual([]);
        // Only live rows left over the cap: nothing is dropped.
        const live: Record<string, TaskIndexRow> = { a: rowOf('a', 0, 1, 'active'), b: rowOf('b', 0, 2, 'waiting') };
        expect(trimIndex(live, 1)).toEqual([]);
    });
});

describe('Task without an index on the host', () => {
    beforeEach(() => {
        app = testActorApp([TaskActor]);
        return app.start();
    });

    it('still creates and transitions', async () => {
        const t = task(id('t1'));
        await t.create(contract(), { owner: a });
        await t.start('user:u1');
        expect((await t.get()).status).toBe('active');
    });
});
