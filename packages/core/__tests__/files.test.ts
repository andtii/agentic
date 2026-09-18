import { CHAT_FILE_INLINE_BUDGET, chatFileUri, isChatFilePart, isTextLikeMediaType, MODEL_IMAGE_TYPES, parseChatFileUri } from '../src/index';
import type { ChatId } from '../src/index';

const chat = 'chat_1' as ChatId;

describe('chat file URIs', () => {
    it('round-trips', () => {
        const uri = chatFileUri(chat, 'file_Ab3');
        expect(uri).toBe('agentic-file:chat_1/file_Ab3');
        expect(parseChatFileUri(uri)).toEqual({ chatId: chat, fileId: 'file_Ab3' });
    });
    it('rejects anything else', () => {
        for (const bad of [undefined, 42, '', 'agentic-file:', 'agentic-file:chat_1', 'agentic-file:chat_1/', 'agentic-file:/f', 'agentic-file:chat_1/f/x', 'agentic-file:chat_1/../f', 'agentic-file:chat 1/f', 'https://x/chat_1/f', 'AGENTIC-FILE:chat_1/f']) {
            expect(parseChatFileUri(bad)).toBeNull();
        }
    });
    it('recognises parts that reference a chat file', () => {
        const url = chatFileUri(chat, 'f1');
        expect(isChatFilePart({ type: 'image', mediaType: 'image/png', url })).toBe(true);
        expect(isChatFilePart({ type: 'file', mediaType: 'text/csv', name: 'a.csv', url })).toBe(true);
        expect(isChatFilePart({ type: 'image', mediaType: 'image/png', data: 'AAAA' })).toBe(false);
        expect(isChatFilePart({ type: 'image', mediaType: 'image/png', url: 'https://example.com/a.png' })).toBe(false);
        expect(isChatFilePart({ type: 'text', text: url })).toBe(false);
        expect(isChatFilePart({ type: 'resource', uri: url })).toBe(false);
    });
});

describe('media types', () => {
    it('text-like types are readable as text', () => {
        for (const mt of ['text/plain', 'text/csv; charset=utf-8', 'TEXT/Markdown', 'application/json', 'application/ld+json', 'image/svg+xml', 'application/x-yaml', 'application/typescript']) {
            expect(isTextLikeMediaType(mt)).toBe(true);
        }
        for (const mt of ['image/png', 'application/pdf', 'application/octet-stream', 'application/zip', '']) {
            expect(isTextLikeMediaType(mt)).toBe(false);
        }
    });
    it('model image types and the inline budget fit a daemon frame', () => {
        expect(MODEL_IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
        expect(CHAT_FILE_INLINE_BUDGET).toBeLessThan(1024 * 1024);
    });
});
