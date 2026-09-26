/**
 * The live PR page (#935): Squash and merge calls `Pulls.merge` and says its refusal under the button; Linked names
 * the task and chat by their live titles and the issue the PR is for (`pullIssueOf`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ChatId, MessageId, PullRequest, TaskId } from '@agentic/core';
import { Chat, TaskActor, definePullsActor, pullsKey, taskKey, type PullSource, type PullsAutopilotPort } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { pullIssueOf } from '../../src/pages/projects/work/pull/model';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const TASK = 't_pr_merge' as TaskId;
const base: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 604, title: 'web: squash and merge on the PR page', url: 'https://github.com/andtii/agentic/pull/604',
    head: '935-pr-live', base: 'main', state: 'open', additions: 12, deletions: 3, files: 2, openedBy: 'forge', openedAt: 1_000,
    checks: [{ name: 'ci', state: 'passed' }], review: { state: 'approved', reviewers: ['Lint'], threads: [] }, mergeable: true
};

describe('pullIssueOf (#935)', () => {
    it('takes the issue from the title, else the task, else the branch', () => {
        expect(pullIssueOf({ ...base, title: 'fix (closes #47)' })).toEqual({ number: 47, label: 'agentic#47', href: 'https://github.com/andtii/agentic/issues/47' });
        expect(pullIssueOf({ ...base, head: 'drawer' }, 'Take #12 end to end')?.number).toBe(12);
        expect(pullIssueOf(base)?.label).toBe('agentic#935');
        expect(pullIssueOf({ ...base, head: 'drawer' })).toBeUndefined();
        expect(pullIssueOf({ ...base, provider: 'gitlab' })).toEqual({ number: 935, label: 'agentic#935' });
    });
});

describe('Squash and merge and Linked, live (#935)', () => {
    let h: LiveHarness;
    let current: PullRequest;
    let answer: { merged: boolean; reason?: string };
    let merges: number[];
    const source: PullSource = { get: async (_repo, n) => (n === current.number ? current : undefined), listOpen: async () => (current.state === 'open' ? [current] : []) };
    const port: PullsAutopilotPort = {
        startTurn: async () => undefined,
        merge: async ({ pr }) => {
            merges.push(pr.number);
            if (answer.merged) current = { ...current, state: 'merged', mergedAt: 2_000 };
            return answer;
        }
    };
    const Pulls = () => definePullsActor({ sources: { open: () => source }, autopilot: () => port });

    beforeEach(async () => {
        current = base;
        merges = [];
        answer = { merged: true };
        h = await startLive(undefined, { actors: [Pulls()] });
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    async function project(): Promise<{ id: string; chatId: string }> {
        const forge = await h.agent('Forge', 'Builds things');
        const defs = clientDefs();
        const { id } = await saveProjectWith(defs, USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const chatId = await createChatWith(defs, USER, [forge], forge, id);
        await h.app.as(owner).actor(Chat, chatKeyOf(WS, chatId)).rename('Merge button chat');
        await h.app.as(owner).actor(TaskActor, taskKey(WS, TASK)).create(
            { objective: 'Wire the merge button', origin: { kind: 'user', chatId: chatId as ChatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} },
            { owner: forge }
        );
        current = { ...base, taskId: TASK, chatId: chatId as ChatId };
        const pulls = h.app.as(owner).actor(Pulls(), pullsKey(WS, id));
        await pulls.watch({ provider: 'github', repo: 'andtii/agentic' });
        await pulls.poll();
        return { id, chatId };
    }
    const mergeButton = (dom: ParentNode) => dom.querySelector<HTMLButtonElement>('button[name="merge"]');

    it('Squash and merge merges through the Pulls actor; Linked shows the task, chat and issue', { timeout: 30_000 }, async () => {
        const { id } = await project();
        const dom = await mountLive(`/projects/${id}/work/pr:604`, h);
        await until(() => mergeButton(dom) !== null, 'the merge button');
        await until(() => dom.querySelector('[data-task-title]')?.textContent === 'Wire the merge button', 'the task title');
        await until(() => dom.querySelector('[data-link="chat"] a')?.textContent === 'Merge button chat', 'the chat title');
        const issue = dom.querySelector<HTMLAnchorElement>('[data-link="issue"] a');
        expect(issue?.textContent).toBe('agentic#935');
        expect(issue?.getAttribute('href')).toBe('https://github.com/andtii/agentic/issues/935');

        expect(mergeButton(dom)!.disabled).toBe(false);
        mergeButton(dom)!.click();
        await until(() => merges.length === 1, 'the merge');
        expect(merges).toEqual([604]);
        // The actor reads the merge back on its next poll (a reminder the harness does not tick): poll now.
        await h.app.as(owner).actor(Pulls(), pullsKey(WS, id)).poll();
        await until(() => dom.querySelector('[data-pull-board]')?.getAttribute('data-pull-state') === 'merged', 'merged on the page');
    });

    it('a refused merge says why under the button', { timeout: 30_000 }, async () => {
        answer = { merged: false, reason: 'branch protection' };
        const { id } = await project();
        const dom = await mountLive(`/projects/${id}/work/pr:604`, h);
        await until(() => mergeButton(dom) !== null, 'the merge button');
        mergeButton(dom)!.click();
        await until(() => dom.querySelector('[data-pull-merge-error]') !== null, 'the refusal');
        expect(dom.querySelector('[data-pull-merge-error]')?.textContent).toContain('branch protection');
        expect(dom.querySelector('[data-pull-board]')?.getAttribute('data-pull-state')).toBe('open');
        expect(mergeButton(dom)!.disabled).toBe(false);
    });
});
