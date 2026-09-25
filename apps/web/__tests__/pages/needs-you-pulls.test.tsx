/**
 * Pull requests on Home's "Needs you" (#745, PRJ-10): only PRs whose next move is yours join the list, as
 * `PullCard`'s `home` item; "Squash and merge" goes through the page's merge, and a failed merge says so.
 */
import { describe, expect, it } from 'vitest';
import { signal } from 'sigx';
import type { PullRequest } from '@agentic/core';
import { memoryNeedsSource } from '../../src/pages/inbox';
import { NeedsYou, pullsNeedingYou, type PullNeeds } from '../../src/pages/inbox/NeedsYou';
import { mountAt, text, tick } from './helpers';

const ready: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 602, title: 'shell: drawer collapses below 768 px', url: 'https://github.com/andtii/agentic/pull/602',
    head: 'drawer', base: 'main', state: 'open', additions: 40, deletions: 8, files: 3, openedBy: 'forge', openedAt: 1_000,
    checks: [{ name: 'test', state: 'passed' }], review: { state: 'approved', reviewers: ['Lint'], threads: [] }, mergeable: true
};
const running: PullRequest = { ...ready, number: 603, checks: [{ name: 'test', state: 'running' }] };
const conflicts: PullRequest = { ...ready, number: 601, openedAt: 500, mergeable: false };

const empty = () => memoryNeedsSource({ rows: [], requests: {}, now: () => 5_000 });
const pullRows = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-needs-pull]')].map((el) => el.getAttribute('data-needs-pull'));

describe('Needs you: pull requests', () => {
    it('lists only PRs whose next move is yours, oldest first', () => {
        expect(pullsNeedingYou([ready, running, conflicts]).map((pr) => pr.number)).toEqual([601, 602]);
    });

    it('renders them as home cards and counts them', async () => {
        const needs: PullNeeds = { usePulls: () => () => [ready, running, conflicts], href: (pr) => `/projects/p/work/pr:${pr.number}` };
        const root = await mountAt('/', <NeedsYou source={empty()} pulls={needs} />);
        expect(pullRows(root)).toEqual(['601', '602']);
        expect(text(root.querySelector('[data-needs-pull="602"] [data-pull-headline]'))).toBe('agentic#602 is ready');
        expect(text(root)).toContain('2 open');
        expect(root.querySelector('[data-home-needs] [data-scope="empty-state"], [data-empty-state]')).toBeNull();
    });

    it('Squash and merge calls the page, and the PR leaves once the record says merged', async () => {
        const pulls = signal({ list: [ready] as PullRequest[] });
        const merged: number[] = [];
        const needs: PullNeeds = {
            usePulls: () => () => pulls.list,
            merge: async (pr) => {
                merged.push(pr.number);
                pulls.list = [{ ...pr, state: 'merged' }];
            }
        };
        const root = await mountAt('/', <NeedsYou source={empty()} pulls={needs} />);
        [...root.querySelectorAll('button')].find((b) => text(b) === 'Squash and merge')!.click();
        await tick();
        await tick();
        expect(merged).toEqual([602]);
        expect(pullRows(root)).toEqual([]);
    });

    it('a failed merge says so and keeps the card', async () => {
        const needs: PullNeeds = { usePulls: () => () => [ready], merge: () => Promise.reject(new Error('blocked by rules')) };
        const root = await mountAt('/', <NeedsYou source={empty()} pulls={needs} />);
        [...root.querySelectorAll('button')].find((b) => text(b) === 'Squash and merge')!.click();
        await tick();
        await tick();
        expect(text(root.querySelector('[data-needs-error]'))).toBe('Could not merge: blocked by rules');
        expect(pullRows(root)).toEqual(['602']);
    });
});
