/**
 * The pure view models behind the live Tasks, History and Usage pages
 * (#146): index rows to table rows, chains for Stop all, the audit query
 * and row adapters, the cost figures that keep reported and estimated
 * apart (OPS-07).
 */
import { describe, it, expect } from 'vitest';
import type { AgentId, TaskId } from '@agentic/core';
import type { AuditEvent, LedgerGroup, LedgerTotals, TaskIndexRow } from '@agentic/platform';
import { lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import { chainRoots, countTasks, filterTasks, taskListRow } from '../../src/pages/task/live';
import { actorOf, auditQueryOf, kindLabel, localIso, mergePages, refOf, rowOf, toneOf } from '../../src/pages/history/live';
import { costPartsOf, costText, daysOf, statsOf, tokensText, usageRowsOf } from '../../src/pages/usage/live';

const agents: Record<string, AgentIdentity> = {
    forge: { id: 'forge', name: 'Forge', role: 'Builds', hue: 2, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'workspace' }, configVersion: 3 }
};
const lookup = lookupOver(agents);

const indexRow = (extra: Partial<TaskIndexRow> = {}): TaskIndexRow => ({ id: 't1' as TaskId, objective: 'do it', assignee: 'forge' as AgentId, owner: 'forge' as AgentId, status: 'queued', origin: 'user', depth: 0, createdAt: 1_000, updatedAt: 1_000, n: 0, ...extra });

describe('task list model', () => {
    it('joins an index row with the directory and spells the wait detail', () => {
        const row = taskListRow(indexRow({ status: 'waiting', wait: { kind: 'input', requestId: 'resume:turn_1' } }), lookup);
        expect(row).toMatchObject({ id: 't1', status: 'waiting', waitDetail: 'interrupted · uncertain', agent: { name: 'Forge', hue: 2 }, environment: { runtime: 'anthropic-api' } });
        const unknown = taskListRow(indexRow({ assignee: 'ghost' as AgentId }), lookup);
        expect(unknown.agent.name).toBe('ghost');
        expect(unknown.waitDetail).toBeUndefined();
    });

    it('filters and counts by status', () => {
        const rows = [indexRow({ id: 'a' as TaskId }), indexRow({ id: 'b' as TaskId, status: 'active' }), indexRow({ id: 'c' as TaskId, status: 'completed' })];
        expect(filterTasks(rows, 'active').map((r) => r.id)).toEqual(['b']);
        expect(filterTasks(rows, 'all')).toHaveLength(3);
        expect(countTasks(rows)).toEqual({ all: 3, queued: 1, active: 1, waiting: 0, completed: 1, failed: 0, cancelled: 0 });
    });

    it('Stop all takes the chain roots only: a child of an active parent is cancelled through its parent', () => {
        const rows = [
            indexRow({ id: 'p' as TaskId, status: 'waiting' }),
            indexRow({ id: 'p.c1' as TaskId, status: 'active', parentId: 'p' as TaskId, depth: 1 }),
            indexRow({ id: 'orphan' as TaskId, status: 'queued', parentId: 'gone' as TaskId, depth: 1 }),
            indexRow({ id: 'done' as TaskId, status: 'completed' })
        ];
        expect(chainRoots(rows).map((r) => r.id)).toEqual(['p', 'orphan']);
    });
});

const event = (extra: Partial<AuditEvent> & Pick<AuditEvent, 'kind' | 'data'>): AuditEvent => ({ key: `k-${extra.seq ?? 0}`, seq: 0, at: Date.UTC(2026, 8, 17, 12, 0, 0), by: 'user:u1', summary: 'something happened', ...extra } as AuditEvent);

