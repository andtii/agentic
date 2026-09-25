/**
 * The Work view (#738, PRJ-05): `workItemsOf` for a project with Git on and one with no stage feature, the filters and
 * groups, the live helpers, and the page on mock data (boards ProjectCode / ProjectPlain).
 */
import { describe, it, expect } from 'vitest';
import type { AgentId, PlanItem, ProjectFeatureUi, PullRequest, TaskId } from '@agentic/core';
import { WORK_STAGES_FALLBACK } from '@agentic/core';
import type { TaskIndexRow } from '@agentic/platform';
import { filterWork, groupWork, isStale, NO_WORK_FILTER, WEEK_MS, workAgentOf, workItemsOf, type WorkFeatures, type WorkTask } from '../../src/pages/projects/work/model';
import { projectTasks } from '../../src/pages/projects/work/live';
import { workItemParam } from '../../src/pages/projects/work/WorkView';
import { mountRoute, page, texts } from '../pages/mount';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const min = (n: number): number => NOW - n * 60_000;
const GIT_STAGES = ['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge'];
const git: WorkFeatures = { enabled: ['agentic.feature.git'], uiOf: (id): ProjectFeatureUi | undefined => (id === 'agentic.feature.git' ? { workStages: GIT_STAGES } : undefined) };
const plain: WorkFeatures = { enabled: [], uiOf: () => undefined };

const task = (id: string, more: Partial<WorkTask> = {}): WorkTask => ({ id: id as TaskId, title: id, status: 'active', assignee: 'forge' as AgentId, updatedAt: min(5), ...more });

const pr = (number: number, more: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github', repo: 'o/r', number, title: `PR ${number}`, url: '', head: `${number}-branch`, base: 'main', state: 'open',
    additions: 1, deletions: 1, files: 3, openedBy: 'forge', openedAt: min(60), checks: [{ name: 'ci', state: 'passed' }],
    review: { state: 'none', reviewers: [], threads: [] }, mergeable: true, ...more
});

