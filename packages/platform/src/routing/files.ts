/**
 * Chat attachments on the way to the model (#203, #205; CHT-04, MEM-11).
 *
 * A chat message carries `agentic-file:` references, never bytes. Before a
 * turn starts, `hydrateChatFiles` turns every reference in the prompt into
 * something the model can use: an image of a `MODEL_IMAGE_TYPES` type goes
 * in as an image block (base64) while `CHAT_FILE_INLINE_BUDGET` lasts —
 * the triggering message's images first, then the newest — and everything
 * else becomes a one-line note naming the file and how to read it. Access is
 * always decided by the Chat actor (`fileAccess`, asked as the agent the
 * turn runs for); the store only holds bytes. A file the agent may not see,
 * or whose bytes are gone, is `[file unavailable]`.
 */

import { CHAT_FILE_INLINE_BUDGET, CHAT_FILE_TEXT_MAX_BYTES, MODEL_IMAGE_TYPES, isChatFilePart, isTextLikeMediaType, parseChatFileUri, type ChatFile, type ChatFileRead, type ChatFileStore, type ChatId, type PromptPart, type WorkspaceId } from '@agentic/core';

/** The chat's word on a file for the agent: its record, or `null` when missing or not visible. */
export type FileAccess = (chatId: ChatId, fileId: string) => Promise<ChatFile | null>;

export const FILE_UNAVAILABLE = '[file unavailable]';

const kb = (bytes: number): number => Math.max(1, Math.ceil(bytes / 1024));

/** The note a file that is not inlined becomes. */
export function fileNote(file: ChatFile, uri: string, image = false): string {
    const what = `"${file.name}" (${file.mediaType}, ${kb(file.bytes)} KB) ${uri}`;
    return image ? `[image ${what} not inlined]` : `[file ${what} — read it with chat_file_read]`;
}

/** Base64 of `bytes` without `node:` APIs (edge-safe), in chunks so a large image does not blow the argument limit. */
export function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

/** Base64 length of `n` bytes. */
const base64Length = (n: number): number => 4 * Math.ceil(n / 3);

export interface HydrateOptions {
    readonly workspaceId: WorkspaceId;
    readonly access: FileAccess;
    /** Absent: every file becomes a note. */
    readonly store?: ChatFileStore;
    /** `agentic-file:` URIs of the triggering message — inlined before any other. */
    readonly first?: readonly string[];
    /** Base64 characters of images to inline. Default `CHAT_FILE_INLINE_BUDGET`. */
    readonly budget?: number;
}

/**
 * Resolve the chat-file parts of `parts` (other parts pass through as they
 * are). Images are considered in order — the `first` URIs, then the rest
 * newest (last) first — and inlined until the budget is spent; the order of
 * the parts themselves never changes.
 */
export async function hydrateChatFiles(parts: readonly PromptPart[], options: HydrateOptions): Promise<PromptPart[]> {
    const out: PromptPart[] = [...parts];
    const indices = parts.flatMap((p, i) => (isChatFilePart(p) ? [i] : []));
    if (indices.length === 0) return out;
    const first = options.first ?? [];
    const url = (i: number): string => (parts[i] as { url: string }).url;
    const rank = (i: number): number => {
        const f = first.indexOf(url(i));
        return f >= 0 ? f : first.length + (parts.length - i);
    };
    const order = [...indices].sort((a, b) => rank(a) - rank(b));

    const records = new Map<string, Promise<ChatFile | null>>();
    const recordOf = (uri: string): Promise<ChatFile | null> => {
        let r = records.get(uri);
        if (!r) {
            const ref = parseChatFileUri(uri)!;
            r = options.access(ref.chatId, ref.fileId).catch(() => null);
            records.set(uri, r);
        }
        return r;
    };

    let budget = options.budget ?? CHAT_FILE_INLINE_BUDGET;
    for (const i of order) {
        const uri = url(i);
        const file = await recordOf(uri);
        if (!file) {
            out[i] = { type: 'text', text: FILE_UNAVAILABLE };
            continue;
        }
        const image = MODEL_IMAGE_TYPES.includes(file.mediaType);
        if (!image) {
            out[i] = { type: 'text', text: fileNote(file, uri) };
            continue;
        }
        if (!options.store || base64Length(file.bytes) > budget) {
            out[i] = { type: 'text', text: fileNote(file, uri, true) };
            continue;
        }
        const body = await options.store.get(options.workspaceId, file.chatId, file.id).catch(() => null);
        if (!body) {
            out[i] = { type: 'text', text: FILE_UNAVAILABLE };
            continue;
        }
        const data = toBase64(body.bytes);
        if (data.length > budget) {
            out[i] = { type: 'text', text: fileNote(file, uri, true) };
            continue;
        }
        budget -= data.length;
        out[i] = { type: 'image', mediaType: file.mediaType, data };
    }
    return out;
}

/** The first `max` bytes of UTF-8 text as a string, cut on a character boundary. */
export function utf8Prefix(bytes: Uint8Array, max: number): { readonly text: string; readonly truncated: boolean } {
    if (bytes.length <= max) return { text: new TextDecoder().decode(bytes), truncated: false };
    let end = max;
    // Back off continuation bytes (10xxxxxx) so a multi-byte character is never split.
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** What `chat_file_read` returns for a file the agent may see: text (cut at `CHAT_FILE_TEXT_MAX_BYTES`) for a text-like file, the record alone otherwise. `null` when the bytes are gone. */
export async function readChatFile(file: ChatFile, workspaceId: WorkspaceId, store: ChatFileStore): Promise<ChatFileRead | null> {
    if (!isTextLikeMediaType(file.mediaType)) return { file };
    const body = await store.get(workspaceId, file.chatId, file.id);
    if (!body) return null;
    const { text, truncated } = utf8Prefix(body.bytes, CHAT_FILE_TEXT_MAX_BYTES);
    return { file, text, ...(truncated ? { truncated: true } : {}) };
}
