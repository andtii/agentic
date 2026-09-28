/**
 * `exportDeployment` — pull a Cloudflare deployment's actor state and chat
 * files over its export routes (`apps/web/src/export`, #994).
 *
 * 1. List the `ACTORS` namespace's objects through the Cloudflare REST API
 *    (`GET /accounts/{account}/workers/durable_objects/namespaces/{ns}/objects`,
 *    an API token with "Workers Scripts: Read"), keeping the ones with
 *    stored data.
 * 2. `POST {origin}/_agentic/export` with `{ ids }`, `EXPORT_BATCH_MAX` at a
 *    time, and hand every NDJSON line to `writeLine` — the dump.
 * 3. Page through the chat files (`/_agentic/export/files`) and copy each one
 *    (`/_agentic/export/file`) into `files`, the node's `fsBucket`, with its
 *    content type and custom metadata.
 *
 * Every request carries `SESSION_SECRET` of the deployment in
 * `x-agentic-export`; a failed request throws — rerun the export, it is a read.
 */
import { EXPORT_BATCH_MAX, EXPORT_FILE_PATH, EXPORT_FILES_PATH, EXPORT_HEADER, EXPORT_PATH, type ExportedFile } from '../../../web/src/export';
import type { R2BucketLike } from '../../../web/src/retention';

export interface ExportDeploymentOptions {
    /** The deployment, e.g. `https://agentic.example`. */
    readonly origin: string;
    /** The deployment's `SESSION_SECRET`. */
    readonly secret: string;
    readonly accountId: string;
    /** The `ACTORS` namespace id (`wrangler durable-objects namespace list`, or the dashboard). */
    readonly namespaceId: string;
    readonly apiToken: string;
    readonly writeLine: (line: string) => void | Promise<void>;
    /** Where the chat files go; omitted → no files are copied. */
    readonly files?: R2BucketLike;
    readonly fetch?: typeof fetch;
    readonly cloudflareApi?: string;
    readonly log?: (message: string) => void;
}

export interface ExportDeploymentCounts {
    readonly objects: number;
    readonly lines: number;
    readonly files: number;
}

interface ObjectListing {
    readonly success?: boolean;
    readonly errors?: readonly { readonly message?: string }[];
    readonly result?: readonly { readonly id: string; readonly hasStoredData?: boolean }[];
    readonly result_info?: { readonly cursor?: string };
}

async function ok(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new Error(`[export] ${what}: ${res.status} ${await res.text()}`);
    return res;
}

/** Every object id of the namespace that holds data, over the REST listing's cursor. */
export async function listObjectIds(options: Pick<ExportDeploymentOptions, 'accountId' | 'namespaceId' | 'apiToken' | 'fetch' | 'cloudflareApi'>): Promise<string[]> {
    const doFetch = options.fetch ?? fetch;
    const api = options.cloudflareApi ?? 'https://api.cloudflare.com/client/v4';
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
        const url = new URL(`${api}/accounts/${encodeURIComponent(options.accountId)}/workers/durable_objects/namespaces/${encodeURIComponent(options.namespaceId)}/objects`);
        url.searchParams.set('limit', '10000');
        if (cursor) url.searchParams.set('cursor', cursor);
        const page = (await (await ok(await doFetch(url, { headers: { authorization: `Bearer ${options.apiToken}` } }), 'listing the objects')).json()) as ObjectListing;
        if (page.success === false) throw new Error(`[export] listing the objects: ${(page.errors ?? []).map((e) => e.message).join('; ')}`);
        for (const object of page.result ?? []) if (object.hasStoredData !== false) ids.push(object.id);
        cursor = page.result_info?.cursor || undefined;
    } while (cursor);
    return ids;
}

export async function exportDeployment(options: ExportDeploymentOptions): Promise<ExportDeploymentCounts> {
    const doFetch = options.fetch ?? fetch;
    const log = options.log ?? (() => undefined);
    const origin = options.origin.replace(/\/+$/, '');
    const post = (path: string, body: unknown): Promise<Response> =>
        doFetch(`${origin}${path}`, { method: 'POST', headers: { [EXPORT_HEADER]: options.secret, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const ids = await listObjectIds(options);
    log(`[export] ${ids.length} objects hold data`);
    let lines = 0;
    for (let i = 0; i < ids.length; i += EXPORT_BATCH_MAX) {
        const batch = ids.slice(i, i + EXPORT_BATCH_MAX);
        const text = await (await ok(await post(EXPORT_PATH, { ids: batch }), `objects ${i}..${i + batch.length - 1}`)).text();
        for (const line of text.split('\n')) {
            if (!line) continue;
            await options.writeLine(line);
            lines++;
        }
        log(`[export] ${Math.min(i + EXPORT_BATCH_MAX, ids.length)}/${ids.length} objects, ${lines} records`);
    }

    let files = 0;
    if (options.files) {
        let cursor: string | undefined;
        do {
            const page = (await (await ok(await post(EXPORT_FILES_PATH, cursor ? { cursor } : {}), 'listing the files')).json()) as { objects: ExportedFile[]; cursor?: string };
            for (const file of page.objects) {
                const res = await ok(await post(EXPORT_FILE_PATH, { key: file.key }), `file ${file.key}`);
                await options.files.put(file.key, await res.arrayBuffer(), {
                    ...(file.contentType ? { httpMetadata: { contentType: file.contentType } } : {}),
                    ...(file.customMetadata ? { customMetadata: file.customMetadata } : {})
                });
                files++;
            }
            cursor = page.cursor;
        } while (cursor);
        log(`[export] ${files} chat files`);
    }
    return { objects: ids.length, lines, files };
}
