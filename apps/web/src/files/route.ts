/**
 * The chat file routes (#207, CHT-10 / CHT-04), mounted by the Worker next to
 * the auth routes (`entry.cloudflare.ts`), after `actors.boot(env)`:
 *
 *   POST /files/chats/:chatId           raw body, `Content-Type`, `X-File-Name` (URI-encoded)
 *                                       → 201 `{ file, uri }`
 *   GET  /files/chats/:chatId/:fileId   the bytes, if `Chat.fileAccess` says so
 *
 * The caller is the session cookie's user (`authenticateRequest`, the reader
 * `/auth/me` uses); an agent token also reads. Every decision is the Chat
 * actor's, asked AS that principal in the principal's own workspace — a chat
 * id from another workspace names a chat of the caller's, which holds no
 * such file (404). The bytes are in R2 (`r2ChatFileStore`).
 *
 * Upload: a same-origin `Origin` is required (the cookie is the credential,
 * so this is the CSRF guard); the body is refused over `CHAT_FILE_MAX_BYTES`
 * by `Content-Length` and again while it streams (413); a missing, malformed
 * or blocked type is 415. The object is written first, then registered with
 * `Chat.registerUpload` — a refusal deletes it again and answers with the
 * Chat's own status (400 / 409 / 413 / 429 / 501).
 *
 * Download: `nosniff`, a sandboxing CSP and `private` caching always; the
 * raster image types a browser renders safely are `inline`, everything else
 * (SVG included) is an `attachment`.
 *
 * Orphans (uploads never posted) are swept opportunistically after an
 * upload — at most once per `SWEEP_EVERY_MS` per isolate, one listing page
 * per sweep, never waited on (`docs/retention.md`).
 */
import { actorKey, CHAT_FILE_MAX_BYTES, chatFileUri, type ChatFile, type ChatId, type Principal, type WorkspaceId } from '@agentic/core';
import { asPrincipal, authenticateRequest, Chat, PENDING_TTL_MS } from '@agentic/platform';
import { actor } from '@sigx/actors';
import { isServerFnError } from '@sigx/server';
import { originOf, type AuthMountEnv } from '../auth/mount';
import type { RouteHandler } from '../auth';
import type { R2ChatFileStore } from './store';

export const FILES_ROUTE_PREFIX = '/files/chats/';

/** How old an unposted upload must be before the sweep deletes it — a day, and never under the Chat's own pending TTL. */
export const ORPHAN_AGE_MS = Math.max(24 * 60 * 60 * 1000, PENDING_TTL_MS);
/** The least time between two opportunistic sweeps in one isolate. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** The longest file name kept, in characters. */
export const MAX_FILE_NAME = 200;

/** Types a browser renders as a plain raster image — the only ones served `inline`. */
const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Types never accepted: markup a browser would run and executables. */
export const BLOCKED_TYPES: ReadonlySet<string> = new Set([
    'text/html',
    'application/xhtml+xml',
    'application/x-msdownload',
    'application/x-msdos-program',
    'application/x-executable',
    'application/x-msi',
    'application/vnd.microsoft.portable-executable'
]);

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A new file id: `file_<16 url-safe chars>`, the shape of `@agentic/core`'s `createId`. */
export function newFileId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
    return `file_${out}`;
}

/** `X-File-Name` → a name to keep: URI-decoded, the last path segment, no control characters, at most `MAX_FILE_NAME`; `null` when it cannot be decoded. */
export function cleanFileName(header: string | null): string | null {
    let name = header ?? '';
    try {
        name = decodeURIComponent(name);
    } catch {
        return null;
    }
    name = [...(name.split(/[/\\]/).pop() ?? '')].filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f).join('').trim();
    if (name === '.' || name === '..') name = '';
    return [...name].slice(0, MAX_FILE_NAME).join('') || 'file';
}

/** `Content-Type` → its lower-cased essence (no parameters); `null` when missing or malformed. */
export function mediaTypeOf(header: string | null): string | null {
    const essence = (header ?? '').split(';')[0]!.trim().toLowerCase();
    return MEDIA_TYPE.test(essence) ? essence : null;
}

