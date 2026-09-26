/**
 * The work item page for work with no pull request (#739, PRJ-05): a plain task and a plan-backed item render on mock
 * data with the stage stepper, owner and next step, and their links; `pr:<n>` stays the pull request page's.
 */
import { describe, it, expect } from 'vitest';
import { WORK_STAGES_FALLBACK } from '@agentic/core';
import { findWorkItem, ownerLabel, stepsOf, doneWhenProgress, stagesOf } from '../../src/pages/projects/work/item/model';
import { MOCK_WORK_ITEMS } from '../../src/pages/projects/work/item/fixtures';
import { mountRoute, page, texts } from '../pages/mount';

const agentic = MOCK_WORK_ITEMS['p_agentic']!;

describe('the work item model (#739)', () => {
    it('finds an item by its id, a bare task ref or a plan ref, never a pull request', () => {
        expect(findWorkItem(agentic, 'task:t_52a1')?.item.id).toBe('task:t_52a1');
        expect(findWorkItem(agentic, 't_52a1')?.item.id).toBe('task:t_52a1');
        expect(findWorkItem(agentic, 'item:12')?.item.id).toBe('item:12');
        expect(findWorkItem(agentic, '#12')?.item.id).toBe('item:12');
        expect(findWorkItem(agentic, 't_8f2c')?.item.id).toBe('item:12');
        expect(findWorkItem(agentic, 'pr:603')).toBeUndefined();
        expect(findWorkItem(agentic, 't_nope')).toBeUndefined();
        expect(findWorkItem(agentic, '')).toBeUndefined();
    });

    it('falls back to Ready → Do → Review → Done when an item has no stages of its own', () => {
        expect(stagesOf({ stages: [] })).toBe(WORK_STAGES_FALLBACK);
        expect(stagesOf({ stages: ['A', 'B'] })).toEqual(['A', 'B']);
    });

    it('steps before the current stage are passed, the current one carries the state, the rest are later', () => {
        expect(stepsOf({ stages: [], stage: 2, stageState: 'needs-you' })).toEqual([
            { name: 'Ready', state: 'passed' },
            { name: 'Do', state: 'passed' },
            { name: 'Review', state: 'current', tone: 'needs-you' },
            { name: 'Done', state: 'later' }
        ]);
        expect(stepsOf({ stages: [], stage: 3, stageState: 'done' }).every((s) => s.state === 'passed')).toBe(true);
        // An out-of-range stage clamps to the last one.
        expect(stepsOf({ stages: [], stage: 9, stageState: 'failed' })[3]).toEqual({ name: 'Done', state: 'current', tone: 'failed' });
    });

    it('names the owner and counts the checklist', () => {
        expect(ownerLabel({ kind: 'you' }, () => 'x')).toBe('You');
        expect(ownerLabel({ kind: 'agent', agentId: 'forge' as never }, (id) => id.toUpperCase())).toBe('FORGE');
        expect(doneWhenProgress([{ text: 'a', checked: true }, { text: 'b', checked: false }])).toBe('1 of 2 done');
        expect(doneWhenProgress([])).toBe('');
    });
});

describe('the work item page on mock data (#739)', () => {
    it('renders a plain task: stepper, you own the next step, task, chat and session linked, no checklist', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/task:t_52a1');
        const el = page(dom, 'project-work-item')!;
        expect(el).not.toBeNull();
        expect(el.querySelector('[data-work-item-title]')?.textContent).toBe('Update the release notes for 0.2');
        expect(texts([...el.querySelectorAll('[data-work-item-steps] > li')])).toEqual(['Ready', 'Do', 'Review', 'Done']);
        expect(el.querySelector('[aria-current="step"]')?.textContent).toBe('Do');
        expect(el.querySelector('[data-owner="you"]')).not.toBeNull();
        expect(el.querySelector('[data-next-step]')?.textContent).toBe('Resume Forge’s interrupted turn');
        expect(el.querySelector('[data-link="task"] a')?.getAttribute('href')).toBe('/tasks/t7');
        expect(el.querySelector('[data-link="chat"] a')?.getAttribute('href')).toBe('/projects/p_agentic/chats/c4'); // inside the project (#929)
        expect(el.querySelector('[data-link="session"] a')?.getAttribute('href')).toBe('/sessions/s6');
        expect(el.querySelector('[data-work-item-done-when]')).toBeNull();
        expect(el.querySelector('[data-link="plan"]')).toBeNull();
    });

    it('renders a plan-backed item with its done-when checklist and the agent that owns it', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/item:12');
        const el = page(dom, 'project-work-item')!;
        expect(el.querySelector('[data-plan-backed="true"]')).not.toBeNull();
        expect(el.querySelector('[data-owner="agent"]')?.textContent).toContain('Forge');
        const checks = [...el.querySelectorAll<HTMLElement>('[data-work-item-done-when] li')];
        expect(texts(checks)).toEqual(['The drawer collapses under 768 px', 'Focus stays trapped in the open drawer', 'Lint approves the change']);
        expect(checks.map((c) => c.dataset['checked'])).toEqual(['true', 'false', 'false']);
        expect(el.querySelector('[data-work-item-done-when] h3 small')?.textContent).toBe('1 of 3 done');
        expect(el.querySelector('[data-link="plan"]')?.textContent).toBe('Mobile pass · Phase 2 · Shell · #12');
        expect(el.querySelector('[data-link="task"] a')?.getAttribute('href')).toBe('/tasks/t1-1');
    });

    it('says so for an item the project does not have', async () => {
        const dom = await mountRoute('/projects/p_docs/work/t_52a1');
        const el = page(dom, 'project-work-item')!;
        expect(el.querySelector('[data-work-item-head]')).toBeNull();
        expect(el.textContent).toContain('No work item with that id');
    });

    it('still sends pr:<n> to the pull request page', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/pr:603');
        expect(page(dom, 'project-pull')).not.toBeNull();
        expect(page(dom, 'project-work-item')).toBeNull();
    });
});
