import type { MemoryEntry, MemoryScope, PluginContext, TaskId } from '@agentic/core';
import { createFlatMemoryState, createFlatMemoryStore, FLAT_MEMORY_PLUGIN_ID, FLAT_UNSUPPORTED_FIELDS, flatMemoryPlugin, MemoryNotFoundError, toFlatEntry } from '../src/index';
import { MEMORY_FEATURES, memoryConformance } from '../src/testing/index';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ctx: PluginContext = { now: Date.now, log: () => {} };

/** The four cases a flat plugin cannot pass — every other case it must. */
const FLAT_WITHOUT = ['conditions', 'kindWeights', 'ttl', 'supersedes'] as const;

describe('memoryConformance: flat plugin', () => {
    const plugin = flatMemoryPlugin();
    for (const c of memoryConformance((scope) => plugin.open(scope, ctx), { without: FLAT_WITHOUT })) it(c.name, c.run);
});

describe('memoryConformance: flat store', () => {
    for (const c of memoryConformance(() => createFlatMemoryStore(), { without: FLAT_WITHOUT })) it(c.name, c.run);
});

describe('memoryConformance features', () => {
    it('tags exactly one case per feature and leaves the rest as the core', () => {
        const all = memoryConformance(() => createFlatMemoryStore());
        const gated = all.filter((c) => c.requires.length);
        expect(gated.map((c) => c.requires).sort()).toEqual(MEMORY_FEATURES.map((f) => [f]).sort());
        expect(memoryConformance(() => createFlatMemoryStore(), { without: FLAT_WITHOUT })).toHaveLength(all.length - MEMORY_FEATURES.length);
        expect(memoryConformance(() => createFlatMemoryStore(), { without: ['ttl'] })).toHaveLength(all.length - 1);
    });
});

const full = (extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id: 'mem_full',
    kind: 'lesson',
    text: 'Use forward slashes',
    tags: ['shell'],
    subject: 'Shell',
    confidence: 'verified',
    provenance: { source: 'verification', at: NOW, taskId: 'task_1' as TaskId },
    conditions: 'when on Windows',
    evidence: ['e1'],
    supersedes: 'mem_older',
    ttl: 1000,
    retired: false,
    ...extra
});

describe('toFlatEntry', () => {
    it('strips the unsupported fields and reports the ones that were present', () => {
        const { entry, dropped } = toFlatEntry(full());
        expect(dropped).toEqual([...FLAT_UNSUPPORTED_FIELDS]);
        expect(Object.keys(entry).sort()).toEqual(['confidence', 'id', 'kind', 'provenance', 'retired', 'subject', 'tags', 'text']);
    });

    it('reports nothing for absent or undefined fields', () => {
        expect(toFlatEntry({ ...full(), conditions: undefined, evidence: undefined, supersedes: undefined, ttl: undefined }).dropped).toEqual([]);
        const { entry, dropped } = toFlatEntry({ id: 'a', kind: 'fact', text: 't', tags: [], confidence: 'stated', provenance: { source: 'agent', at: NOW }, evidence: ['x'] });
        expect(dropped).toEqual(['evidence']);
        expect('evidence' in entry).toBe(false);
    });
});

describe('flatMemoryPlugin', () => {
    it('declares partial export and keeps one store per scope', async () => {
        const plugin = flatMemoryPlugin();
        expect([plugin.id, plugin.version, plugin.capabilities]).toEqual([FLAT_MEMORY_PLUGIN_ID, '0.1.0', { semantic: false, export: 'partial' }]);
        const a = plugin.open('agent:agent_a' as MemoryScope, ctx);
        const b = plugin.open('agent:agent_b' as MemoryScope, ctx);
        await a.put({ kind: 'fact', text: 'private to a', tags: [], confidence: 'stated', provenance: { source: 'agent' } });
        expect(await b.query({ limit: 10 })).toEqual([]);
        expect(plugin.open('agent:agent_a' as MemoryScope, ctx)).toBe(a);
        expect(flatMemoryPlugin({ id: 'x', version: '2' }).id).toBe('x');
    });

    it('logs every field a put or update had to drop', async () => {
        const log = vi.fn();
        const store = flatMemoryPlugin().open('agent:agent_log' as MemoryScope, { now: () => NOW, log });
        const put = await store.put({ kind: 'lesson', text: 'Lesson', tags: [], confidence: 'stated', provenance: { source: 'user' }, conditions: 'when x', evidence: ['e'] });
        expect(log).toHaveBeenCalledWith('warn', 'flat memory: put dropped conditions, evidence', { id: put.id, dropped: ['conditions', 'evidence'] });
        expect('conditions' in put || 'evidence' in put).toBe(false);
        expect(await store.get(put.id)).toEqual(put);

        log.mockClear();
        const updated = await store.update(put.id, { text: 'Changed', supersedes: 'mem_x' });
        expect(log).toHaveBeenCalledWith('warn', 'flat memory: update dropped supersedes', { id: put.id, dropped: ['supersedes'] });
        expect(updated).toEqual({ ...put, text: 'Changed' });

        log.mockClear();
        await store.put({ kind: 'fact', text: 'Plain', tags: [], confidence: 'stated', provenance: { source: 'user' } });
        expect(log).not.toHaveBeenCalled();
    });
});

