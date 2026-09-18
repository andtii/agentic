/**
 * The Audit actor against the in-process host under a workspace principal:
 * idempotent records, filtered and cursor-paged reads, the rollover into
 * month archives, survival across activations over one storage, and
 * authorization.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, Principal, TaskId, WorkspaceId } from '@agentic/core';
import { AUDIT_ROLL_BATCH, AUDIT_WINDOW, AuditActor, auditKey, auditMonth, auditMonthKey, parseAuditKey, type AuditEvent, type AuditEventInput } from '../../src/audit/index';
import { memoryStorage, recordingStorage, statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const A = 'agent_a' as AgentId;
const B = 'agent_b' as AgentId;
const T1 = 'task_1' as TaskId;
const T2 = 'task_2' as TaskId;
/** 2026-09-10T12:00Z. */
const AT = Date.UTC(2026, 8, 10, 12);
const KEY = auditKey(WS);

const transition = (key: string, extra: Partial<Omit<Extract<AuditEventInput, { kind: 'task.transition' }>, 'kind' | 'data'>> = {}): AuditEventInput => ({
    key,
    kind: 'task.transition',
    at: AT,
    by: 'user:u1',
    summary: 'task_1: queued → active',
    agentId: A,
    taskId: T1,
    data: { from: 'queued', to: 'active', why: 'started' },
    ...extra
});

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([AuditActor]);
    return app.start();
});
afterEach(() => app.stop());

const audit = (principal: Principal | null = owner, key = KEY) => app.as(principal).actor(AuditActor, key);
const keys = (events: readonly AuditEvent[]) => events.map((e) => e.key);

describe('audit keys', () => {
    it('names the live log and the month archives', () => {
        expect(auditKey(WS)).toBe('u1:audit');
        expect(auditMonthKey(WS, '2026-09')).toBe('u1:audit:2026-09');
        expect(auditMonth(AT)).toBe('2026-09');
        expect(parseAuditKey('u1:audit')).toEqual({ workspaceId: 'u1' });
        expect(parseAuditKey('u1:audit:2026-09')).toEqual({ workspaceId: 'u1', month: '2026-09' });
        expect(parseAuditKey('u1:audit:nope')).toBeNull();
        expect(parseAuditKey('u1:ledger:2026-09')).toBeNull();
    });
});

describe('Audit authorization', () => {
    it('admits only principals of the workspace; over the wire only a user records', async () => {
        expect(await statusOf(audit(userPrincipal('u2')).list())).toBe(403);
        expect(await statusOf(audit(null).list())).toBe(401);
        const agent: Principal = { kind: 'agent', workspaceId: WS, agentId: A, sessionId: 's1' as never };
        expect(await statusOf(audit(agent).list())).toBeUndefined();
        expect(await statusOf(audit(agent).record(transition('k1')))).toBe(403);
        expect(await statusOf(audit(owner).archive([]))).toBe(403);
        expect(await statusOf(audit().record(transition('k1')))).toBeUndefined();
    });
});

describe('Audit records', () => {
    it('folds an event once by key, stamps a seq, and lists newest first', async () => {
        expect(await audit().record(transition('k1'))).toBe(true);
        expect(await audit().record(transition('k1', { summary: 'again' }))).toBe(false);
        expect(await audit().record(transition('k2', { at: AT + 1 }))).toBe(true);
        // One durable write per recorded event: the first creates the record (a save), the next is an O(entry) append.
        expect([...app.saves, ...app.appends].filter((s) => s.type === 'audit')).toHaveLength(2);
        expect(app.appends.filter((s) => s.type === 'audit')).toHaveLength(1);
        const page = await audit().list();
        expect(keys(page.events)).toEqual(['k2', 'k1']);
        expect(page.events.map((e) => e.seq)).toEqual([1, 0]);
        expect(page.events[1]!.summary).toBe('task_1: queued → active');
        expect(page.next).toBeNull();
        expect(await audit().stats()).toEqual({ inState: 2, recorded: 2, archived: 0, months: [] });
    });

    it('refuses a malformed event, a record on an archive key and an archive on the live key', async () => {
        await expect(audit().record({ ...transition('k1'), kind: 'nope' } as never)).rejects.toThrow(/unknown event kind/);
        await expect(audit().record({ ...transition('k1'), by: '' })).rejects.toThrow(/needs a by/);
        await expect(audit(owner, auditMonthKey(WS, '2026-09')).record(transition('k1'))).rejects.toThrow(/record on the live log/);
        expect(await audit().list()).toEqual({ events: [], next: null });
    });

    it('filters by kind, agent, task (a delegation matches its child), session and time', async () => {
        await audit().record(transition('t1-a', { at: AT }));
        await audit().record(transition('t1-b', { at: AT + 10, sessionId: 'sess_1' as never }));
        await audit().record({
            key: 'd1',
            kind: 'delegation.created',
            at: AT + 20,
            by: `agent:${A}`,
            summary: 'delegated',
            agentId: A,
            taskId: T1,
            data: { parentTaskId: T1, childTaskId: T2, assignee: B, owner: A, objective: 'sub', callId: 'c1', constraints: {} }
        });
        await audit().record({ key: 'v1', kind: 'config.versioned', at: AT + 30, by: 'user:u1', summary: 'v1', agentId: B, data: { version: 1, reason: 'create' } });
        expect(keys((await audit().list({ kinds: ['task.transition'] })).events)).toEqual(['t1-b', 't1-a']);
        expect(keys((await audit().list({ kinds: ['config.versioned', 'delegation.created'] })).events)).toEqual(['v1', 'd1']);
        expect(keys((await audit().list({ agentId: B })).events)).toEqual(['v1']);
        expect(keys((await audit().list({ taskId: T1 })).events)).toEqual(['d1', 't1-b', 't1-a']);
        expect(keys((await audit().list({ taskId: T2 })).events)).toEqual(['d1']);
        expect(keys((await audit().list({ sessionId: 'sess_1' })).events)).toEqual(['t1-b']);
        expect(keys((await audit().list({ since: AT + 10, until: AT + 30 })).events)).toEqual(['d1', 't1-b']);
        expect((await audit().list({ agentId: 'nobody' })).events).toEqual([]);
    });

    it('pages with an exclusive seq cursor', async () => {
        for (let i = 0; i < 7; i++) await audit().record(transition(`k${i}`, { at: AT + i }));
        const first = await audit().list({ limit: 3 });
        expect(keys(first.events)).toEqual(['k6', 'k5', 'k4']);
        expect(first.next).toBe(4);
        const second = await audit().list({ limit: 3, cursor: first.next });
        expect(keys(second.events)).toEqual(['k3', 'k2', 'k1']);
        const third = await audit().list({ limit: 3, cursor: second.next });
        expect(keys(third.events)).toEqual(['k0']);
        expect(third.next).toBeNull();
        expect(await audit().list({ cursor: 0 })).toEqual({ events: [], next: null });
        // A filter rides along with the cursor.
        expect(keys((await audit().list({ limit: 2, cursor: 5, kinds: ['task.transition'] })).events)).toEqual(['k4', 'k3']);
    });
});

