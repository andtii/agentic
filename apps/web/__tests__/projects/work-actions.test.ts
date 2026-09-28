/**
 * Clearing the Work view (#1040), the model: a failed task leaves "Your move" once dismissed or a week old, and a
 * task's row offers Retry and Dismiss when failed, Stop while queued, running or waiting; a pull request's row none.
 */
import { describe, it, expect } from 'vitest';
import type { AgentId, PullRequest, TaskId } from '@agentic/core';
import { WEEK_MS, workActionsOf, workItemsOf, type WorkFeatures, type WorkTask } from '../../src/pages/projects/work/model';
import { workTaskOf } from '../../src/pages/projects/work/live';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const plain: WorkFeatures = { enabled: [], uiOf: () => undefined };
const task = (id: string, more: Partial<WorkTask> = {}): WorkTask => ({ id: id as TaskId, title: id, status: 'failed', assignee: 'forge' as AgentId, updatedAt: NOW - 60_000, ...more });
const ids = (tasks: WorkTask[]) => workItemsOf(tasks, [], [], plain, NOW).map((i) => i.id);

describe('failed tasks in the Work view (#1040)', () => {
    it('a recent failed task is your move, to retry or dismiss', () => {
        expect(workItemsOf([task('t1')], [], [], plain, NOW)[0]).toMatchObject({ group: 'your-move', stageState: 'failed', nextStep: 'Failed — retry or dismiss it' });
    });

    it('a dismissed failed task is left out, for every viewer (the row carries it)', () => {
        expect(ids([task('t1', { dismissedAt: NOW - 1_000 }), task('t2')])).toEqual(['task:t2']);
        expect(workTaskOf({ id: 't1' as TaskId, objective: 'x', status: 'failed', assignee: 'forge' as AgentId, updatedAt: 1, dismissedAt: 5 }).dismissedAt).toBe(5);
    });

    it('a failed task older than a week is left out, as done work leaves Done this week', () => {
        expect(ids([task('old', { updatedAt: NOW - WEEK_MS - 1 }), task('edge', { updatedAt: NOW - WEEK_MS })])).toEqual(['task:edge']);
    });
});

describe('workActionsOf (#1040)', () => {
    const actions = (t: WorkTask) => workActionsOf(workItemsOf([t], [], [], plain, NOW)[0]!, [t]);
    it('failed → Retry and Dismiss; queued, active and waiting → Stop', () => {
        expect(actions(task('f'))).toEqual(['retry', 'dismiss']);
        for (const status of ['queued', 'active'] as const) expect(actions(task('s', { status }))).toEqual(['stop']);
        expect(actions(task('w', { status: 'waiting', wait: { kind: 'input', message: 'Which?' } as unknown as WorkTask['wait'] }))).toEqual(['stop']);
        expect(actions(task('c', { status: 'completed' }))).toEqual([]);
    });

    it('a pull request’s row has none: its buttons are the PR page’s', () => {
        const pr: PullRequest = { provider: 'github', repo: 'o/r', number: 7, title: 'PR 7', url: '', head: 'b', base: 'main', state: 'open', additions: 1, deletions: 0, files: 1, openedBy: 'forge', openedAt: NOW - 60_000, checks: [{ name: 'ci', state: 'failed' }], review: { state: 'none', reviewers: [], threads: [] }, mergeable: true, taskId: 'f' as TaskId };
        const t = task('f');
        const [row] = workItemsOf([t], [pr], [], plain, NOW);
        expect(row!.id).toBe('pr:7');
        expect(workActionsOf(row!, [t])).toEqual([]);
    });
});