describe('createFlatMemoryStore', () => {
    const entry = (text: string, extra: Partial<Parameters<ReturnType<typeof createFlatMemoryStore>['put']>[0]> = {}) => ({ kind: 'fact' as const, text, tags: [], confidence: 'stated' as const, provenance: { source: 'agent' as const, at: NOW }, ...extra });

    it('retrieves by substring: more query terms found ranks higher, ties break by recency', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        const one = await store.put(entry('The deploys run nightly.'));
        const two = await store.put(entry('Deploys go through the staging worker.'));
        const none = await store.put(entry('Unrelated note.'));
        const ranked = await store.query({ text: 'deploy staging', limit: 10 });
        expect(ranked.map((r) => [r.entry.id, r.score])).toEqual([
            [two.id, 3],
            [one.id, 2],
            [none.id, 1]
        ]);
        const older = await store.put(entry('Unrelated note.', { provenance: { source: 'agent', at: NOW - DAY } }));
        const tail = (await store.query({ text: 'deploy staging', limit: 10 })).slice(2).map((r) => r.entry.id);
        expect(tail).toEqual([none.id, older.id]);
    });

    it('does not weight kinds: identical text ranks by recency then id', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        const a = await store.put(entry('same words', { kind: 'assumption' }));
        const p = await store.put(entry('same words', { kind: 'preference' }));
        const ids = (await store.query({ text: 'same words', limit: 10 })).map((r) => r.entry.id);
        expect(ids).toEqual([a.id, p.id].sort());
    });

    it('treats conditions as nothing: a lesson is found by its tags only', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        const lesson = await store.put(entry('Use forward slashes', { kind: 'lesson', tags: ['shell'], conditions: 'when running on Windows' }));
        expect((await store.query({ tags: ['windows'], limit: 10 })).map((r) => r.entry.id)).toEqual([]);
        expect((await store.query({ tags: ['Shell'], limit: 10 })).map((r) => r.entry.id)).toEqual([lesson.id]);
    });

    it('never expires a working entry and never supersedes a record', async () => {
        let now = NOW;
        const store = createFlatMemoryStore({ now: () => now });
        const working = await store.put(entry('scratch', { kind: 'working', ttl: 10 }));
        const first = await store.put(entry('result v1', { kind: 'record', provenance: { source: 'agent', at: NOW, taskId: 'task_1' as TaskId } }));
        const second = await store.put(entry('result v2', { kind: 'record', provenance: { source: 'agent', at: NOW + 1, taskId: 'task_1' as TaskId } }));
        now += 10 * DAY;
        expect((await store.query({ kinds: ['working'], limit: 10 })).map((r) => r.entry.id)).toEqual([working.id]);
        expect('ttl' in working).toBe(false);
        expect((await store.query({ kinds: ['record'], limit: 10 })).map((r) => r.entry.id).sort()).toEqual([first.id, second.id].sort());
        expect('supersedes' in second).toBe(false);
        expect((await store.get(first.id))?.retired).toBeUndefined();
    });

    it('keeps the retirement reason and rejects unknown ids', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        const put = await store.put(entry('bye'));
        await store.retire(put.id, 'obsolete');
        expect(store.retirement(put.id)).toEqual({ why: 'obsolete', at: NOW });
        expect(store.size).toBe(1);
        await expect(store.update('mem_nope', { text: 'x' })).rejects.toBeInstanceOf(MemoryNotFoundError);
        await expect(store.retire('mem_nope', 'x')).rejects.toBeInstanceOf(MemoryNotFoundError);
        expect(store.retirement('mem_nope')).toBeUndefined();
    });

    it('fidelity says what import would drop, without writing', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        expect(store.fidelity(full())).toEqual(['conditions', 'evidence', 'supersedes', 'ttl']);
        expect(store.fidelity({ ...full({ conditions: undefined, supersedes: undefined, ttl: undefined }), embedding: [1] } as MemoryEntry)).toEqual(['embedding', 'evidence']);
        expect(store.fidelity({ id: 'x' } as MemoryEntry)).toBeNull();
        expect(store.size).toBe(0);
    });

    it('import strips the unsupported fields and reports them with the foreign ones', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        const rows = [full(), { ...full({ id: 'mem_2', ttl: undefined }), provenance: { ...full().provenance, model: 'm' } }, { nope: true }];
        const report = await store.import((async function* () {
            yield* rows as MemoryEntry[];
        })());
        expect(report).toEqual({ imported: 2, skipped: 1, droppedFields: ['conditions', 'evidence', 'provenance.model', 'supersedes', 'ttl'] });
        expect(Object.keys((await store.get('mem_full')) ?? {}).some((k) => (FLAT_UNSUPPORTED_FIELDS as readonly string[]).includes(k))).toBe(false);
        expect((await store.get('mem_2'))?.provenance).toEqual(full().provenance);
    });
});

