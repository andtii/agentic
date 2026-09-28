/**
 * Moving a Cloudflare deployment's actor state to a Node host (#994).
 *
 * Every actor is one `ActorHost` Durable Object, and a namespace cannot be
 * enumerated from inside the Worker — but it can from outside: the
 * Cloudflare REST API lists a namespace's object ids
 * (`/workers/durable_objects/namespaces/{id}/objects`). An object reached by
 * such an id has no `state.id.name`, and needs none: its storage keys name
 * the actor (`sigx:state\0<type>\0<key>`, `durableObjectStorage`). So the
 * export is the object list plus one read per object — no walk of the
 * Workspace graph, no knowledge of any platform actor's state shape — and it
 * also reaches what a walk would miss (task records, ledger months, audit).
 *
 * - `createExportHandler` — the object half, at `EXPORT_PATH`, modelled on
 *   the purge (`retention.ts`): `POST` with `SESSION_SECRET` in
 *   `EXPORT_HEADER`, answers NDJSON, one `ExportLine` per record the object
 *   holds (its actor, plus e.g. the actor's `$sigx:tasks` record), its
 *   durable reminders on its owner's line. It reads storage only: the host
 *   is not booted, so nothing activates, saves or re-arms an alarm.
 * - `createExportRoute` — the Worker half, the same path: a JSON body
 *   `{ ids }` (≤ `EXPORT_BATCH_MAX` object ids from the listing) is fanned
 *   out to those objects and their lines concatenated. Beside it, the chat
 *   files (`ARTIFACTS` under `files/`): a listing page and one file's bytes,
 *   so they land in the node's `fsBucket` layout with their metadata — a
 *   plain `rclone` copy would drop the sidecars the file store reads. The
 *   Worker checks the secret too, so an unauthenticated caller wakes nothing.
 *
 * The driver that lists the ids and writes the dump and the files, and the
 * import into a node's SQLite, are `apps/node/src/import` (`export` and
 * `import` subcommands of the node's `main.js`; the steps are there).
 */
import { durableObjectStorage, type DurableObjectIdLike, type DurableObjectNamespaceLike, type DurableObjectStateLike } from '@sigx/actors-cloudflare';
import { timingSafeEquals } from '@sigx/actors/host';
import { actorKeyOfObject } from '../daemon';
import { FILES_PREFIX } from '../files/store';
import type { R2BucketLike } from '../retention';

export const EXPORT_PATH = '/_agentic/export';
export const EXPORT_FILES_PATH = '/_agentic/export/files';
export const EXPORT_FILE_PATH = '/_agentic/export/file';
export const EXPORT_HEADER = 'x-agentic-export';
/** Object ids per Worker request: well under the Worker's subrequest limit, and a batch's lines stay small in memory. */
export const EXPORT_BATCH_MAX = 50;

/** `durableObjectStorage`'s record key prefix and separator (storage identity in `@sigx/actors-cloudflare`). */
const STATE_PREFIX = 'sigx:state\0';
const SEP = '\0';
/** `durableObjectReminders`' table key. */
const REMINDERS_KEY = 'sigx:reminders';

export interface ExportedReminder {
    /** Epoch ms the reminder is next due. */
    readonly nextDue: number;
    readonly period?: number;
}

/** One NDJSON line of a dump: one actor storage record, as `ActorStorage.load` returns it, without the etag. */
export interface ExportLine {
    readonly type: string;
    readonly key: string;
    /** The last full save and the entries appended since, oldest first; `null` when the object holds reminders but no record. */
    readonly record: { readonly state: unknown; readonly log: readonly unknown[] } | null;
    /** The object's durable reminders by name — on its owner's line only, `{}` elsewhere. */
    readonly reminders: Readonly<Record<string, ExportedReminder>>;
}

interface ReminderTable {
    readonly owner?: { readonly type: string; readonly key: string };
    readonly entries?: Readonly<Record<string, ExportedReminder>>;
}

/** What a real `DurableObjectStorage` has beyond the host's narrow slice: `list` without a prefix is not needed, `list({ prefix })` is. */
type ListableStorage = DurableObjectStateLike['storage'] & {
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};

function authorized(request: Request, secret: string | undefined): boolean {
    const given = request.headers.get(EXPORT_HEADER);
    return request.method === 'POST' && !!secret && !!given && timingSafeEquals(given, secret);
}

/** Every record and the reminders one object holds, as dump lines. */
export async function exportObject(state: DurableObjectStateLike): Promise<ExportLine[]> {
    const storage = state.storage as ListableStorage;
    const records = durableObjectStorage(storage);
    const refs: { type: string; key: string }[] = [];
    for (const [name, value] of await storage.list<unknown>({ prefix: STATE_PREFIX })) {
        // A record's snapshot is `{ state, etag }`; its append path (`…\0head`, `…\0log\0<n>`) holds strings. A key may
        // itself hold a NUL (`$sigx:tasks` records are keyed by actor id), so the value's shape decides, not the name's.
        if (!value || typeof value !== 'object' || !('etag' in value)) continue;
        const rest = name.slice(STATE_PREFIX.length);
        const at = rest.indexOf(SEP);
        if (at > 0) refs.push({ type: rest.slice(0, at), key: rest.slice(at + 1) });
    }
    const table = (await storage.get<ReminderTable>(REMINDERS_KEY)) ?? {};
    const entries = table.entries ?? {};
    const owner = Object.keys(entries).length > 0 ? (table.owner ?? actorKeyOfObject(state)) : null;
    const lines: ExportLine[] = [];
    let ownerSeen = false;
    for (const ref of refs) {
        const loaded = await records.load(ref.type, ref.key);
        if (!loaded) continue;
        const own = !!owner && owner.type === ref.type && owner.key === ref.key;
        ownerSeen ||= own;
        lines.push({ type: ref.type, key: ref.key, record: { state: loaded.state, log: loaded.log ?? [] }, reminders: own ? entries : {} });
    }
    if (owner && !ownerSeen) lines.push({ type: owner.type, key: owner.key, record: null, reminders: entries });
    return lines;
}

