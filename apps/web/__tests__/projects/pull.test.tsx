/**
 * The pull request page (#744, PRJ-08/09): the stepper, the blocker sentence from `pullBlockers`, what is happening
 * now, checks, threads, autopilot and linked items — the Pull board on mock data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PullRequest } from '@agentic/core';
import { MOCK_PULLS } from '../../src/mock/projects/pull';
import {
    autopilotOff, autopilotRows, blockerSentence, canMerge, checksProgress, durationText, findPull, openedAgo, originText, pullNow, pullSteps
} from '../../src/pages/projects/work/pull/model';
import { definePullsActor, pullsKey, type PullSource } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { mountRoute, page, texts, tick } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const agentic = MOCK_PULLS['p_agentic']!;
const board = findPull(agentic, 603)!.pr;
const ready = findPull(agentic, 602)!.pr;
const merged = findPull(agentic, 597)!.pr;
const with_ = (p: Partial<PullRequest>): PullRequest => ({ ...board, ...p });

describe('the pull request model (#744)', () => {
    it('joins every blocker into one sentence', () => {
        expect(blockerSentence(board)).toBe('Blocked: 1 failing check, 1 check running, 2 open threads, Lint has not approved.');
        expect(blockerSentence(ready)).toBe('Ready to merge.');
        expect(blockerSentence(merged)).toBe('Merged.');
        expect(blockerSentence(with_({ state: 'closed' }))).toBe('Closed without merging.');
        expect(blockerSentence({ ...ready, mergeable: undefined })).toBe('Checking whether it merges cleanly.');
        expect(canMerge(ready)).toBe(true);
        expect(canMerge(board)).toBe(false);
        expect(canMerge({ ...ready, mergeable: undefined })).toBe(false);
    });

    it('steps: the first unmet one is current, earlier ones passed', () => {
        const steps = pullSteps(board, () => '14:02');
        expect(steps.map((s) => [s.name, s.state, s.detail])).toEqual([
            ['Opened', 'passed', '14:02'],
            ['Checks', 'current', '7 of 9'],
            ['Review', 'later', 'Lint'],
            ['Approved', 'later', undefined],
            ['Merge', 'later', 'squash']
        ]);
        expect(steps[1]!.tone).toBe('failed');
        expect(pullSteps(ready, () => '').find((s) => s.state === 'current')?.name).toBe('Merge');
        expect(pullSteps(merged, () => '').every((s) => s.state === 'passed')).toBe(true);
        const closed = pullSteps(with_({ state: 'closed' }), () => '');
        expect(closed[4]).toMatchObject({ state: 'current', tone: 'failed', detail: 'closed' });
        const asked = pullSteps({ ...ready, review: { state: 'changes-requested', reviewers: ['Lint'], threads: [] } }, () => '');
        expect(asked.find((s) => s.state === 'current')).toMatchObject({ name: 'Review', tone: 'needs-you' });
    });

    it('says what is happening now, and nothing once the PR is not open', () => {
        expect(pullNow(board, () => 'Forge')).toEqual({
            title: 'Forge is fixing a failing check',
            body: 'size-limit failed: @agentic/ui is 41.2 kB, the limit is 40 kB',
            attempt: 'attempt 2 of 3'
        });
        expect(pullNow(ready, () => 'Forge')).toBeUndefined();
        expect(pullNow(with_({ state: 'merged' }), () => 'Forge')).toBeUndefined();
    });

    it('formats checks, durations, the origin and the age', () => {
        expect(checksProgress([{ name: 'a', state: 'passed' }, { name: 'b', state: 'skipped' }, { name: 'c', state: 'failed' }])).toBe('1 of 2');
        expect(durationText(41_000)).toBe('41s');
        expect(durationText(250_000)).toBe('4m 10s');
        expect(durationText(undefined)).toBe('');
        expect(originText(board, { issue: { number: 47, label: 'x' } })).toBe('from task t_91a0 · issue #47');
        expect(originText({}, undefined)).toBe('');
        expect(openedAgo(0, 0, () => '25m')).toBe('25m ago');
        expect(openedAgo(0, 0, () => 'now')).toBe('just now');
        expect(openedAgo(0, 0, () => '15 Sep')).toBe('on 15 Sep');
    });

    it('lists the four autopilot switches and turns them all off', () => {
        const a = board.autopilot!;
        expect(autopilotRows(a, 'main').map((r) => r.label)).toEqual(['Fix failing checks', 'Answer review threads', 'Rebase when main moves', 'Merge when green and approved']);
        expect(autopilotRows(a, 'main')[0]!.caption).toBe('up to 3 attempts, then asks you');
        const off = autopilotOff(a);
        expect([off.fixChecks, off.answerThreads, off.rebase, off.mergeWhenGreen]).toEqual([false, false, false, false]);
        expect(off.activity).toBeUndefined();
        expect(off.attempt).toBeUndefined();
    });
});

describe('the pull request page on mock data (#744)', () => {
    it('renders the Pull board: header, stepper, now, checks, threads, rail', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/pr:603');
        const el = page(dom, 'project-pull')!;
        expect(el).not.toBeNull();
        expect(el.querySelector('[data-pull-title]')?.textContent).toBe('ui: member card usage rings');
        expect(el.querySelector('[data-pull-ref]')?.textContent).toBe('agentic#603');
        expect(el.querySelector('[data-pull-diff]')?.textContent).toBe('+184 -41 · 6 files');
        expect(el.querySelector('[data-pull-origin]')?.textContent).toBe('from task t_91a0 · issue #47');
        expect(texts([...el.querySelectorAll('[data-pull-steps] > li > strong')])).toEqual(['Opened', 'Checks', 'Review', 'Approved', 'Merge']);
        expect(el.querySelector('[data-pull-steps] [aria-current="step"] strong')?.textContent).toBe('Checks');
        expect(el.querySelector('[data-pull-now-head] strong')?.textContent).toBe('Forge is fixing a failing check');
        expect(el.querySelector('[data-pull-attempt]')?.textContent).toBe('attempt 2 of 3');
        expect(el.querySelector('[data-pull-now] a[href="/sessions/s_52c1"]')).not.toBeNull();
        expect(el.querySelectorAll('[data-pull-checks] li')).toHaveLength(9);
        expect(el.querySelector('[data-check="failed"] [data-check-name]')?.textContent).toBe('size-limit');
        expect(el.querySelector('[data-pull-review] h3')?.textContent).toBe('Review · 2 open threads');
        expect(texts([...el.querySelectorAll('[data-thread-state]')])).toEqual(['Forge replying', 'OPEN', 'RESOLVED']);
        expect(el.querySelector('[data-pull-blockers]')?.textContent).toBe('Blocked: 1 failing check, 1 check running, 2 open threads, Lint has not approved.');
        expect(el.querySelector<HTMLButtonElement>('button[name="merge"]')?.disabled).toBe(true);
        expect(el.querySelector('[data-pull-approval]')?.textContent).toBe('Will ask for approval: rule ask on merge');
        const switches = [...el.querySelectorAll<HTMLInputElement>('[data-pull-autopilot] input[role="switch"]')];
        expect(switches.map((s) => s.checked)).toEqual([true, true, true, false]);
        expect(el.querySelector('[data-link="task"] a')?.getAttribute('href')).toBe('/tasks/t_91a0');
        expect(el.querySelector('[data-link="issue"]')?.textContent).toBe('agentic#47 mobile pass');
        expect(el.querySelector('[data-link="chat"] a')?.textContent).toBe('Mobile pass #47');
        expect(el.querySelector('[data-link="environment"]')?.textContent).toContain('alien01');
        expect(el.querySelector('[data-link="stack"] a')?.getAttribute('href')).toBe('/projects/p_agentic/work/pr:602');
    });

    it('Stop autopilot turns every switch off and says so', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/pr:603');
        const el = page(dom, 'project-pull')!;
        el.querySelector<HTMLButtonElement>('button[name="stop-autopilot"]')!.click();
        await tick();
        expect(el.querySelector('[data-pull-now]')?.getAttribute('data-stopped')).toBe('stopped');
        expect([...el.querySelectorAll<HTMLInputElement>('[data-pull-autopilot] input[role="switch"]')].map((s) => s.checked)).toEqual([false, false, false, false]);
        // The fixture itself is untouched: the page edits its own copy.
        expect(board.autopilot).toMatchObject({ fixChecks: true, answerThreads: true, rebase: true, attempt: 2 });
    });

    it('a switch flips its own copy, never the fixture', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/pr:603');
        const el = page(dom, 'project-pull')!;
        const merge = el.querySelector<HTMLInputElement>('[data-switch="mergeWhenGreen"] input[role="switch"]')!;
        merge.click();
        await tick();
        expect(merge.checked).toBe(true);
        expect(board.autopilot?.mergeWhenGreen).toBe(false);
    });

    it('offers Squash and merge on a PR with nothing in the way', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/pr:602');
        const el = page(dom, 'project-pull')!;
        expect(el.querySelector('[data-pull-blockers]')?.textContent).toBe('Ready to merge.');
        const merge = el.querySelector<HTMLButtonElement>('button[name="merge"]')!;
        expect(merge.disabled).toBe(false);
        merge.click();
        await tick();
        expect(el.querySelector('[data-pull-approval]')?.textContent).toBe('Asked for approval: rule ask on merge');
    });

    it('says so for a PR the project does not have', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/pr:9999');
        const el = page(dom, 'project-pull')!;
        expect(el.querySelector('[data-pull-board]')).toBeNull();
        expect(el.textContent).toContain('No pull request #9999');
    });
});

describe('the pull request page on the live wire (#744)', () => {
    let h: LiveHarness;
    const source: PullSource = { get: async (_repo, n) => (n === 603 ? board : undefined), listOpen: async () => [board] };
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [definePullsActor({ sources: { open: () => source } })] });
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    it('reads the PR from Pulls.get, with the autopilot controls live (#858)', { timeout: 20_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        await h.app.as(owner).actor(definePullsActor({ sources: { open: () => source } }), pullsKey(WS, id)).watch({ provider: 'github', repo: 'andtii/agentic' });
        const dom = await mountLive(`/projects/${id}/work/pr:603`, h);
        await until(() => dom.querySelector('[data-pull-title]') !== null, 'the PR');
        expect(dom.querySelector('[data-pull-title]')?.textContent).toBe('ui: member card usage rings');
        expect(dom.querySelector('[data-pull-blockers]')?.textContent).toBe('Blocked: 1 failing check, 1 check running, 2 open threads, Lint has not approved.');
        expect(dom.querySelector<HTMLButtonElement>('button[name="stop-autopilot"]')?.disabled).toBe(false);
        expect([...dom.querySelectorAll<HTMLInputElement>('[data-pull-autopilot] input[role="switch"]')].some((s) => s.disabled)).toBe(false);

        const gone = await mountLive(`/projects/${id}/work/pr:9999`, h);
        await until(() => gone.textContent?.includes('No pull request #9999') ?? false, 'the not-found state');
    });
});