describe('history model', () => {
    it('turns the filters into the actor query', () => {
        const now = 1_000_000;
        expect(auditQueryOf({ kind: 'all', agentId: null, window: 'all' }, now)).toEqual({ limit: 50 });
        expect(auditQueryOf({ kind: 'approvals', agentId: 'forge', window: 'hour' }, now, 42)).toEqual({ kinds: ['approval.requested', 'approval.resolved'], agentId: 'forge', since: now - 3_600_000, cursor: 42, limit: 50 });
    });

    it('labels, tones, actors and refs per kind', () => {
        const requested = event({ kind: 'approval.requested', data: { requestId: 'r1' }, by: 'agent:forge', taskId: 't1' as TaskId, sessionId: 's1' as never });
        expect(kindLabel(requested)).toBe('approval requested');
        expect(toneOf(requested)).toBe('needs-you');
        expect(actorOf(requested.by, lookup)).toEqual({ name: 'Forge', hue: 2, person: false });
        expect(refOf(requested)).toEqual({ label: 't1', href: '/tasks/t1' });

        const interrupted = event({ kind: 'task.transition', data: { from: 'active', to: 'waiting', why: 'interrupted', wait: { kind: 'input', requestId: 'resume:turn_3' } }, by: 'system:routing', sessionId: 's1' as never });
        expect(kindLabel(interrupted)).toBe('interrupted');
        expect(toneOf(interrupted)).toBe('failed');
        expect(actorOf(interrupted.by, lookup).name).toBe('platform');
        expect(refOf(interrupted)).toEqual({ label: 's1', href: '/sessions/s1' });

        const failed = event({ kind: 'task.transition', data: { from: 'active', to: 'failed', why: 'failed: budget' } });
        expect(kindLabel(failed)).toBe('failed');
        expect(toneOf(failed)).toBe('failed');
        expect(toneOf(event({ kind: 'task.transition', data: { from: 'queued', to: 'active', why: 'started' } }))).toBeUndefined();

        const delegated = event({ kind: 'delegation.created', data: { parentTaskId: 'p' as TaskId, childTaskId: 'p.c1' as TaskId, assignee: 'forge' as AgentId, owner: 'forge' as AgentId, objective: 'sub', callId: 'c1', constraints: {} }, taskId: 'p' as TaskId });
        expect(refOf(delegated)).toEqual({ label: 'p.c1', href: '/tasks/p.c1' });
        const paired = event({ kind: 'machine.paired', data: { machineId: 'm1' as never, name: 'alien01' }, by: 'machine:m1' });
        expect(refOf(paired)).toEqual({ label: 'alien01', href: '/machines/m1' });
        expect(actorOf(paired.by, lookup).name).toBe('m1');
        expect(actorOf('user:u1', lookup)).toEqual({ name: 'You', hue: 1, person: true });
        // The pages cancel as a bare `user`; a child settling its parent signs `task:<id>`.
        expect(actorOf('user', lookup)).toEqual({ name: 'You', hue: 1, person: true });
        expect(actorOf('task:p.c1', lookup).name).toBe('task p.c1');
        expect(refOf(event({ kind: 'plugin.enabled', data: { pluginId: 'p' } }))).toBeNull();

        // A worktree created from the folder picker (#189, #193): filed with the environment choices, leads to its machine.
        const worktree = event({ kind: 'workdir.worktree-created', data: { machineId: 'm1' as never, environmentId: 'env_work' as never, repo: 'C:\\src\\app', branch: 'feat/x', path: 'C:\\src\\app-worktrees\\feat-x' } });
        expect(kindLabel(worktree)).toBe('worktree created');
        expect(toneOf(worktree)).toBe('live');
        expect(refOf(worktree)).toEqual({ label: 'feat/x', href: '/machines/m1' });
        expect(auditQueryOf({ kind: 'environments', agentId: null, window: 'all' }, 0).kinds).toEqual(['environment.chosen', 'workdir.worktree-created']);
    });

    it('stamps the workspace-zone time and groups by day through it', () => {
        expect(localIso(Date.UTC(2026, 8, 17, 23, 30, 5), 'UTC')).toBe('2026-09-17T23:30:05');
        expect(localIso(Date.UTC(2026, 8, 17, 23, 30, 5), 'Europe/Stockholm')).toBe('2026-09-18T01:30:05');
        expect(localIso(Date.UTC(2026, 8, 17, 23, 30, 5), 'Not/AZone')).toBe('2026-09-17T23:30:05');
        const row = rowOf(event({ kind: 'config.versioned', data: { version: 2, reason: 'edited' }, agentId: 'forge' as AgentId, seq: 7 }), lookup, 'UTC');
        expect(row).toMatchObject({ seq: 7, kind: 'config.versioned', label: 'config versioned', at: '2026-09-17T12:00:00', what: 'something happened', ref: { href: '/agents/forge' } });
    });

    it('merges pages newest first without repeating an event', () => {
        const a = event({ kind: 'plugin.enabled', data: { pluginId: 'a' }, seq: 5, key: 'a' });
        const b = event({ kind: 'plugin.enabled', data: { pluginId: 'b' }, seq: 4, key: 'b' });
        const c = event({ kind: 'plugin.enabled', data: { pluginId: 'c' }, seq: 3, key: 'c' });
        expect(mergePages([[a, b], [b, c]]).map((e) => e.seq)).toEqual([5, 4, 3]);
    });
});

