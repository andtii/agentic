/**
 * `fsBucket(dir)` — the `R2BucketLike` the web app's chat file store
 * (`r2ChatFileStore`), export sink (`r2ArtifactSink`) and orphan sweep run on,
 * over a directory (#988).
 *
 *     <dir>/objects/<key>%.bin    the bytes
 *     <dir>/meta/<key>%.json      { size, uploaded, httpMetadata, customMetadata }
 *
 * Every key segment is percent-encoded (`encodeURIComponent`, plus `*`), so a
 * key is a valid path on Windows as on Linux and cannot climb out of `dir`
 * (`.` and `..` segments and empty segments are refused). An encoded segment
 * never holds `%.` (a `%` is always followed by two hex digits), so the leaf
 * suffixes never name a directory: `a` and `a/b` sit side by side, as on R2
 * (#1006). A put writes the
 * bytes and then the sidecar, each through a temp file and a rename, so a
 * reader sees the old object or the new one. `list` walks the sidecars in key
 * order; its cursor is the last key it returned.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { R2BucketLike, R2ListOptionsLike, R2ObjectBodyLike, R2ObjectLike, R2ObjectsLike, R2PutOptionsLike } from '../../web/src/retention';

interface Sidecar {
    readonly size: number;
    readonly uploaded: number;
    readonly httpMetadata?: { readonly contentType?: string };
    readonly customMetadata?: Readonly<Record<string, string>>;
}

const DEFAULT_LIST_LIMIT = 1000;
/** Leaf suffixes no encoded segment can end in, so a leaf never shares a name with a directory (#1006). */
const OBJECT_SUFFIX = '%.bin';
const META_SUFFIX = '%.json';

const encodeSegment = (segment: string): string => encodeURIComponent(segment).replace(/\*/g, '%2A');

/** The key's path segments, encoded; a throw for a key that is not a plain relative path. */
function segmentsOf(key: string): string[] {
    const parts = key.split('/');
    if (!key || parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`[fsBucket] invalid key: ${JSON.stringify(key)}`);
    return parts.map(encodeSegment);
}

async function bytesOf(value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string): Promise<Uint8Array> {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(await new Response(value).arrayBuffer());
}

async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
}

const isMissing = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'ENOENT';

export function fsBucket(dir: string): R2BucketLike {
    const objects = join(dir, 'objects');
    const meta = join(dir, 'meta');
    const leafPath = (root: string, key: string, suffix: string): string => {
        const s = segmentsOf(key);
        s[s.length - 1] += suffix;
        return join(root, ...s);
    };
    const objectPath = (key: string): string => leafPath(objects, key, OBJECT_SUFFIX);
    const metaPath = (key: string): string => leafPath(meta, key, META_SUFFIX);

    const head = async (key: string): Promise<R2ObjectLike | null> => {
        let text: string;
        try {
            text = await readFile(metaPath(key), 'utf8');
        } catch (e) {
            if (isMissing(e)) return null;
            throw e;
        }
        const sidecar = JSON.parse(text) as Sidecar;
        return {
            key,
            size: sidecar.size,
            uploaded: new Date(sidecar.uploaded),
            ...(sidecar.httpMetadata ? { httpMetadata: sidecar.httpMetadata } : {}),
            ...(sidecar.customMetadata ? { customMetadata: sidecar.customMetadata } : {})
        };
    };

    /** Every key under `meta/`, decoded, sorted. */
    const keys = async (): Promise<string[]> => {
        const out: string[] = [];
        const walk = async (path: string, prefix: string): Promise<void> => {
            let entries;
            try {
                entries = await readdir(path, { withFileTypes: true });
            } catch (e) {
                if (isMissing(e)) return;
                throw e;
            }
            for (const entry of entries) {
                if (entry.isDirectory()) await walk(join(path, entry.name), `${prefix}${decodeURIComponent(entry.name)}/`);
                else if (entry.name.endsWith(META_SUFFIX)) out.push(prefix + decodeURIComponent(entry.name.slice(0, -META_SUFFIX.length)));
            }
        };
        await walk(meta, '');
        return out.sort();
    };

    return {
        async put(key, value, options?: R2PutOptionsLike) {
            const bytes = await bytesOf(value);
            await writeAtomic(objectPath(key), bytes);
            const sidecar: Sidecar = {
                size: bytes.byteLength,
                uploaded: Date.now(),
                ...(options?.httpMetadata ? { httpMetadata: { ...options.httpMetadata } } : {}),
                ...(options?.customMetadata ? { customMetadata: { ...options.customMetadata } } : {})
            };
            await writeAtomic(metaPath(key), JSON.stringify(sidecar));
            return head(key);
        },

        async get(key): Promise<R2ObjectBodyLike | null> {
            const object = await head(key);
            if (!object) return null;
            let bytes: Uint8Array;
            try {
                bytes = new Uint8Array(await readFile(objectPath(key)));
            } catch (e) {
                if (isMissing(e)) return null;
                throw e;
            }
            return {
                ...object,
                get body() {
                    return new Response(bytes as Uint8Array<ArrayBuffer>).body!;
                },
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
            };
        },

        head,

        async delete(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                await rm(metaPath(key), { force: true });
                await rm(objectPath(key), { force: true });
            }
        },

        async list(options: R2ListOptionsLike = {}): Promise<R2ObjectsLike> {
            const prefix = options.prefix ?? '';
            const limit = options.limit ?? DEFAULT_LIST_LIMIT;
            const after = options.cursor;
            const matching = (await keys()).filter((k) => k.startsWith(prefix) && (after === undefined || k > after));
            const page = matching.slice(0, limit);
            const objects: R2ObjectLike[] = [];
            for (const key of page) {
                const object = await head(key);
                if (!object) continue;
                // R2 leaves custom metadata out of a listing unless asked.
                if (!options.include?.includes('customMetadata')) {
                    const { customMetadata: _omit, ...rest } = object;
                    objects.push(rest);
                } else objects.push(object);
            }
            const truncated = matching.length > page.length;
            return { objects, truncated, ...(truncated ? { cursor: page.at(-1)! } : {}) };
        }
    };
}

