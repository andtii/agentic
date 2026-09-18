import type { MemoryEntry, TaskId } from '@agentic/core';
import { applyMemoryLog, coerceEntry, completeEntry, createMemoryState, createMemoryStore, isExpired, liveEntries, memoryId } from '../src/index';

const NOW = 1_800_000_000_000;

function entry(id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
    return { id, kind: 'fact', text, tags: [], confidence: 'stated', provenance: { source: 'agent', at: NOW }, ...extra };
}

describe('memoryId', () => {
    it('mints mem_ ids of 22 url-safe characters', () => {
        const id = memoryId();
        expect(id).toMatch(/^mem_[0-9A-Za-z]{22}$/);
        expect(memoryId()).not.toBe(id);
    });
});

describe('completeEntry', () => {
    it('stamps id and at, normalizes tags and drops undefined members', () => {
        const e = completeEntry({ kind: 'fact', text: 'x', tags: ['A', 'a', ' b '], confidence: 'stated', subject: undefined, provenance: { source: 'user' } }, NOW, 'mem_1');
        expect(e).toEqual({ id: 'mem_1', kind: 'fact', text: 'x', tags: ['a', 'b'], confidence: 'stated', provenance: { source: 'user', at: NOW } });
        expect('subject' in e).toBe(false);
    });
});

describe('applyMemoryLog', () => {
    it('is a pure fold: replaying the same log yields the same state', () => {
        const log = [
            { op: 'put', entry: entry('a', 'one') },
            { op: 'update', id: 'a', patch: { text: 'uno', tags: ['T'] } },
            { op: 'put', entry: entry('b', 'two', { kind: 'working', ttl: 10, provenance: { source: 'agent', at: NOW - 100 } }) },
            { op: 'retire', id: 'a', why: 'stale', at: NOW },
            { op: 'compact', now: NOW }
        ] as const;
        const s1 = createMemoryState();
        const s2 = createMemoryState();
        for (const l of log) applyMemoryLog(s1, l);
        for (const l of log) applyMemoryLog(s2, l);
        expect(s1).toEqual(s2);
        expect(s1.rev).toBe(5);
        expect(s1.entries.a).toEqual({ ...entry('a', 'uno'), tags: ['t'], retired: true });
        expect(s1.retirements.a).toEqual({ why: 'stale', at: NOW });
        expect(s1.entries.b).toBeUndefined();
    });

    it('ignores update/retire of unknown ids (the command layer validates)', () => {
        const s = createMemoryState();
        applyMemoryLog(s, { op: 'update', id: 'nope', patch: { text: 'x' } });
        applyMemoryLog(s, { op: 'retire', id: 'nope', why: 'x', at: NOW });
        expect(s.entries).toEqual({});
        expect(s.rev).toBe(2);
    });

    it('delete drops the entry and its retirement; replaying folds to the same state', () => {
        const log = [
            { op: 'put', entry: entry('a', 'one') },
            { op: 'put', entry: entry('b', 'two') },
            { op: 'retire', id: 'a', why: 'stale', at: NOW },
            { op: 'delete', id: 'a' },
            { op: 'delete', id: 'nope' }
        ] as const;
        const s1 = createMemoryState();
        const s2 = createMemoryState();
        for (const l of log) applyMemoryLog(s1, l);
        for (const l of log) applyMemoryLog(s2, l);
        expect(s1).toEqual(s2);
        expect(Object.keys(s1.entries)).toEqual(['b']);
        expect(s1.retirements).toEqual({});
        expect(s1.rev).toBe(5);
    });

    it('compacts records per task and leaves records without a task alone', () => {
        const s = createMemoryState();
        const taskId = 'task_1' as TaskId;
        applyMemoryLog(s, { op: 'put', entry: entry('r1', 'v1', { kind: 'record', provenance: { source: 'agent', at: NOW - 2, taskId } }) });
        applyMemoryLog(s, { op: 'put', entry: entry('r2', 'v2', { kind: 'record', provenance: { source: 'agent', at: NOW - 1, taskId } }) });
        applyMemoryLog(s, { op: 'put', entry: entry('free', 'no task', { kind: 'record' }) });
        applyMemoryLog(s, { op: 'put', entry: entry('free2', 'no task either', { kind: 'record' }) });
        expect(s.entries.r1!.retired).toBe(true);
        expect(s.retirements.r1).toEqual({ why: 'superseded by r2', at: NOW - 1 });
        expect(s.entries.r2!.supersedes).toBe('r1');
        expect(s.entries.free!.retired).toBeUndefined();
        expect(liveEntries(s, NOW).map((e) => e.id).sort()).toEqual(['free', 'free2', 'r2']);
    });

    it('keeps an explicit supersedes on a record', () => {
        const s = createMemoryState();
        const taskId = 'task_1' as TaskId;
        applyMemoryLog(s, { op: 'put', entry: entry('r1', 'v1', { kind: 'record', provenance: { source: 'agent', at: NOW - 1, taskId } }) });
        applyMemoryLog(s, { op: 'put', entry: entry('r2', 'v2', { kind: 'record', supersedes: 'other', provenance: { source: 'agent', at: NOW, taskId } }) });
        expect(s.entries.r2!.supersedes).toBe('other');
        expect(s.entries.r1!.retired).toBe(true);
    });
});

