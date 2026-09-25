/**
 * PR notifications (#747, PRJ-10): push only when the next move becomes yours or autopilot gives up — never for a
 * passing check. Table-tested transitions over `pullNotification(prev, next)`, plus `notifyPull`'s Inbox send.
 */
import { describe, expect, it } from 'vitest';
import type { AnyActorDefinition } from '@sigx/actors';
import type { AgentId, Autopilot, ChatId, PullCheck, PullRequest, TaskId, WorkspaceId } from '@agentic/core';
import { notifyPull, pullMove, pullNotification } from '../../src/pulls/notify';

const check = (name: string, state: PullCheck['state']): PullCheck => ({ name, state });

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github',
    repo: 'andtii/agentic',
    number: 603,
    title: 'ui: member card usage rings',
    url: 'https://github.com/andtii/agentic/pull/603',
    head: 'feat/rings',
    base: 'main',
    state: 'open',
    additions: 10,
    deletions: 2,
    files: 3,
    openedBy: 'forge',
    openedAt: 1,
    checks: [check('lint', 'passed'), check('size-limit', 'passed')],
    review: { state: 'none', reviewers: [], threads: [] },
    mergeable: true,
    ...over
});

const auto = (over: Partial<Autopilot> = {}): Autopilot => ({
    agentId: 'Forge' as AgentId,
    fixChecks: true,
    maxAttempts: 3,
    answerThreads: true,
    rebase: true,
    mergeWhenGreen: false,
    ...over
});

const running = [check('lint', 'passed'), check('size-limit', 'running')];
const failing = [check('lint', 'passed'), check('size-limit', 'failed')];
const openThread = { id: 't1', author: 'lint', body: 'why?', state: 'open' as const };

describe('pullNotification — transitions', () => {
    // [name, prev, next, expected title or undefined]
    const table: ReadonlyArray<readonly [string, PullRequest | undefined, PullRequest, string | undefined]> = [
        // Never for a passing check or an agent/CI move.
        ['checks start running', pr(), pr({ checks: running, mergeable: undefined }), undefined],
        ['a check passes, one still running', pr({ checks: running }), pr({ checks: [check('lint', 'passed'), check('size-limit', 'queued')] }), undefined],
        ['check fails under autopilot', pr({ checks: running, autopilot: auto() }), pr({ checks: failing, autopilot: auto({ attempt: 1, activity: 'Fixing size-limit' }) }), undefined],
        ['autopilot attempt 2 fails and continues', pr({ checks: failing, autopilot: auto({ attempt: 1 }) }), pr({ checks: failing, autopilot: auto({ attempt: 2, activity: 'Fixing size-limit' }) }), undefined],
        ['review requested from a reviewer', pr({ checks: running }), pr({ review: { state: 'requested', reviewers: ['lint'], threads: [] } }), undefined],
        ['green but autopilot merges when green', pr({ checks: running, autopilot: auto({ mergeWhenGreen: true }) }), pr({ autopilot: auto({ mergeWhenGreen: true }) }), undefined],
        ['green but mergeability still computing', pr({ checks: running }), pr({ mergeable: undefined }), undefined],
        ['thread open under autopilot answering', pr({ autopilot: auto() }), pr({ autopilot: auto(), review: { state: 'none', reviewers: [], threads: [openThread] } }), undefined],
        ['draft goes red', pr({ draft: true }), pr({ draft: true, checks: failing }), undefined],
        ['merged', pr(), pr({ state: 'merged', mergedAt: 5 }), undefined],
        ['closed', pr({ checks: failing }), pr({ state: 'closed', checks: failing }), undefined],
        // The next move becomes yours.
        ['checks finish green', pr({ checks: running }), pr(), 'agentic#603 is ready to merge'],
        ['approved and green', pr({ review: { state: 'requested', reviewers: ['lint'], threads: [] } }), pr({ review: { state: 'approved', reviewers: ['lint'], threads: [] } }), 'agentic#603 is ready to merge'],
        ['first read already ready', undefined, pr(), 'agentic#603 is ready to merge'],
        ['check fails, no autopilot', pr({ checks: running }), pr({ checks: failing }), 'agentic#603 needs you'],
        ['conflicts with the base', pr({ autopilot: auto() }), pr({ autopilot: auto(), mergeable: false }), 'agentic#603 needs you'],
        ['changes requested, no autopilot', pr({ checks: running }), pr({ checks: running, review: { state: 'changes-requested', reviewers: ['lint'], threads: [] } }), 'agentic#603 needs you'],
        ['autopilot gives up', pr({ checks: running, autopilot: auto({ attempt: 3, activity: 'Fixing size-limit' }) }), pr({ checks: failing, autopilot: auto({ attempt: 3 }) }), 'agentic#603 needs you'],
        ['failing turns into conflicts', pr({ checks: failing }), pr({ checks: failing, mergeable: false }), 'agentic#603 needs you'],
        // The same reason again pushes nothing.
        ['still failing, another check fails', pr({ checks: failing }), pr({ checks: [check('lint', 'failed'), check('size-limit', 'failed')] }), undefined],
        ['still ready, a new title', pr(), pr({ title: 'renamed' }), undefined],
        ['still given up', pr({ checks: failing, autopilot: auto({ attempt: 3 }) }), pr({ checks: failing, autopilot: auto({ attempt: 3 }) }), undefined]
    ];

    it.each(table)('%s', (_name, prev, next, title) => {
        expect(pullNotification(prev, next)?.title).toBe(title);
    });
});

