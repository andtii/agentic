/**
 * What the Node host needs of `sqliteStorage` beyond the shared suite:
 * appends are O(1) — one `log` row each, the state row untouched — and a
 * record (state + log) survives closing and reopening the database file.
 *
 * Gated on `node:sqlite` (Node >= 22.13); see storage-conformance.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nodeSqlite = await import('node:sqlite').then(
    (m) => m,
    () => null
);
const mod = nodeSqlite ? await import('../src/index') : null;

describe.skipIf(!nodeSqlite)('sqliteStorage (node host)', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });
    const freshPath = async (): Promise<string> => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-node-sqlite-'));
        dirs.push(dir);
        return join(dir, 'actors.db');
    };

    it('an append adds one log row and never rewrites the state row', async () => {
        const db = new nodeSqlite!.DatabaseSync(':memory:');
        const storage = mod!.sqliteStorage({ database: db, table: 'records' });
        const logRows = () => Number((db.prepare('SELECT COUNT(*) AS n FROM records_log').get() as { n: number | bigint }).n);
        const stateText = () => (db.prepare('SELECT state FROM records').get() as { state: string }).state;

        let etag = await storage.save('Session', 's1', { events: [] }, null);
        const before = stateText();
        for (let i = 1; i <= 5; i++) {
            etag = await storage.appendText('Session', 's1', JSON.stringify({ n: i }), etag);
            expect(logRows()).toBe(i);
            expect(stateText()).toBe(before);
        }
        const record = await storage.load('Session', 's1');
        expect(record?.log).toEqual([1, 2, 3, 4, 5].map((n) => ({ n })));

        // A full save is the compaction: the log goes with it.
        await storage.save('Session', 's1', { events: [1, 2, 3, 4, 5] }, etag);
        expect(logRows()).toBe(0);
        storage.close();
    });

    it('state and log survive closing and reopening the database', async () => {
        const path = await freshPath();
        const first = mod!.sqliteStorage({ path });
        let etag = await first.save('Session', 's1', { title: 'hello' }, null);
        etag = await first.appendText('Session', 's1', '{"n":1}', etag);
        etag = await first.appendText('Session', 's1', '{"n":2}', etag);
        first.close();

        const second = mod!.sqliteStorage({ path });
        const record = await second.load('Session', 's1');
        expect(record).toEqual({ state: { title: 'hello' }, etag, log: [{ n: 1 }, { n: 2 }] });
        // The reopened store continues the same etag chain.
        await expect(second.appendText('Session', 's1', '{"n":3}', etag)).resolves.toBeTypeOf('string');
        second.close();
    });

    it('a path database runs in WAL mode', async () => {
        const path = await freshPath();
        const storage = mod!.sqliteStorage({ path });
        await storage.save('T', 'k', {}, null);
        storage.close();
        const db = new nodeSqlite!.DatabaseSync(path);
        expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
        db.close();
    });
});
