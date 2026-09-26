/**
 * Pull requests as Inbox rows (#951, PRJ-10): with `pullSurface="notification"` "Needs you" lists the PRs whose
 * next move is yours on `PullCard`'s `notification` surface — `agentic#603 needs you` and why — the headline linked
 * to the PR page, no merge button; Home's default `home` item is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, PullRequest } from '@agentic/core';
import { memoryNeedsSource, NeedsYou, pullsNeedingYou, type PullNeeds } from '../../src/pages/inbox';
import { mockPullNeeds } from '../../src/pages/projects/work/pull/links';
import { mountAt, text } from './helpers';

const ready: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 602, title: 'shell: drawer collapses below 768 px', url: 'https://github.com/andtii/agentic/pull/602',
    head: 'drawer', base: 'main', state: 'open', additions: 40, deletions: 8, files: 3, openedBy: 'forge', openedAt: 1_000,
    checks: [{ name: 'test', state: 'passed' }], review: { state: 'approved', reviewers: ['Lint'], threads: [] }, mergeable: true
};
const running: PullRequest = { ...ready, number: 604, checks: [{ name: 'test', state: 'running' }] };
const stopped: PullRequest = {
    ...ready, number: 603, openedAt: 500, title: 'ui: member card usage rings',
    checks: [{ name: 'size-limit', state: 'failed' }],
    autopilot: { agentId: 'forge' as AgentId, fixChecks: true, answerThreads: false, rebase: false, mergeWhenGreen: false, maxAttempts: 3, attempt: 3 }
};

const empty = () => memoryNeedsSource({ rows: [], requests: {}, now: () => 5_000 });
const pullRows = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-needs-pull]')].map((el) => el.getAttribute('data-needs-pull'));
const href = (pr: PullRequest) => `/projects/p/work/pr:${pr.number}`;

describe('Inbox: pull request notification rows', () => {
    it('lists only PRs whose next move is yours, oldest first, as notification rows linked to the PR page', async () => {
        const needs: PullNeeds = { usePulls: () => () => [ready, running, stopped], href };
        const root = await mountAt('/', <NeedsYou source={empty()} pulls={needs} pullSurface="notification" />);
        expect(pullRows(root)).toEqual(['603', '602']);
        const cards = [...root.querySelectorAll<HTMLElement>('[data-needs-pull] [data-surface]')].map((el) => el.getAttribute('data-surface'));
        expect(cards).toEqual(['notification', 'notification']);
        const link = root.querySelector<HTMLAnchorElement>('[data-needs-pull="603"] [data-pull-headline] a');
        expect(text(link)).toBe('agentic#603 needs you');
        expect(link?.getAttribute('href')).toBe('/projects/p/work/pr:603');
        expect(text(root.querySelector('[data-needs-pull="603"] [data-pull-status]'))).toBe('forge tried 3 times to fix the checks and stopped.');
        expect(text(root.querySelector('[data-needs-pull="602"] [data-pull-status]'))).toBe('shell: drawer collapses below 768 px · ready to merge');
        expect([...root.querySelectorAll('button')].some((b) => text(b) === 'Squash and merge')).toBe(false);
        expect(text(root)).toContain('2 open');
    });

    it('a PR without a page is a row without a link', async () => {
        const needs: PullNeeds = { usePulls: () => () => [ready] };
        const root = await mountAt('/', <NeedsYou source={empty()} pulls={needs} pullSurface="notification" />);
        expect(text(root.querySelector('[data-needs-pull="602"] [data-pull-headline]'))).toBe('agentic#602 needs you');
        expect(root.querySelector('[data-needs-pull="602"] [data-pull-headline] a')).toBeNull();
    });

    it('Home keeps its item by default', async () => {
        const needs: PullNeeds = { usePulls: () => () => [ready], href };
        const root = await mountAt('/', <NeedsYou source={empty()} pulls={needs} />);
        expect(root.querySelector('[data-needs-pull="602"] [data-surface]')?.getAttribute('data-surface')).toBe('home');
    });

    it('fed by the workspace pulls on mock data: every row links to its PR page', async () => {
        const needs = mockPullNeeds();
        const expected = pullsNeedingYou(needs.usePulls()(), needs.me);
        expect(expected.length).toBeGreaterThan(0);
        const root = await mountAt('/', <NeedsYou source={empty()} pulls={needs} pullSurface="notification" />);
        expect(pullRows(root)).toEqual(expected.map((pr) => String(pr.number)));
        for (const pr of expected) {
            const a = root.querySelector<HTMLAnchorElement>(`[data-needs-pull="${pr.number}"] [data-pull-headline] a`);
            expect(a?.getAttribute('href')).toBe(needs.href!(pr));
            expect(a?.getAttribute('href')).toMatch(/^\/projects\/[^/]+\/work\/pr:\d+$/);
        }
    });
});
