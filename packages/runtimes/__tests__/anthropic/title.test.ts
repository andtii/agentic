/** `generateChatTitle`: one haiku call over the first messages, the answer cleaned into a list title (#460). */
import { mockModel } from '@sigx/ai/testing';
import { cleanTitle, generateChatTitle, titlePrompt, TITLE_MAX_LENGTH, TITLE_MESSAGE_CHARS, TITLE_SYSTEM_PROMPT } from '../../src/index';

const messages = [
    { role: 'user' as const, text: 'the chats list is hard to scan, can we auto-title chats like claude code does?' },
    { role: 'agent' as const, name: 'Atlas', text: 'Yes — Claude Code writes an ai-title row; we can read it.' }
];

describe('generateChatTitle', () => {
    it('asks once, without tools, with the transcript labelled by speaker, and returns the cleaned answer', async () => {
        const model = mockModel({ modelId: 'claude-haiku-4-5', script: [{ text: '"Auto-generated chat titles."\n' }] });
        expect(await generateChatTitle(model, { messages })).toBe('Auto-generated chat titles');
        expect(model.requests).toHaveLength(1);
        const request = model.requests[0]!;
        expect(request.system).toBe(TITLE_SYSTEM_PROMPT);
        expect(request.tools ?? []).toHaveLength(0);
        expect(request.maxTokens).toBe(40);
        expect(request.messages).toEqual([{ role: 'user', content: titlePrompt({ messages }) }]);
        expect(titlePrompt({ messages })).toContain('User: the chats list is hard to scan');
        expect(titlePrompt({ messages })).toContain('Atlas: Yes — Claude Code writes an ai-title row');
    });

    it('is undefined with nothing to title, or an answer that is only noise', async () => {
        const model = mockModel({ script: [{ text: '""' }] });
        expect(await generateChatTitle(model, { messages: [{ role: 'user', text: '   ' }] })).toBeUndefined();
        expect(model.requests).toHaveLength(0);
        expect(await generateChatTitle(model, { messages })).toBeUndefined();
    });

    it('cuts long messages in the prompt, never the whole transcript', () => {
        const long = 'x'.repeat(TITLE_MESSAGE_CHARS * 3);
        const prompt = titlePrompt({ messages: [{ role: 'user', text: long }, { role: 'agent', text: 'short' }] });
        expect(prompt.length).toBeLessThan(TITLE_MESSAGE_CHARS + 100);
        expect(prompt).toContain('Agent: short');
    });

    it('lets a provider error propagate: the caller decides', async () => {
        const model = mockModel({ script: [{ error: 'overloaded' }] });
        await expect(generateChatTitle(model, { messages })).rejects.toThrow(/overloaded/);
    });
});

describe('cleanTitle', () => {
    it('strips quotes, a label, a trailing period and extra whitespace, and keeps the first line', () => {
        expect(cleanTitle('Title: “Root  folder check”.')).toBe('Root folder check');
        expect(cleanTitle("Title:\n'Agent members design'\nA second line")).toBe('Agent members design');
        expect(cleanTitle('**Bold title**')).toBe('Bold title');
    });

    it('caps the length with an ellipsis', () => {
        const title = cleanTitle('word '.repeat(30))!;
        expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
        expect(title.endsWith('…')).toBe(true);
    });

    it('is undefined for nothing', () => {
        expect(cleanTitle('')).toBeUndefined();
        expect(cleanTitle('""')).toBeUndefined();
        expect(cleanTitle('Title:')).toBeUndefined();
    });
});
