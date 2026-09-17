/** Pure ledger rules: keys, the reducer, aggregation with honest flags (OPS-07), and budget verdicts (COL-11, OPS-08). */
import { describe, expect, it } from 'vitest';
import type { AgentId, WorkspaceId } from '@agentic/core';
import {
    BUDGET_ERROR_CODE,
    UNATTRIBUTED,
    applyLedgerEntry,
    budgetError,
    checkBudget,
    dayOf,
    initialLedgerState,
    isBudgetFailure,
    ledgerKey,
    ledgerMonth,
    parseLedgerKey,
    remainingBudget,
    summarize,
    type LedgerRow
} from '../../src/ledger/index';

const WS = 'ws_1' as WorkspaceId;
const A = 'agent_a' as AgentId;
const B = 'agent_b' as AgentId;
const T0 = Date.UTC(2026, 8, 16, 23, 30); // 2026-09-16T23:30Z — 17 Sep 01:30 in Stockholm

const row = (key: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({
    key,
    at: T0,
    sessionId: 's1',
    agentId: A,
    usage: { inputTokens: 100, outputTokens: 10 },
    estimated: false,
    ...extra
});

describe('keys', () => {
    it('months are UTC and keys round-trip', () => {
        expect(ledgerMonth(T0)).toBe('2026-09');
        expect(ledgerMonth(Date.UTC(2026, 11, 31, 23, 59))).toBe('2026-12');
        expect(ledgerKey(WS, '2026-09')).toBe('ws_1:ledger:2026-09');
        expect(parseLedgerKey('ws_1:ledger:2026-09')).toEqual({ workspaceId: WS, month: '2026-09' });
        expect(parseLedgerKey('ws_1:ledger:2026-13')).toBeNull();
        expect(parseLedgerKey('ws_1:task:t1')).toBeNull();
        expect(() => ledgerMonth(Number.NaN)).toThrow(RangeError);
    });

    it('dayOf follows the zone', () => {
        expect(dayOf(T0)).toBe('2026-09-16');
        expect(dayOf(T0, 'Europe/Stockholm')).toBe('2026-09-17');
        expect(() => dayOf(T0, 'Mars/Olympus')).toThrow(RangeError);
    });
});

describe('reducer', () => {
    it('folds a row once by key and counts corrections', () => {
        const s = initialLedgerState();
        applyLedgerEntry(s, { t: 'usage', row: row('k1') });
        applyLedgerEntry(s, { t: 'usage', row: row('k1', { costUsd: 99 }) });
        applyLedgerEntry(s, { t: 'usage', row: row('k2') });
        expect(s.rows.map((r) => r.key)).toEqual(['k1', 'k2']);
        expect(s.rows[0]!.costUsd).toBeUndefined();
        applyLedgerEntry(s, { t: 'correction', tally: { agentId: A, week: '2026-W38', what: 'wrong', at: T0 } });
        applyLedgerEntry(s, { t: 'correction', tally: { agentId: A, week: '2026-W38', what: 'wrong', at: T0 } });
        expect(s.corrections).toEqual({ 'agent_a|2026-W38|wrong': 2 });
    });
});

describe('summarize', () => {
    const rows: LedgerRow[] = [
        row('r1', { taskId: 't1', turnId: 'u1', costUsd: 0.5, usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 40 } }),
        row('r2', { taskId: 't1', turnId: 'u2', costUsd: 0.25, estimated: true, at: T0 + 3_600_000 }),
        row('r3', { agentId: B, sessionId: 's2', at: T0 + 7_200_000 }), // no task, no cost: provider data unavailable
        row('r4', { agentId: B, sessionId: 's2', taskId: 't2', costUsd: 1, at: T0 + 7_200_000 })
    ];

    it('adds usage across every counter and prices only the rows that carry a cost', () => {
        const { total } = summarize(rows, { by: 'agent' });
        expect(total.rows).toBe(4);
        expect(total.usage).toEqual({ inputTokens: 400, outputTokens: 40, cacheReadInputTokens: 40 });
        expect(total.costUsd).toBeCloseTo(1.75);
        expect(total.estimatedCostUsd).toBeCloseTo(0.25);
        expect(total.estimatedRows).toBe(1);
        expect(total.unpricedRows).toBe(1);
        expect(total.quality).toBe('partly-estimated');
        expect(total.from).toBe(T0);
        expect(total.to).toBe(T0 + 7_200_000);
    });

    it('groups by agent, task, session, turn and day with the right quality per group', () => {
        const byAgent = summarize(rows, { by: 'agent' });
        expect(byAgent.groups.map((g) => g.key)).toEqual(['agent_a', 'agent_b']);
        expect(byAgent.groups[0]).toMatchObject({ rows: 2, costUsd: 0.75, quality: 'partly-estimated', estimatedRows: 1 });
        expect(byAgent.groups[1]).toMatchObject({ rows: 2, costUsd: 1, quality: 'partly-estimated', unpricedRows: 1 });

        const byTask = summarize(rows, { by: 'task' });
        expect(byTask.groups.map((g) => g.key)).toEqual([UNATTRIBUTED, 't1', 't2']);
        expect(byTask.groups[0]).toMatchObject({ costUsd: null, quality: 'not-reported' });
        expect(byTask.groups[2]).toMatchObject({ costUsd: 1, quality: 'reported' });

        expect(summarize(rows, { by: 'session' }).groups.map((g) => [g.key, g.rows])).toEqual([
            ['s1', 2],
            ['s2', 2]
        ]);
        const byTurn = summarize(rows, { by: 'turn' });
        expect(byTurn.groups.map((g) => g.key)).toEqual([UNATTRIBUTED, 'u1', 'u2']);
        expect(byTurn.groups[2]).toMatchObject({ quality: 'estimated', estimatedCostUsd: 0.25 });

        expect(summarize(rows, { by: 'day' }).groups.map((g) => [g.key, g.rows])).toEqual([
            ['2026-09-16', 1],
            ['2026-09-17', 3]
        ]);
        expect(summarize(rows, { by: 'day', timeZone: 'Europe/Stockholm' }).groups.map((g) => [g.key, g.rows])).toEqual([['2026-09-17', 4]]);
        expect(() => summarize(rows, { by: 'day', timeZone: 'Nowhere/Land' })).toThrow(RangeError);
    });

    it('filters before grouping and never reports 0 for unreported cost', () => {
        const only = summarize(rows, { by: 'task', agentId: B, sessionId: 's2' });
        expect(only.total.rows).toBe(2);
        const none = summarize(rows, { by: 'agent', taskId: 'missing' });
        expect(none.total).toMatchObject({ rows: 0, costUsd: null, quality: 'not-reported', from: 0, to: 0 });
        expect(none.groups).toEqual([]);
        const unpriced = summarize([rows[2]!], { by: 'agent' });
        expect(unpriced.total.costUsd).toBeNull();
        expect(unpriced.total.quality).toBe('not-reported');
    });
});

