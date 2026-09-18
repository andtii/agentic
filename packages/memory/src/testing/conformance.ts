/**
 * `memoryConformance` — the suite every `MemoryStore` backend runs (MEM-02):
 * the in-memory store, the Memory actor over any `ActorStorage`, a future
 * embeddings plugin. Storage-agnostic by construction: every case gets a
 * fresh store from the factory, drives it only through the `MemoryStore`
 * contract, and states time explicitly through `provenance.at` so nothing
 * waits on a clock. No test-runner import — consumers wire the cases into
 * theirs:
 *
 * ```ts
 * for (const c of memoryConformance(make)) it(c.name, c.run);
 * ```
 */

import type { ImportReport, MemoryEntry, MemoryScope, MemoryStore, NewMemoryEntry, TaskId } from '@agentic/core';
import { exportToString, fromNdjson, ndjsonLines, parseExportHeader, MEMORY_EXPORT_VERSION } from '../export/index.js';
import { byteLength } from '../rank/index.js';
import { assert, assertEqual, assertRejects } from './assert.js';

/**
 * Behaviour beyond the `MemoryStore` core that a narrower plugin may leave
 * out (MEM-09: it then reports the fields instead): `conditions` matching as
 * tags, kind-weighted ranking, `working` expiry by `ttl`, per-task record
 * compaction through `supersedes`.
 */
export type MemoryFeature = 'conditions' | 'kindWeights' | 'ttl' | 'supersedes';
export const MEMORY_FEATURES: readonly MemoryFeature[] = ['conditions', 'kindWeights', 'ttl', 'supersedes'];

export interface MemoryConformanceCase {
    readonly name: string;
    /** The features this case exercises; empty for the core every plugin must pass. */
    readonly requires: readonly MemoryFeature[];
    run(): Promise<void>;
}

/** A fresh, empty store for `scope`; called once per case. */
export type MemoryStoreFactory = (scope: MemoryScope) => MemoryStore | Promise<MemoryStore>;

export interface MemoryConformanceOptions {
    /** The clock the store under test uses; the suite dates entries relative to it. Default `Date.now`. */
    readonly now?: () => number;
    /** A scope per case; default `agent:<prefix>_<n>`. */
    readonly scope?: (index: number, name: string) => MemoryScope;
    /** Features the plugin under test does not have: the cases requiring them are left out. Default: none. */
    readonly without?: readonly MemoryFeature[];
}

const DAY = 24 * 60 * 60 * 1000;

