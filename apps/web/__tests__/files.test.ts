/**
 * Chat attachments in the web app (#207), the parts that need no workerd:
 * the R2 store over an in-memory bucket, the route's header and name rules,
 * and the composer's upload helper. The routes themselves run on the real
 * Worker in `__tests__/workers/files.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_FILE_MAX_BYTES, type ChatFile, type ChatId, type WorkspaceId } from '@agentic/core';
import { chatFileKey, r2ChatFileStore } from '../src/files/store';
import { cleanFileName, dispositionOf, MAX_FILE_NAME, mediaTypeOf, newFileId } from '../src/files/route';
import type { R2BucketLike, R2ListOptionsLike, R2ObjectLike, R2PutOptionsLike } from '../src/retention';
import { readyParts, uploadChatFile, uploaded, type Upload } from '../src/pages/chat/uploads';

/** A bucket in memory with R2's listing rules: sorted keys, `limit`, `cursor`, custom metadata only when included. */
function memoryBucket() {
    const objects = new Map<string, { bytes: Uint8Array; options: R2PutOptionsLike }>();
    const toBytes = async (value: unknown): Promise<Uint8Array> => {
        if (typeof value === 'string') return new TextEncoder().encode(value);
        if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
    };
    const head = (key: string): R2ObjectLike | null => {
        const o = objects.get(key);
        return o ? { key, size: o.bytes.byteLength, ...(o.options.httpMetadata ? { httpMetadata: o.options.httpMetadata } : {}), ...(o.options.customMetadata ? { customMetadata: o.options.customMetadata } : {}) } : null;
    };
    const bucket: R2BucketLike = {
        async put(key, value, options = {}) {
            objects.set(key, { bytes: await toBytes(value), options });
        },
        async get(key) {
            const h = head(key);
            if (!h) return null;
            const bytes = objects.get(key)!.bytes;
            return { ...h, body: new Response(bytes.slice()).body!, arrayBuffer: async () => bytes.slice().buffer };
        },
        async head(key) {
            return head(key);
        },
        async delete(keys) {
            for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
        },
        async list(options: R2ListOptionsLike = {}) {
            const all = [...objects.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort();
            const start = options.cursor ? Number(options.cursor) : 0;
            const limit = options.limit ?? 1000;
            const page = all.slice(start, start + limit).map((k) => {
                const h = head(k)!;
                return options.include?.includes('customMetadata') ? h : { key: h.key, size: h.size };
            });
            const truncated = start + limit < all.length;
            return { objects: page, truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
        }
    };
    return { bucket, objects };
}

const WS = 'gh_1' as WorkspaceId;
const CHAT = 'chat_a' as ChatId;
const file = (id: string, at: number, over: Partial<ChatFile> = {}): ChatFile => ({ id, chatId: CHAT, name: `${id}.png`, mediaType: 'image/png', bytes: 3, at, ...over });

describe('r2ChatFileStore', () => {
    it('stores under files/<ws>/<chat>/<fileId> with name, type, posted and time; reads the record back', async () => {
        const { bucket, objects } = memoryBucket();
        const store = r2ChatFileStore(() => bucket);
        await store.put(WS, file('file_1', 1000), new Uint8Array([1, 2, 3]));
        const key = chatFileKey(WS, CHAT, 'file_1');
        expect(key).toBe('files/gh_1/chat_a/file_1');
        expect(objects.get(key)!.options).toEqual({ httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'file_1.png', mediaType: 'image/png', posted: '0', at: '1000' } });
        const body = await store.get(WS, CHAT, 'file_1');
        expect(body?.file).toEqual(file('file_1', 1000));
        expect([...body!.bytes]).toEqual([1, 2, 3]);
        expect(await store.get(WS, CHAT, 'nope')).toBeNull();
        const opened = await store.open(WS, CHAT, 'file_1');
        expect(opened?.size).toBe(3);
    });

    it('markPosted rewrites the metadata and keeps the bytes; a missing object fails the post', async () => {
        const { bucket, objects } = memoryBucket();
        const store = r2ChatFileStore(() => bucket);
        await store.put(WS, file('file_1', 1000), new Uint8Array([7, 8, 9]));
        await store.markPosted(WS, CHAT, 'file_1');
        const o = objects.get(chatFileKey(WS, CHAT, 'file_1'))!;
        expect(o.options.customMetadata?.posted).toBe('1');
        expect([...o.bytes]).toEqual([7, 8, 9]);
        await expect(store.markPosted(WS, CHAT, 'gone')).rejects.toThrow(/gone/);
    });

    it('sweeps unposted uploads older than the age, one bounded page per call, resuming where it stopped', async () => {
        const { bucket, objects } = memoryBucket();
        const now = 10 * 86_400_000;
        const store = r2ChatFileStore(() => bucket, { sweepPage: 2, now: () => now });
        await store.put(WS, file('a_old', now - 2 * 86_400_000), new Uint8Array(1));
        await store.put(WS, file('b_posted', now - 2 * 86_400_000), new Uint8Array(1));
        await store.markPosted(WS, CHAT, 'b_posted');
        await store.put(WS, file('c_fresh', now - 1000), new Uint8Array(1));
        await store.put(WS, file('d_old', now - 3 * 86_400_000), new Uint8Array(1));
        await bucket.put('exports/keep.json', '{}');
        expect(await store.sweepOrphans(86_400_000)).toBe(1); // a_old; b_posted kept
        expect(await store.sweepOrphans(86_400_000)).toBe(1); // c_fresh kept, d_old gone
        expect([...objects.keys()].sort()).toEqual(['exports/keep.json', 'files/gh_1/chat_a/b_posted', 'files/gh_1/chat_a/c_fresh']);
    });

    it('deleteChat removes every file of that chat only', async () => {
        const { bucket, objects } = memoryBucket();
        const store = r2ChatFileStore(() => bucket);
        await store.put(WS, file('f1', 1), new Uint8Array(1));
        await store.put(WS, file('f2', 1), new Uint8Array(1));
        await store.put(WS, file('f3', 1, { chatId: 'chat_b' as ChatId }), new Uint8Array(1));
        await store.deleteChat(WS, CHAT);
        expect([...objects.keys()]).toEqual(['files/gh_1/chat_b/f3']);
    });

    it('refuses to work without a bucket', async () => {
        await expect(r2ChatFileStore(() => undefined).get(WS, CHAT, 'x')).rejects.toThrow(/no ARTIFACTS bucket/);
    });
});

describe('the file route rules', () => {
    it('cleans X-File-Name: decoded, last path segment, no control characters, capped', () => {
        expect(cleanFileName(encodeURIComponent('report Q3.csv'))).toBe('report Q3.csv');
        expect(cleanFileName(encodeURIComponent('../../etc/passwd'))).toBe('passwd');
        expect(cleanFileName(encodeURIComponent('C:\\Users\\me\\a.txt'))).toBe('a.txt');
        expect(cleanFileName(encodeURIComponent('a\nb\u0000.txt'))).toBe('ab.txt');
        expect(cleanFileName(encodeURIComponent('..'))).toBe('file');
        expect(cleanFileName(null)).toBe('file');
        expect(cleanFileName('%E0%A4%A')).toBeNull();
        expect(cleanFileName('x'.repeat(500))!.length).toBe(MAX_FILE_NAME);
    });

    it('reads a media type as its lower-cased essence, or nothing', () => {
        expect(mediaTypeOf('Text/CSV; charset=utf-8')).toBe('text/csv');
        expect(mediaTypeOf('image/svg+xml')).toBe('image/svg+xml');
        expect(mediaTypeOf('nonsense')).toBeNull();
        expect(mediaTypeOf(null)).toBeNull();
    });

    it('serves raster images inline and everything else as an attachment, the name RFC 5987-encoded', () => {
        expect(dispositionOf({ name: 'a b.png', mediaType: 'image/png' })).toBe("inline; filename*=UTF-8''a%20b.png");
        expect(dispositionOf({ name: "it's (1).svg", mediaType: 'image/svg+xml' })).toBe("attachment; filename*=UTF-8''it%27s%20%281%29.svg");
        expect(dispositionOf({ name: 'åäö.csv', mediaType: 'text/csv' })).toBe("attachment; filename*=UTF-8''%C3%A5%C3%A4%C3%B6.csv");
    });

    it('mints url-safe file ids', () => {
        expect(newFileId()).toMatch(/^file_[A-Za-z0-9]{16}$/);
        expect(newFileId()).not.toBe(newFileId());
    });
});

describe('the composer upload', () => {
    it('posts the raw bytes with the type and the encoded name, and turns the answer into a ready chip', async () => {
        const seen: { url: string; init: RequestInit }[] = [];
        const record: ChatFile = { id: 'file_1', chatId: CHAT, name: 'data.csv', mediaType: 'text/csv', bytes: 3, at: 1 };
        const result = await uploadChatFile('chat_a', new File(['a,b'], 'data.csv', { type: 'text/csv' }), async (url, init) => {
            seen.push({ url, init });
            return new Response(JSON.stringify({ file: record, uri: 'agentic-file:chat_a/file_1' }), { status: 201 });
        });
        expect(seen[0]!.url).toBe('/files/chats/chat_a');
        expect(seen[0]!.init.headers).toEqual({ 'content-type': 'text/csv', 'x-file-name': 'data.csv' });
        const chip: Upload = { id: 'u1', name: 'data.csv', status: 'uploading' };
        const ready = uploaded(chip, result);
        expect(ready).toMatchObject({ status: 'ready', size: 3, part: { type: 'file', mediaType: 'text/csv', name: 'data.csv', url: 'agentic-file:chat_a/file_1' } });
        expect(readyParts([ready, chip, { id: 'u3', name: 'x', status: 'error' }])).toEqual([ready.part]);
    });

    it('says why an upload failed, and refuses an oversize file before sending it', async () => {
        const answer = (status: number) => async () => new Response(JSON.stringify({ error: 'nope' }), { status });
        await expect(uploadChatFile('c', new File(['x'], 'x.exe'), answer(415))).rejects.toThrow('This file type cannot be attached');
        await expect(uploadChatFile('c', new File(['x'], 'x'), answer(500))).rejects.toThrow('nope');
        let called = false;
        const big = { name: 'big.bin', size: CHAT_FILE_MAX_BYTES + 1, type: '' } as unknown as File;
        await expect(uploadChatFile('c', big, async () => ((called = true), new Response(null, { status: 201 })))).rejects.toThrow(/Too large/);
        expect(called).toBe(false);
    });
});
