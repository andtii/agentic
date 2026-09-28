/** The project tally follows the Work view (#1040): a dismissed failed task, or one failed over a week ago, is no one's move. */
import { describe, expect, it } from 'vitest';
import type { AgentId, TaskId, TaskStatus } from '@agentic/core';
import type { TaskIndexRow } from '../../src/task/task-index';
import { tallyProjectWork } from '../../src/workspace/project-work';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const WEEK = 7 * 24 * 3_600_000;
const row = (id: string, status: TaskStatus, extra: Partial<TaskIndexRow> = {}): TaskIndexRow => ({
    id: id as TaskId, objective: id, assignee: 'forge' as AgentId, owner: 'forge' as AgentId, status, origin: 'user', depth: 0, createdAt: NOW - 10_000, updatedAt: NOW - 10_000, n: 1, ...extra
});

describe('tallyProjectWork: failed tasks (#1040)', () => {
    it('counts a recent failed task as your move, but not a dismissed or week-old one', () => {
        const tally = tallyProjectWork([row('t1', 'failed'), row('t2', 'failed', { dismissedAt: NOW - 1_000 }), row('t3', 'failed', { updatedAt: NOW - WEEK - 1 })], [], [], NOW);
        expect(tally).toMatchObject({ yourMove: 1, next: ['retry t1'] });
    });
});
