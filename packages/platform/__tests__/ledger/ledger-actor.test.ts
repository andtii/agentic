/** The Ledger actor against the in-process host under a workspace principal: idempotent appends, reads, corrections, authorization. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, Principal, WorkspaceId } from '@agentic/core';
import { LedgerActor, ledgerKey, ledgerMonth, type LedgerRow } from '../../src/ledger/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const A = 'agent_a' as AgentId;
const AT = Date.UTC(2026, 8, 10, 12);
const KEY = ledgerKey(WS, ledgerMonth(AT));

const row = (key: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({
    key,
    at: AT,
    sessionId: 's1',
    agentId: A,
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0.1,
    estimated: false,
    ...extra
});

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([LedgerActor]);
    return app.start();
});
afterEach(() => app.stop());

const ledger = (principal: Principal | null = owner) => app.as(principal).actor(LedgerActor, KEY);

describe('Ledger authorization', () => {
    it('admits only principals of the workspace', async () => {
        expect(await statusOf(app.as(userPrincipal('u2')).actor(LedgerActor, KEY).rows())).toBe(403);
        expect(await statusOf(ledger(null).rows())).toBe(401);
        const agent: Principal = { kind: 'agent', workspaceId: WS, agentId: A, sessionId: 's1' as never };
        expect(await statusOf(ledger(agent).append(row('k1')))).toBeUndefined();
    });
});

describe('Ledger rows', () => {
    it('appends once per key, one save each, and lists newest first', async () => {
        expect(await ledger().append(row('k1'))).toBe(true);
        expect(await ledger().append(row('k1', { costUsd: 9 }))).toBe(false);
        expect(await ledger().append(row('k2', { at: AT + 1, taskId: 't1', estimated: true }))).toBe(true);
        expect(app.saves.filter((s) => s.type === 'ledger')).toHaveLength(2);
        const rows = await ledger().rows();
        expect(rows.map((r) => r.key)).toEqual(['k2', 'k1']);
        expect(rows[1]!.costUsd).toBe(0.1);
        expect(await ledger().rows({ taskId: 't1' })).toHaveLength(1);
        expect(await ledger().rows({ limit: 1 })).toHaveLength(1);
        expect((await ledger().rows({ agentId: 'nobody' })).length).toBe(0);
    });

    it('refuses a row of another month', async () => {
        await expect(ledger().append(row('k1', { at: Date.UTC(2026, 9, 1) }))).rejects.toThrow(/belongs to 2026-10/);
        expect(await ledger().rows()).toEqual([]);
    });

    it('summarizes with estimate and unavailable flags', async () => {
        await ledger().append(row('k1', { taskId: 't1', costUsd: 0.5 }));
        await ledger().append(row('k2', { taskId: 't1', costUsd: 0.25, estimated: true }));
        await ledger().append(row('k3', { taskId: 't2', costUsd: undefined }));
        const byTask = await ledger().summary({ by: 'task' });
        expect(byTask.total).toMatchObject({ rows: 3, costUsd: 0.75, estimatedCostUsd: 0.25, estimatedRows: 1, unpricedRows: 1, quality: 'partly-estimated' });
        expect(byTask.groups.map((g) => [g.key, g.costUsd, g.quality])).toEqual([
            ['t1', 0.75, 'partly-estimated'],
            ['t2', null, 'not-reported']
        ]);
        const byDay = await ledger().summary({ by: 'day', timeZone: 'Europe/Stockholm' });
        expect(byDay.groups.map((g) => g.key)).toEqual(['2026-09-10']);
    });
});

describe('Ledger corrections (LRN-09)', () => {
    it('counts per agent, week and kind and resolves the weekly total', async () => {
        expect(await ledger().recordCorrection({ agentId: A, week: '2026-W37', what: 'wrong', at: AT })).toBe(1);
        expect(await ledger().recordCorrection({ agentId: A, week: '2026-W37', what: 'prefer', at: AT })).toBe(2);
        expect(await ledger().recordCorrection({ agentId: A, week: '2026-W38', what: 'wrong', at: AT })).toBe(1);
        expect(await ledger().corrections(A, '2026-W37')).toBe(2);
        expect(await ledger().corrections(A, '2026-W37', 'wrong')).toBe(1);
        expect(await ledger().corrections('other' as AgentId, '2026-W37')).toBe(0);
    });
});
