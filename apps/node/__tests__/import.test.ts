/**
 * Moving a Cloudflare deployment to a node (#994): the lines an object's
 * export handler writes import into `sqliteStorage` as the same records
 * (state + log) and the same reminders, an import twice converges, and
 * `exportDeployment` walks the object listing and the chat files into a dump
 * and an `fsBucket`.
 *
 * Gated on `node:sqlite` (Node >= 22.13), as the other storage tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMINDER_TYPE, manualScheduler, shardedReminders } from '@sigx/actors/host';
import type { ActorStorage } from '@sigx/actors';
import { EXPORT_FILE_PATH, EXPORT_FILES_PATH, EXPORT_HEADER, EXPORT_PATH, exportObject, toNdjson } from '../../web/src/export';
import { seededObject } from '../../web/__tests__/export-fakes';
import { fsBucket } from '../src/fs-bucket';
import { importDump } from '../src/import/dump';
import { exportDeployment } from '../src/import/pull';

const nodeSqlite = await import('node:sqlite').then(
    (m) => m,
    () => null
);
const mod = nodeSqlite ? await import('../src/index') : null;

const reminderNames = (storage: ActorStorage, type: string, key: string): Promise<string[]> => {
    const reminders = shardedReminders();
    reminders.bind({ storage, scheduler: manualScheduler(), tickMs: 1000, ownsShard: () => true, deliver: async () => undefined });
    return reminders.apiFor({ type, key }).list();
};

describe.skipIf(!nodeSqlite)('importDump (Cloudflare export → node)', () => {
    it('writes every record with its log and every reminder, and a second import converges', async () => {
        const lines = toNdjson(await exportObject(await seededObject())).split('\n');
        const storage = mod!.sqliteStorage({ database: new nodeSqlite!.DatabaseSync(':memory:'), table: 'records' });

        expect(await importDump(lines, storage)).toEqual({ records: 2, logEntries: 2, reminders: 2 });
        const session = await storage.load('Session', 'ws:s1');
        expect(session?.state).toEqual({ title: 'hello', events: [] });
        expect(session?.log).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]);
        expect((await storage.load('$sigx:tasks', 'Session\0ws:s1'))?.state).toEqual({ runs: {} });
        expect((await reminderNames(storage, 'Session', 'ws:s1')).sort()).toEqual(['once', 'sweep']);

        await importDump(lines, storage);
        expect((await storage.load('Session', 'ws:s1'))?.log).toHaveLength(2);
        expect((await reminderNames(storage, 'Session', 'ws:s1')).sort()).toEqual(['once', 'sweep']);
        // The reminder table is an ordinary record on the same storage: the node's host reads it as-is.
        const shards = await Promise.all(Array.from({ length: 16 }, (_, i) => storage.load(REMINDER_TYPE, `p${i}`)));
        const periodic = shards.flatMap((r) => Object.values((r?.state ?? {}) as Record<string, Record<string, { period?: number }>>)).flatMap((t) => Object.values(t));
        expect(periodic.map((r) => r.period).filter(Boolean)).toEqual([3_600_000]);
    });

    it('refuses a line that is not an export line', async () => {
        const storage = mod!.sqliteStorage({ database: new nodeSqlite!.DatabaseSync(':memory:'), table: 'records' });
        await expect(importDump(['', '{"type":"X"}'], storage)).rejects.toThrow('line 2');
        await expect(importDump(['nope'], storage)).rejects.toThrow('not JSON');
    });
});

describe('exportDeployment', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    it('lists the objects over the cursor, exports them in batches and copies the chat files with their metadata', async () => {
        const ids = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(64, '0'));
        const seen: { path: string; body: unknown; secret: string | null }[] = [];
        const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.hostname === 'api.cloudflare.com') {
                expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
                const cursor = url.searchParams.get('cursor');
                const page = cursor ? ids.slice(30) : ids.slice(0, 30);
                return Response.json({ success: true, result: [...page.map((id) => ({ id, hasStoredData: true })), ...(cursor ? [] : [{ id: 'f'.repeat(64), hasStoredData: false }])], result_info: { cursor: cursor ? '' : 'next' } });
            }
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            seen.push({ path: url.pathname, body, secret: new Headers(init?.headers).get(EXPORT_HEADER) });
            if (url.pathname === EXPORT_PATH) return new Response((body.ids as string[]).map((id) => `${JSON.stringify({ type: 'T', key: id, record: { state: 1, log: [] }, reminders: {} })}\n`).join(''));
            if (url.pathname === EXPORT_FILES_PATH) return Response.json({ objects: [{ key: 'files/ws/c/1', size: 3, contentType: 'text/plain', customMetadata: { name: 'a.txt' } }] });
            if (url.pathname === EXPORT_FILE_PATH) return new Response('one');
            return new Response('no', { status: 404 });
        }) as typeof fetch;

        const dir = await mkdtemp(join(tmpdir(), 'agentic-export-'));
        dirs.push(dir);
        const files = fsBucket(dir);
        const written: string[] = [];
        const counts = await exportDeployment({ origin: 'https://agentic.test/', secret: 'sek', accountId: 'acc', namespaceId: 'ns', apiToken: 'tok', files, writeLine: (l) => void written.push(l), fetch: fakeFetch });

        expect(counts).toEqual({ objects: 60, lines: 60, files: 1 });
        expect(written.map((l) => (JSON.parse(l) as { key: string }).key)).toEqual(ids);
        expect(seen.filter((s) => s.path === EXPORT_PATH).map((s) => (s.body as { ids: string[] }).ids.length)).toEqual([50, 10]);
        expect(seen.every((s) => s.secret === 'sek')).toBe(true);
        const copied = await files.get('files/ws/c/1');
        expect(copied && [await new Response(copied.body).text(), copied.httpMetadata?.contentType, copied.customMetadata]).toEqual(['one', 'text/plain', { name: 'a.txt' }]);
    });

    it('throws on a failed batch rather than writing a dump with a hole', async () => {
        const fakeFetch = (async (input: string | URL | Request) =>
            new URL(String(input)).hostname === 'api.cloudflare.com'
                ? Response.json({ success: true, result: [{ id: 'a'.repeat(64), hasStoredData: true }], result_info: {} })
                : new Response('boom', { status: 502 })) as typeof fetch;
        await expect(exportDeployment({ origin: 'https://agentic.test', secret: 's', accountId: 'a', namespaceId: 'n', apiToken: 't', writeLine: () => undefined, fetch: fakeFetch })).rejects.toThrow('502 boom');
    });
});
