/**
 * The Cloudflare state export (#994): an object's handler reads every record
 * (state + appended log) and its reminders straight from storage, the Worker
 * route fans a batch of listed ids out to the objects, and both refuse a
 * caller without the deployment secret.
 */
import { describe, expect, it } from 'vitest';
import { durableObjectName, durableObjectReminders, durableObjectStorage, type DurableObjectStateLike } from '@sigx/actors-cloudflare';
import { fakeObjectState, seededObject } from './export-fakes';
import { EXPORT_FILE_PATH, EXPORT_FILES_PATH, EXPORT_HEADER, EXPORT_PATH, createExportHandler, createExportRoute, exportObject, type ExportLine, type ExportNamespace } from '../src/export';
import type { R2BucketLike, R2ObjectLike } from '../src/retention';

const SECRET = 's'.repeat(32);

const post = (path: string, body?: unknown, secret: string | null = SECRET) =>
    new Request(`https://agentic.test${path}`, { method: 'POST', headers: secret ? { [EXPORT_HEADER]: secret } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const parse = (text: string): ExportLine[] => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ExportLine);

describe('exportObject', () => {
    it('exports every record with its log, and the reminders on the owner line only', async () => {
        const lines = await exportObject(await seededObject());
        expect(lines.map((l) => [l.type, l.key])).toEqual([
            ['$sigx:tasks', 'Session\0ws:s1'],
            ['Session', 'ws:s1']
        ]);
        const session = lines.find((l) => l.type === 'Session')!;
        expect(session.record).toEqual({ state: { title: 'hello', events: [] }, log: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }] });
        expect(Object.keys(session.reminders).sort()).toEqual(['once', 'sweep']);
        expect(session.reminders.sweep!.period).toBe(3_600_000);
        expect(lines.find((l) => l.type === '$sigx:tasks')!.reminders).toEqual({});
    });

    it('keeps reminders whose actor has no record, on a line with a null record', async () => {
        const state = fakeObjectState(durableObjectName({ type: 'Schedule', key: 'ws:x' }));
        await durableObjectReminders({ storage: state.storage, alarms: state.storage }).apiFor({ type: 'Schedule', key: 'ws:x' }).set('tick', { due: 1000 });
        expect(await exportObject(state)).toEqual([{ type: 'Schedule', key: 'ws:x', record: null, reminders: { tick: { nextDue: expect.any(Number) } } }]);
    });

    it('an empty object exports nothing', async () => {
        expect(await exportObject(fakeObjectState())).toEqual([]);
    });
});

describe('createExportHandler (the object half)', () => {
    it('answers NDJSON to the secret, 403 without it, and ignores other paths', async () => {
        const handler = createExportHandler({ state: await seededObject(), secret: () => SECRET });
        expect(handler.fetch(new Request('https://actor-host/_sigx/actor'))).toBeNull();
        expect((await handler.fetch(post(EXPORT_PATH, undefined, null))!).status).toBe(403);
        expect((await handler.fetch(post(EXPORT_PATH, undefined, 'x'.repeat(32)))!).status).toBe(403);
        expect((await createExportHandler({ state: fakeObjectState(), secret: () => undefined }).fetch(post(EXPORT_PATH))!).status).toBe(403);
        const res = (await handler.fetch(post(EXPORT_PATH)))!;
        expect(res.status).toBe(200);
        expect(parse(await res.text())).toHaveLength(2);
    });
});

function fakeNamespace(objects: Record<string, DurableObjectStateLike>): ExportNamespace {
    return {
        idFromName: () => {
            throw new Error('not by name');
        },
        idFromString: (id) => ({ toString: () => id }),
        get: (id) => {
            const state = objects[id.toString()];
            return { fetch: async (input, init) => (state ? await createExportHandler({ state, secret: () => SECRET }).fetch(new Request(input, init))! : new Response('gone', { status: 500 })) };
        }
    };
}

