/**
 * PullCard data on Home, the task tree and the chat (#826, PRJ-10): on mock data Home lists the ready PR as a MERGE
 * item that opens its PR page, the task node carries its PR line, and the chat card links into the project.
 */
import { describe, it, expect } from 'vitest';
import type { PullRequest } from '@agentic/core';
import { chatPullLinks, mockPullNeeds, mockTaskPull, pullDiffHref, pullPageHref } from '../../src/pages/projects/work/pull/links';
import { mountRoute } from '../pages/mount';

describe('pull links', () => {
    it('names the PR page and the provider diff', () => {
        expect(pullPageHref('p_agentic', 602)).toBe('/projects/p_agentic/work/pr:602');
        expect(pullDiffHref({ provider: 'github', url: 'https://github.com/a/b/pull/1/' })).toBe('https://github.com/a/b/pull/1/files');
        expect(pullDiffHref({ provider: 'gitlab' as PullRequest['provider'], url: 'https://gitlab.com/a/b/-/merge_requests/1' })).toBeUndefined();
    });

    it('a chat in a project links its PR cards to the PR page; a chat outside one keeps the provider URL', () => {
        const pr = mockTaskPull('t_8f2c')!;
        expect(chatPullLinks('p_agentic')!(pr)).toEqual({ href: '/projects/p_agentic/work/pr:602', diffHref: `${pr.url}/files` });
        expect(chatPullLinks(undefined)).toBeUndefined();
    });

    it('resolves a task to its PR by id or short ref', () => {
        expect(mockTaskPull('t1-1', 't_8f2c')?.number).toBe(602);
        expect(mockTaskPull('t_nope', undefined)).toBeUndefined();
        expect(mockTaskPull()).toBeUndefined();
    });

    it('Home merges succeed on mock data and link every PR to its project', async () => {
        const needs = mockPullNeeds();
        const all = needs.usePulls()();
        expect(all.length).toBeGreaterThan(0);
        expect(needs.href!(all.find((p) => p.number === 602)!)).toBe('/projects/p_agentic/work/pr:602');
        await expect(needs.merge!(all[0]!)).resolves.toBeUndefined();
    });
});

describe('PullCard consumers on mock data', () => {
    it('Home lists the ready PR under Needs you as a MERGE item opening its PR page', async () => {
        const dom = await mountRoute('/');
        const row = dom.querySelector<HTMLElement>('[data-home-needs] [data-needs-pull="602"]');
        expect(row).not.toBeNull();
        expect(row!.textContent).toContain('MERGE');
        expect([...row!.querySelectorAll('[href]')].map((a) => a.getAttribute('href'))).toContain('/projects/p_agentic/work/pr:602');
    });

    it('the task tree node carries its PR line', async () => {
        const dom = await mountRoute('/tasks/t1-1');
        expect(dom.querySelector('[data-task-tree] [data-pull-line]')?.textContent).toBe('#602 · ready to merge');
    });
});
