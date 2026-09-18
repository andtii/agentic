/** `chat_file_read` and `chat_post` attachments over fake ports (#206). */
import { SchemaValidationError, type ToolContext } from '@sigx/ai';
import { CHAT_FILE_TEXT_MAX_BYTES, type ChatFile, type ChatFileRead, type ChatId } from '@agentic/core';
import { bridgedPlatformTools } from '../../src/claude-code/index';
import { platformTools, type ChatFilesPort, type PlatformPorts, type ToolCall } from '../../src/index';
import { fakePorts } from '../anthropic/helpers';

const ctx = (id = 'call_1'): ToolContext => ({ toolCallId: id, signal: new AbortController().signal });
const URI = 'agentic-file:chat_1/f_1';

const file = (over: Partial<ChatFile> = {}): ChatFile => ({ id: 'f_1', chatId: 'chat_1' as ChatId, name: 'notes.md', mediaType: 'text/markdown', bytes: 2048, at: 1, ...over });

function withFiles(answer: (uri: string) => ChatFileRead) {
    const reads: { uri: string; call: ToolCall }[] = [];
    const files: ChatFilesPort = {
        async read(uri, call) {
            reads.push({ uri, call });
            return answer(uri);
        }
    };
    const ports: PlatformPorts = { ...fakePorts(), files };
    return { reads, tool: platformTools(ports).find((t) => t.name === 'chat_file_read')! };
}

describe('chat_file_read', () => {
    it('returns the text of a text file, with the call id', async () => {
        const { reads, tool } = withFiles(() => ({ file: file(), text: '# Notes\n' }));
        const out = await tool.run({ uri: URI }, ctx('c9'));
        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({ uri: URI, call: { callId: 'c9' } });
        expect(out).toEqual({ name: 'notes.md', mediaType: 'text/markdown', bytes: 2048, text: '# Notes\n' });
        expect(tool.annotations).toEqual({ readOnly: true, idempotent: true });
    });

    it('flags a truncated file and says how much was returned', async () => {
        const { tool } = withFiles(() => ({ file: file({ bytes: 1024 * 1024 }), text: 'x'.repeat(10), truncated: true }));
        const out = (await tool.run({ uri: URI }, ctx())) as { truncated?: boolean; note?: string; text?: string };
        expect(out.truncated).toBe(true);
        expect(out.text).toBe('x'.repeat(10));
        expect(out.note).toBe(`truncated: this is the first ${CHAT_FILE_TEXT_MAX_BYTES / 1024} KB of 1024 KB`);
    });

    it('describes a binary file instead of returning its content', async () => {
        const { tool } = withFiles(() => ({ file: file({ name: 'report.pdf', mediaType: 'application/pdf', bytes: 5 * 1024 }) }));
        const out = (await tool.run({ uri: URI }, ctx())) as { text?: string; note?: string };
        expect(out.text).toBeUndefined();
        expect(out.note).toBe('binary file report.pdf (application/pdf, 5 KB): content not readable by this tool');
    });

    it('says an image is attached to the turn when it fits', async () => {
        const { tool } = withFiles(() => ({ file: file({ name: 'shot.png', mediaType: 'image/png', bytes: 300 }) }));
        const out = (await tool.run({ uri: URI }, ctx())) as { note?: string };
        expect(out.note).toBe('binary file shot.png (image/png, 1 KB): content not readable by this tool. Images posted in the chat are attached to your turn when they fit.');
    });

    it('fails the call when the port refuses (denied, missing)', async () => {
        const { tool } = withFiles(() => {
            throw new Error('forbidden: the file is in a message this agent may not see');
        });
        await expect(tool.run({ uri: URI }, ctx())).rejects.toThrow(/forbidden/);
    });

    it('fails clearly on a host without a files port', async () => {
        const tool = platformTools(fakePorts()).find((t) => t.name === 'chat_file_read')!;
        await expect(tool.run({ uri: URI }, ctx())).rejects.toThrow(/not available on this host/);
    });

    it('refuses anything but an agentic-file: URI before the port is called', async () => {
        const { reads, tool } = withFiles(() => ({ file: file(), text: '' }));
        for (const uri of ['https://example.com/a.txt', 'agentic-file:chat_1', 'agentic-file:chat_1/f_1/x', '']) {
            await expect(tool.run({ uri }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        }
        expect(reads).toEqual([]);
    });

    it('is bridged to Claude Code with the same definition', () => {
        const { tools, unknown } = bridgedPlatformTools(['chat_file_read'], async () => null);
        expect(unknown).toEqual([]);
        expect(tools.map((t) => t.name)).toEqual(['chat_file_read']);
        expect(tools[0]!.spec).toEqual(platformTools(fakePorts()).find((t) => t.name === 'chat_file_read')!.spec);
    });
});

describe('chat_post attachments', () => {
    const chatPost = (ports = fakePorts()) => ({ ports, tool: platformTools(ports).find((t) => t.name === 'chat_post')! });

    it('passes attachments through to the chat port', async () => {
        const { ports, tool } = chatPost();
        await tool.run({ text: 'Here it is.', attachments: [URI, 'agentic-file:chat_1/f_2'] }, ctx());
        expect(ports.calls[0]).toMatchObject({ port: 'chat', op: 'post', args: { text: 'Here it is.', mentions: [], attachments: [URI, 'agentic-file:chat_1/f_2'] } });
    });

    it('leaves attachments off when none are given', async () => {
        const { ports, tool } = chatPost();
        await tool.run({ text: 'Plain.', attachments: [] }, ctx());
        expect(ports.calls[0]!.args).toEqual({ text: 'Plain.', mentions: [] });
    });

    it('refuses an attachment that is not an agentic-file: URI', async () => {
        const { ports, tool } = chatPost();
        await expect(tool.run({ text: 'x', attachments: ['https://example.com/a.png'] }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        expect(ports.calls).toEqual([]);
    });
});
