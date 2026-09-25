/**
 * The Pulls actor's autopilot (#820): one run per PR, driven after every good poll through the app's port; the
 * view carries the run's attempt and activity; take over / stop / resume / turn ended; `ask on merge` waits for
 * `answerMerge`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, Principal, ProjectId, PullRequest, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { TaskActor } from '../../src/task/index';
import { AUTOPILOT_SETTLE_MS, definePullsActor, pullsKey, type AutopilotMergeAsk, type AutopilotStop, type AutopilotSwitches, type PullSource, type PullsAutopilotPort } from '../../src/pulls/index';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const REPO = 'o/r';
const forge = 'agent_forge' as AgentId;

const pilot: AutopilotSwitches = { agentId: forge, fixChecks: true, maxAttempts: 2, answerThreads: true, rebase: true, mergeWhenGreen: true };

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
    checks: [],
    review: { state: 'none', reviewers: [], threads: [] },
    chatId: 'chat_9' as ChatId,
    ...over
});
const failing = (over: Partial<PullRequest> = {}) => pr({ checks: [{ name: 'size', state: 'failed', detail: 'too big' }], ...over });
const green = (over: Partial<PullRequest> = {}) => pr({ checks: [{ name: 'ci', state: 'passed' }], mergeable: true, review: { state: 'approved', reviewers: [], threads: [] }, ...over });

let current: PullRequest;
const source: PullSource = {
    get: async () => current,
    listOpen: async () => (current.state === 'open' ? [current] : [])
};

class FakePort implements PullsAutopilotPort {
    turns: { agentId: AgentId; chatId: ChatId; text: string }[] = [];
    merges: number[] = [];
    asks: AutopilotMergeAsk[] = [];
    moves: AutopilotStop[] = [];
    mergeAnswer: { merged: boolean; reason?: string } = { merged: true };
    turnError: Error | undefined;
    async startTurn(t: { agentId: AgentId; chatId: ChatId; text: string }): Promise<void> {
        if (this.turnError) throw this.turnError;
        this.turns.push({ agentId: t.agentId, chatId: t.chatId, text: t.text });
    }
    async merge(r: { pr: PullRequest }): Promise<{ merged: boolean; reason?: string }> {
        this.merges.push(r.pr.number);
        return this.mergeAnswer;
    }
    async yourMove(e: { stop: AutopilotStop }): Promise<void> {
        this.moves.push(e.stop);
    }
    async askMerge(a: AutopilotMergeAsk): Promise<void> {
        this.asks.push(a);
    }
}

let clock = 1_000_000;
let port: FakePort;
let refs: { workspaceId: WorkspaceId; projectId: ProjectId }[];
let app: TestActorApp;
let Pulls: ReturnType<typeof definePullsActor>;

beforeEach(() => {
    clock = 1_000_000;
    current = pr();
    port = new FakePort();
    refs = [];
    Pulls = definePullsActor({
        sources: { open: () => source },
        audit: capturingAuditPort(),
        now: () => clock,
        autopilot: (ref) => (refs.push(ref), port)
    });
    app = testActorApp([TaskActor, Pulls]);
    return app.start();
});
afterEach(() => app.stop());

const pulls = () => app.as(user).actor(Pulls, pullsKey(ws, project));
const view9 = async () => (await pulls().get()).pulls.find((p) => p.number === 9)!;

async function watchWithPilot(first: PullRequest): Promise<void> {
    current = first;
    await pulls().watch({ provider: 'github', repo: REPO });
    await pulls().setAutopilot(9, pilot);
    await pulls().poll();
}

describe('driven after every poll', () => {
    it('a failing check starts a fix turn in the PR chat for the agent; the view shows the attempt', async () => {
        await watchWithPilot(failing());
        expect(refs[0]).toEqual({ workspaceId: ws, projectId: project });
        expect(port.turns).toHaveLength(1);
        expect(port.turns[0]).toMatchObject({ agentId: forge, chatId: 'chat_9' });
        expect(port.turns[0]!.text).toMatch(/size: too big/);
        const v = await view9();
        expect(v.autopilot).toMatchObject({ agentId: forge, attempt: 1, activity: 'Fixing size · attempt 1 of 2' });

        // The turn holds the PR: another poll starts nothing.
        await pulls().poll();
        expect(port.turns).toHaveLength(1);
    });

    it('turn ended → after the settle window the next attempt; past the last it gives up and says so', async () => {
        await watchWithPilot(failing());
        await pulls().autopilotTurnEnded(9);
        clock += AUTOPILOT_SETTLE_MS;
        await pulls().poll();
        expect(port.turns).toHaveLength(2);
        await pulls().autopilotTurnEnded(9);
        clock += AUTOPILOT_SETTLE_MS;
        await pulls().poll();
        expect(port.turns).toHaveLength(2);
        expect(port.moves.map((m) => m.reason)).toEqual(['gave-up']);
        expect((await view9()).autopilot?.activity).toMatch(/Gave up on size after 2 attempts/);
    });

    it('nothing is driven without switches, and a failed read drives nothing', async () => {
        current = failing();
        await pulls().watch({ provider: 'github', repo: REPO });
        expect(port.turns).toHaveLength(0);
        await pulls().setAutopilot(9, pilot);
        const original = source.listOpen;
        source.listOpen = async () => {
            throw new Error('boom');
        };
        try {
            await pulls().poll();
            expect(port.turns).toHaveLength(0);
        } finally {
            source.listOpen = original;
        }
        await pulls().poll();
        expect(port.turns).toHaveLength(1);
    });

    it('a turn that cannot start stops the autopilot: your move', async () => {
        port.turnError = new Error('not a member');
        await watchWithPilot(failing());
        expect(port.moves).toHaveLength(1);
        expect(port.moves[0]).toMatchObject({ reason: 'gave-up' });
        expect((await view9()).autopilot?.activity).toMatch(/not a member/);
    });
});

describe('the page and the chat', () => {
    it('take over and stop hold it; resume starts again with a fresh count', async () => {
        await watchWithPilot(failing());
        await pulls().takeOver(9);
        expect((await view9()).autopilot?.activity).toBe('Taken over by you.');
        clock += 2 * 60 * 60_000;
        await pulls().poll();
        expect(port.turns).toHaveLength(1);

        await pulls().stopAutopilot(9);
        expect((await view9()).autopilot?.activity).toBe('Autopilot is off');
        await pulls().poll();
        expect(port.turns).toHaveLength(1);

        await pulls().resumeAutopilot(9);
        await pulls().poll();
        expect(port.turns).toHaveLength(2);
        expect((await view9()).autopilot?.attempt).toBe(1);
    });

    it('setAutopilot validates, keeps its switches across polls, and null switches it off', async () => {
        current = pr();
        await pulls().watch({ provider: 'github', repo: REPO });
        expect(await statusOf(pulls().setAutopilot(9, { ...pilot, maxAttempts: 0 }))).toBe(400);
        expect(await statusOf(pulls().setAutopilot(9, { ...pilot, fixChecks: 'yes' as unknown as boolean }))).toBe(400);
        expect(await statusOf(pulls().setAutopilot(10, pilot))).toBe(404);
        expect(await statusOf(pulls().answerMerge(9, true))).toBe(409);
        await pulls().setAutopilot(9, pilot);
        await pulls().poll();
        expect((await view9()).autopilot).toMatchObject({ agentId: forge, maxAttempts: 2 });
        await pulls().setAutopilot(9, null);
        expect((await view9()).autopilot).toBeUndefined();
    });
});

describe('merge through ask on merge', () => {
    it('green and approved asks you once; yes merges through the port', async () => {
        await watchWithPilot(green());
        expect(port.asks).toHaveLength(1);
        expect(port.asks[0]).toMatchObject({ agentId: forge, rule: { id: 'ask-on-merge', outcome: 'ask' } });
        expect(port.merges).toEqual([]);
        expect(port.moves).toEqual([]);
        expect((await view9()).autopilot?.activity).toBe('Asking to merge');
        await pulls().poll();
        expect(port.asks).toHaveLength(1);

        await pulls().answerMerge(9, true);
        expect(port.merges).toEqual([9]);
        expect(await statusOf(pulls().answerMerge(9, true))).toBe(409);
    });

    it('no stops it: your move until resumed', async () => {
        await watchWithPilot(green());
        await pulls().answerMerge(9, false);
        expect(port.merges).toEqual([]);
        expect((await view9()).autopilot?.activity).toMatch(/declined: you declined it/);
    });

    it('a provider refusal after yes stops it with the reason', async () => {
        port.mergeAnswer = { merged: false, reason: 'Head branch was modified' };
        await watchWithPilot(green());
        await pulls().answerMerge(9, true);
        expect((await view9()).autopilot?.activity).toMatch(/Head branch was modified/);
    });

    it('a PR that stops being green drops the pending ask', async () => {
        await watchWithPilot(green());
        current = failing({ mergeable: true, review: { state: 'approved', reviewers: [], threads: [] } });
        await pulls().poll();
        expect(await statusOf(pulls().answerMerge(9, true))).toBe(409);
    });
});
