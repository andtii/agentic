import type { MemoryEntry } from '@agentic/core';
import { createMemoryStore, exportToString, fromNdjson, MEMORY_EXPORT_VERSION, MemoryExportError, ndjsonLines, parseExportHeader, toNdjson } from '../src/index';

const NOW = 1_800_000_000_000;
const entry = (id: string, text: string): MemoryEntry => ({ id, kind: 'fact', text, tags: [], confidence: 'stated', provenance: { source: 'agent', at: NOW } });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

describe('NDJSON export', () => {
    it('writes a versioned header then one entry per line', async () => {
        const lines = await collect(toNdjson([entry('a', 'one'), entry('b', 'two')], { scope: 'agent:x', exportedAt: NOW }));
        expect(lines).toEqual([JSON.stringify({ format: 'agentic-memory', version: MEMORY_EXPORT_VERSION, exportedAt: NOW, scope: 'agent:x' }), JSON.stringify(entry('a', 'one')), JSON.stringify(entry('b', 'two'))]);
        const text = await exportToString([entry('a', 'one')], { exportedAt: NOW });
        expect(text.endsWith('\n')).toBe(true);
        expect(ndjsonLines(text + '\n\n')).toHaveLength(2);
    });

    it('is stable across a round trip through a fresh store', async () => {
        const source = createMemoryStore({ now: () => NOW });
        await source.importBatch([entry('a', 'one'), { ...entry('b', 'two'), retired: true, evidence: ['e'] }]);
        const text = await exportToString(source.export(), { exportedAt: NOW });
        const target = createMemoryStore({ now: () => NOW });
        expect(await target.import(fromNdjson(ndjsonLines(text)))).toEqual({ imported: 2, skipped: 0, droppedFields: [] });
        expect(await exportToString(target.export(), { exportedAt: NOW })).toBe(text);
    });
});

describe('NDJSON import', () => {
    it('refuses an unknown format or version and an empty input', async () => {
        expect(() => parseExportHeader('{"format":"other","version":1}')).toThrow(MemoryExportError);
        expect(() => parseExportHeader(`{"format":"agentic-memory","version":${MEMORY_EXPORT_VERSION + 1}}`)).toThrow(/unsupported version/);
        expect(() => parseExportHeader('nope')).toThrow(/not JSON/);
        await expect(collect(fromNdjson([]))).rejects.toThrow(/empty input/);
        await expect(collect(fromNdjson(['{"format":"x","version":1}', '{}']))).rejects.toThrow(MemoryExportError);
    });

    it('hands the header to the caller and yields the rows verbatim', async () => {
        let header: unknown;
        const rows = await collect(fromNdjson([JSON.stringify({ format: 'agentic-memory', version: 1, exportedAt: 5 }), '', '{"id":"a","extra":true}'], (h) => (header = h)));
        expect(header).toEqual({ format: 'agentic-memory', version: 1, exportedAt: 5 });
        expect(rows).toEqual([{ id: 'a', extra: true }]);
    });
});