describe('Audit rollover', () => {
    const TOTAL = AUDIT_WINDOW + AUDIT_ROLL_BATCH;
    /** Events spanning two UTC months: the first `AUDIT_ROLL_BATCH` in August 2026, the rest in September. */
    const at = (i: number) => (i < AUDIT_ROLL_BATCH ? Date.UTC(2026, 7, 20, 0, i) : Date.UTC(2026, 8, 1, 0, 0, i));

    async function fill(): Promise<void> {
        for (let i = 0; i < TOTAL; i++) await audit().record(transition(`k${i}`, { at: at(i), agentId: i % 2 ? A : B }));
    }

    it('rolls the oldest batch into month archives once the window overflows; list walks past the window by cursor', async () => {
        await fill();
        expect(await audit().stats()).toEqual({ inState: AUDIT_WINDOW, recorded: TOTAL, archived: AUDIT_ROLL_BATCH, months: ['2026-08'] });
        const archive = await audit(owner, auditMonthKey(WS, '2026-08')).list({ limit: 200 });
        expect(archive.events).toHaveLength(AUDIT_ROLL_BATCH);
        expect(archive.events[0]!.key).toBe(`k${AUDIT_ROLL_BATCH - 1}`);
        expect(archive.events.at(-1)!.key).toBe('k0');
        // The whole history, newest first, through the cursor — every event once, in seq order, across the seam.
        const all: AuditEvent[] = [];
        let cursor: number | null = null;
        for (;;) {
            const page: { events: readonly AuditEvent[]; next: number | null } = await audit().list({ limit: 200, cursor });
            all.push(...page.events);
            if (page.next === null) break;
            cursor = page.next;
        }
        expect(all).toHaveLength(TOTAL);
        expect(all.map((e) => e.seq)).toEqual(Array.from({ length: TOTAL }, (_, i) => TOTAL - 1 - i));
        expect(new Set(all.map((e) => e.key)).size).toBe(TOTAL);
        // Filters reach into the archives too; a time bound prunes months it cannot match.
        const august = await audit().list({ until: Date.UTC(2026, 8, 1), limit: 200 });
        expect(august.events).toHaveLength(AUDIT_ROLL_BATCH);
        expect(august.events.every((e) => e.at < Date.UTC(2026, 8, 1))).toBe(true);
        const byAgent = await audit().list({ agentId: B, cursor: AUDIT_ROLL_BATCH + 4, limit: 200 });
        expect(byAgent.events.map((e) => e.seq)).toEqual([AUDIT_ROLL_BATCH + 2, AUDIT_ROLL_BATCH, ...Array.from({ length: AUDIT_ROLL_BATCH / 2 }, (_, i) => AUDIT_ROLL_BATCH - 2 - 2 * i)]);
        expect(await audit(owner, auditMonthKey(WS, '2026-08')).stats()).toEqual({ inState: AUDIT_ROLL_BATCH, recorded: 0, archived: 0, months: [] });
    });

    it('survives re-activation: a fresh host over the same storage lists the same history', async () => {
        const storage = recordingStorage(memoryStorage());
        await app.stop();
        app = testActorApp([AuditActor], { storage });
        await app.start();
        await fill();
        const before = await audit().list({ limit: 200, cursor: AUDIT_ROLL_BATCH + 10 });
        expect(before.events).toHaveLength(AUDIT_ROLL_BATCH + 10);
        await app.stop();

        app = testActorApp([AuditActor], { storage });
        await app.start();
        expect(await audit().stats()).toEqual({ inState: AUDIT_WINDOW, recorded: TOTAL, archived: AUDIT_ROLL_BATCH, months: ['2026-08'] });
        const after = await audit().list({ limit: 200, cursor: AUDIT_ROLL_BATCH + 10 });
        expect(after).toEqual(before);
        expect(await audit().record(transition('k0'))).toBe(true); // forgotten by the window, so it is a new occurrence to the live log
        expect(await audit().record(transition(`k${TOTAL - 1}`))).toBe(false);
    });
});
