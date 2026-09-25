/**
 * `PullCard` (#745, PRJ-10): one pull request, the same state on every surface — the chat's live card, Home's
 * Needs-you item, the task node's line, a notification — and whose next move it is.
 */
import { signal } from '@sigx/reactivity';
import { component } from '@sigx/runtime-core';
import type { PullCheck, PullRequest, TaskId } from '@agentic/core';
import type { ToolPartState } from '@sigx/ai-agent/app';
import { PullCard, TaskNode, isPullRequest, pullName, pullNeedsYou, pullNextMove, pullStatusText } from '@agentic/ui';
import { ToolCall } from '../../src/thread';
import { mount, tick } from '../helpers';

const passed = (n: number): PullCheck[] => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, state: 'passed' as const }));

/** agentic#602 — green, approved, mergeable: yours to merge. */
const ready: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 602, title: 'shell: drawer collapses below 768 px', url: 'https://github.com/andtii/agentic/pull/602',
    head: 'drawer', base: 'main', state: 'open', additions: 40, deletions: 8, files: 3, openedBy: 'forge', openedAt: 1_000,
    checks: passed(9), review: { state: 'approved', reviewers: ['Lint'], threads: [] }, mergeable: true
};

/** agentic#603 — autopilot fixing a failing check, changes asked: the agent's move. */
const fixing: PullRequest = {
    ...ready, number: 603, title: 'ui: member card usage rings', openedAt: 2_000, mergeable: true,
    checks: [...passed(7), { name: 'test', state: 'running' }, { name: 'size-limit', state: 'failed' }],
    review: { state: 'changes-requested', reviewers: ['Lint'], threads: [{ id: 't1', author: 'Lint', body: 'nit', state: 'open' }] },
    autopilot: { agentId: 'agent_forge' as never, fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: false, attempt: 2, activity: 'fixing size-limit' }
};

const card = (host: ParentNode): HTMLElement => host.querySelector<HTMLElement>('[data-ag-project="pull-card"]')!;
const text = (el: ParentNode, sel: string): string | undefined => el.querySelector(sel)?.textContent ?? undefined;

describe('pullNextMove: Home shows only PRs whose next move is yours', () => {
    it('ready to merge is yours', () => {
        expect(pullNextMove(ready)).toBe('merge');
        expect(pullNeedsYou(ready)).toBe(true);
        expect(pullStatusText(ready)).toBe('ready to merge');
    });

    it('a PR the agent is still fixing is not', () => {
        expect(pullNextMove(fixing)).toBeUndefined();
        expect(pullStatusText(fixing)).toBe('1 failing check');
    });

    it('conflicts are yours to decide; running checks, drafts and closed PRs are not', () => {
        expect(pullNextMove({ ...ready, mergeable: false })).toBe('conflicts');
        expect(pullNextMove({ ...ready, checks: [{ name: 'test', state: 'running' }] })).toBeUndefined();
        expect(pullNextMove({ ...ready, mergeable: undefined })).toBeUndefined();
        expect(pullNextMove({ ...ready, draft: true })).toBeUndefined();
        expect(pullStatusText({ ...ready, state: 'merged' })).toBe('merged');
        expect(pullNextMove({ ...ready, state: 'merged' })).toBeUndefined();
    });

    it('a review is yours only when it was asked of you', () => {
        const asked: PullRequest = { ...ready, review: { state: 'requested', reviewers: ['andy'], threads: [] } };
        expect(pullNextMove(asked, 'andy')).toBe('review');
        expect(pullNextMove(asked, 'someone')).toBeUndefined();
        expect(pullNextMove(asked)).toBeUndefined();
    });

    it('autopilot that used its attempts and stopped hands it to you; merge-when-green keeps a ready PR with the agent', () => {
        const stopped: PullRequest = { ...fixing, checks: [...passed(8), { name: 'size-limit', state: 'failed' }], autopilot: { ...fixing.autopilot!, attempt: 3, activity: undefined } };
        expect(pullNextMove(stopped)).toBe('stopped');
        expect(pullNextMove({ ...ready, autopilot: { ...fixing.autopilot!, mergeWhenGreen: true } })).toBeUndefined();
    });

    it('names and recognises a PR', () => {
        expect(pullName(ready)).toBe('agentic#602');
        expect(isPullRequest(ready)).toBe(true);
        expect(isPullRequest({ number: 1, title: 'x' })).toBe(false);
        expect(isPullRequest('text')).toBe(false);
    });
});