function fakeBucket(files: Record<string, { body: string; contentType?: string; meta?: Record<string, string> }>): R2BucketLike {
    const head = (key: string): R2ObjectLike => ({ key, size: files[key]!.body.length, httpMetadata: { contentType: files[key]!.contentType }, customMetadata: files[key]!.meta });
    return {
        put: async () => undefined,
        delete: async () => undefined,
        head: async (key) => (files[key] ? head(key) : null),
        get: async (key) => (files[key] ? { ...head(key), body: new Response(files[key]!.body).body!, arrayBuffer: () => new Response(files[key]!.body).arrayBuffer() } : null),
        list: async (options) => {
            const keys = Object.keys(files).filter((k) => k.startsWith(options?.prefix ?? '')).sort();
            const from = options?.cursor ? Number(options.cursor) : 0;
            const page = keys.slice(from, from + 1);
            return { objects: page.map(head), truncated: from + 1 < keys.length, ...(from + 1 < keys.length ? { cursor: String(from + 1) } : {}) };
        }
    };
}

describe('createExportRoute (the Worker half)', () => {
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);

    it('fans a batch of ids out to their objects and concatenates the lines', async () => {
        const second = fakeObjectState();
        await durableObjectStorage(second.storage).save('Workspace', 'ws', { name: 'W' }, null);
        const first = await seededObject();
        const route = createExportRoute({ namespace: () => fakeNamespace({ [idA]: first, [idB]: second }), bucket: () => undefined, secret: () => SECRET });
        const res = (await route.fetch(post(EXPORT_PATH, { ids: [idA, idB] })))!;
        expect(res.status).toBe(200);
        expect(parse(await res.text()).map((l) => l.type)).toEqual(['$sigx:tasks', 'Session', 'Workspace']);
    });

    it('refuses a caller without the secret, a malformed batch, and fails the batch when an object fails', async () => {
        const route = createExportRoute({ namespace: () => fakeNamespace({ [idA]: fakeObjectState() }), bucket: () => undefined, secret: () => SECRET });
        expect(route.fetch(new Request('https://agentic.test/_sigx/actor'))).toBeNull();
        expect((await route.fetch(post(EXPORT_PATH, { ids: [idA] }, null))!).status).toBe(403);
        expect((await route.fetch(post(EXPORT_PATH, { ids: ['not-an-id'] }))!).status).toBe(400);
        expect((await route.fetch(post(EXPORT_PATH, { ids: Array.from({ length: 51 }, () => idA) }))!).status).toBe(400);
        expect((await route.fetch(post(EXPORT_PATH, { ids: [idA, idB] }))!).status).toBe(502);
    });

    it('lists the chat files page by page and serves one file, only under files/', async () => {
        const bucket = fakeBucket({ 'files/ws/c/1': { body: 'one', contentType: 'text/plain', meta: { name: 'a.txt' } }, 'files/ws/c/2': { body: 'two' }, 'exports/x': { body: 'no' } });
        const route = createExportRoute({ namespace: () => undefined, bucket: () => bucket, secret: () => SECRET });
        const first = (await (await route.fetch(post(EXPORT_FILES_PATH, {}))!).json()) as { objects: { key: string }[]; cursor?: string };
        expect(first.objects).toEqual([{ key: 'files/ws/c/1', size: 3, contentType: 'text/plain', customMetadata: { name: 'a.txt' } }]);
        const second = (await (await route.fetch(post(EXPORT_FILES_PATH, { cursor: first.cursor }))!).json()) as { objects: { key: string }[]; cursor?: string };
        expect(second.objects.map((o) => o.key)).toEqual(['files/ws/c/2']);
        expect(second.cursor).toBeUndefined();
        const file = (await route.fetch(post(EXPORT_FILE_PATH, { key: 'files/ws/c/1' })))!;
        expect([file.status, file.headers.get('content-type'), await file.text()]).toEqual([200, 'text/plain', 'one']);
        expect((await route.fetch(post(EXPORT_FILE_PATH, { key: 'exports/x' }))!).status).toBe(400);
        expect((await route.fetch(post(EXPORT_FILES_PATH, {}, null))!).status).toBe(403);
    });
});
