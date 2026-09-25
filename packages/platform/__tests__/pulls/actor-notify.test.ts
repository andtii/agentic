/**
 * The Pulls actor tells the Inbox when a PR becomes your move (#818, PRJ-10): one `input` row per new reason, none for
 * a passing check or the same reason again, none for the first read of a repo, none twice for an autopilot stop and none
 * for a conflict the autopilot is rebasing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, Principal, ProjectId, PullRequest, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { Inbox, inboxKey } from '../../src/notify/index';
import { TaskActor } from '../../src/task/index';
import { definePullsActor, pullsKey, type AutopilotStop, type AutopilotSwitches, type PullSource, type PullsAutopilotPort } from '../../src/pulls/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const REPO = 'o/r';

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
    checks: [{ name: 'ci', state: 'running' }],
    review: { state: 'none', reviewers: [], threads: [] },
    chatId: 'chat_9' as ChatId,
    ...over
});
const red = (over: Partial<PullRequest> = {}) => pr({ checks: [{ name: 'size', state: 'failed', detail: 'too big' }], ...over });
const passed = (over: Partial<PullRequest> = {}) => pr({ checks: [{ name: 'ci', state: 'passed' }], ...over });

let open: PullRequest[];
const source: PullSource = {
    get: async (_repo, n) => open.find((p) => p.number === n),
    listOpen: async () => open
};

class FakePort implements PullsAutopilotPort {
    moves: AutopilotStop[] = [];
    async startTurn(): Promise<void> {}
    async merge(): Promise<{ merged: boolean }> {
        return { merged: false };
    }
    async yourMove(e: { stop: AutopilotStop }): Promise<void> {
        this.moves.push(e.stop);
    }
}

let clock: number;
let app: TestActorApp;
let Pulls: ReturnType<typeof definePullsActor>;
let port: FakePort;

async function start(withPort = false): Promise<void> {
    port = new FakePort();
    Pulls = definePullsActor({
        sources: { open: () => source },
        audit: capturingAuditPort(),
        now: () => clock,
        inbox: () => Inbox,
        ...(withPort ? { autopilot: () => port } : {})
    });
    app = testActorApp([TaskActor, Inbox, Pulls]);
    await app.start();
}

beforeEach(() => {
    clock = 1_000_000;
    open = [pr()];
});
afterEach(() => app.stop());

const pulls = () => app.as(user).actor(Pulls, pullsKey(ws, project));
const watch = () => pulls().watch({ provider: 'github', repo: REPO });

/** The inbox's rows once the one-way pushes landed (`want` rows, or a short settle when none are expected). */
async function rows(want = 0): Promise<string[]> {
    const inbox = app.as(user).actor(Inbox, inboxKey(ws));
    for (let i = 0; i < 20 && (await inbox.list()).length < Math.max(want, 1); i++) await new Promise((r) => setTimeout(r, 5));
    return (await inbox.list()).map((n) => `${n.kind} ${n.title}`);
}

describe('Pulls → Inbox', () => {
    it('a poll that turns a PR red pushes one input row; the next identical poll pushes none', async () => {
        await start();
        await watch();
        open = [red()];
        await pulls().poll();
        expect(await rows(1)).toEqual(['input r#9 needs you']);
        await pulls().poll();
        expect(await rows(2)).toEqual(['input r#9 needs you']);
    });

    it('a passing check pushes nothing', async () => {
        await start();
        await watch();
        open = [passed()];
        await pulls().poll();
        expect(await rows()).toEqual([]);
    });

    it('the first read of a repo is a baseline; a PR red on first sight later is one row', async () => {
        open = [red()];
        await start();
        await watch();
        expect(await rows()).toEqual([]);
        open = [red(), red({ number: 10, head: 'chat/10', url: `https://github.com/${REPO}/pull/10` })];
        await pulls().poll();
        expect(await rows(1)).toEqual(['input r#10 needs you']);
    });

    it('an autopilot that gives up says so once, through its own port — not again from the poll', async () => {
        const pilot: AutopilotSwitches = { agentId: 'agent_forge' as AgentId, fixChecks: true, maxAttempts: 1, answerThreads: false, rebase: true, mergeWhenGreen: false };
        await start(true);
        await watch();
        await pulls().setAutopilot(9, pilot);
        open = [red()];
        await pulls().poll(); // attempt 1 starts
        clock += 2 * 60 * 60_000; // the turn goes stale
        await pulls().poll(); // still failing past the last attempt: gave up
        expect(port.moves.map((m) => m.reason)).toEqual(['gave-up']);
        await pulls().poll();
        expect(await rows()).toEqual([]);
    });

    it('a conflict the autopilot is rebasing pushes nothing', async () => {
        const pilot: AutopilotSwitches = { agentId: 'agent_forge' as AgentId, fixChecks: false, maxAttempts: 1, answerThreads: false, rebase: true, mergeWhenGreen: false };
        await start(true);
        await watch();
        await pulls().setAutopilot(9, pilot);
        open = [passed({ mergeable: false })];
        await pulls().poll();
        expect(await rows()).toEqual([]);
    });

    it('a conflict with the rebase switch off is one row', async () => {
        const pilot: AutopilotSwitches = { agentId: 'agent_forge' as AgentId, fixChecks: false, maxAttempts: 1, answerThreads: false, rebase: false, mergeWhenGreen: false };
        await start(true);
        await watch();
        await pulls().setAutopilot(9, pilot);
        open = [passed({ mergeable: false })];
        await pulls().poll();
        expect(await rows(1)).toEqual(['input r#9 needs you']);
    });
});
