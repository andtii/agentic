/** `chat_file_read` — read a file attached to the task's chat (#203, CHT-10). */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import { CHAT_FILE_TEXT_MAX_BYTES, parseChatFileUri, type ChatFile } from '@agentic/core';
import type { ChatFilesPort } from './ports.js';

/** An `agentic-file:<chatId>/<fileId>` URI; anything else is refused before a port is called. */
export const chatFileUriInput = z.string().refine((uri) => parseChatFileUri(uri) !== null, { message: 'expected an agentic-file:<chatId>/<fileId> URI' });

export const chatFileReadInput = z.object({
    uri: chatFileUriInput.describe('The agentic-file: URI of the file, as shown in the chat transcript.')
});

/** What the model gets back: the file's metadata, and its text for a text file or a note otherwise. */
export interface ChatFileReadResult {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly text?: string;
    readonly truncated?: boolean;
    readonly note?: string;
}

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

function binaryNote(file: ChatFile): string {
    const note = `binary file ${file.name} (${file.mediaType}, ${kb(file.bytes)}): content not readable by this tool`;
    return file.mediaType.toLowerCase().startsWith('image/') ? `${note}. Images posted in the chat are attached to your turn when they fit.` : note;
}

export function chatFileReadTool(port: ChatFilesPort | undefined) {
    return defineTool({
        name: 'chat_file_read',
        description: 'Read a file attached to this chat by its agentic-file: URI. Returns the text of a text file (cut at 256 KB); for any other file only its name, type and size.',
        input: chatFileReadInput,
        annotations: { readOnly: true, idempotent: true },
        execute: async (input, ctx): Promise<ChatFileReadResult> => {
            if (!port) throw new Error('chat_file_read: reading chat files is not available on this host');
            const { file, text, truncated } = await port.read(input.uri, { callId: ctx.toolCallId, signal: ctx.signal });
            const meta = { name: file.name, mediaType: file.mediaType, bytes: file.bytes };
            if (text === undefined) return { ...meta, note: binaryNote(file) };
            if (!truncated) return { ...meta, text };
            return { ...meta, text, truncated: true, note: `truncated: this is the first ${kb(CHAT_FILE_TEXT_MAX_BYTES)} of ${kb(file.bytes)}` };
        }
    });
}