function entry(text: string, extra: Partial<NewMemoryEntry> = {}): NewMemoryEntry {
    return { kind: 'fact', text, tags: [], confidence: 'stated', provenance: { source: 'agent' }, ...extra };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

const byId = (a: MemoryEntry, b: MemoryEntry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function memoryConformance(make: MemoryStoreFactory, options: MemoryConformanceOptions = {}): readonly MemoryConformanceCase[] {
    const now = options.now ?? Date.now;
    const scopeFor = options.scope ?? ((i: number) => `agent:agent_conformance_${i}` as MemoryScope);
    const without = options.without ?? [];
    const cases: MemoryConformanceCase[] = [];
    const define = (name: string, body: (store: MemoryStore, fresh: () => Promise<MemoryStore>) => Promise<void>, requires: readonly MemoryFeature[] = []) => {
        const index = cases.length;
        cases.push({
            name,
            requires,
            run: async () => {
                let n = 0;
                const fresh = async () => make(`${scopeFor(index, name)}_${++n}` as MemoryScope);
                await body(await make(scopeFor(index, name)), fresh);
            }
        });
    };

    define('put stamps id and provenance.at; get returns the entry', async (store) => {
        const before = now();
        const put = await store.put(entry('The build runs on Windows first.', { tags: ['Build', 'windows', 'build'] }));
        assert(typeof put.id === 'string' && put.id.length > 0, 'put returns an id');
        assert(put.provenance.at >= before, 'provenance.at is stamped with the clock');
        assertEqual(put.tags, ['build', 'windows'], 'tags are normalized and unique');
        assertEqual(await store.get(put.id), put, 'get returns what put returned');
        assertEqual(await store.get('mem_missing'), undefined, 'get of an unknown id is undefined');
    });

    define('put keeps an explicit provenance.at and every provenance field', async (store) => {
        const at = now() - 5 * DAY;
        const put = await store.put(entry('Dated.', { provenance: { source: 'user', at, sessionId: 'session_1' as never, taskId: 'task_1' as never, messageId: 'msg_1' as never } }));
        assertEqual(put.provenance, { source: 'user', at, sessionId: 'session_1', taskId: 'task_1', messageId: 'msg_1' }, 'provenance round-trips');
    });

    define('update patches fields and keeps the id', async (store) => {
        const put = await store.put(entry('Old text', { tags: ['a'] }));
        const updated = await store.update(put.id, { text: 'New text', tags: ['b'], confidence: 'verified' });
        assertEqual(updated.id, put.id, 'id is stable');
        assertEqual([updated.text, updated.tags, updated.confidence], ['New text', ['b'], 'verified'], 'the patch is applied');
        assertEqual(await store.get(put.id), updated, 'get sees the update');
        await assertRejects(() => store.update('mem_missing', { text: 'x' }), 'update of an unknown id rejects');
    });

    define('retire hides an entry from query but keeps it inspectable', async (store) => {
        const keep = await store.put(entry('Keep the deploy checklist'));
        const gone = await store.put(entry('Retire the deploy checklist'));
        await store.retire(gone.id, 'no longer true');
        const got = await store.get(gone.id);
        assert(got?.retired === true, 'a retired entry is still readable, flagged retired');
        const ids = (await store.query({ text: 'deploy checklist', limit: 10 })).map((r) => r.entry.id);
        assertEqual(ids, [keep.id], 'query never returns retired entries');
        await assertRejects(() => store.retire('mem_missing', 'why'), 'retire of an unknown id rejects');
    });

    define('delete removes an entry from get, query and export', async (store) => {
        const keep = await store.put(entry('Keep the release notes'));
        const gone = await store.put(entry('Delete the release notes'));
        assertEqual(await store.delete(gone.id), true, 'delete of a stored entry resolves true');
        assertEqual(await store.get(gone.id), undefined, 'a deleted entry is not readable');
        const ids = (await store.query({ text: 'release notes', limit: 10 })).map((r) => r.entry.id);
        assertEqual(ids, [keep.id], 'query never returns a deleted entry');
        const exported: string[] = [];
        for await (const e of store.export()) exported.push(e.id);
        assertEqual(exported, [keep.id], 'export leaves a deleted entry out');
        assertEqual(await store.delete(gone.id), false, 'delete of an unknown id resolves false');
    });

    define('query ranks by text relevance', async (store) => {
        await store.put(entry('The user prefers tabs over spaces in TypeScript files.'));
        const target = await store.put(entry('Deploys go through the staging Cloudflare worker before production.'));
        await store.put(entry('The daemon pairs with a six character code.'));
        const ranked = await store.query({ text: 'cloudflare deploy staging', limit: 10 });
        assert(ranked.length === 3, 'every live entry passes when the query has no filters');
        assertEqual(ranked[0]!.entry.id, target.id, 'the best lexical match ranks first');
        assert(ranked[0]!.score > ranked[1]!.score, 'scores are strictly ordered');
        for (const r of ranked) assert(typeof r.score === 'number' && r.score > 0, 'every score is a positive number');
    });

    define('query filters by kinds, tags, subject and since', async (store) => {
        const t0 = now() - 10 * DAY;
        const pref = await store.put(entry('Prefers concise answers', { kind: 'preference', tags: ['style'], subject: 'User', provenance: { source: 'user', at: t0 } }));
        const fact = await store.put(entry('Repo uses pnpm', { kind: 'fact', tags: ['tooling', 'repo'], subject: 'repo', provenance: { source: 'agent', at: t0 + DAY } }));
        const lesson = await store.put(entry('Run typecheck before commit', { kind: 'lesson', tags: ['tooling'], subject: 'Repo', provenance: { source: 'verification', at: t0 + 2 * DAY } }));
        const ids = async (q: Parameters<MemoryStore['query']>[0]) => (await store.query(q)).map((r) => r.entry.id).sort();
        assertEqual(await ids({ kinds: ['preference'], limit: 10 }), [pref.id], 'kinds filter');
        assertEqual(await ids({ kinds: ['fact', 'lesson'], limit: 10 }), [fact.id, lesson.id].sort(), 'kinds filter, several');
        assertEqual(await ids({ tags: ['Tooling'], limit: 10 }), [fact.id, lesson.id].sort(), 'tags filter is any-of and case-insensitive');
        assertEqual(await ids({ tags: ['style', 'repo'], limit: 10 }), [pref.id, fact.id].sort(), 'tags filter matches any listed tag');
        assertEqual(await ids({ subject: 'repo', limit: 10 }), [fact.id, lesson.id].sort(), 'subject filter is case-insensitive');
        assertEqual(await ids({ since: t0 + 2 * DAY, limit: 10 }), [lesson.id], 'since filters on provenance.at');
        assertEqual(await ids({ kinds: ['fact'], tags: ['style'], limit: 10 }), [], 'filters AND together');
    });

    define('query never exceeds limit', async (store) => {
        for (let i = 0; i < 8; i++) await store.put(entry(`Note number ${i} about limits`));
        assertEqual((await store.query({ text: 'limits', limit: 3 })).length, 3, 'limit caps the result');
        assertEqual((await store.query({ limit: 0 })).length, 0, 'limit 0 returns nothing');
    });

    define('query never exceeds the byte budget', async (store) => {
        const big = 'x'.repeat(3000);
        await store.put(entry(`${big} budget`));
        const small = await store.put(entry('small budget note'));
        await store.put(entry(`${big} budget two`));
        const ranked = await store.query({ text: 'budget', limit: 10, maxBytes: 3100 });
        const bytes = ranked.reduce((n, r) => n + byteLength(r.entry.text), 0);
        assert(bytes <= 3100, `total text bytes ${bytes} within the budget`);
        assert(ranked.some((r) => r.entry.id === small.id), 'an entry that fits is returned even when a larger one ranked above it did not');
        const tiny = await store.query({ text: 'budget', limit: 10, maxBytes: 1 });
        assertEqual(tiny.length, 0, 'a budget nothing fits in returns nothing');
    });

    define('conditions match as tags', async (store) => {
        const lesson = await store.put(entry('Use forward slashes in shell commands', { kind: 'lesson', conditions: 'when running on Windows with git bash' }));
        await store.put(entry('Unrelated lesson', { kind: 'lesson' }));
        const ids = (await store.query({ tags: ['windows'], limit: 10 })).map((r) => r.entry.id);
        assertEqual(ids, [lesson.id], 'a token of `conditions` satisfies a tags filter');
    }, ['conditions']);

    define('kind weights: preference > lesson > fact > record > assumption', async (store) => {
        const at = now();
        const text = 'the same words in every entry';
        const put = async (kind: MemoryEntry['kind']) => (await store.put(entry(text, { kind, provenance: { source: 'agent', at } }))).id;
        const [assumption, record, fact, lesson, preference] = [await put('assumption'), await put('record'), await put('fact'), await put('lesson'), await put('preference')];
        const ids = (await store.query({ text, limit: 10 })).map((r) => r.entry.id);
        assertEqual(ids, [preference, lesson, fact, record, assumption], 'ties on text break by kind weight');
    }, ['kindWeights']);

    define('recency: a newer entry outranks an identical older one', async (store) => {
        const text = 'identical text, different age';
        const old = await store.put(entry(text, { provenance: { source: 'agent', at: now() - 60 * DAY } }));
        const fresh = await store.put(entry(text, { provenance: { source: 'agent', at: now() } }));
        const ids = (await store.query({ text, limit: 10 })).map((r) => r.entry.id);
        assertEqual(ids, [fresh.id, old.id], 'newer first');
    });

    define('working entries expire after their ttl', async (store) => {
        const expired = await store.put(entry('expired working context', { kind: 'working', ttl: 1000, provenance: { source: 'agent', at: now() - 10_000 } }));
        const live = await store.put(entry('live working context', { kind: 'working', ttl: 60_000, provenance: { source: 'agent', at: now() } }));
        const ids = (await store.query({ kinds: ['working'], limit: 10 })).map((r) => r.entry.id);
        assertEqual(ids, [live.id], 'an expired working entry is never returned');
        assertEqual(await store.get(expired.id), undefined, 'an expired working entry is compacted away');
    }, ['ttl']);

    define('records are compacted per task: one live record, superseding the last', async (store) => {
        const taskId = 'task_compact' as TaskId;
        const first = await store.put(entry('Task result v1', { kind: 'record', provenance: { source: 'agent', at: now() - 2000, taskId } }));
        const second = await store.put(entry('Task result v2', { kind: 'record', provenance: { source: 'agent', at: now() - 1000, taskId } }));
        const third = await store.put(entry('Task result v3', { kind: 'record', provenance: { source: 'agent', at: now(), taskId } }));
        const other = await store.put(entry('Other task record', { kind: 'record', provenance: { source: 'agent', at: now(), taskId: 'task_other' as TaskId } }));
        const ids = (await store.query({ kinds: ['record'], limit: 10 })).map((r) => r.entry.id).sort();
        assertEqual(ids, [third.id, other.id].sort(), 'only the newest record per task is live');
        assertEqual(third.supersedes, second.id, 'the new record supersedes the previous one');
        assert((await store.get(first.id))?.retired === true && (await store.get(second.id))?.retired === true, 'older records are retired, not deleted');
    }, ['supersedes']);

    define('export is versioned NDJSON and round-trips through import', async (store, fresh) => {
        const at = now() - DAY;
        await store.put(entry('Fact one', { tags: ['one'], subject: 'S', provenance: { source: 'user', at, sessionId: 'session_1' as never } }));
        await store.put(entry('Lesson two', { kind: 'lesson', conditions: 'when x', evidence: ['e1'], confidence: 'verified', provenance: { source: 'verification', at: at + 1 } }));
        const retired = await store.put(entry('Retired three', { provenance: { source: 'agent', at: at + 2 } }));
        await store.retire(retired.id, 'obsolete');
        await store.put(entry('Working four', { kind: 'working', ttl: 10 * DAY, provenance: { source: 'agent', at: at + 3 } }));

        const original = (await collect(store.export())).sort(byId);
        assertEqual(original.length, 4, 'export includes retired entries');
        const text = await exportToString(store.export(), { scope: 'agent:test' });
        const lines = ndjsonLines(text);
        const header = parseExportHeader(lines[0]!);
        assertEqual([header.format, header.version, header.scope], ['agentic-memory', MEMORY_EXPORT_VERSION, 'agent:test'], 'the header names the format and version');
        assertEqual(lines.length, 5, 'one line per entry after the header');

        const target = await fresh();
        const report: ImportReport = await target.import(fromNdjson(lines));
        assertEqual(report, { imported: 4, skipped: 0, droppedFields: [] }, 'a same-plugin import is lossless');
        const copy = (await collect(target.export())).sort(byId);
        assertEqual(copy, original, 'the imported store exports the same entries');
        assert((await target.get(retired.id))?.retired === true, 'retired stays retired across the round trip');
    });

    define('import honours onConflict and reports dropped fields', async (store) => {
        const existing = await store.put(entry('Existing'));
        const rows = [{ ...existing, text: 'Replaced', embedding: [0.1, 0.2], provenance: { ...existing.provenance, model: 'x' } }];
        const skip = await store.import((async function* () {
            yield* rows as unknown as MemoryEntry[];
        })());
        assertEqual(skip, { imported: 0, skipped: 1, droppedFields: ['embedding', 'provenance.model'] }, 'skip by default, still reporting what the shape cannot hold');
        assertEqual((await store.get(existing.id))?.text, 'Existing', 'a skipped row leaves the entry alone');
        const replace = await store.import((async function* () {
            yield* rows as unknown as MemoryEntry[];
        })(), { onConflict: 'replace' });
        assertEqual([replace.imported, replace.skipped], [1, 0], 'replace overwrites');
        assertEqual((await store.get(existing.id))?.text, 'Replaced', 'the replaced row is stored without the dropped fields');
        assertEqual(Object.keys((await store.get(existing.id)) ?? {}).includes('embedding'), false, 'dropped fields are not stored');
        const junk = await store.import((async function* () {
            yield { id: 'x' } as MemoryEntry;
            yield 'nope' as unknown as MemoryEntry;
        })());
        assertEqual(junk, { imported: 0, skipped: 2, droppedFields: [] }, 'rows that are not entries are skipped');
    });

    return without.length ? cases.filter((c) => !c.requires.some((f) => without.includes(f))) : cases;
}
