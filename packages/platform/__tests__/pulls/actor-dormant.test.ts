/**
 * The Pulls actor goes dormant without demand (#985): with no reader, no running check, no autopilot turn and no
 * waiting task, a poll arms nothing — the reminder stops reading GitHub. A `get` of stale data wakes it; demand keeps
 * the floor cadence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import type { AgentId, ChatId, MessageId, Principal, ProjectId, PullRequest, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { TaskActor, taskKey } from '../../src/task/index';
import { definePullsActor, POLL_FLOOR_MS, POLL_MAX_MS, pullsKey, VIEW_DEMAND_MS, type PullsAutopilotPort } from '../../src/pulls/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const quiet: PullRequest = {
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
    checks: [{ name: 'ci', state: 'passed' }],
    review: { state: 'none', reviewers: [], threads: [] }
};

let scheduler: ManualScheduler;
let app: TestActorApp;
let current: PullRequest;
let reads = 0;
let turns = 0;
const autopilot: PullsAutopilotPort = {
    startTurn: async () => (turns++, { taskId: `t_turn_${turns}` as TaskId }),
    merge: async () => ({ merged: false })
};
const Pulls = definePullsActor({
    sources: {
        open: () => ({
            get: async () => (reads++, current),
            listOpen: async () => (reads++, current.state === 'open' ? [current] : [])
        })
    },
    audit: capturingAuditPort(),
    // Read at call time: the tests move the faked Date.
    now: () => Date.now(),
    autopilot: () => autopilot
});

const yieldTurns = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
};
/** `n` reminder ticks, a floor apart. */
async function ticks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
        vi.setSystemTime(Date.now() + POLL_FLOOR_MS);
        scheduler.advance(POLL_FLOOR_MS);
        await yieldTurns(20);
    }
}
const pulls = () => app.as(user).actor(Pulls, pullsKey(ws, 'prj_1' as ProjectId));
/** Reads over the next `n` ticks. */
async function readsOver(n: number): Promise<number> {
    const before = reads;
    await ticks(n);
    return reads - before;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    current = quiet;
    reads = 0;
    turns = 0;
    scheduler = manualScheduler();
    app = testActorApp([TaskActor, Pulls], { scheduler, defaults: { reminderTickMs: POLL_FLOOR_MS } });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

describe('dormant without demand', () => {
    it('backs off to a longer ceiling, then stops polling once nobody has read the view for a while', async () => {
        expect(POLL_MAX_MS).toBe(60 * 60_000);
        await pulls().watch({ provider: 'github', repo: 'o/r' });
        // The reader of `watch` is demand for VIEW_DEMAND_MS; after it the next poll finds none.
        await ticks(VIEW_DEMAND_MS / POLL_FLOOR_MS + 40);
        const state = (await app.storage.load('pulls', pullsKey(ws, 'prj_1' as ProjectId))) as { state: { dormant?: boolean; next?: number } } | null;
        expect(state?.state.dormant).toBe(true);
        expect(state?.state.next).toBeUndefined();
        // Nothing armed: hours pass without a read of GitHub.
        expect(await readsOver(300)).toBe(0);
    });

    it('a get of stale data wakes it with a fresh poll', async () => {
        await pulls().watch({ provider: 'github', repo: 'o/r' });
        await ticks(VIEW_DEMAND_MS / POLL_FLOOR_MS + 40);
        const before = reads;
        const view = await pulls().get();
        expect(view.dormant).toBeUndefined();
        await ticks(1);
        expect(reads).toBeGreaterThan(before);
        const fresh = await pulls().get();
        expect(fresh.polledAt).toBe(Date.now());
        // Back from the floor: nothing changed, so the first interval doubles once.
        expect(fresh.next).toBe(Date.now() + 2 * POLL_FLOOR_MS);
        // A reader keeps it polling while it reads.
        expect(await readsOver(5)).toBeGreaterThan(0);
    });

    it('a get while the view was just read saves nothing and arms nothing', async () => {
        await pulls().watch({ provider: 'github', repo: 'o/r' });
        const saves = app.saves.length;
        await pulls().get();
        await pulls().get();
        expect(app.saves.length).toBe(saves);
    });
});

describe('demand keeps the floor', () => {
    it('a running check polls every minute with no reader', async () => {
        current = { ...quiet, checks: [{ name: 'ci', state: 'running' }] };
        await pulls().watch({ provider: 'github', repo: 'o/r' });
        await ticks(VIEW_DEMAND_MS / POLL_FLOOR_MS + 5);
        expect(await readsOver(10)).toBe(10);
        // The check finishes: the actor settles and goes dormant.
        current = quiet;
        await ticks(30);
        expect(await readsOver(200)).toBe(0);
    });

    it('a task waiting on the open PR keeps polling with no reader', async () => {
        const task = app.as(user).actor(TaskActor, taskKey(ws, 't1' as TaskId));
        await task.create({ objective: 'ship', origin: { kind: 'user', chatId: 'c' as ChatId, messageId: 'm' as MessageId }, assignee: 'agent_a' as AgentId, context: [], constraints: {} }, { owner: 'agent_a' as AgentId });
        await task.start('user:u1', 'sess_1' as SessionId);
        await pulls().watch({ provider: 'github', repo: 'o/r' });
        await pulls().report(21, { taskId: 't1' as TaskId });
        await ticks(VIEW_DEMAND_MS / POLL_FLOOR_MS + 120);
        expect(await readsOver(200)).toBeGreaterThan(0);
        current = { ...quiet, state: 'merged' };
        await ticks(POLL_MAX_MS / POLL_FLOOR_MS);
        expect((await task.get()).status).toBe('completed');
    });

    it('a running autopilot turn keeps the 60 s cadence', async () => {
        current = { ...quiet, checks: [{ name: 'ci', state: 'failed' }] };
        await pulls().linkBranch('chat/21', { chatId: 'chat_21' as ChatId });
        await pulls().watch({ provider: 'github', repo: 'o/r' });
        await pulls().setAutopilot(21, { agentId: 'agent_a' as AgentId, fixChecks: true, maxAttempts: 3, answerThreads: false, rebase: false, mergeWhenGreen: false });
        await ticks(1);
        expect(turns).toBe(1);
        await ticks(VIEW_DEMAND_MS / POLL_FLOOR_MS + 5);
        // The turn's task is never readable here, so it runs until AUTOPILOT_TURN_STALE_MS: every tick reads.
        expect(await readsOver(10)).toBe(10);
    });
});
