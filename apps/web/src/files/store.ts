/**
 * `r2ChatFileStore` — the `ChatFileStore` (#203, `@agentic/core`) on R2 (#207).
 *
 * One object per chat file, in the `ARTIFACTS` bucket under
 * `files/<ws>/<chat>/<fileId>`, with custom metadata `name`, `mediaType`,
 * `posted` (`'1'` once `Chat.post` referenced it) and `at` (upload time, ms).
 * The store decides nothing about access — the upload route asks
 * `Chat.fileAccess` first (`docs/architecture.md` §6).
 *
 * R2 cannot update metadata in place, so `markPosted` rewrites the object
 * with `posted: '1'` (≤ `CHAT_FILE_MAX_BYTES`, read whole). `sweepOrphans`
 * walks the `files/` prefix one listing page per call, resuming where the
 * last call stopped, so an opportunistic sweep is bounded.
 */
import type { ChatFile, ChatFileBody, ChatFileStore, ChatId, WorkspaceId } from '@agentic/core';
import type { R2BucketLike, R2ObjectLike } from '../retention';

export const FILES_PREFIX = 'files/';

/** The object key of a chat file. */
export const chatFileKey = (workspaceId: string, chatId: string, fileId: string): string => `${FILES_PREFIX}${workspaceId}/${chatId}/${fileId}`;

/** The R2 key prefix of every file of one chat. */
const chatPrefix = (workspaceId: string, chatId: string): string => `${FILES_PREFIX}${workspaceId}/${chatId}/`;

/** A chat file's object as the download route streams it. */
export interface ChatFileObject {
    readonly body: ReadableStream<Uint8Array>;
    readonly size: number;
}

/** The R2 store: the core port plus what the web routes need beside it. */
export interface R2ChatFileStore extends ChatFileStore {
    /** Stream a file's bytes (the download route); `null` when the object is gone. */
    open(workspaceId: WorkspaceId, chatId: ChatId, fileId: string): Promise<ChatFileObject | null>;
    /** Delete one file — the upload route's undo when `Chat.registerUpload` refuses it. */
    remove(workspaceId: WorkspaceId, chatId: ChatId, fileId: string): Promise<void>;
}

export interface R2ChatFileStoreOptions {
    /** Objects one `sweepOrphans` call examines (one listing page). Default 500. */
    readonly sweepPage?: number;
    readonly now?: () => number;
}

const metadataOf = (file: ChatFile, posted: boolean): Record<string, string> => ({
    name: file.name,
    mediaType: file.mediaType,
    posted: posted ? '1' : '0',
    at: String(file.at)
});

function recordOf(object: R2ObjectLike, chatId: ChatId, fileId: string): ChatFile {
    const m = object.customMetadata ?? {};
    const at = Number(m.at);
    return {
        id: fileId,
        chatId,
        name: m.name ?? fileId,
        mediaType: m.mediaType ?? object.httpMetadata?.contentType ?? 'application/octet-stream',
        bytes: object.size,
        at: Number.isFinite(at) ? at : (object.uploaded?.getTime() ?? 0)
    };
}

export function r2ChatFileStore(bucket: () => R2BucketLike | undefined, options: R2ChatFileStoreOptions = {}): R2ChatFileStore {
    const now = options.now ?? Date.now;
    const page = options.sweepPage ?? 500;
    const need = (): R2BucketLike => {
        const b = bucket();
        if (!b) throw new Error('[files] no ARTIFACTS bucket bound: chat files cannot be stored');
        return b;
    };
    /** Where the next sweep resumes; `undefined` starts from the top of `files/`. */
    let sweepCursor: string | undefined;

    return {
        async put(workspaceId, file, body) {
            await need().put(chatFileKey(workspaceId, file.chatId, file.id), body, {
                httpMetadata: { contentType: file.mediaType },
                customMetadata: metadataOf(file, false)
            });
        },

        async get(workspaceId, chatId, fileId): Promise<ChatFileBody | null> {
            const object = await need().get(chatFileKey(workspaceId, chatId, fileId));
            if (!object) return null;
            return { file: recordOf(object, chatId, fileId), bytes: new Uint8Array(await object.arrayBuffer()) };
        },

        async open(workspaceId, chatId, fileId) {
            const object = await need().get(chatFileKey(workspaceId, chatId, fileId));
            return object ? { body: object.body, size: object.size } : null;
        },

        async markPosted(workspaceId, chatId, fileId) {
            const b = need();
            const key = chatFileKey(workspaceId, chatId, fileId);
            const head = await b.head(key);
            if (!head) throw new Error(`[files] ${key} is gone: it cannot be posted`);
            if (head.customMetadata?.posted === '1') return;
            const object = await b.get(key);
            if (!object) throw new Error(`[files] ${key} is gone: it cannot be posted`);
            const file = recordOf(object, chatId, fileId);
            await b.put(key, await object.arrayBuffer(), { httpMetadata: { contentType: file.mediaType }, customMetadata: metadataOf(file, true) });
        },

        async remove(workspaceId, chatId, fileId) {
            await need().delete(chatFileKey(workspaceId, chatId, fileId));
        },

        async deleteChat(workspaceId, chatId) {
            const b = need();
            const prefix = chatPrefix(workspaceId, chatId);
            let cursor: string | undefined;
            do {
                const listed = await b.list({ prefix, ...(cursor ? { cursor } : {}) });
                const keys = listed.objects.map((o) => o.key);
                if (keys.length) await b.delete(keys);
                cursor = listed.truncated ? listed.cursor : undefined;
            } while (cursor);
        },

        async sweepOrphans(olderThanMs) {
            const b = need();
            const listed = await b.list({ prefix: FILES_PREFIX, limit: page, include: ['customMetadata'], ...(sweepCursor ? { cursor: sweepCursor } : {}) });
            sweepCursor = listed.truncated ? listed.cursor : undefined;
            const cutoff = now() - olderThanMs;
            const orphans = listed.objects.filter((o) => {
                if (o.customMetadata?.posted === '1') return false;
                const at = Number(o.customMetadata?.at);
                const when = Number.isFinite(at) ? at : (o.uploaded?.getTime() ?? Number.POSITIVE_INFINITY);
                return when < cutoff;
            });
            if (orphans.length) await b.delete(orphans.map((o) => o.key));
            return orphans.length;
        }
    };
}
