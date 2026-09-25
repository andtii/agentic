/**
 * Mock data for the pull request page (#744) — imported only by its own page; nothing shared re-exports it.
 * `p_agentic` #603 is the Pull board (docs/design/projects/boards/Pull.dc.html): a failing size-limit Forge is fixing on
 * attempt 2 of 3, two open threads, stacked on #602 — which is ready to merge; #597 is merged.
 */
import type { AgentId, ChatId, PullCheck, PullRequest, SessionId, TaskId } from '@agentic/core';
import type { PullPageData } from '../../pages/projects/work/pull/model';
import { MOCK_NOW } from '../workspace';

const m = (n: number): number => MOCK_NOW - n * 60_000;
const h = (n: number): number => MOCK_NOW - n * 3_600_000;
const s = (n: number): number => n * 1000;

const forge = 'forge' as AgentId;
const ok = (name: string, durationMs: number): PullCheck => ({ name, state: 'passed', durationMs });

function pull(p: Pick<PullRequest, 'number' | 'title' | 'head' | 'openedAt'> & Partial<PullRequest>): PullRequest {
    return {
        provider: 'github',
        repo: 'andtii/agentic',
        url: `https://github.com/andtii/agentic/pull/${p.number}`,
        base: 'main',
        state: 'open',
        additions: 120,
        deletions: 30,
        files: 4,
        openedBy: 'forge',
        checks: [],
        review: { state: 'none', reviewers: [], threads: [] },
        mergeable: true,
        ...p
    };
}

const board: PullPageData = {
    pr: pull({
        number: 603,
        title: 'ui: member card usage rings',
        head: '603-usage-rings',
        openedAt: m(25),
        additions: 184,
        deletions: 41,
        files: 6,
        taskId: 't_91a0' as TaskId,
        chatId: 'c_mobile47' as ChatId,
        sessionId: 's_52c1' as SessionId,
        after: 602,
        checks: [
            { name: 'size-limit', state: 'failed', detail: '@agentic/ui is 41.2 kB, the limit is 40 kB', durationMs: s(41) },
            { name: 'e2e:mobile', state: 'running', detail: 'about 6 min left', durationMs: s(250) },
            ok('typecheck', s(62)),
            ok('test packages/ui', s(151)),
            ok('zero:validate', s(38)),
            ok('lint', s(22)),
            ok('build web', s(108)),
            ok('test core', s(44)),
            ok('codecov/patch', s(12))
        ],
        review: {
            state: 'requested',
            reviewers: ['Lint'],
            threads: [
                { id: 'th1', author: 'lint', path: 'MemberCard.tsx', line: 41, body: 'The ring needs an accessible name; screen readers get three unlabeled SVGs.', state: 'replying', reply: 'adding role="img" and aria-label per ring, pushing with the size fix.' },
                { id: 'th2', author: 'lint', path: 'usage.ts', line: 12, body: 'Round down, not to nearest: 99.6% must not read as 100%.', state: 'open' },
                { id: 'th3', author: 'you', path: 'lib.css', line: 8, body: 'Keep amber for full, not red.', state: 'resolved' }
            ]
        },
        autopilot: { agentId: forge, fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: false, attempt: 2, activity: 'Fixing a failing check' }
    }),
    linked: {
        taskTitle: 'Member card usage rings',
        issue: { number: 47, label: 'agentic#47 mobile pass' },
        chatTitle: 'Mobile pass #47',
        environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }
    }
};

/** Pull requests by project id, with what the page links them to. */
export const MOCK_PULLS: Readonly<Record<string, readonly PullPageData[]>> = {
    p_agentic: [
        board,
        {
            pr: pull({
                number: 602, title: 'Make the drawer collapse below 768 px', head: '602-mobile-drawer', openedAt: h(5), taskId: 't_8f2c' as TaskId,
                checks: [ok('typecheck', s(60)), ok('lint', s(20)), ok('test core', s(40))],
                review: { state: 'approved', reviewers: ['Lint'], threads: [] },
                autopilot: { agentId: forge, fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: false }
            }),
            linked: { taskTitle: 'Make the drawer collapse below 768 px' }
        },
        {
            pr: pull({
                number: 597, title: 'Home shows the agents strip', head: '597-agents-strip', openedAt: h(50), state: 'merged', mergedAt: h(20),
                checks: [ok('typecheck', s(60)), ok('lint', s(20))],
                review: { state: 'approved', reviewers: ['Lint'], threads: [] }
            })
        }
    ]
};
