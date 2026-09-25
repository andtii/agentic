/**
 * The Pulls actor (#742) against a real in-process host, with a fake pull request source: polled state, the
 * poll interval, PR ↔ task links by report and by branch, the `pull-request` wait, completion on merge, failure on
 * close, and `pull.merged` / `pull.closed` recorded once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, Principal, ProjectId, PullRequest, SessionId, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { TaskActor, taskKey } from '../../src/task/index';
import { definePullsActor, parsePullsKey, POLL_FLOOR_MS, POLL_MAX_MS, pullsKey, PULLS_BY, type PullSource } from '../../src/pulls/index';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const REPO = 'o/r';

const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github',
    repo: REPO,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    head: `chat/${number}`,
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [],
    review: { state: 'none', reviewers: [], threads: [] },
    ...over
});

/** A repo in memory: `set` a PR's state, `fail` the next reads. */
class FakeSource implements PullSource {
    readonly prs = new Map<number, PullRequest>();
    calls = 0;
    error: Error | undefined;
    set(p: PullRequest): void {
        this.prs.set(p.number, p);
    }
    async get(_repo: string, number: number): Promise<PullRequest | undefined> {
        this.calls++;
        if (this.error) throw this.error;
        return this.prs.get(number);
    }
    async listOpen(): Promise<PullRequest[]> {
        this.calls++;
        if (this.error) throw this.error;
        return [...this.prs.values()].filter((p) => p.state === 'open');
    }
}

let clock = 1_000_000;
let source: FakeSource;
let audit: ReturnType<typeof capturingAuditPort>;
let app: TestActorApp;
let Pulls: ReturnType<typeof definePullsActor>;

beforeEach(() => {
    clock = 1_000_000;
    source = new FakeSource();
    audit = capturingAuditPort();
    Pulls = definePullsActor({ sources: { open: () => source }, audit, now: () => clock });
    app = testActorApp([TaskActor, Pulls]);
    return app.start();
});
afterEach(() => app.stop());

const pulls = () => app.as(user).actor(Pulls, pullsKey(ws, project));
const task = (id: string) => app.as(user).actor(TaskActor, taskKey(ws, id as TaskId));
const contract: TaskContract = {
    objective: 'ship it',
    origin: { kind: 'user', chatId: 'chat_1' as ChatId, messageId: 'msg_1' as MessageId },
    assignee: 'agent_a' as AgentId,
    context: [],
    constraints: {}
};
async function activeTask(id: string): Promise<void> {
    await task(id).create(contract, { owner: 'agent_a' as AgentId });
    await task(id).start('user:u1', 'sess_1' as SessionId);
}

describe('keys', () => {
    it('is workspace first and round-trips', () => {
        expect(pullsKey(ws, project)).toBe('ws_1:pulls:prj_1');
        expect(parsePullsKey('ws_1:pulls:prj_1')).toEqual({ workspaceId: ws, projectId: project });
        expect(parsePullsKey('ws_1:task:t1')).toBeNull();
        expect(parsePullsKey('ws_1:pulls:')).toBeNull();
    });
});

describe('polling', () => {
    it('watch reads the open PRs at once, newest first, and arms the next poll', async () => {
        source.set(pr(3));
        source.set(pr(5));
        source.set(pr(4, { state: 'merged' }));
        const view = await pulls().watch({ provider: 'github', repo: REPO });
        expect(view.repo).toEqual({ provider: 'github', repo: REPO });
        expect(view.pulls.map((p) => p.number)).toEqual([5, 3]);
        expect(view.polledAt).toBe(clock);
        expect(view.next).toBe(clock + POLL_FLOOR_MS);
        expect(view.error).toBeUndefined();
    });

    it('backs off while nothing changes, and polls every minute while a check runs', async () => {
        source.set(pr(1));
        await pulls().watch({ provider: 'github', repo: REPO });
        expect((await pulls().poll()).next).toBe(clock + 2 * POLL_FLOOR_MS);
        expect((await pulls().poll()).next).toBe(clock + 4 * POLL_FLOOR_MS);
        for (let i = 0; i < 8; i++) await pulls().poll();
        expect((await pulls().get()).next).toBe(clock + POLL_MAX_MS);
        source.set(pr(1, { checks: [{ name: 'ci', state: 'running' }] }));
        expect((await pulls().poll()).next).toBe(clock + POLL_FLOOR_MS);
        expect((await pulls().poll()).next).toBe(clock + POLL_FLOOR_MS); // still running, nothing changed
        source.set(pr(1, { checks: [{ name: 'ci', state: 'passed' }] }));
        expect((await pulls().poll()).next).toBe(clock + POLL_FLOOR_MS); // changed
        expect((await pulls().poll()).next).toBe(clock + 2 * POLL_FLOOR_MS);
    });

    it('a failing source is on the view and backs off; a rate limit waits until its retryAt', async () => {
        await pulls().watch({ provider: 'github', repo: REPO });
        source.error = new Error('boom');
        const failed = await pulls().poll();
        expect(failed.error).toBe('boom');
        expect(failed.next).toBe(clock + 4 * POLL_FLOOR_MS); // an empty repo already doubled once
        source.error = Object.assign(new Error('rate limited'), { code: 'rate-limited', retryAt: clock + 30 * 60_000 });
        expect((await pulls().poll()).next).toBe(clock + 30 * 60_000);
        source.error = undefined;
        const ok = await pulls().poll();
        expect(ok.error).toBeUndefined();
        expect(ok.next).toBe(clock + POLL_FLOOR_MS);
    });

    it('no source is an error on the view, not a throw', async () => {
        const None = definePullsActor({ sources: { open: () => undefined }, now: () => clock });
        const other = testActorApp([None]);
        await other.start();
        try {
            const view = await other.as(user).actor(None, pullsKey(ws, project)).watch({ provider: 'github', repo: REPO });
            expect(view.error).toMatch(/no github pull request source/);
        } finally {
            await other.stop();
        }
    });

    it('unwatch stops polling and keeps what it read; another repo starts over', async () => {
        source.set(pr(1));
        await pulls().watch({ provider: 'github', repo: REPO });
        const stopped = await pulls().unwatch();
        expect(stopped.repo).toBeUndefined();
        expect(stopped.next).toBeUndefined();
        expect(stopped.pulls).toHaveLength(1);
        const other = await pulls().watch({ provider: 'github', repo: 'o/other' });
        expect(other.pulls).toEqual([]);
    });

    it('refuses a malformed repo, provider, link or key', async () => {
        expect(await statusOf(pulls().watch({ provider: 'github', repo: 'nope' }))).toBe(400);
        expect(await statusOf(pulls().watch({ provider: 'Git Hub', repo: REPO }))).toBe(400);
        expect(await statusOf(pulls().report(0, { taskId: 't' as TaskId }))).toBe(400);
        expect(await statusOf(pulls().report(1, {}))).toBe(400);
        expect(await statusOf(pulls().linkBranch('', { chatId: 'c' as ChatId }))).toBe(400);
        expect(await statusOf(app.as(user).actor(Pulls, 'ws_1:pulls').poll())).toBe(400);
    });
});