const totals = (extra: Partial<LedgerTotals> = {}): LedgerTotals => ({ rows: 2, usage: { inputTokens: 1_000, outputTokens: 200 }, costUsd: 1.5, estimatedCostUsd: 0, estimatedRows: 0, unpricedRows: 0, quality: 'reported', from: 1, to: 2, ...extra });

describe('usage model', () => {
    it('keeps the reported and the estimated part of a cost apart, and prints n/a for nothing priced', () => {
        expect(costText(costPartsOf(totals()))).toBe('$1.50');
        expect(costText(costPartsOf(totals({ costUsd: 1.5, estimatedCostUsd: 0.5, estimatedRows: 1, quality: 'partly-estimated' })))).toBe('$1.00 + ~$0.50');
        expect(costText(costPartsOf(totals({ costUsd: 0.5, estimatedCostUsd: 0.5, estimatedRows: 2, quality: 'estimated' })))).toBe('~$0.50');
        expect(costText(costPartsOf(totals({ costUsd: null, unpricedRows: 2, quality: 'not-reported' })))).toBe('n/a');
        expect(costText(costPartsOf(totals({ costUsd: 0, quality: 'reported' })))).toBe('$0.00');
        expect(tokensText(null)).toBe('n/a');
        expect(tokensText(1_234)).toBe('1.2k');
        expect(tokensText(2_500_000)).toBe('2.5M');
    });

    it('rows per grouping: agents through the directory, the unattributed task named, days newest first', () => {
        const group = (key: string, extra: Partial<LedgerTotals> = {}): LedgerGroup => ({ key, ...totals(extra) });
        const byAgent = usageRowsOf({ by: 'agent', total: totals(), groups: [group('forge'), group('ghost', { costUsd: null, quality: 'not-reported', unpricedRows: 2 })] }, 'agent', lookup);
        expect(byAgent.map((r) => [r.label, r.agent?.runtime ?? null, costText(r.cost), r.quality])).toEqual([['Forge', 'anthropic-api', '$1.50', 'reported'], ['ghost', '—', 'n/a', 'not-reported']]);
        const byTask = usageRowsOf({ by: 'task', total: totals(), groups: [group('(none)'), group('t1')] }, 'task', lookup);
        expect(byTask.map((r) => r.label)).toEqual(['t1', 'No task (chat turns)']);
        const byDay = usageRowsOf({ by: 'day', total: totals(), groups: [group('2026-09-01'), group('2026-09-02')] }, 'day', lookup);
        expect(byDay.map((r) => r.id)).toEqual(['2026-09-02', '2026-09-01']);
        expect(usageRowsOf(null, 'agent', lookup)).toEqual([]);
    });

    it('the stat cards say what each figure is', () => {
        const [spend, estimated, unpriced, turns] = statsOf(totals({ rows: 4, costUsd: 2.0, estimatedCostUsd: 0.5, estimatedRows: 1, unpricedRows: 1, quality: 'partly-estimated' }), '2026-09');
        expect(spend).toMatchObject({ label: 'September 2026 spend', value: '$2.00', caption: '$1.50 reported + $0.50 estimated', tone: 'live' });
        expect(estimated).toMatchObject({ value: '~$0.50', caption: '1 turn priced at a guessed rate', tone: 'needs-you' });
        expect(unpriced).toMatchObject({ value: '1 turn', caption: 'the runtime gave no cost data' });
        expect(turns).toMatchObject({ value: '4', caption: '1.2k tokens' });
        expect(statsOf(null, '2026-09')[0]).toMatchObject({ value: 'n/a', caption: 'nothing recorded yet', tone: 'muted' });
        expect(statsOf(totals({ costUsd: null, quality: 'not-reported', unpricedRows: 2 }), '2026-09')[0]).toMatchObject({ value: 'n/a', caption: 'no provider reported a cost' });
    });

    it('one bar per day up to today, unpriced days at 0', () => {
        const days = daysOf({ by: 'day', total: totals(), groups: [{ key: '2026-09-02', ...totals({ costUsd: 1.25 }) }, { key: '2026-09-04', ...totals({ costUsd: null, quality: 'not-reported' }) }] }, '2026-09', '2026-09-04');
        expect(days).toEqual({ from: '1 Sept', to: '4 Sept', values: [0, 1.25, 0, 0], today: '$0.00' });
        expect(daysOf(null, '2026-02', '2026-03-01').values).toHaveLength(28);
    });
});
