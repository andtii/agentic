/**
 * Mock data for the Work view (#738) — imported only by its own page; nothing shared re-exports it. What the page
 * derives its rows from on mock data: each project's tasks, pull requests and plan items, and the enabled features'
 * `ui` blocks (boards ProjectCode for `p_agentic`, Git on, and ProjectPlain for `p_docs`, no stage feature).
 */
import type { AgentId, PlanItem, ProjectFeatureUi, PullCheck, PullRequest, SessionId, TaskId } from '@agentic/core';
import { gitFeatureManifest } from '@agentic/plugins-git';
import { MOCK_NOW } from '../workspace';
import type { WorkTask } from '../../pages/projects/work/model';

export interface MockWork {
    readonly tasks: readonly WorkTask[];
    readonly pulls: readonly PullRequest[];
    readonly planItems: readonly PlanItem[];
}

const m = (n: number): number => MOCK_NOW - n * 60_000;
const h = (n: number): number => MOCK_NOW - n * 3_600_000;
const tid = (s: string): TaskId => s as TaskId;
const aid = (s: string): AgentId => s as AgentId;

const passed = (n: number): PullCheck[] => Array.from({ length: n }, (_, i) => ({ name: `check ${i + 1}`, state: 'passed' as const }));

function pull(p: Pick<PullRequest, 'number' | 'title' | 'head' | 'checks' | 'openedAt'> & Partial<PullRequest>): PullRequest {
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
        review: { state: 'none', reviewers: [], threads: [] },
        mergeable: true,
        ...p
    };
}

const task = (id: string, title: string, assignee: string, updatedAt: number, more: Partial<WorkTask> = {}): WorkTask =>
    ({ id: tid(id), title, status: 'active', assignee: aid(assignee), updatedAt, ...more });

const agentic: MockWork = {
    tasks: [
        task('t_8f2c', 'Make the drawer collapse below 768 px', 'forge', h(2), { status: 'waiting', wait: { kind: 'pull-request', number: 602, state: 'open' } }),
        task('t_77c0', 'Mobile drawer spec measures after the slide', 'lint', h(26), { status: 'waiting', wait: { kind: 'pull-request', number: 598, state: 'open' } }),
        task('t_80e4', 'History filter lists audit kinds', 'forge', m(40), { status: 'waiting', wait: { kind: 'pull-request', number: 605, state: 'open' } }),
        task('t_91a0', 'Member card usage rings', 'forge', m(25), { status: 'waiting', wait: { kind: 'pull-request', number: 603, state: 'open' } }),
        task('t_88b2', 'Session changes and files views', 'forge', h(3), { status: 'waiting', wait: { kind: 'pull-request', number: 599, state: 'open' } }),
        task('t_93d1', 'Orchestration MCP tools', 'forge', m(11), { branch: '604-mcp-tools', activity: 'Writing tests · opens a PR when they pass' }),
        task('t_77b1', 'A2A landscape note', 'scout', m(18), { status: 'queued', activity: 'Reading the A2A spec and client list' }),
        task('t_85d0', 'Retry budget in the task timeline', 'forge', m(6), { status: 'waiting', wait: { kind: 'pull-request', number: 600, state: 'open' } }),
        task('t_86e1', 'Agent card rename field', 'forge', h(1), { status: 'waiting', wait: { kind: 'pull-request', number: 601, state: 'open' } }),
        task('t_70aa', 'Machines page empty state', 'forge', h(30), { status: 'completed' }),
        task('t_6f10', 'Crumbs name the project', 'lint', h(52), { status: 'completed' })
    ],
    pulls: [
        pull({ number: 602, title: 'Make the drawer collapse below 768 px', head: '602-mobile-drawer', checks: passed(9), openedAt: h(5), taskId: tid('t_8f2c'), review: { state: 'approved', reviewers: ['Lint'], threads: [] }, autopilot: { agentId: aid('forge'), fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: false } }),
        pull({ number: 598, title: 'Mobile drawer spec measures after the slide', head: '598-drawer-spec', checks: passed(8), openedAt: h(30), files: 3, taskId: tid('t_77c0'), openedBy: 'lint', review: { state: 'requested', reviewers: [], threads: [] } }),
        pull({ number: 605, title: 'History filter lists audit kinds', head: '605-history-kinds', checks: [], openedAt: h(1), taskId: tid('t_80e4'), mergeable: false, after: 602 }),
        pull({
            number: 603, title: 'Member card usage rings', head: '603-usage-rings', openedAt: h(4), taskId: tid('t_91a0'),
            checks: [...passed(7), { name: 'size-limit', state: 'failed', detail: '+1.2 kB over the budget' }, { name: 'e2e', state: 'running' }],
            autopilot: { agentId: aid('forge'), fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: false, attempt: 2, activity: 'Fixing size-limit' }
        }),
        pull({
            number: 599, title: 'Session changes and files views', head: '599-session-files', checks: passed(9), openedAt: h(8), taskId: tid('t_88b2'),
            review: { state: 'changes-requested', reviewers: ['Lint'], threads: [{ id: 'th1', author: 'lint', body: 'Name the empty state.', state: 'open' }, { id: 'th2', author: 'lint', body: 'Keep the tree collapsed by default.', state: 'replying' }] },
            autopilot: { agentId: aid('forge'), fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: false, activity: 'Answering 2 review threads from Lint' }
        }),
        pull({ number: 600, title: 'Retry budget in the task timeline', head: '600-retry-budget', openedAt: h(1), taskId: tid('t_85d0'), checks: [...passed(6), { name: 'test', state: 'running' }, { name: 'e2e', state: 'queued' }, { name: 'size', state: 'queued' }] }),
        pull({ number: 601, title: 'Agent card rename field', head: '601-agent-rename', checks: passed(9), openedAt: h(3), taskId: tid('t_86e1'), review: { state: 'requested', reviewers: ['Lint'], threads: [] } }),
        pull({ number: 597, title: 'Home shows the agents strip', head: '597-agents-strip', checks: passed(9), openedAt: h(50), state: 'merged', mergedAt: h(20), review: { state: 'approved', reviewers: ['Lint'], threads: [] } })
    ],
    planItems: []
};

const approval = (requestId: string) => ({ kind: 'approval' as const, requestId, sessionId: 's_docs' as SessionId });

const docs: MockWork = {
    tasks: [
        task('t_a102', 'Publish the release notes post', 'scout', h(3), { status: 'waiting', wait: approval('r_a102'), activity: 'Approve publishing the post to the blog' }),
        task('t_a0f7', 'Shortlist diagrams for the A2A post', 'scout', h(1), { activity: 'Comparing 6 candidates · 4 in' }),
        task('t_a0e1', 'Collect reader questions', 'atlas', m(20), { activity: 'Reading 14 comments on the last post' }),
        task('t_9f30', 'Fix broken links on the about page', 'scout', h(20), { status: 'completed' }),
        task('t_9e21', 'Draft the September changelog', 'atlas', h(44), { status: 'completed' }),
        task('t_9d12', 'Tag old posts by topic', 'scout', h(70), { status: 'completed' })
    ],
    pulls: [],
    planItems: []
};

/** What each mock project's Work view derives its rows from. */
export const MOCK_WORK: Readonly<Record<string, MockWork>> = { p_agentic: agentic, p_docs: docs };

/** The manifest `ui` of the features the mock workspace ships (Git's is the real one). */
export const mockFeatureUi = (featureId: string): ProjectFeatureUi | undefined => (featureId === gitFeatureManifest.id ? gitFeatureManifest.ui : undefined);