describe('createFlatMemoryStore over a given state (#281)', () => {
    const entry = (text: string) => ({ kind: 'fact' as const, text, tags: [], confidence: 'stated' as const, provenance: { source: 'agent' as const, at: NOW } });

    it('reads and writes the state in place, JSON-safe, so a host can persist it and a new store can pick it up', async () => {
        const state = createFlatMemoryState();
        const store = createFlatMemoryStore({ state, now: () => NOW });
        const a = await store.put(entry('kept'));
        const b = await store.put(entry('retired'));
        await store.retire(b.id, 'stale');
        expect(Object.keys(state.entries).sort()).toEqual([a.id, b.id].sort());
        expect(state.retirements[b.id]).toEqual({ why: 'stale', at: NOW });

        const reloaded = createFlatMemoryStore({ state: JSON.parse(JSON.stringify(state)) as typeof state, now: () => NOW });
        expect((await reloaded.get(a.id))?.text).toBe('kept');
        expect(reloaded.retirement(b.id)).toEqual({ why: 'stale', at: NOW });
        expect(await reloaded.delete(b.id)).toBe(true);
        expect(await reloaded.delete(b.id)).toBe(false);
        expect(reloaded.retirement(b.id)).toBeUndefined();
    });

    it('exportPage walks the entries in id order, a page at a time', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        const ids = [];
        for (let i = 0; i < 5; i++) ids.push((await store.put(entry(`e${i}`))).id);
        ids.sort();
        const seen: string[] = [];
        let after: string | null = null;
        let pages = 0;
        do {
            const page: ReturnType<typeof store.exportPage> = store.exportPage(after, 2);
            seen.push(...page.entries.map((e) => e.id));
            after = page.next;
            pages++;
        } while (after !== null);
        expect(seen).toEqual(ids);
        expect(pages).toBe(3);
    });

    it('exportPage follows puts, imports and deletes between pages', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        const [a, b, c] = [await store.put(entry('a')), await store.put(entry('b')), await store.put(entry('c'))].map((e) => e.id).sort();
        const first = store.exportPage(null, 1);
        expect(first.entries.map((e) => e.id)).toEqual([a]);
        await store.delete(b!);
        const added = await store.put(entry('d'));
        const rest: string[] = [];
        for (let after = first.next; after !== null; ) {
            const page: ReturnType<typeof store.exportPage> = store.exportPage(after, 1);
            rest.push(...page.entries.map((e) => e.id));
            after = page.next;
        }
        expect(rest).toEqual([c!, added.id].filter((id) => id > a!).sort());
    });

    it('never reads an inherited property as an entry, and skips an import row whose id a record cannot hold', async () => {
        const store = createFlatMemoryStore({ now: () => NOW });
        expect(await store.get('toString')).toBeUndefined();
        expect(await store.delete('constructor')).toBe(false);
        async function* rows() {
            yield { id: '__proto__', ...entry('polluted') };
            yield { id: 'mem_ok', ...entry('fine') };
        }
        expect(await store.import(rows())).toMatchObject({ imported: 1, skipped: 1 });
        expect(store.size).toBe(1);
        expect(({} as Record<string, unknown>)['text']).toBeUndefined();
    });
});
