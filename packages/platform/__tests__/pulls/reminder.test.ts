/**
 * The Pulls actor's own reminder (#742): after `watch`, polls come from the durable reminder alone — a merge
 * observed there completes the task with nobody calling the actor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import type { AgentId, ChatId, MessageId, Principal, ProjectId, PullRequest, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { TaskActor, taskKey } from '../../src/task/index';
import { definePullsActor, POLL_FLOOR_MS, pullsKey } from '../../src/pulls/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const open: PullRequest = {
    provider: 'github',
    repo: 'o/r',
    number: 21,
    title: 'Add pulls',
    url: 'https://github.com/o/r/pull/21',
    head: 'chat/21',
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [{ name: 'ci', state: 'running' }],
    review: { state: 'none', reviewers: [], threads: [] }
};

let scheduler: ManualScheduler;
let app: TestActorApp;
let current: PullRequest;
let reads = 0;
const Pulls = definePullsActor({
    sources: {
        open: () => ({
            get: async () => (reads++, current),
            listOpen: async () => (reads++, current.state === 'open' ? [current] : [])
        })
    },
    audit: capturingAuditPort()
});

const yieldTurns = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
};
/** One reminder tick, a floor later. */
async function tick(): Promise<void> {
    vi.setSystemTime(Date.now() + POLL_FLOOR_MS);
    scheduler.advance(POLL_FLOOR_MS);
    await yieldTurns(30);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    current = open;
    reads = 0;
    scheduler = manualScheduler();
    app = testActorApp([TaskActor, Pulls], { scheduler, defaults: { reminderTickMs: POLL_FLOOR_MS } });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

describe('the poll reminder', () => {
    it('polls on its own and completes the waiting task when the PR merges', async () => {
        const task = app.as(user).actor(TaskActor, taskKey(ws, 't1' as TaskId));
        await task.create({ objective: 'ship', origin: { kind: 'user', chatId: 'c' as ChatId, messageId: 'm' as MessageId }, assignee: 'agent_a' as AgentId, context: [], constraints: {} }, { owner: 'agent_a' as AgentId });
        await task.start('user:u1', 'sess_1' as SessionId);
        const pulls = app.as(user).actor(Pulls, pullsKey(ws, 'prj_1' as ProjectId));
        await pulls.watch({ provider: 'github', repo: 'o/r' });
        await pulls.report(21, { taskId: 't1' as TaskId });
        expect((await task.get()).status).toBe('waiting');

        const before = reads;
        await tick();
        expect(reads).toBeGreaterThan(before);
        expect((await task.get()).status).toBe('waiting');

        current = { ...open, state: 'merged', checks: [{ name: 'ci', state: 'passed' }] };
        await tick();
        expect((await task.get()).status).toBe('completed');
        expect((await pulls.get()).pulls[0]?.state).toBe('merged');
    });
});