const item = (id: number, more: Partial<PlanItem> = {}): PlanItem => ({ id, title: `Item ${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [{ at: min(10), actor: { kind: 'user', userId: 'u' }, text: 'added' }], ...more });

const one = (items: ReturnType<typeof workItemsOf>, id: string) => {
    const found = items.find((i) => i.id === id);
    expect(found, id).toBeDefined();
    return found!;
};

describe('workItemsOf with Git on (#738)', () => {
    it('takes the Git stages and folds a PR’s task into its row', () => {
        const items = workItemsOf([task('t1')], [pr(10, { taskId: 't1' as TaskId })], [], git, NOW);
        expect(items).toHaveLength(1);
        const row = items[0]!;
        expect(row.id).toBe('pr:10');
        expect(row.taskId).toBe('t1');
        expect(row.stages).toEqual(GIT_STAGES);
    });

    it('green and approved is your move to merge', () => {
        const row = one(workItemsOf([], [pr(1, { review: { state: 'approved', reviewers: ['Lint'], threads: [] } })], [], git, NOW), 'pr:1');
        expect(row).toMatchObject({ stage: 5, stageState: 'needs-you', owner: { kind: 'you' }, group: 'your-move', nextStep: 'Merge — green, Lint approved' });
    });

    it('a review requested of nobody in particular is yours; of a named reviewer it waits', () => {
        const mine = one(workItemsOf([], [pr(1, { review: { state: 'requested', reviewers: [], threads: [] } })], [], git, NOW), 'pr:1');
        expect(mine).toMatchObject({ stage: 4, group: 'your-move', nextStep: 'Review — requested on 3 files' });
        const theirs = one(workItemsOf([task('t2')], [pr(2, { taskId: 't2' as TaskId, review: { state: 'requested', reviewers: ['Lint'], threads: [] } })], [], git, NOW), 'pr:2');
        expect(theirs).toMatchObject({ stage: 4, group: 'waiting', owner: { kind: 'agent', agentId: 'forge' } });
    });

    it('a conflict is your decision unless autopilot rebases', () => {
        const mine = one(workItemsOf([], [pr(5, { mergeable: false, after: 4 })], [], git, NOW), 'pr:5');
        expect(mine).toMatchObject({ stage: 2, stageState: 'needs-you', group: 'your-move', nextStep: 'Decide — merge #4 first, or rebase' });
        const pilot = { agentId: 'forge' as AgentId, fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: false };
        expect(one(workItemsOf([], [pr(5, { mergeable: false, autopilot: pilot })], [], git, NOW), 'pr:5')).toMatchObject({ group: 'agents', owner: { kind: 'agent', agentId: 'forge' } });
    });

    it('a failing check is the agent’s while autopilot has attempts left, else yours', () => {
        const checks = [{ name: 'size-limit', state: 'failed' as const }, { name: 'e2e', state: 'running' as const }];
        const pilot = { agentId: 'forge' as AgentId, fixChecks: true, maxAttempts: 3, answerThreads: false, rebase: false, mergeWhenGreen: false, attempt: 2 };
        expect(one(workItemsOf([], [pr(3, { checks, autopilot: pilot })], [], git, NOW), 'pr:3')).toMatchObject({ stage: 3, stageState: 'failed', group: 'agents', nextStep: 'Fixing size-limit · attempt 2 of 3' });
        expect(one(workItemsOf([], [pr(3, { checks, autopilot: { ...pilot, attempt: 4 } })], [], git, NOW), 'pr:3')).toMatchObject({ stageState: 'failed', group: 'your-move', owner: { kind: 'you' } });
        expect(one(workItemsOf([], [pr(3, { checks })], [], git, NOW), 'pr:3')).toMatchObject({ group: 'your-move', nextStep: 'Fix — 1 failing check' });
    });

    it('running checks wait on CI; open threads are answered by autopilot', () => {
        expect(one(workItemsOf([], [pr(4, { checks: [{ name: 'ci', state: 'running' }] })], [], git, NOW), 'pr:4')).toMatchObject({ stage: 3, stageState: 'working', group: 'waiting' });
        const threads = [{ id: 'a', author: 'lint', body: 'x', state: 'open' as const }];
        const pilot = { agentId: 'forge' as AgentId, fixChecks: false, maxAttempts: 3, answerThreads: true, rebase: false, mergeWhenGreen: false };
        expect(one(workItemsOf([], [pr(4, { review: { state: 'changes-requested', reviewers: ['Lint'], threads }, autopilot: pilot })], [], git, NOW), 'pr:4')).toMatchObject({ stage: 4, group: 'agents', nextStep: 'Answering 1 review thread' });
    });

    it('a merged PR is done this week, then drops off; a closed one never shows', () => {
        expect(one(workItemsOf([], [pr(6, { state: 'merged', mergedAt: min(60) })], [], git, NOW), 'pr:6')).toMatchObject({ stage: 5, stageState: 'done', group: 'done' });
        expect(workItemsOf([], [pr(6, { state: 'merged', mergedAt: NOW - WEEK_MS - 1 })], [], git, NOW)).toEqual([]);
        expect(workItemsOf([], [pr(7, { state: 'closed' })], [], git, NOW)).toEqual([]);
    });

    it('a task with no PR sits at Code while it works, Ready while queued', () => {
        const items = workItemsOf([task('t1', { activity: 'Writing tests' }), task('t2', { status: 'queued' })], [], [], git, NOW);
        expect(one(items, 'task:t1')).toMatchObject({ stage: 1, stageState: 'working', group: 'agents', nextStep: 'Writing tests', owner: { kind: 'agent', agentId: 'forge' } });
        expect(one(items, 'task:t2')).toMatchObject({ stage: 0, group: 'agents' });
    });
});

describe('workItemsOf with no stage feature (#738)', () => {
    it('falls back to Ready → Do → Review → Done', () => {
        const items = workItemsOf([task('t1')], [], [], plain, NOW);
        expect(items[0]!.stages).toBe(WORK_STAGES_FALLBACK);
        expect(items[0]).toMatchObject({ stage: 1, group: 'agents' });
    });

    it('an approval is your move at Review; a question at Do; a failure is yours', () => {
        const items = workItemsOf([
            task('a', { status: 'waiting', wait: { kind: 'approval', requestId: 'r', sessionId: 's' as never }, activity: 'Approve sending the email' }),
            task('q', { status: 'waiting', wait: { kind: 'input', requestId: 'r' } }),
            task('f', { status: 'failed' })
        ], [], [], plain, NOW);
        expect(one(items, 'task:a')).toMatchObject({ stage: 2, stageState: 'needs-you', group: 'your-move', owner: { kind: 'you' }, nextStep: 'Approve sending the email' });
        expect(one(items, 'task:q')).toMatchObject({ stage: 1, stageState: 'needs-you', group: 'your-move' });
        expect(one(items, 'task:f')).toMatchObject({ stageState: 'failed', group: 'your-move' });
    });

    it('completed this week is done; older and cancelled drop off', () => {
        const items = workItemsOf([task('c', { status: 'completed', updatedAt: min(90) }), task('old', { status: 'completed', updatedAt: NOW - WEEK_MS - 1 }), task('x', { status: 'cancelled' })], [], [], plain, NOW);
        expect(items.map((i) => i.id)).toEqual(['task:c']);
        expect(items[0]).toMatchObject({ stage: 3, stageState: 'done', group: 'done' });
    });

    it('plan items: a decision is yours, a live claim the agent’s, open ones stay on the Plan; a claimed item’s task carries its ref', () => {
        const items = workItemsOf([task('t9')], [], [
            item(1, { state: 'needs-you', options: [{ label: 'a' }, { label: 'b' }] }),
            item(2, { state: 'claimed', claim: { agentId: 'scout' as AgentId, leaseUntil: NOW + 60_000 } }),
            item(3),
            item(4, { state: 'claimed', claim: { agentId: 'forge' as AgentId, leaseUntil: NOW + 60_000, taskId: 't9' as TaskId } })
        ], plain, NOW);
        expect(items.map((i) => i.id).sort()).toEqual(['item:1', 'item:2', 'task:t9']);
        expect(one(items, 'item:1')).toMatchObject({ itemRef: '#1', group: 'your-move', nextStep: 'Decide · 2 options' });
        expect(one(items, 'item:2')).toMatchObject({ group: 'agents', owner: { kind: 'agent', agentId: 'scout' } });
        expect(one(items, 'task:t9').itemRef).toBe('#4');
    });
});

describe('filters, groups and helpers (#738)', () => {
    const tasks = [task('t1', { branch: '604-mcp-tools' }), task('t2', { assignee: 'scout' as AgentId, status: 'queued' })];
    const pulls = [pr(603, { head: '603-usage-rings', review: { state: 'approved', reviewers: [], threads: [] } })];
    const items = workItemsOf(tasks, pulls, [], git, NOW);

    it('filters by agent, stage and search over title, task id, #PR and branch', () => {
        expect(filterWork(items, NO_WORK_FILTER, tasks, pulls)).toHaveLength(3);
        expect(filterWork(items, { ...NO_WORK_FILTER, agent: 'scout' }, tasks, pulls).map((i) => i.id)).toEqual(['task:t2']);
        expect(filterWork(items, { ...NO_WORK_FILTER, stage: 'Merge' }, tasks, pulls).map((i) => i.id)).toEqual(['pr:603']);
        expect(filterWork(items, { ...NO_WORK_FILTER, q: '#603' }, tasks, pulls).map((i) => i.id)).toEqual(['pr:603']);
        expect(filterWork(items, { ...NO_WORK_FILTER, q: 'MCP-TOOLS' }, tasks, pulls).map((i) => i.id)).toEqual(['task:t1']);
    });

    it('groups, the row agent, the link param and staleness', () => {
        const g = groupWork(items);
        expect(g['your-move'].map((i) => i.id)).toEqual(['pr:603']);
        expect(g.agents).toHaveLength(2);
        expect(workAgentOf(one(items, 'task:t2'), tasks, pulls)).toBe('scout');
        expect(workItemParam(one(items, 'pr:603'))).toBe('pr:603');
        expect(workItemParam(one(items, 'task:t1'))).toBe('t1');
        expect(isStale({ ...one(items, 'pr:603'), updatedAt: NOW - 25 * 3_600_000 }, NOW)).toBe(true);
        expect(isStale(one(items, 'task:t1'), NOW)).toBe(false);
    });

    it('live: a task is the project’s when its chat is', () => {
        const row = (id: string, chatId?: string): TaskIndexRow => ({ id, objective: id, assignee: 'forge', owner: 'forge', status: 'active', origin: 'user', depth: 0, createdAt: 1, updatedAt: 2, n: 1, ...(chatId ? { chatId } : {}) }) as unknown as TaskIndexRow;
        expect(projectTasks([row('a', 'c1'), row('b', 'c2'), row('c')], new Set(['c1'])).map((t) => t.id)).toEqual(['a']);
    });
});

describe('the Work page on mock data (#738)', () => {
    const rowsOf = (el: HTMLElement, group: string) => [...el.querySelectorAll<HTMLElement>(`[data-work-group="${group}"] [data-work-row]`)];

    it('agentic (Git on) matches ProjectCode: 3 your move, 4 with agents, waiting and done collapsed', async () => {
        const dom = await mountRoute('/projects/p_agentic/work');
        const el = page(dom, 'project-work')!;
        expect(el.querySelector('[data-stub]')).toBeNull();
        expect(el.querySelector('[data-work-counts]')?.textContent).toBe('3 your move · 4 with agents');
        expect(texts(rowsOf(el, 'your-move').map((r) => r.querySelector('[data-work-title]')!))).toEqual(['History filter lists audit kinds', 'Make the drawer collapse below 768 px', 'Mobile drawer spec measures after the slide']);
        expect(rowsOf(el, 'agents')).toHaveLength(4);
        expect(rowsOf(el, 'waiting')).toHaveLength(0);
        expect(el.querySelector('[data-work-group="waiting"] [data-work-group-head]')?.getAttribute('aria-expanded')).toBe('false');
        expect(el.querySelector('[data-work-row="pr:605"] [data-work-conflict]')?.textContent).toBe('conflicts with #602');
        expect(el.querySelector('[data-work-row="pr:603"] [data-work-next]')?.textContent).toBe('Fixing size-limit · attempt 2 of 3');
        expect(el.querySelector('[data-work-row="pr:603"] a')?.getAttribute('href')).toBe('/projects/p_agentic/work/pr:603');
        expect(el.querySelector('[data-work-stages]')?.textContent).toBe('Stages: Ready → Code → PR → Checks → Review → Merge');
    });

    it('opening a collapsed group shows its rows', async () => {
        const dom = await mountRoute('/projects/p_agentic/work');
        const el = page(dom, 'project-work')!;
        el.querySelector<HTMLButtonElement>('[data-work-group="waiting"] [data-work-group-head]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(rowsOf(el, 'waiting')).toHaveLength(2);
    });

    it('docs-site (no stage feature) matches ProjectPlain: Ready → Do → Review → Done, same groups', async () => {
        const dom = await mountRoute('/projects/p_docs/work');
        const el = page(dom, 'project-work')!;
        expect(el.querySelector('[data-work-counts]')?.textContent).toBe('1 your move · 2 with agents');
        const [mine] = rowsOf(el, 'your-move');
        expect(mine?.getAttribute('data-state')).toBe('needs-you');
        expect(mine?.querySelector('[data-work-you]')).not.toBeNull();
        expect(el.querySelector('[data-work-stages]')).toBeNull();
        expect(el.querySelector('[data-work-footnote]')?.textContent).toContain('Ready → Do → Review → Done');
        expect(el.querySelector('[data-work-group="waiting"]')).toBeNull();
    });
});
