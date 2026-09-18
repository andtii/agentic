/**
 * Chat attachments (#203): a file uploaded into a chat is stored once and
 * referenced from messages by an `agentic-file:<chatId>/<fileId>` URI in the
 * `url` of an `image` or `file` part — a message never carries the bytes.
 * Who may read a file is who may see the message it was posted in (CHT-04);
 * the Chat actor decides, the store only holds bytes.
 */

import type { PromptPart } from './chat.js';
import type { ChatId, WorkspaceId } from './ids.js';

/** A file attached to a chat. `id` is unique within the chat. */
export interface ChatFile {
    readonly id: string;
    readonly chatId: ChatId;
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly at: number;
}

export const CHAT_FILE_SCHEME = 'agentic-file:';
/** The largest upload the platform accepts. */
export const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** The most text `chat_file_read` returns; longer files are cut and flagged `truncated`. */
export const CHAT_FILE_TEXT_MAX_BYTES = 256 * 1024;
/** Base64 characters of images inlined into one turn — keeps a `prompt` command under the 1 MiB daemon frame. */
export const CHAT_FILE_INLINE_BUDGET = 700 * 1024;
/** Image types a model accepts as an image block; anything else reaches the model as a placeholder. */
export const MODEL_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const SEGMENT = /^[A-Za-z0-9_-]+$/;

export function chatFileUri(chatId: ChatId, fileId: string): string {
    return `${CHAT_FILE_SCHEME}${chatId}/${fileId}`;
}

/** `null` for anything that is not exactly `agentic-file:<chatId>/<fileId>` with url-safe segments. */
export function parseChatFileUri(uri: unknown): { readonly chatId: ChatId; readonly fileId: string } | null {
    if (typeof uri !== 'string' || !uri.startsWith(CHAT_FILE_SCHEME)) return null;
    const [chatId, fileId, ...rest] = uri.slice(CHAT_FILE_SCHEME.length).split('/');
    if (rest.length > 0 || !chatId || !fileId || !SEGMENT.test(chatId) || !SEGMENT.test(fileId)) return null;
    return { chatId: chatId as ChatId, fileId };
}

export type ChatFilePart = Extract<PromptPart, { type: 'image' | 'file' }> & { readonly url: string };

/** An `image` or `file` part that references a chat file (rather than carrying `data` or an external url). */
export function isChatFilePart(part: PromptPart): part is ChatFilePart {
    return (part.type === 'image' || part.type === 'file') && parseChatFileUri(part.url) !== null;
}

/** Media types `chat_file_read` returns as text. */
export function isTextLikeMediaType(mediaType: string): boolean {
    const mt = mediaType.split(';')[0]!.trim().toLowerCase();
    if (mt.startsWith('text/')) return true;
    if (mt.endsWith('+json') || mt.endsWith('+xml')) return true;
    return ['application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/javascript', 'application/typescript', 'application/x-sh', 'application/sql', 'application/toml'].includes(mt);
}

/** What the platform reads back for a file: its record and bytes. */
export interface ChatFileBody {
    readonly file: ChatFile;
    readonly bytes: Uint8Array;
}

/**
 * Where attachment bytes live (R2 in the web app). No access decisions here —
 * callers ask `Chat.fileAccess` first.
 */
export interface ChatFileStore {
    put(workspaceId: WorkspaceId, file: ChatFile, body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<void>;
    get(workspaceId: WorkspaceId, chatId: ChatId, fileId: string): Promise<ChatFileBody | null>;
    /** The file went into a message, so `sweepOrphans` keeps it. */
    markPosted(workspaceId: WorkspaceId, chatId: ChatId, fileId: string): Promise<void>;
    /** Every file of the chat — the chat's purge cascade. */
    deleteChat(workspaceId: WorkspaceId, chatId: ChatId): Promise<void>;
    /** Delete uploads never posted into a message and older than `olderThanMs`; returns how many went. */
    sweepOrphans(olderThanMs: number): Promise<number>;
}

/** What an agent's `chat_file_read` gets back: text for text-like files, metadata only otherwise. */
export interface ChatFileRead {
    readonly file: ChatFile;
    readonly text?: string;
    readonly truncated?: boolean;
}