describe('pullNotification — the row', () => {
    it('autopilot giving up says who tried, how often and what', () => {
        const row = pullNotification(pr({ checks: running, autopilot: auto({ attempt: 3 }) }), pr({ checks: failing, autopilot: auto({ attempt: 3 }), taskId: 't_93d1' as TaskId }));
        expect(row).toEqual({
            kind: 'input',
            title: 'agentic#603 needs you',
            body: 'Forge tried 3 times to fix size-limit and stopped.',
            ref: { kind: 'task', taskId: 't_93d1' }
        });
    });

    it('ready counts the checks that ran and deep-links the chat when there is no task', () => {
        const row = pullNotification(undefined, pr({ checks: [check('lint', 'passed'), check('e2e', 'skipped')], review: { state: 'approved', reviewers: ['lint'], threads: [] }, chatId: 'c_1' as ChatId }));
        expect(row?.body).toBe('ui: member card usage rings · 1/1 checks · approved');
        expect(row?.ref).toEqual({ kind: 'chat', chatId: 'c_1' });
    });

    it('an unlinked PR has no ref', () => {
        expect(pullNotification(undefined, pr({ checks: failing }))).not.toHaveProperty('ref');
    });
});

describe('pullMove', () => {
    it('gave-up outranks conflicts; conflicts outrank failing', () => {
        expect(pullMove(pr({ checks: failing, mergeable: false, autopilot: auto({ attempt: 3 }) }))).toBe('gave-up');
        expect(pullMove(pr({ checks: failing, mergeable: false }))).toBe('conflicts');
    });

    it('autopilot still at work on the last attempt is not giving up', () => {
        expect(pullMove(pr({ checks: failing, autopilot: auto({ attempt: 3, activity: 'Fixing size-limit' }) }))).toBeUndefined();
        expect(pullMove(pr({ checks: [check('size-limit', 'failed'), check('e2e', 'running')], autopilot: auto({ attempt: 3 }) }))).toBeUndefined();
    });
});

describe('notifyPull', () => {
    const ws = 'ws_1' as WorkspaceId;
    const inboxDef = { type: 'inbox' } as unknown as AnyActorDefinition;

    const fakeCtx = (push: (row: unknown) => Promise<unknown>) => {
        const calls: { key: string; oneWay?: boolean }[] = [];
        const ctx = {
            actor: (_def: unknown, key: string) => ({
                with: (opts: { oneWay?: boolean }) => {
                    calls.push({ key, ...opts });
                    return { push };
                }
            })
        } as unknown as Parameters<typeof notifyPull>[0];
        return { ctx, calls };
    };

    it("pushes the row one-way to the workspace's inbox", async () => {
        const pushed: unknown[] = [];
        const { ctx, calls } = fakeCtx(async (row) => pushed.push(row));
        const row = await notifyPull(ctx, () => inboxDef, ws, pr({ checks: running }), pr({ checks: failing }));
        expect(row?.title).toBe('agentic#603 needs you');
        expect(pushed).toEqual([row]);
        expect(calls).toEqual([{ key: 'ws_1:inbox', oneWay: true }]);
    });

    it('sends nothing without a row or without an inbox, and never throws', async () => {
        const pushed: unknown[] = [];
        const { ctx } = fakeCtx(async (row) => pushed.push(row));
        expect(await notifyPull(ctx, () => inboxDef, ws, pr(), pr({ checks: running }))).toBeUndefined();
        expect(await notifyPull(ctx, undefined, ws, pr({ checks: running }), pr({ checks: failing }))).toBeDefined();
        expect(pushed).toEqual([]);
        const failingInbox = fakeCtx(async () => {
            throw new Error('refused');
        });
        await expect(notifyPull(failingInbox.ctx, () => inboxDef, ws, pr({ checks: running }), pr({ checks: failing }))).resolves.toBeDefined();
    });
});