export const toNdjson = (lines: readonly ExportLine[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join('');

export interface ExportHandlerOptions {
    readonly state: DurableObjectStateLike;
    readonly secret: () => string | undefined;
}

/** The object half: `POST EXPORT_PATH` → this object's lines. `null` for any other path. */
export function createExportHandler(options: ExportHandlerOptions): { fetch(request: Request): Promise<Response> | null } {
    return {
        fetch(request) {
            if (new URL(request.url).pathname !== EXPORT_PATH) return null;
            return (async () => {
                if (!authorized(request, options.secret())) return new Response('forbidden', { status: 403 });
                return new Response(toNdjson(await exportObject(options.state)), { headers: { 'content-type': 'application/x-ndjson' } });
            })();
        }
    };
}

/** The namespace binding as workerd has it: `idFromString` parses a listed object id. */
export type ExportNamespace = DurableObjectNamespaceLike & { idFromString(id: string): DurableObjectIdLike };

export interface ExportRouteOptions {
    readonly namespace: () => ExportNamespace | undefined;
    /** The `ARTIFACTS` bucket: the chat files under `FILES_PREFIX` are listed and read through it. */
    readonly bucket: () => R2BucketLike | undefined;
    readonly secret: () => string | undefined;
}

/** One chat file as `EXPORT_FILES_PATH` lists it. */
export interface ExportedFile {
    readonly key: string;
    readonly size: number;
    readonly contentType?: string;
    readonly customMetadata?: Readonly<Record<string, string>>;
}

const OBJECT_ID = /^[0-9a-f]{64}$/;

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
    try {
        const body: unknown = await request.json();
        return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

async function exportObjects(namespace: ExportNamespace, secret: string, body: Record<string, unknown> | null): Promise<Response> {
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length > EXPORT_BATCH_MAX || !ids.every((id) => typeof id === 'string' && OBJECT_ID.test(id))) {
        return new Response(`expected { ids }: at most ${EXPORT_BATCH_MAX} object ids (64 hex chars)`, { status: 400 });
    }
    const texts = await Promise.all(
        (ids as string[]).map(async (id) => {
            const res = await namespace.get(namespace.idFromString(id)).fetch(`https://actor-host${EXPORT_PATH}`, { method: 'POST', headers: { [EXPORT_HEADER]: secret } });
            if (!res.ok) throw new Error(`object ${id}: ${res.status} ${await res.text()}`);
            return res.text();
        })
    ).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // One failed object fails the batch: a dump with a silent hole is worse than a retry.
    if (texts instanceof Error) return new Response(`[export] ${texts.message}`, { status: 502 });
    return new Response(texts.join(''), { headers: { 'content-type': 'application/x-ndjson' } });
}

async function listFiles(bucket: R2BucketLike, body: Record<string, unknown> | null): Promise<Response> {
    const cursor = typeof body?.cursor === 'string' ? body.cursor : undefined;
    const page = await bucket.list({ prefix: FILES_PREFIX, include: ['httpMetadata', 'customMetadata'], ...(cursor ? { cursor } : {}) });
    const objects: ExportedFile[] = page.objects.map((o) => ({
        key: o.key,
        size: o.size,
        ...(o.httpMetadata?.contentType ? { contentType: o.httpMetadata.contentType } : {}),
        ...(o.customMetadata ? { customMetadata: o.customMetadata } : {})
    }));
    return Response.json({ objects, ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}) });
}

async function readFile(bucket: R2BucketLike, body: Record<string, unknown> | null): Promise<Response> {
    const key = body?.key;
    if (typeof key !== 'string' || !key.startsWith(FILES_PREFIX)) return new Response(`expected { key } under ${FILES_PREFIX}`, { status: 400 });
    const object = await bucket.get(key);
    if (!object) return new Response('not found', { status: 404 });
    return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' } });
}

/**
 * The Worker half, every path under `EXPORT_PATH`, `POST` with the secret; `null` for any other path.
 *
 * - `EXPORT_PATH` with `{ ids }` — the lines of every named object, in order (NDJSON).
 * - `EXPORT_FILES_PATH` with `{ cursor? }` — one page of the chat files: `{ objects: ExportedFile[], cursor? }`.
 * - `EXPORT_FILE_PATH` with `{ key }` — one chat file's bytes.
 */
export function createExportRoute(options: ExportRouteOptions): { fetch(request: Request): Promise<Response> | null } {
    return {
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path !== EXPORT_PATH && path !== EXPORT_FILES_PATH && path !== EXPORT_FILE_PATH) return null;
            return (async () => {
                const secret = options.secret();
                if (!authorized(request, secret)) return new Response('forbidden', { status: 403 });
                const body = await bodyOf(request);
                if (path === EXPORT_PATH) {
                    const namespace = options.namespace();
                    return namespace ? exportObjects(namespace, secret!, body) : new Response('no ACTORS binding', { status: 500 });
                }
                const bucket = options.bucket();
                if (!bucket) return new Response('no ARTIFACTS bucket', { status: 500 });
                return path === EXPORT_FILES_PATH ? listFiles(bucket, body) : readFile(bucket, body);
            })();
        }
    };
}
