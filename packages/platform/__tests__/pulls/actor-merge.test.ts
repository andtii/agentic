/**
 * `Pulls.merge` (#892): a person's own Squash and merge through the app's merge port — a ready PR merges without an
 * autopilot ask, is read at once, and `pull.merged` names the person; a refusal is a 409 that changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ApprovalRule, ChatId, Principal, ProjectId, PullRequest, SessionId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { TaskActor } from '../../src/task/index';
import { definePullsActor, PERSON_MERGE, pullsKey, type AutopilotSwitches, type PullSource, type PullsAutopilotPort } from '../../src/pulls/index';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agent: Principal = { kind: 'agent', agentId: 'agent_forge' as AgentId, sessionId: 'ses_1' as SessionId, workspaceId: ws };
const REPO = 'o/r';

const ready = (over: Partial<PullRequest> = {}): PullRequest => ({
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
    checks: [{ name: 'ci', state: 'passed' }],
    mergeable: true,
    review: { state: 'approved', reviewers: [], threads: [] },
    chatId: 'chat_9' as ChatId,
    ...over
});

let current: PullRequest;
const source: PullSource = {
    get: async () => current,
    listOpen: async () => (current.state === 'open' ? [current] : [])
};

interface MergeRequest {
    agentId?: AgentId;
    by?: string;
    rule: ApprovalRule;
    pr: PullRequest;
}
let merges: MergeRequest[];
let answer: { merged: boolean; reason?: string } | Error;
const port: PullsAutopilotPort = {
    startTurn: async () => undefined,
    merge: async (request) => {
        merges.push(request);
        if (answer instanceof Error) throw answer;
        // The provider merged it: the next read shows it.
        if (answer.merged) current = { ...current, state: 'merged', mergedAt: 2_000_000 };
        return answer;
    }
};

let audit: ReturnType<typeof capturingAuditPort>;
let app: TestActorApp;
let Pulls: ReturnType<typeof definePullsActor>;
let wired: boolean;

beforeEach(() => {
    current = ready();
    merges = [];
    answer = { merged: true };
    wired = true;
    audit = capturingAuditPort();
    Pulls = definePullsActor({ sources: { open: () => source }, audit, now: () => 1_000_000, autopilot: () => (wired ? port : undefined) as PullsAutopilotPort });
    app = testActorApp([TaskActor, Pulls]);
    return app.start();
});
afterEach(() => app.stop());

const pulls = (as: Principal = user) => app.as(as).actor(Pulls, pullsKey(ws, project));

describe('Pulls.merge', () => {
    it('merges a ready PR without an autopilot ask, as the person, and the view shows it merged', async () => {
        await pulls().watch({ provider: 'github', repo: REPO });
        await pulls().merge(9);
        expect(merges).toHaveLength(1);
        expect(merges[0]).toMatchObject({ by: 'user:u1', rule: PERSON_MERGE, pr: { number: 9 } });
        expect(merges[0]!.agentId).toBeUndefined();

        await pulls().poll();
        expect((await pulls().get()).pulls.find((p) => p.number === 9)?.state).toBe('merged');
        const merged = audit.events.filter((e) => e.kind === 'pull.merged');
        expect(merged).toHaveLength(1);
        expect(merged[0]!.by).toBe('user:u1');
    });

    it('answers a pending autopilot ask: the ask is gone once merged', async () => {
        const pilot: AutopilotSwitches = { agentId: 'agent_forge' as AgentId, fixChecks: true, maxAttempts: 2, answerThreads: true, rebase: true, mergeWhenGreen: true };
        await pulls().watch({ provider: 'github', repo: REPO });
        await pulls().setAutopilot(9, pilot);
        await pulls().poll();
        // The autopilot's merge goes through `ask on merge` and waits: nothing merged yet.
        expect(merges).toHaveLength(0);
        expect((await pulls().get()).runs['9']?.askingMerge).toBe(true);
        await pulls().merge(9);
        expect(merges).toHaveLength(1);
        expect((await pulls().get()).runs['9']?.askingMerge).toBeUndefined();
    });

    it("the port's refusal, or its throw, is a 409 and nothing is recorded", async () => {
        await pulls().watch({ provider: 'github', repo: REPO });
        answer = { merged: false, reason: 'head moved' };
        expect(await statusOf(pulls().merge(9))).toBe(409);
        answer = new Error('boom');
        expect(await statusOf(pulls().merge(9))).toBe(409);
        await pulls().poll();
        expect((await pulls().get()).pulls.find((p) => p.number === 9)?.state).toBe('open');
        expect(audit.events.filter((e) => e.kind === 'pull.merged')).toHaveLength(0);
    });

    it('refuses an agent (403), a PR that is not open or not tracked, and a deployment without a merge', async () => {
        await pulls().watch({ provider: 'github', repo: REPO });
        expect(await statusOf(pulls(agent).merge(9))).toBe(403);
        expect(await statusOf(pulls().merge(10))).toBe(404);
        wired = false;
        expect(await statusOf(pulls().merge(9))).toBe(409);
        wired = true;
        current = ready({ state: 'closed' });
        await pulls().poll();
        expect(await statusOf(pulls().merge(9))).toBe(409);
        expect(merges).toHaveLength(0);
    });
});