describe('checkBudget', () => {
    it('passes a task with no limits and trips the first exhausted budget in key order', () => {
        expect(checkBudget({}, { maxCostUsd: 100 })).toEqual({ ok: true });
        expect(checkBudget({ maxCostUsd: 1, maxTokens: 10 }, { maxCostUsd: 0.99, maxTokens: 5 })).toEqual({ ok: true });
        expect(checkBudget({ maxCostUsd: 1 }, { maxCostUsd: 1 })).toEqual({ ok: false, limit: 'maxCostUsd', max: 1, spent: 1 });
        expect(checkBudget({ maxCostUsd: 1, maxTokens: 10 }, { maxCostUsd: 2, maxTokens: 20 })).toMatchObject({ ok: false, limit: 'maxCostUsd' });
        expect(checkBudget({ maxTokens: 10 }, { maxCostUsd: 2, maxTokens: 20 })).toMatchObject({ ok: false, limit: 'maxTokens', max: 10, spent: 20 });
        expect(checkBudget({ maxWallMs: 10 }, {})).toEqual({ ok: true });
    });

    it('remainingBudget clamps at zero and is undefined for a limit the task lacks', () => {
        expect(remainingBudget({ maxCostUsd: 1 }, { maxCostUsd: 0.25 }, 'maxCostUsd')).toBeCloseTo(0.75);
        expect(remainingBudget({ maxCostUsd: 1 }, { maxCostUsd: 3 }, 'maxCostUsd')).toBe(0);
        expect(remainingBudget({}, { maxCostUsd: 3 }, 'maxCostUsd')).toBeUndefined();
    });

    it('budgetError is the failed {budget} error', () => {
        const error = budgetError({ ok: false, limit: 'maxCostUsd', max: 1, spent: 1.2 });
        expect(error).toEqual({ code: BUDGET_ERROR_CODE, message: 'budget exhausted: maxCostUsd 1 reached (spent 1.2)', recoverable: false });
        expect(isBudgetFailure({ status: 'failed', error })).toBe(true);
        expect(isBudgetFailure({ status: 'failed', error: { code: 'other', message: '', recoverable: false } })).toBe(false);
        expect(isBudgetFailure({ status: 'active', error })).toBe(false);
    });
});