describe('isExpired', () => {
    it('applies only to working entries with a ttl', () => {
        expect(isExpired(entry('a', 'x', { kind: 'working', ttl: 10, provenance: { source: 'agent', at: NOW - 10 } }), NOW)).toBe(true);
        expect(isExpired(entry('a', 'x', { kind: 'working', ttl: 10, provenance: { source: 'agent', at: NOW - 9 } }), NOW)).toBe(false);
        expect(isExpired(entry('a', 'x', { kind: 'working' }), NOW)).toBe(false);
        expect(isExpired(entry('a', 'x', { kind: 'fact', ttl: 1, provenance: { source: 'agent', at: NOW - 10 } }), NOW)).toBe(false);
    });
});

describe('coerceEntry', () => {
    it('accepts a valid entry, defaults confidence and reports unknown fields', () => {
        const r = coerceEntry({ id: 'x', kind: 'lesson', text: 't', tags: ['B', 'b'], provenance: { source: 'import', at: 1, extra: 1 }, embedding: [1], retired: false });
        expect(r?.entry).toEqual({ id: 'x', kind: 'lesson', text: 't', tags: ['b'], confidence: 'stated', provenance: { source: 'import', at: 1 }, retired: false });
        expect(r?.dropped).toEqual(['embedding', 'provenance.extra']);
    });

    it.each([
        ['not an object', 'x'],
        ['missing id', { kind: 'fact', text: 't', provenance: { source: 'agent', at: 1 } }],
        ['bad kind', { id: 'a', kind: 'thought', text: 't', provenance: { source: 'agent', at: 1 } }],
        ['missing text', { id: 'a', kind: 'fact', provenance: { source: 'agent', at: 1 } }],
        ['bad source', { id: 'a', kind: 'fact', text: 't', provenance: { source: 'web', at: 1 } }],
        ['bad at', { id: 'a', kind: 'fact', text: 't', provenance: { source: 'agent', at: '1' } }],
        ['bad tags', { id: 'a', kind: 'fact', text: 't', tags: [1], provenance: { source: 'agent', at: 1 } }],
        ['bad confidence', { id: 'a', kind: 'fact', text: 't', confidence: 'sure', provenance: { source: 'agent', at: 1 } }],
        ['bad ttl', { id: 'a', kind: 'fact', text: 't', ttl: 'soon', provenance: { source: 'agent', at: 1 } }]
    ])('rejects %s', (_name, row) => {
        expect(coerceEntry(row)).toBeNull();
    });
});

describe('createMemoryStore', () => {
    it('routes every mutation through commit, in order', async () => {
        const ops: string[] = [];
        const store = createMemoryStore({
            now: () => NOW,
            commit: (state, log) => {
                ops.push(log.op);
                applyMemoryLog(state, log);
            }
        });
        const e = await store.put({ kind: 'working', text: 'w', tags: [], confidence: 'assumed', ttl: 1000, provenance: { source: 'agent' } });
        await store.update(e.id, { text: 'w2' });
        await store.retire(e.id, 'done');
        await store.compact();
        expect(ops).toEqual(['put', 'compact', 'update', 'retire', 'compact']);
        expect(store.state.rev).toBe(5);
    });

    it('pages exports by id', async () => {
        const store = createMemoryStore({ now: () => NOW, exportPageSize: 2 });
        for (const id of ['c', 'a', 'b', 'e', 'd']) await store.importBatch([entry(id, id)]);
        const p1 = store.exportPage(null);
        expect(p1.entries.map((e) => e.id)).toEqual(['a', 'b']);
        expect(p1.next).toBe('b');
        const p2 = store.exportPage(p1.next);
        expect(p2.entries.map((e) => e.id)).toEqual(['c', 'd']);
        const p3 = store.exportPage(p2.next);
        expect(p3).toEqual({ entries: [entry('e', 'e')], next: null });
        const all: string[] = [];
        for await (const e of store.export()) all.push(e.id);
        expect(all).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
});
