import type { MemoryEntry, MemoryStore, TaskId } from '@agentic/core';
import { createFlatMemoryStore, createMemoryStore, MemoryMigrationError, migrate, type MigrationReport } from '../src/index';

const NOW = 1_800_000_000_000;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

const whole = (entries: number) => ({ entries, imported: entries, skipped: 0, droppedFields: [] as string[] });

/** A default store with every kind and every field the flat plugin lacks. */
async function seed() {
    const source = createMemoryStore({ now: () => NOW });
    await source.put({ kind: 'fact', text: 'Repo uses pnpm', tags: ['tooling'], subject: 'repo', confidence: 'verified', provenance: { source: 'user' } });
    await source.put({ kind: 'preference', text: 'Concise answers', tags: ['style'], confidence: 'stated', provenance: { source: 'user', sessionId: 'session_1' as never } });
    await source.put({ kind: 'assumption', text: 'The daemon is on Windows', tags: [], confidence: 'assumed', provenance: { source: 'agent' } });
    await source.put({ kind: 'lesson', text: 'Use forward slashes', tags: ['shell'], confidence: 'verified', provenance: { source: 'verification' }, conditions: 'when on Windows', evidence: ['e1', 'e2'] });
    const first = await source.put({ kind: 'record', text: 'result v1', tags: [], confidence: 'assumed', provenance: { source: 'agent', at: NOW - 1000, taskId: 'task_1' as TaskId } });
    const second = await source.put({ kind: 'record', text: 'result v2', tags: [], confidence: 'verified', provenance: { source: 'verification', at: NOW, taskId: 'task_1' as TaskId } });
    await source.put({ kind: 'working', text: 'scratch', tags: [], confidence: 'assumed', provenance: { source: 'agent' }, ttl: 60_000 });
    expect(second.supersedes).toBe(first.id);
    expect((await source.get(first.id))?.retired).toBe(true);
    return source;
}

/** The report a full migration of `seed()` into the flat plugin must produce — no more, no less. */
const INTO_FLAT: MigrationReport = {
    dryRun: false,
    entries: 7,
    imported: 7,
    skipped: 0,
    droppedFields: ['conditions', 'evidence', 'supersedes', 'ttl'],
    kinds: {
        working: { entries: 1, imported: 1, skipped: 0, droppedFields: ['ttl'] },
        fact: { entries: 1, imported: 1, skipped: 0, droppedFields: [] },
        preference: { entries: 1, imported: 1, skipped: 0, droppedFields: [] },
        assumption: { entries: 1, imported: 1, skipped: 0, droppedFields: [] },
        lesson: { entries: 1, imported: 1, skipped: 0, droppedFields: ['conditions', 'evidence'] },
        record: { entries: 2, imported: 2, skipped: 0, droppedFields: ['supersedes'] }
    }
};

const LOSSLESS: MigrationReport = {
    dryRun: false,
    entries: 7,
    imported: 7,
    skipped: 0,
    droppedFields: [],
    kinds: { working: whole(1), fact: whole(1), preference: whole(1), assumption: whole(1), lesson: whole(1), record: whole(2) }
};

describe('migrate: default → flat → default (AC-11)', () => {
    it('reports exactly the fields the flat plugin drops, per kind, and nothing else', async () => {
        const source = await seed();
        const flat = createFlatMemoryStore({ now: () => NOW });

        const dry = await migrate(source, flat, { dryRun: true });
        expect(flat.size).toBe(0);
        expect(dry).toEqual({ ...INTO_FLAT, dryRun: true });

        const wet = await migrate(source, flat);
        expect(wet).toEqual(INTO_FLAT);
        expect(flat.size).toBe(7);

        const back = createMemoryStore({ now: () => NOW });
        expect(await migrate(flat, back, { dryRun: true })).toEqual({ ...LOSSLESS, dryRun: true });
        expect(await migrate(flat, back)).toEqual(LOSSLESS);

        const originals = await collect(source.export());
        expect(originals).toHaveLength(7);
        for (const original of originals) {
            const { conditions: _c, evidence: _e, supersedes: _s, ttl: _t, ...kept } = original;
            const copy = await back.get(original.id);
            expect(copy).toEqual(kept);
            expect(Object.keys(copy ?? {}).sort()).toEqual(Object.keys(kept).sort());
        }
        expect((await collect(back.export())).map((e) => e.id)).toEqual(originals.map((e) => e.id));
    });

    it('is lossless between two default stores, supersedes and conditions included', async () => {
        const source = await seed();
        const target = createMemoryStore({ now: () => NOW });
        expect(await migrate(source, target)).toEqual(LOSSLESS);
        expect(await collect(target.export())).toEqual(await collect(source.export()));
    });
});

