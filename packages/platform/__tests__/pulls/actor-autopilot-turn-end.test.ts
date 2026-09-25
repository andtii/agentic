/**
 * The autopilot's turn ends with its task (#858): the port names the task a turn runs as, the Pulls actor keeps it on
 * the turn, reads it every poll (at the floor while it runs) and ends the turn when the task is terminal or waits on
 * a pull request — so the PR gets `AUTOPILOT_SETTLE_MS`, not `AUTOPILOT_TURN_STALE_MS`. The view's `runs` says where
 * each run stands for the page's Resume and Approve / Decline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, Principal, ProjectId, PullRequest, SessionId, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { TaskActor, taskKey } from '../../src/task/index';
import {
    AUTOPILOT_SETTLE_MS, POLL_FLOOR_MS, driveAutopilot, definePullsActor, pullsKey, NEW_AUTOPILOT_RUN,
    type AutopilotSwitches, type PullSource, type PullsAutopilotPort
} from '../../src/pulls/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const REPO = 'o/r';
const forge = 'agent_forge' as AgentId;
const pilot: AutopilotSwitches = { agentId: forge, fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: true };

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github',
    repo: REPO,
    number: 9,
    title: 'PR 9',
    url: `https://github.com/${REPO}/pull/9`,
    head: 'chat/9',
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [{ name: 'size', state: 'failed', detail: 'too big' }],
    review: { state: 'none', reviewers: [], threads: [] },
    chatId: 'chat_9' as ChatId,
    ...over
});

let current: PullRequest;
const source: PullSource = { get: async () => current, listOpen: async () => (current.state === 'open' ? [current] : []) };

const contract: TaskContract = {
    objective: 'fix it',
    origin: { kind: 'user', chatId: 'chat_9' as ChatId, messageId: 'msg_1' as MessageId },
    assignee: forge,
    context: [],
    constraints: {}
};

let clock = 1_000_000;
let turns: TaskId[];
let app: TestActorApp;
let Pulls: ReturnType<typeof definePullsActor>;

const task = (id: TaskId) => app.as(user).actor(TaskActor, taskKey(ws, id));

beforeEach(() => {
    clock = 1_000_000;
    current = pr();
    turns = [];
    const port: PullsAutopilotPort = {
        // Each turn runs as a task of its own, as `chatAutopilotPort` starts it.
        startTurn: async () => {
            const taskId = `task_turn${turns.length + 1}` as TaskId;
            await task(taskId).create(contract, { owner: forge });
            await task(taskId).start('user:u1', 'sess_1' as SessionId);
            turns.push(taskId);
            return { taskId };
        },
        merge: async () => ({ merged: true })
    };
    Pulls = definePullsActor({ sources: { open: () => source }, audit: capturingAuditPort(), now: () => clock, autopilot: () => port });
    app = testActorApp([TaskActor, Pulls]);
    return app.start();
});
afterEach(() => app.stop());

const pulls = () => app.as(user).actor(Pulls, pullsKey(ws, project));

async function started(): Promise<void> {
    await pulls().watch({ provider: 'github', repo: REPO });
    await pulls().setAutopilot(9, pilot);
    await pulls().poll();
}

describe('the turn ends with its task (#858)', () => {
    it('driveAutopilot keeps the task the port names on the turn', async () => {
        const out = await driveAutopilot(
            { startTurn: async () => ({ taskId: 'task_x' as TaskId }), merge: async () => ({ merged: false }) },
            NEW_AUTOPILOT_RUN,
            { ...pr(), autopilot: pilot },
            1
        );
        expect(out.turn).toMatchObject({ kind: 'fix', taskId: 'task_x' });
        const bare = await driveAutopilot({ startTurn: async () => undefined, merge: async () => ({ merged: false }) }, NEW_AUTOPILOT_RUN, { ...pr(), autopilot: pilot }, 1);
        expect(bare.turn?.taskId).toBeUndefined();
    });

    it('a completed task ends the turn: the next attempt comes after the settle window, not the stale one', async () => {
        await started();
        expect(turns).toHaveLength(1);
        // While the turn's task runs, the actor polls at the floor to see it end.
        const running = await pulls().get();
        expect(running.next! - running.polledAt!).toBe(POLL_FLOOR_MS);

        await task(turns[0]!).complete({ text: 'pushed a fix', artifacts: [], verified: true }, forge);
        await pulls().poll();
        expect(turns).toHaveLength(1);
        clock += AUTOPILOT_SETTLE_MS;
        await pulls().poll();
        expect(turns).toHaveLength(2);
        expect((await pulls().get()).pulls[0]!.autopilot?.attempt).toBe(2);
    });

    it('a task that waits on a pull request ends the turn too; a still-active one holds it', async () => {
        await started();
        clock += AUTOPILOT_SETTLE_MS;
        await pulls().poll();
        expect(turns).toHaveLength(1);

        await task(turns[0]!).reportWaiting({ kind: 'pull-request', number: 9, state: 'open' }, forge, 'sess_1' as SessionId);
        await pulls().poll();
        clock += AUTOPILOT_SETTLE_MS;
        await pulls().poll();
        expect(turns).toHaveLength(2);
    });
});

describe('the view says where each run stands (#858)', () => {
    it('paused while taken over or off, cleared by resume; asking to merge until answered', async () => {
        await started();
        expect((await pulls().get()).runs).toEqual({ '9': {} });
        expect((await pulls().takeOver(9)).runs['9']).toEqual({ paused: 'taken-over' });
        expect((await pulls().resumeAutopilot(9)).runs['9']).toEqual({});
        expect((await pulls().stopAutopilot(9)).runs['9']).toEqual({ paused: 'off' });
        await pulls().resumeAutopilot(9);

        current = pr({ checks: [{ name: 'ci', state: 'passed' }], mergeable: true, review: { state: 'approved', reviewers: [], threads: [] } });
        await pulls().poll();
        expect((await pulls().get()).runs['9']).toEqual({ askingMerge: true });
        expect((await pulls().answerMerge(9, false)).runs['9']).toEqual({ paused: 'merge-declined' });

        expect((await pulls().setAutopilot(9, null)).runs).toEqual({});
    });
});
