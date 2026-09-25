/**
 * Work view model follow-ups (#802): an open PR with no checks reported waits on CI rather than showing green, and a
 * plan item without History lines keeps a timestamp instead of sorting as the oldest row and dropping off when done.
 */
import { describe, it, expect } from 'vitest';
import type { AgentId, PlanItem, ProjectFeatureUi, PullRequest } from '@agentic/core';
import { WEEK_MS, workItemsOf, type WorkFeatures } from '../../src/pages/projects/work/model';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const min = (n: number): number => NOW - n * 60_000;
const GIT_STAGES = ['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge'];
const git: WorkFeatures = { enabled: ['agentic.feature.git'], uiOf: (id): ProjectFeatureUi | undefined => (id === 'agentic.feature.git' ? { workStages: GIT_STAGES } : undefined) };
const plain: WorkFeatures = { enabled: [], uiOf: () => undefined };

const pr = (number: number, more: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github', repo: 'o/r', number, title: `PR ${number}`, url: '', head: `${number}-branch`, base: 'main', state: 'open',
    additions: 1, deletions: 1, files: 3, openedBy: 'forge', openedAt: min(60), checks: [],
    review: { state: 'none', reviewers: [], threads: [] }, mergeable: true, ...more
});

const item = (id: number, more: Partial<PlanItem> = {}): PlanItem => ({ id, title: `Item ${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...more });

describe('empty checks are not green (#802)', () => {
    it('an open PR with no checks waits on CI at the Checks stage', () => {
        const [row] = workItemsOf([], [pr(7)], [], git, NOW);
        expect(row).toMatchObject({ id: 'pr:7', stage: 3, stageState: 'working', group: 'waiting', nextStep: 'Waiting on CI · no checks reported yet' });
    });

    it('conflicts still come first', () => {
        const [row] = workItemsOf([], [pr(7, { mergeable: false })], [], git, NOW);
        expect(row).toMatchObject({ stage: 2, group: 'your-move' });
    });
});

describe('plan items without activity keep a timestamp (#802)', () => {
    it('a done item with no History stays in done', () => {
        const rows = workItemsOf([], [], [item(1, { state: 'done' })], plain, NOW);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'item:1', group: 'done' });
        expect(rows[0]!.updatedAt).toBe(NOW);
    });

    it('a claimed item with no History does not sort as the oldest row', () => {
        const claim = { agentId: 'forge' as AgentId, leaseUntil: NOW + WEEK_MS };
        const rows = workItemsOf([], [pr(9, { checks: [{ name: 'ci', state: 'passed' }] })], [item(2, { state: 'claimed', claim })], git, NOW);
        expect(rows.map((r) => r.id)).toEqual(['item:2', 'pr:9']);
    });

    it('an item with History still takes its newest line', () => {
        const activity = [{ at: min(30), actor: { kind: 'user' as const, userId: 'u' }, text: 'added' }, { at: min(10), actor: { kind: 'user' as const, userId: 'u' }, text: 'done' }];
        const [row] = workItemsOf([], [], [item(3, { state: 'done', activity })], plain, NOW);
        expect(row!.updatedAt).toBe(min(10));
    });
});