describe('the task waits on its pull request', () => {
    it('report parks the task on the PR, and the merge completes it — audited once', async () => {
        await activeTask('t1');
        source.set(pr(7));
        await pulls().watch({ provider: 'github', repo: REPO });
        const view = await pulls().report(7, { taskId: 't1' as TaskId, chatId: 'chat_1' as ChatId });
        expect(view.pulls[0]).toMatchObject({ number: 7, taskId: 't1', chatId: 'chat_1' });
        expect(await task('t1').explain()).toEqual({ kind: 'pull-request', number: 7, state: 'open' });

        // Still open: nothing moves.
        await pulls().poll();
        expect((await task('t1').get()).status).toBe('waiting');

        source.set(pr(7, { state: 'merged', mergedAt: clock + 5 }));
        const merged = await pulls().poll();
        expect(merged.pulls[0]).toMatchObject({ number: 7, state: 'merged', taskId: 't1' });
        const done = await task('t1').get();
        expect(done.status).toBe('completed');
        expect(done.result).toMatchObject({ text: 'Pull request #7 merged: PR 7', verified: true });
        expect(done.transitions.slice(-2).map((t) => [t.to, t.by])).toEqual([
            ['active', PULLS_BY],
            ['completed', PULLS_BY]
        ]);

        await pulls().poll();
        expect(audit.events.map((e) => e.kind)).toEqual(['pull.merged']);
        expect(audit.events[0]).toMatchObject({ at: clock + 5, by: PULLS_BY, taskId: 't1', data: { projectId: project, repo: REPO, number: 7, taskId: 't1', chatId: 'chat_1' } });
    });

    it('a PR closed without merging fails its task', async () => {
        await activeTask('t2');
        source.set(pr(8));
        await pulls().watch({ provider: 'github', repo: REPO });
        await pulls().report(8, { taskId: 't2' as TaskId });
        source.set(pr(8, { state: 'closed' }));
        await pulls().poll();
        const failed = await task('t2').get();
        expect(failed.status).toBe('failed');
        expect(failed.error).toMatchObject({ code: 'pull-closed' });
        expect(audit.events.map((e) => [e.kind, e.key])).toEqual([['pull.closed', 'ws_1:pulls:prj_1:8:closed']]);
    });

    it('the task waits even before the PR is read, and a PR the repo lacks fails it', async () => {
        await activeTask('t3');
        // Not watched yet: the wait is recorded, the read comes with `watch`.
        await pulls().report(9, { taskId: 't3' as TaskId });
        expect(await task('t3').explain()).toEqual({ kind: 'pull-request', number: 9, state: 'open' });
        await pulls().watch({ provider: 'github', repo: REPO });
        const failed = await task('t3').get();
        expect(failed.status).toBe('failed');
        expect(failed.error).toMatchObject({ code: 'pull-missing' });
    });

    it('a PR on a linked branch is linked on the next poll, and its task waits on it', async () => {
        await activeTask('t4');
        await pulls().watch({ provider: 'github', repo: REPO });
        await pulls().linkBranch('chat/abc', { taskId: 't4' as TaskId, chatId: 'chat_4' as ChatId, sessionId: 'sess_4' as SessionId });
        source.set(pr(11, { head: 'chat/abc' }));
        source.set(pr(12));
        const view = await pulls().poll();
        expect(view.pulls.find((p) => p.number === 11)).toMatchObject({ taskId: 't4', chatId: 'chat_4', sessionId: 'sess_4' });
        expect(view.pulls.find((p) => p.number === 12)?.taskId).toBeUndefined();
        expect(await task('t4').explain()).toEqual({ kind: 'pull-request', number: 11, state: 'open' });
    });

    it('a PR reported after it merged completes the task at once', async () => {
        await activeTask('t5');
        source.set(pr(13, { state: 'merged' }));
        await pulls().watch({ provider: 'github', repo: REPO });
        await pulls().report(13, { taskId: 't5' as TaskId });
        expect((await task('t5').get()).status).toBe('completed');
        expect(audit.events.map((e) => e.kind)).toEqual(['pull.merged']);
    });
});
