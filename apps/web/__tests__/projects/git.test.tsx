/**
 * The Git feature's views (#746): the Code card on the project Overview and the Code section, from the mock Pulls
 * state of `p_agentic` (seven open pull requests, #597 merged, task t_93d1 on `604-mcp-tools` without a PR).
 */
import { describe, it, expect } from 'vitest';
import type { PullRequest } from '@agentic/core';
import { MOCK_WORK } from '../../src/mock/projects/work';
import { PROJECTS } from '../../src/mock/workspace';
import { featureHref, featureViewsOf } from '../../src/pages/projects/features/registry';
import { GitOverviewCard } from '../../src/pages/projects/features/git/GitSection';
import { checksOf, gitSectionHref, gitSummaryOf, GIT_FEATURE_ID } from '../../src/pages/projects/features/git/model';
import { mountAt, text } from '../pages/helpers';
import { mountRoute, page, texts } from '../pages/mount';

const agentic = PROJECTS.find((p) => p.id === 'p_agentic')!;
const work = MOCK_WORK['p_agentic']!;
const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('the git model (#746)', () => {
    it('counts open PRs, your move and failing, finds branches without a PR and the last merge', () => {
        const s = gitSummaryOf(work.pulls, work.tasks);
        expect(s.branch).toBe('main');
        expect(s.checks).toBe('pass');
        expect(s.open.map((o) => o.pr.number).sort()).toEqual([598, 599, 600, 601, 602, 603, 605]);
        // Merge #602 (green), review #598 (requested, no reviewer), decide #605 (conflicts, no autopilot).
        expect(s.open.filter((o) => o.yourMove).map((o) => o.pr.number).sort()).toEqual([598, 602, 605]);
        expect(s.yourMove).toBe(3);
        expect(s.failing).toBe(1);
        expect(s.branchesWithoutPr.map((b) => b.name)).toEqual(['604-mcp-tools']);
        expect(s.lastMerge?.number).toBe(597);
    });

    it('reads the checks pill off the last merge, and is empty without pull requests', () => {
        const pr = (states: PullRequest['checks'][number]['state'][]) => ({ checks: states.map((state, i) => ({ name: `c${i}`, state })) });
        expect(checksOf(undefined)).toBe('none');
        expect(checksOf(pr([]))).toBe('none');
        expect(checksOf(pr(['passed', 'failed', 'running']))).toBe('fail');
        expect(checksOf(pr(['passed', 'queued']))).toBe('running');
        expect(checksOf(pr(['passed']))).toBe('pass');
        expect(checksOf(pr(['skipped']))).toBe('none');
        expect(checksOf(pr(['passed', 'skipped']))).toBe('pass');
        const empty = gitSummaryOf([], []);
        expect(empty).toMatchObject({ branch: 'main', checks: 'none', yourMove: 0, failing: 0, branchesWithoutPr: [] });
        expect(empty.lastMerge).toBeUndefined();
    });

    it('registers the Code section and card under the git feature', () => {
        const views = featureViewsOf(GIT_FEATURE_ID)!;
        expect(views.label).toBe('Code');
        expect(views.Section).toBeDefined();
        expect(views.OverviewCard).toBe(GitOverviewCard);
        expect(featureHref('p_agentic', GIT_FEATURE_ID)).toBe(gitSectionHref('p_agentic'));
    });
});

describe('the Code card (#746)', () => {
    it('renders from the mock Pulls state', async () => {
        const dom = await mountAt('/projects/p_agentic', <GitOverviewCard project={agentic} />);
        await settle();
        const card = dom.querySelector('[data-git-card]')!;
        expect(card).not.toBeNull();
        expect(text(card.querySelector('[data-overview-card-title]'))).toBe('Code');
        expect(text(card.querySelector('[data-git-branch]'))).toBe('main');
        expect(text(card.querySelector('[data-git-checks]'))).toContain('CHECKS PASS');
        expect(texts([...card.querySelectorAll('[data-git-stat-n]')])).toEqual(['7', '3', '1']);
        expect(text(card.querySelector('[data-git-without] [data-overview-v]'))).toBe('1 · 604-mcp-tools');
        expect(text(card.querySelector('[data-git-last-merge] [data-overview-v]'))).toContain('#597');
        expect(card.querySelector('[data-overview-card-aside] a')!.getAttribute('href')).toBe(gitSectionHref('p_agentic'));
    });

    it('sits in the Overview rail of a project with git on', async () => {
        const dom = await mountRoute('/projects/p_agentic');
        const rail = page(dom, 'project-overview')!.querySelector('[data-overview-rail]')!;
        expect(rail.querySelector(`[data-overview-feature="${GIT_FEATURE_ID}"] [data-git-card]`)).not.toBeNull();
    });
});

describe('the Code section (#746)', () => {
    it('lists the open pull requests and the branches without a PR', async () => {
        const dom = await mountRoute(gitSectionHref('p_agentic'));
        const el = page(dom, 'project-feature')!;
        const section = el.querySelector('[data-git-section]')!;
        expect(section).not.toBeNull();
        expect(el.querySelector('[data-stub]')).toBeNull();
        const rows = [...section.querySelectorAll('[data-git-pull]')];
        expect(rows).toHaveLength(7);
        const merge = section.querySelector('[data-git-pull="602"]')!;
        expect(merge.hasAttribute('data-your-move')).toBe(true);
        expect(merge.querySelector('[data-git-row-main] a')!.getAttribute('href')).toBe('/projects/p_agentic/work/pr:602');
        expect(text(merge.querySelector('[data-git-row-detail]'))).toMatch(/^Merge/);
        expect(text(section.querySelector('[data-git-pull="603"] [data-git-pull-checks]'))).toContain('1 FAILING');
        const branch = section.querySelector('[data-git-branch-row="604-mcp-tools"]')!;
        expect(branch.querySelector('a')!.getAttribute('href')).toBe('/projects/p_agentic/work/t_93d1');
    });

    it('says so when a project has no pull requests', async () => {
        const dom = await mountRoute(gitSectionHref('p_docs'));
        const el = page(dom, 'project-feature')!;
        expect(texts([...el.querySelectorAll('[data-git-empty]')])).toEqual(['No open pull requests.', 'Every branch has a pull request.']);
    });
});
