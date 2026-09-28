/** `fsBucket` (#988): the R2 slice the chat file store, the export sink and the orphan sweep use, over a directory. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatFile, ChatId, WorkspaceId } from '@agentic/core';
import { r2ChatFileStore } from '../../web/src/files/store';
import { fsBucket } from '../src/fs-bucket';

describe('fsBucket', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });
    const bucket = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-fs-bucket-'));
        dirs.push(dir);
        return fsBucket(dir);
    };

    it('puts, heads, gets and deletes an object with its metadata', async () => {
        const b = await bucket();
        await b.put('files/ws/chat/f1', new TextEncoder().encode('hello'), { httpMetadata: { contentType: 'text/plain' }, customMetadata: { posted: '1' } });
        const head = await b.head('files/ws/chat/f1');
        expect(head).toMatchObject({ key: 'files/ws/chat/f1', size: 5, httpMetadata: { contentType: 'text/plain' }, customMetadata: { posted: '1' } });
        const got = await b.get('files/ws/chat/f1');
        expect(new TextDecoder().decode(await got!.arrayBuffer())).toBe('hello');
        expect(await new Response(got!.body).text()).toBe('hello');
        await b.delete('files/ws/chat/f1');
        expect(await b.head('files/ws/chat/f1')).toBeNull();
        expect(await b.get('files/ws/chat/f1')).toBeNull();
    });

    it('takes strings and streams, and a put replaces the object', async () => {
        const b = await bucket();
        await b.put('k', 'first');
        await b.put('k', new Response('second').body!);
        expect(new TextDecoder().decode(await (await b.get('k'))!.arrayBuffer())).toBe('second');
        expect((await b.head('k'))!.size).toBe(6);
    });

    it('keeps keys Windows cannot name as files, and refuses keys that climb out', async () => {
        const b = await bucket();
        await b.put('exports/ws:1/a*b?.json', '{}');
        expect((await b.list({ prefix: 'exports/' })).objects.map((o) => o.key)).toEqual(['exports/ws:1/a*b?.json']);
        for (const key of ['../x', 'a/../../x', '/abs', 'a//b', '']) await expect(b.put(key, 'x')).rejects.toThrow(/invalid key/);
    });

    it('keeps a key and the keys it prefixes side by side, as R2 does (#1006)', async () => {
        const b = await bucket();
        const keys = ['a', 'a/b', 'a.json/b', 'a%.bin', 'a%.bin/c'];
        for (const k of keys) await b.put(k, `v:${k}`);
        for (const k of keys) expect(new TextDecoder().decode(await (await b.get(k))!.arrayBuffer())).toBe(`v:${k}`);
        expect((await b.list()).objects.map((o) => o.key)).toEqual([...keys].sort());
        await b.delete('a');
        expect(await b.get('a')).toBeNull();
        expect((await b.list()).objects.map((o) => o.key)).toEqual(keys.filter((k) => k !== 'a').sort());
    });

    it('lists by prefix in key order, pages with a cursor, and leaves custom metadata out unless asked', async () => {
        const b = await bucket();
        for (const k of ['files/b/2', 'files/a/1', 'files/b/1', 'other/x']) await b.put(k, k, { customMetadata: { at: '1' } });
        const first = await b.list({ prefix: 'files/', limit: 2 });
        expect(first.objects.map((o) => o.key)).toEqual(['files/a/1', 'files/b/1']);
        expect(first.truncated).toBe(true);
        expect(first.objects[0]!.customMetadata).toBeUndefined();
        const second = await b.list({ prefix: 'files/', limit: 2, cursor: first.cursor, include: ['customMetadata'] });
        expect(second.objects.map((o) => o.key)).toEqual(['files/b/2']);
        expect(second.truncated).toBe(false);
        expect(second.objects[0]!.customMetadata).toEqual({ at: '1' });
        await b.delete(['files/a/1', 'files/b/1', 'files/b/2']);
        expect((await b.list()).objects.map((o) => o.key)).toEqual(['other/x']);
    });

    it('runs the chat file store unchanged: post, read back, sweep the orphans, delete a chat', async () => {
        const b = await bucket();
        let now = 1_000_000;
        const store = r2ChatFileStore(() => b, { now: () => now });
        const ws = 'ws1' as WorkspaceId;
        const c1 = 'c1' as ChatId;
        const file = (id: string): ChatFile => ({ id, chatId: c1, name: `${id}.txt`, mediaType: 'text/plain', bytes: 2, at: now });
        await store.put(ws, file('posted'), new TextEncoder().encode('hi'));
        await store.put(ws, file('orphan'), new TextEncoder().encode('yo'));
        await store.markPosted(ws, c1, 'posted');
        expect(new TextDecoder().decode((await store.get(ws, c1, 'posted'))!.bytes)).toBe('hi');
        now += 10_000;
        expect(await store.sweepOrphans(5_000)).toBe(1);
        expect(await store.get(ws, c1, 'orphan')).toBeNull();
        await store.deleteChat(ws, c1);
        expect(await store.get(ws, c1, 'posted')).toBeNull();
    });
});