describe('migrate: options', () => {
    it('honours onConflict and counts skipped ids the same in a dry and a real run', async () => {
        const source = await seed();
        const flat = createFlatMemoryStore({ now: () => NOW });
        await migrate(source, flat);
        const again = { ...INTO_FLAT, imported: 0, skipped: 7, kinds: Object.fromEntries(Object.entries(INTO_FLAT.kinds).map(([k, v]) => [k, { ...v, imported: 0, skipped: v.entries }])) };
        expect(await migrate(source, flat, { dryRun: true })).toEqual({ ...again, dryRun: true });
        expect(await migrate(source, flat)).toEqual(again);
        expect(await migrate(source, flat, { dryRun: true, onConflict: 'replace' })).toEqual({ ...INTO_FLAT, dryRun: true });
        expect(await migrate(source, flat, { onConflict: 'replace' })).toEqual(INTO_FLAT);
    });

    it('skips rows that are not entries and reports foreign fields per kind', async () => {
        const rows = [
            { id: 'mem_a', kind: 'fact', text: 'a', tags: [], confidence: 'stated', provenance: { source: 'agent', at: NOW }, embedding: [0.1] },
            { id: 'mem_b', kind: 'lesson', text: 'b', tags: [], confidence: 'stated', provenance: { source: 'agent', at: NOW, model: 'm' } },
            { id: 'mem_c', kind: 'lesson', text: 'c', tags: [], confidence: 'stated', provenance: { source: 'agent', at: NOW }, conditions: 'when' },
            { id: 'mem_d', kind: 'fact', text: 'junk', provenance: {} }
        ] as unknown as MemoryEntry[];
        const foreign = { ...createFlatMemoryStore(), export: async function* () { yield* rows; } } as MemoryStore;
        const expected: MigrationReport = {
            dryRun: false,
            entries: 4,
            imported: 3,
            skipped: 1,
            droppedFields: ['conditions', 'embedding', 'provenance.model'],
            kinds: { fact: { entries: 2, imported: 1, skipped: 1, droppedFields: ['embedding'] }, lesson: { entries: 2, imported: 2, skipped: 0, droppedFields: ['conditions', 'provenance.model'] } }
        };
        expect(await migrate(foreign, createFlatMemoryStore(), { dryRun: true })).toEqual({ ...expected, dryRun: true });
        expect(await migrate(foreign, createFlatMemoryStore())).toEqual(expected);
        const intoDefault = { ...expected, droppedFields: ['embedding', 'provenance.model'], kinds: { ...expected.kinds, lesson: { ...expected.kinds.lesson!, droppedFields: ['provenance.model'] } } };
        expect(await migrate(foreign, createMemoryStore(), { dryRun: true })).toEqual({ ...intoDefault, dryRun: true });
    });

    it('migrates for real into any MemoryStore but needs the fidelity seam for a dry run', async () => {
        const source = await seed();
        const flat = createFlatMemoryStore({ now: () => NOW });
        const plain: MemoryStore = {
            put: (e) => flat.put(e),
            update: (id, p) => flat.update(id, p),
            retire: (id, why) => flat.retire(id, why),
            get: (id) => flat.get(id),
            query: (q) => flat.query(q),
            export: () => flat.export(),
            import: (rows, o) => flat.import(rows, o)
        };
        await expect(migrate(source, plain, { dryRun: true })).rejects.toBeInstanceOf(MemoryMigrationError);
        expect(flat.size).toBe(0);
        expect(await migrate(source, plain)).toEqual(INTO_FLAT);
        expect(flat.size).toBe(7);
    });

    it('reports an empty source as nothing to do', async () => {
        expect(await migrate(createMemoryStore(), createFlatMemoryStore())).toEqual({ dryRun: false, entries: 0, imported: 0, skipped: 0, droppedFields: [], kinds: {} });
    });
});