describe('PullCard surfaces', () => {
    it('chat: title, autopilot badge, number, checks, review, what autopilot is doing, Open and View diff', () => {
        const el = card(mount(<PullCard pull={fixing} surface="chat" href="/projects/p/work/pr:603" diffHref="/projects/p/work/pr:603/changes" agentName="Forge" />));
        expect(el.getAttribute('data-surface')).toBe('chat');
        expect(text(el, '[data-pull-title]')).toBe('ui: member card usage rings');
        expect(text(el, '[data-pull-autopilot]')).toBe('autopilot');
        expect(el.textContent).toContain('#603');
        expect(text(el, '[data-checks-summary]')).toBe('1 failing · 1 running');
        expect(text(el, '[data-pull-review]')).toBe('Changes asked');
        expect(text(el, '[data-pull-activity]')).toContain('fixing size-limit · attempt 2 of 3');
        expect([...el.querySelectorAll('a')].map((a) => `${a.textContent} ${a.getAttribute('href')}`)).toEqual(['Open /projects/p/work/pr:603', 'View diff /projects/p/work/pr:603/changes']);
    });

    it('chat: updates in place when the record changes', async () => {
        const pr = signal({ value: fixing });
        const Host = component(() => () => <PullCard pull={pr.value} surface="chat" />);
        const host = mount(<Host />);
        const before = card(host);
        expect(text(before, '[data-checks-summary]')).toBe('1 failing · 1 running');
        pr.value = { ...ready, number: 603 };
        await tick();
        expect(card(host)).toBe(before);
        expect(text(before, '[data-checks-summary]')).toBe('9/9 passed');
        expect(text(before, '[data-pull-move]')).toBe('ready to merge');
    });

    it('home: MERGE pill, headline, one-line detail, Squash and merge emits merge, Open links', () => {
        const merged: PullRequest[] = [];
        const el = card(mount(<PullCard pull={ready} surface="home" href="/projects/p/work/pr:602" onMerge={(pr) => merged.push(pr)} />));
        expect(el.getAttribute('data-move')).toBe('merge');
        expect(text(el, '[data-pull-pill]')).toBe('MERGE');
        expect(text(el, '[data-pull-headline]')).toBe('agentic#602 is ready');
        expect(text(el, '[data-pull-detail]')).toBe('shell: drawer collapses below 768 px · 9/9 checks · Lint approved');
        const merge = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Squash and merge')!;
        merge.click();
        expect(merged.map((pr) => pr.number)).toEqual([602]);
        expect(el.querySelector('a')!.getAttribute('href')).toBe('/projects/p/work/pr:602');
    });

    it('home: no merge button when the move is not a merge', () => {
        const el = card(mount(<PullCard pull={{ ...ready, mergeable: false }} surface="home" />));
        expect(text(el, '[data-pull-pill]')).toBe('CONFLICTS');
        expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Squash and merge')).toBe(false);
    });

    it('task: one line, "#602 · ready to merge", no link', () => {
        const el = card(mount(<PullCard pull={ready} surface="task" href="/x" />));
        expect(text(el, '[data-pull-status]')).toBe('#602 · ready to merge');
        expect(el.querySelector('a')).toBeNull();
    });

    it('notification: needs you, and why', () => {
        const stopped: PullRequest = { ...fixing, checks: [{ name: 'size-limit', state: 'failed' }], autopilot: { ...fixing.autopilot!, attempt: 3, activity: undefined } };
        const el = card(mount(<PullCard pull={stopped} surface="notification" agentName="Forge" />));
        expect(text(el, '[data-pull-headline]')).toBe('agentic#603 needs you');
        expect(text(el, '[data-pull-status]')).toBe('Forge tried 3 times to fix the checks and stopped.');
    });
});

describe('PullCard consumers', () => {
    it('the task node shows the PR line', () => {
        const host = mount(<TaskNode id={'t_1' as TaskId} title="Make the drawer collapse below 768 px" status="waiting" agent="Forge" pull={ready} />);
        expect(text(host, '[data-pull-line]')).toBe('#602 · ready to merge');
    });

    it('a tool call that returned a PR carries the live card instead of the output well', () => {
        const part: ToolPartState = { type: 'tool', callId: 'c1', name: 'git_pr_create', status: 'completed', input: { title: 'x' }, output: JSON.stringify(fixing) };
        const host = mount(<ToolCall part={part} pullLinks={(pr) => ({ href: `/projects/p/work/pr:${pr.number}` })} />);
        const el = card(host);
        expect(el.getAttribute('data-surface')).toBe('chat');
        expect(el.querySelector('a')!.getAttribute('href')).toBe('/projects/p/work/pr:603');
        expect(host.querySelector('[data-scope="ai-tool-call"][data-part="output"]')).toBeNull();
        expect(host.querySelector('[data-scope="ai-tool-call"][data-part="meta"]')).toBeNull();
    });

    it('a tool call whose output is not a PR keeps its well', () => {
        const part: ToolPartState = { type: 'tool', callId: 'c1', name: 'Bash', status: 'completed', input: { command: 'ls' }, output: '{"number": 1}' };
        const host = mount(<ToolCall part={part} />);
        expect(host.querySelector('[data-ag-project="pull-card"]')).toBeNull();
        expect(host.querySelector('[data-scope="ai-tool-call"][data-part="output"]')).not.toBeNull();
    });
});
