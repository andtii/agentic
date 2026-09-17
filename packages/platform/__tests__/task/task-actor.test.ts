/**
 * The Task actor against a real in-process host (the shared `testActorApp`
 * harness) under a workspace principal, through the entry point that runs
 * `authorize`. Offline and deterministic: the only timers are the cancel
 * deadlines, and every assertion that depends on one waits for the `cancel`
 * promise rather than on wall time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childTaskId } from '@agentic/core';
import type { AgentId, ChatId, MessageId, Principal, SessionId, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';
import { TaskActor, parseTaskKey, taskKey } from '../../src/task/index';
import type { TaskOutcome } from '../../src/task/index';

const ws = 'ws_1' as WorkspaceId;
const a = 'agent_a' as AgentId;
const b = 'agent_b' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };

// One app per test: a stopped app cannot restart, and no state may leak between cases.
let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([TaskActor]);
    return app.start();
});
afterEach(() => app.stop());

const id = (s: string) => s as TaskId;
const task = (taskId: TaskId, principal: Principal | null = user) => app.as(principal).actor(TaskActor, taskKey(ws, taskId));
const contract = (extra: Partial<TaskContract> = {}): TaskContract => ({
    objective: 'do the thing',
    origin: { kind: 'user', chatId: 'chat_1' as ChatId, messageId: 'msg_1' as MessageId },
    assignee: a,
    context: [{ type: 'text', text: 'hello' }],
    constraints: {},
    ...extra
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('keys', () => {
    it('round-trips through actorKey and rejects other shapes', () => {
        expect(taskKey(ws, id('task_1'))).toBe('ws_1:task:task_1');
        expect(parseTaskKey('ws_1:task:task_1.call_1')).toEqual({ workspaceId: ws, id: 'task_1.call_1' });
        expect(() => parseTaskKey('ws_1:chat:c1')).toThrow(/not a task key/);
        expect(() => parseTaskKey('ws_1:task:')).toThrow(/not a task key/);
    });
});

describe('lifecycle', () => {
    it('AC-05: the snapshot exposes owner, objective, origin, status and result', async () => {
        const t = task(id('task_1'));
        const created = await t.create(contract(), { owner: a });
        expect(created).toMatchObject({ id: 'task_1', owner: a, objective: 'do the thing', status: 'queued', depth: 0, children: [] });
        expect(created.origin).toEqual({ kind: 'user', chatId: 'chat_1', messageId: 'msg_1' });
        expect(created.result).toBeUndefined();
        await t.start('user:u1', 'sess_1' as SessionId);
        const done = await t.complete({ text: 'done', artifacts: [], verified: false }, 'agent:agent_a');
        expect(done.status).toBe('completed');
        expect(done.result).toEqual({ text: 'done', artifacts: [], verified: false });
        expect(done.sessionId).toBe('sess_1');
        // create is idempotent: a second call returns the task as it stands.
        const again = await t.create(contract({ objective: 'other' }), { owner: b });
        expect(again.objective).toBe('do the thing');
        expect(again.status).toBe('completed');
    });

    it('every legal transition appends one entry with from, to, by and why', async () => {
        const t = task(id('task_2'));
        await t.create(contract(), { owner: a });
        await t.start('user:u1');
        await t.reportWaiting({ kind: 'input', requestId: 'rq_1' }, 'agent:agent_a');
        expect(await t.explain()).toEqual({ kind: 'input', requestId: 'rq_1' });
        await t.resolveWaiting('user:u1', 'answered');
        expect(await t.explain()).toBeNull();
        const view = await t.fail({ code: 'boom', message: 'it broke', recoverable: false }, 'agent:agent_a');
        expect(view.error?.code).toBe('boom');
        expect(view.transitions.map((x) => [x.from, x.to, x.by, x.why])).toEqual([
            ['queued', 'active', 'user:u1', 'started'],
            ['active', 'waiting', 'agent:agent_a', 'waiting: input'],
            ['waiting', 'active', 'user:u1', 'answered'],
            ['active', 'failed', 'agent:agent_a', 'failed: boom']
        ]);
        expect(view.transitions[1]?.wait).toEqual({ kind: 'input', requestId: 'rq_1' });
        for (const x of view.transitions) expect(typeof x.at).toBe('number');
    });

    it('illegal transitions throw and leave no entry behind', async () => {
        const t = task(id('task_3'));
        await expect(t.start('user:u1')).rejects.toThrow(/has not been created/);
        await t.create(contract(), { owner: a });
        await expect(t.complete({ artifacts: [], verified: false }, 'x')).rejects.toThrow(/illegal transition queued -> completed/);
        await t.start('user:u1');
        await expect(t.resolveWaiting('x')).rejects.toThrow(/illegal transition active -> active/);
        await expect(t.start('user:u1')).rejects.toThrow(/illegal transition active -> active/);
        await t.complete({ artifacts: [], verified: false }, 'agent:agent_a');
        await expect(t.fail({ code: 'late', message: '', recoverable: false }, 'x')).rejects.toThrow(/illegal transition completed -> failed/);
        expect((await t.get()).transitions).toHaveLength(2);
        // Cancelling finished work is a no-op report, not a transition.
        expect(await t.cancel('user:u1')).toEqual({ id: 'task_3', stopped: true, notStopped: [] });
        expect((await t.get()).status).toBe('completed');
    });

    it('start runs only from queued and resolveWaiting only from waiting', async () => {
        const t = task(id('task_3b'));
        await t.create(contract(), { owner: a });
        await expect(t.resolveWaiting('user:u1')).rejects.toMatchObject({ name: 'TaskStateError', code: 'wrong-state' });
        await t.start('user:u1');
        await t.reportWaiting({ kind: 'input', requestId: 'req_1' }, 'agent:agent_a');
        await expect(t.start('user:u1')).rejects.toMatchObject({ name: 'TaskStateError', code: 'wrong-state' });
        let view = await t.get();
        expect(view.status).toBe('waiting');
        expect(view.transitions).toHaveLength(2);
        await t.resolveWaiting('user:u1');
        view = await t.get();
        expect(view.status).toBe('active');
        expect(view.transitions).toHaveLength(3);
    });

    it('the result stream resolves on the terminal state', async () => {
        const t = task(id('task_4'));
        await t.create(contract(), { owner: a });
        const outcomes: TaskOutcome[] = [];
        const consumed = (async () => {
            for await (const o of t.result()) outcomes.push(o);
        })();
        await t.start('user:u1');
        await t.complete({ output: { n: 1 }, artifacts: [], verified: true }, 'agent:agent_a');
        await consumed;
        expect(outcomes).toEqual([{ id: 'task_4', status: 'completed', result: { output: { n: 1 }, artifacts: [], verified: true } }]);
    });

    it('survives deactivation: the log replays into the same state', async () => {
        const t = task(id('task_5'));
        await t.create(contract(), { owner: a });
        await t.start('user:u1', 'sess_5' as SessionId);
        await t.recordUsage({ inputTokens: 10, outputTokens: 5 }, 0.25);
        await t.reportWaiting({ kind: 'approval', requestId: 'rq_9', sessionId: 'sess_5' as SessionId }, 'agent:agent_a');
        const before = await t.get();
        await app.host.deactivate({ type: 'task', key: taskKey(ws, id('task_5')) });
        expect(await t.get()).toEqual(before);
        expect(before.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
        expect(before.costUsd).toBe(0.25);
    });

    it('refuses a principal from another workspace, and an anonymous caller', async () => {
        await task(id('task_6')).create(contract(), { owner: a });
        const stranger: Principal = { kind: 'user', userId: 'u2', workspaceId: 'ws_2' as WorkspaceId };
        expect(await statusOf(task(id('task_6'), stranger).get())).toBe(403);
        expect(await statusOf(task(id('task_6'), null).get())).toBe(401);
        expect(await statusOf(task(id('task_6')).get())).toBeUndefined();
    });
});

describe('delegation', () => {
    it('creates the child deterministically, links both sides and parks the parent on waiting {child}', async () => {
        const root = task(id('root'));
        await root.create(contract({ constraints: { maxDepth: 3 } }), { owner: a });
        await expect(root.delegate({ callId: 'call_1', objective: 'sub', assignee: b, sessionId: 'sess_r' as SessionId })).rejects.toThrow(/only an active task delegates/);
        await root.start('user:u1', 'sess_r' as SessionId);
        const childId = await root.delegate({ callId: 'call_1', objective: 'sub', assignee: b, context: [{ type: 'text', text: 'ctx' }] });
        expect(childId).toBe(childTaskId(id('root'), 'call_1'));
        // Same call id → same child, no second creation.
        expect(await root.delegate({ callId: 'call_1', objective: 'sub', assignee: b })).toBe(childId);

        const parent = await root.get();
        expect(parent.status).toBe('waiting');
        expect(parent.wait).toEqual({ kind: 'child', childTaskIds: [childId] });
        expect(parent.children).toEqual([childId]);
        expect(await root.explain()).toEqual({ kind: 'child', childTaskIds: [childId] });

        const child = await task(childId).get();
        expect(child).toMatchObject({ id: childId, owner: a, assignee: b, depth: 1, parentId: 'root', status: 'queued', objective: 'sub' });
        expect(child.origin).toEqual({ kind: 'agent', agentId: a, taskId: 'root', sessionId: 'sess_r', callId: 'call_1' });
        expect(child.constraints.maxDepth).toBe(3);
        expect(child.context).toEqual([{ type: 'text', text: 'ctx' }]);

        const tree = await root.tree();
        expect(tree).toMatchObject({ id: 'root', status: 'waiting', children: [{ id: childId, status: 'queued', children: [] }] });

        // The child settling resumes the parent and clears the wait.
        await task(childId).start('agent:agent_b');
        await task(childId).complete({ text: 'sub done', artifacts: [], verified: false }, 'agent:agent_b');
        const resumed = await root.get();
        expect(resumed.status).toBe('active');
        expect(resumed.wait).toBeUndefined();
        expect(resumed.transitions.at(-1)).toMatchObject({ from: 'waiting', to: 'active', by: `task:${childId}`, why: 'child completed' });
    });

    it('the depth limit rejects the 4th level', async () => {
        const root = task(id('d0'));
        await root.create(contract({ constraints: { maxDepth: 3 } }), { owner: a });
        await root.start('user:u1', 'sess_0' as SessionId);
        let current = id('d0');
        for (let level = 1; level <= 3; level++) {
            const next = await task(current).delegate({ callId: `c${level}`, objective: `level ${level}`, assignee: b, sessionId: 'sess_x' as SessionId });
            expect((await task(next).get()).depth).toBe(level);
            await task(next).start('agent:agent_b');
            current = next;
        }
        await expect(task(current).delegate({ callId: 'c4', objective: 'level 4', assignee: b, sessionId: 'sess_x' as SessionId })).rejects.toThrow(/depth 4 exceeds maxDepth 3/);
        expect((await task(current).get()).children).toEqual([]);
    });

    it('the budget split never exceeds the parent’s remaining', async () => {
        const root = task(id('bud'));
        await root.create(contract({ constraints: { maxCostUsd: 10, maxTokens: 1000, maxConcurrentChildren: 4 } }), { owner: a });
        await root.start('user:u1', 'sess_b' as SessionId);
        await root.recordUsage({ inputTokens: 300, outputTokens: 100 }, 4);

        const c1 = await root.delegate({ callId: 'c1', objective: 'one', assignee: b, constraints: { maxCostUsd: 20, maxTurns: 5 } });
        const first = (await task(c1).get()).constraints;
        expect(first.maxCostUsd).toBe(6); // 10 − 4 spent, clamped from the 20 asked
        expect(first.maxTokens).toBe(600); // inherited remaining
        expect(first.maxTurns).toBe(5); // the parent carries no turn budget: passes through
        expect(first.maxConcurrentChildren).toBe(4);

        // The first child holds the whole remaining cost budget while it lives.
        await expect(root.delegate({ callId: 'c2', objective: 'two', assignee: b })).rejects.toThrow(/no maxCostUsd left/);

        await task(c1).start('agent:agent_b');
        await task(c1).complete({ artifacts: [], verified: false }, 'agent:agent_b');
        const c3 = await root.delegate({ callId: 'c3', objective: 'three', assignee: b, constraints: { maxCostUsd: 2 } });
        expect((await task(c3).get()).constraints.maxCostUsd).toBe(2);
    });

    it('the concurrency limit caps unsettled children', async () => {
        const root = task(id('conc'));
        await root.create(contract({ constraints: { maxConcurrentChildren: 1 } }), { owner: a });
        await root.start('user:u1', 'sess_c' as SessionId);
        await root.delegate({ callId: 'c1', objective: 'one', assignee: b });
        await expect(root.delegate({ callId: 'c2', objective: 'two', assignee: b })).rejects.toThrow(/maxConcurrentChildren 1/);
    });
});

describe('stop cascade', () => {
    /** root → c1 → c2 → c3, every node active, no sessions attached. */
    async function chain(): Promise<TaskId[]> {
        const root = id('chain');
        await task(root).create(contract(), { owner: a });
        await task(root).start('user:u1');
        const ids = [root];
        for (let level = 1; level <= 3; level++) {
            const next = await task(ids[level - 1]!).delegate({ callId: `c${level}`, objective: `level ${level}`, assignee: b, sessionId: 'sess_x' as SessionId });
            await task(next).start('agent:agent_b');
            ids.push(next);
        }
        return ids;
    }

    it('a 3-deep tree cancels every node', async () => {
        const ids = await chain();
        const report = await task(ids[0]!).cancel('user:u1', { timeoutMs: 2000 });
        expect(report).toEqual({ id: 'chain', stopped: true, notStopped: [] });
        for (const t of ids) {
            const view = await task(t).get();
            expect(view.status).toBe('cancelled');
            expect(view.cancel).toMatchObject({ by: 'user:u1', stopped: true });
            expect(view.transitions.at(-1)).toMatchObject({ to: 'cancelled', by: 'user:u1', why: 'cancel requested' });
        }
        const tree = await task(ids[0]!).tree();
        expect(tree.stopped).toBe(true);
        expect(tree.children[0]?.children[0]?.children[0]).toMatchObject({ id: ids[3], status: 'cancelled', stopped: true, children: [] });
    });

    it('a child that never acks is listed as not stopped', async () => {
        const root = task(id('strag'));
        await root.create(contract(), { owner: a });
        await root.start('user:u1', 'sess_s' as SessionId);
        const c1 = await root.delegate({ callId: 'c1', objective: 'one', assignee: b });
        // The child runs a session that nobody confirms stopped.
        await task(c1).start('agent:agent_b', 'sess_c1' as SessionId);
        await root.sessionStopped();

        const report = await root.cancel('user:u1', { timeoutMs: 150 });
        expect(report.stopped).toBe(false);
        expect(report.notStopped).toEqual([c1]);
        expect((await root.get()).cancel).toMatchObject({ stopped: false });
        expect((await root.get()).notStopped).toEqual([c1]);
        const child = await task(c1).get();
        expect(child.status).toBe('cancelled');
        expect(child.cancel).toMatchObject({ stopped: false });
        expect(child.notStopped).toEqual([c1]);

        // The session's late word still lands on the child.
        await task(c1).sessionStopped();
        expect((await task(c1).get()).cancel).toMatchObject({ stopped: true });
    });

    it('a session acknowledged during the wait counts as stopped', async () => {
        const root = task(id('ack'));
        await root.create(contract(), { owner: a });
        await root.start('user:u1', 'sess_a' as SessionId);
        const c1 = await root.delegate({ callId: 'c1', objective: 'one', assignee: b });
        await task(c1).start('agent:agent_b', 'sess_c1' as SessionId);

        const pending = root.cancel('user:u1', { timeoutMs: 5000 });
        await sleep(20);
        await task(c1).sessionStopped();
        await root.sessionStopped();
        const report = await pending;
        expect(report).toEqual({ id: 'ack', stopped: true, notStopped: [] });
        expect((await task(c1).get()).cancel).toMatchObject({ stopped: true });
    });

    it('cancelling twice returns the settled report', async () => {
        const t = task(id('twice'));
        await t.create(contract(), { owner: a });
        await t.start('user:u1');
        const first = await t.cancel('user:u1', { timeoutMs: 100 });
        const second = await t.cancel('user:u2', { timeoutMs: 100 });
        expect(second).toEqual(first);
        expect((await t.get()).transitions.filter((x) => x.to === 'cancelled')).toHaveLength(1);
    });
});