/** `Content-Disposition` for a download: `inline` for a raster image, `attachment` for everything else; the name RFC 5987-encoded. */
export function dispositionOf(file: Pick<ChatFile, 'name' | 'mediaType'>): string {
    const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${INLINE_TYPES.has(file.mediaType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`;
}

const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const refuse = (status: number, error: string): Response => json({ error }, status);

/** The body, whole, or `null` once it grows past `max` (the stream is cancelled). */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
    }
    return out;
}

/** `waitUntil` where the runtime has one (the Worker's `ctx`). */
export interface WaitUntilLike {
    waitUntil?(promise: Promise<unknown>): void;
}

export interface FilesMountWiring {
    readonly store: R2ChatFileStore;
    /** Largest accepted upload. Default `CHAT_FILE_MAX_BYTES`. */
    readonly maxBytes?: number;
    readonly now?: () => number;
}

const secretOf = (env: AuthMountEnv): string => ((env.SESSION_SECRET ?? '').length >= 32 ? env.SESSION_SECRET! : '');

/**
 * Build the resolver: `(request, env, ctx) → handler | undefined` — `undefined`
 * for any path outside `/files/chats/`, so the Worker falls through.
 */
export function createFilesMount(wiring: FilesMountWiring): (request: Request, env: AuthMountEnv, ctx?: WaitUntilLike) => RouteHandler | undefined {
    const now = wiring.now ?? Date.now;
    const maxBytes = wiring.maxBytes ?? CHAT_FILE_MAX_BYTES;
    let lastSweep = Number.NEGATIVE_INFINITY;

    const chatAs = (principal: Principal, workspaceId: WorkspaceId, chatId: string) => actor(Chat, actorKey(workspaceId, 'chat', chatId)).with({ context: asPrincipal(principal) });

    const sweepSoon = (ctx: WaitUntilLike | undefined): void => {
        const t = now();
        if (t - lastSweep < SWEEP_EVERY_MS) return;
        lastSweep = t;
        const run = wiring.store.sweepOrphans(ORPHAN_AGE_MS).catch((e: unknown) => {
            console.warn('[files] orphan sweep failed:', e);
            return 0;
        });
        ctx?.waitUntil?.(run);
    };

    const upload = async (request: Request, env: AuthMountEnv, ctx: WaitUntilLike | undefined, principal: Principal, workspaceId: WorkspaceId, chatId: string): Promise<Response> => {
        const origin = request.headers.get('origin');
        if (!origin || (origin !== new URL(request.url).origin && origin !== originOf(env, request))) return refuse(403, 'cross-origin');
        const declared = request.headers.get('content-length');
        if (declared !== null && Number(declared) > maxBytes) return refuse(413, 'too-large');
        const mediaType = mediaTypeOf(request.headers.get('content-type'));
        if (!mediaType || BLOCKED_TYPES.has(mediaType)) return refuse(415, 'unsupported-type');
        const name = cleanFileName(request.headers.get('x-file-name'));
        if (name === null) return refuse(400, 'bad-file-name');
        const bytes = await readCapped(request.body, maxBytes);
        if (!bytes) return refuse(413, 'too-large');

        const file: ChatFile = { id: newFileId(), chatId: chatId as ChatId, name, mediaType, bytes: bytes.byteLength, at: now() };
        await wiring.store.put(workspaceId, file, bytes);
        let registered: ChatFile;
        try {
            registered = await chatAs(principal, workspaceId, chatId).registerUpload(file);
        } catch (e) {
            await wiring.store.remove(workspaceId, file.chatId, file.id).catch(() => undefined);
            if (isServerFnError(e)) return refuse(e.status, e.message);
            throw e;
        }
        sweepSoon(ctx);
        return json({ file: registered, uri: chatFileUri(registered.chatId, registered.id) }, 201);
    };

    const download = async (principal: Principal, workspaceId: WorkspaceId, chatId: string, fileId: string): Promise<Response> => {
        let file: ChatFile | null;
        try {
            file = await chatAs(principal, workspaceId, chatId).fileAccess(fileId);
        } catch (e) {
            if (isServerFnError(e) && (e.status === 403 || e.status === 404)) return refuse(404, 'not-found');
            throw e;
        }
        if (!file) return refuse(404, 'not-found');
        const object = await wiring.store.open(workspaceId, file.chatId, file.id);
        if (!object) return refuse(404, 'not-found');
        return new Response(object.body, {
            status: 200,
            headers: {
                'content-type': file.mediaType,
                'content-length': String(object.size),
                'content-disposition': dispositionOf(file),
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
                'cache-control': 'private, max-age=3600'
            }
        });
    };

    return (request, env, ctx) => {
        const { pathname } = new URL(request.url);
        if (!pathname.startsWith(FILES_ROUTE_PREFIX)) return undefined;
        const segments = pathname.slice(FILES_ROUTE_PREFIX.length).split('/');
        if (!segments.every((s) => SEGMENT.test(s)) || segments.length > 2) return undefined;
        const [chatId, fileId] = segments as [string, string | undefined];
        const method = fileId === undefined ? 'POST' : 'GET';
        return async (req) => {
            if (req.method !== method) return new Response(null, { status: 405, headers: { allow: method } });
            const secret = secretOf(env);
            const principal = secret ? await authenticateRequest(req, { sessionSecret: secret }) : null;
            if (!principal || principal.kind === 'machine') return refuse(401, 'unauthorized');
            const workspaceId = principal.workspaceId as WorkspaceId;
            return fileId === undefined ? upload(req, env, ctx, principal, workspaceId, chatId) : download(principal, workspaceId, chatId, fileId);
        };
    };
}
