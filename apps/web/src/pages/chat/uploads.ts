/**
 * The live composer's uploads (#207): a file the Composer hands over (`files`)
 * is shrunk when it is a photo (`prepareImage`), sent raw to
 * `POST /files/chats/:chatId` (`src/files/route.ts`), and tracked as a chip
 * until it is posted, removed or failed. Nothing here touches the DOM beyond
 * object URLs for thumbnails, so the rules are unit-testable and
 * `LiveChat.tsx` stays wiring.
 */
import { CHAT_FILE_MAX_BYTES, type ChatFile, type ChatFilePart } from '@agentic/core';
import type { Attachment } from '@agentic/ui';
import { attachmentPart } from './live';

/** One chip: what the Composer shows, plus the part it posts once uploaded. */
export interface Upload extends Attachment {
    /** Set once the upload is registered — what `send` posts. */
    readonly part?: ChatFilePart;
}

/** What the upload route answers with 201. */
export interface UploadResult {
    readonly file: ChatFile;
    readonly uri: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Why an upload failed, in the chip's words — the route's status first. */
export function uploadError(status: number, detail?: string): string {
    switch (status) {
        case 413:
            return `Too large — the limit is ${Math.round(CHAT_FILE_MAX_BYTES / (1024 * 1024))} MB`;
        case 415:
            return 'This file type cannot be attached';
        case 429:
            return 'Too many files waiting to be sent';
        case 501:
            return 'Attachments are not available on this deployment';
        case 401:
            return 'Sign in again to attach files';
        default:
            return detail || `Upload failed (${status})`;
    }
}

/** Upload one file into a chat; throws with the chip's error line. */
export async function uploadChatFile(chatId: string, file: Blob & { readonly name: string }, fetcher: FetchLike = fetch): Promise<UploadResult> {
    if (file.size > CHAT_FILE_MAX_BYTES) throw new Error(uploadError(413));
    let res: Response;
    try {
        res = await fetcher(`/files/chats/${encodeURIComponent(chatId)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
            body: file
        });
    } catch {
        throw new Error('Upload failed — check the connection');
    }
    if (res.status !== 201) {
        const detail = await res.json().then((b: { error?: unknown }) => (typeof b.error === 'string' ? b.error : undefined)).catch(() => undefined);
        throw new Error(uploadError(res.status, detail));
    }
    return (await res.json()) as UploadResult;
}

/** The chip of a finished upload: ready, carrying its part. */
export const uploaded = (chip: Upload, result: UploadResult): Upload => ({ ...chip, status: 'ready', size: result.file.bytes, part: attachmentPart(result.file, result.uri) });

/** The parts a send posts: the ready chips', in order; a chip still uploading or failed posts nothing. */
export const readyParts = (chips: readonly Upload[]): ChatFilePart[] => chips.flatMap((c) => (c.status === 'ready' && c.part ? [c.part] : []));

/** A thumbnail is worth making for a raster image only. */
export const previewable = (type: string): boolean => type.startsWith('image/') && type !== 'image/svg+xml';
