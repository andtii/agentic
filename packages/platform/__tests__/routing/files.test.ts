/**
 * Chat attachments on the router and the tool ports (#205, tracking #203;
 * CHT-04, CHT-10, MEM-11): `hydrateChatFiles` (images inlined within the
 * budget, the trigger's first then the newest, notes for the rest), the
 * router prompting a chat task with its images, and `createActorToolPorts`'
 * `files.read` / `chat.post` attachments — every read decided by
 * `Chat.fileAccess` as the agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatFileUri, CHAT_FILE_TEXT_MAX_BYTES, type AgentId, type ChatFile, type ChatId, type MessageId, type PromptPart, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { mintAgentPrincipal } from '../../src/auth/index';
import { Chat, ChatPage, defineChatActor } from '../../src/chat/index';
import { createActorToolPorts, defineRoutingActor, FILE_UNAVAILABLE, hydrateChatFiles, routingKey, type AgentPrincipal } from '../../src/routing/index';
import { defineSessionActor, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { memoryFileStore, type MemoryFileStore } from '../chat/helpers';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const CHAT = 'c1' as ChatId;
const ADA = 'agent_ada' as AgentId;
const BOB = 'agent_bob' as AgentId;

const uri = (fileId: string, chatId: string = CHAT) => chatFileUri(chatId as ChatId, fileId);
const record = (id: string, mediaType = 'image/png', bytes = 3, name = `${id}.png`): ChatFile => ({ id, chatId: CHAT, name, mediaType, bytes, at: 1 });
const image = (id: string, mediaType = 'image/png'): PromptPart => ({ type: 'image', mediaType, url: uri(id) });
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe('hydrateChatFiles', () => {
    /** Files `a`..`d`, 3 bytes each (4 base64 characters), all readable. */
    function fixture(files: ChatFile[] = ['a', 'b', 'c', 'd'].map((id) => record(id))) {
        const store = memoryFileStore();
        const byId = new Map(files.map((f) => [f.id, f]));
        for (const f of files) store.add(WS, f, new Uint8Array(f.bytes).fill(f.id.charCodeAt(0)));
        const access = async (_chat: ChatId, id: string) => byId.get(id) ?? null;
        return { store, access };
    }
    const inlined = (parts: PromptPart[]) => parts.flatMap((p) => (p.type === 'image' && p.data ? [String.fromCharCode(atob(p.data).charCodeAt(0))] : []));

    it('inlines images within the budget: the triggering message first, then the newest; the parts keep their order', async () => {
        const { store, access } = fixture();
        const parts: PromptPart[] = [{ type: 'text', text: 'objective' }, image('a'), image('b'), image('c'), image('d')];
        // Room for two images of 4 base64 characters: the trigger (`b`), then the newest (`d`).
        const out = await hydrateChatFiles(parts, { workspaceId: WS, access, store, first: [uri('b')], budget: 8 });
        expect(inlined(out)).toEqual(['b', 'd']);
        expect(out[0]).toEqual({ type: 'text', text: 'objective' });
        expect(out[2]).toEqual({ type: 'image', mediaType: 'image/png', data: b64(new Uint8Array(3).fill(98)) });
        expect(out[1]).toEqual({ type: 'text', text: `[image "a.png" (image/png, 1 KB) ${uri('a')} not inlined]` });
        expect(out[3]).toEqual({ type: 'text', text: `[image "c.png" (image/png, 1 KB) ${uri('c')} not inlined]` });
    });

    it('turns every other file into a note, and a missing or denied one into [file unavailable]', async () => {
        const { store, access } = fixture([record('doc', 'text/markdown', 3000, 'notes.md'), record('svg', 'image/svg+xml', 10, 'x.svg'), record('gone')]);
        store.bodies.clear();
        const parts: PromptPart[] = [{ type: 'file', mediaType: 'text/markdown', name: 'notes.md', url: uri('doc') }, image('svg', 'image/svg+xml'), image('denied'), image('gone')];
        const out = await hydrateChatFiles(parts, { workspaceId: WS, access, store });
        expect(out).toEqual([
            { type: 'text', text: `[file "notes.md" (text/markdown, 3 KB) ${uri('doc')} — read it with chat_file_read]` },
            { type: 'text', text: `[file "x.svg" (image/svg+xml, 1 KB) ${uri('svg')} — read it with chat_file_read]` },
            { type: 'text', text: FILE_UNAVAILABLE },
            { type: 'text', text: FILE_UNAVAILABLE }
        ]);
    });

    it('without a store every file is a note, and nothing is read', async () => {
        const { store, access } = fixture();
        const out = await hydrateChatFiles([image('a'), { type: 'text', text: 'x' }], { workspaceId: WS, access });
        expect(out).toEqual([{ type: 'text', text: `[image "a.png" (image/png, 1 KB) ${uri('a')} not inlined]` }, { type: 'text', text: 'x' }]);
        expect(store.gets).toBe(0);
    });

    it('leaves parts that reference no chat file alone', async () => {
        const parts: PromptPart[] = [{ type: 'text', text: 't' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'image', mediaType: 'image/png', url: 'https://example.com/x.png' }];
        await expect(hydrateChatFiles(parts, { workspaceId: WS, access: async () => null })).resolves.toEqual(parts);
    });
});

describe('the router and the tool ports over the actors', () => {
    let app: TestActorApp;
    let store: MemoryFileStore;
    let prompts: PromptPart[][];
    let Routing: ReturnType<typeof defineRoutingActor>;

    const factory = (): SessionFactory => {
        const agent = mockAgent({
            respond: (input) => {
                prompts.push([...input] as PromptPart[]);
                return [{ text: 'ok' }];
            }
        });
        return async (runtime, c) => {
            if (runtime !== 'anthropic-api') return null;
            const session = await agent.session({ policy: allowAll, signal: c.signal });
            return { session, agentId: agent.id, capabilities: agent.capabilities };
        };
    };

    beforeEach(async () => {
        store = memoryFileStore();
        prompts = [];
        const Session = defineSessionActor({ factory: factory() });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, files: store });
        app = testActorApp([Routing, Session, TaskActor, AgentActor, defineChatActor({ files: store }), ChatPage]);
        await app.start();
        for (const id of [ADA, BOB]) {
            await app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name: id, instructions: 'Be brief.', tools: [], approvalPolicy: [], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        }
    });

    afterEach(async () => {
        await app.stop();
    });

    const chat = () => app.as(owner).actor(Chat, `${WS}:chat:${CHAT}`);
    const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
    const until = async (check: () => Promise<boolean> | boolean, what: string): Promise<void> => {
        const deadline = Date.now() + 4_000;
        while (!(await check())) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 5));
        }
    };

    /** Upload `id` as the user (bytes in the store, the record in the chat). */
    async function upload(id: string, mediaType = 'image/png', bytes: Uint8Array | string = new Uint8Array([1, 2, 3]), name = `${id}.png`): Promise<void> {
        const size = typeof bytes === 'string' ? new TextEncoder().encode(bytes).length : bytes.length;
        const file: ChatFile = { id, chatId: CHAT, name, mediaType, bytes: size, at: 1 };
        store.add(WS, file, bytes);
        await chat().registerUpload(file);
    }

    async function runChatTask(taskId: string, assignee: AgentId, messageId: MessageId, context: PromptPart[] = []): Promise<PromptPart[]> {
        await task(taskId).create({ objective: 'what is in the picture?', origin: { kind: 'user', chatId: CHAT, messageId }, assignee, context, constraints: {} }, { owner: assignee });
        await app.as(owner).actor(Routing, routingKey(WS)).run(taskId as TaskId);
        await until(async () => (await task(taskId).get()).status === 'completed', `task ${taskId} to complete`);
        return prompts.at(-1)!;
    }

    it("prompts a chat task with its triggering message's image inlined, read as the task's agent", async () => {
        await chat().addAgent(ADA, 'from-now');
        await upload('pic');
        const { messageId } = await chat().post([{ type: 'text', text: 'what is in the picture?' }, image('pic')], [ADA]);
        const input = await runChatTask('t1', ADA, messageId);
        expect(input[0]).toEqual({ type: 'text', text: 'what is in the picture?' });
        expect(input[1]).toEqual({ type: 'image', mediaType: 'image/png', data: b64(new Uint8Array([1, 2, 3])) });
    });

    it('gives an agent a note for a file posted before its history starts, and a placeholder for a text file', async () => {
        await upload('old');
        await chat().post([image('old')]);
        await chat().addAgent(ADA, 'from-now');
        await upload('doc', 'text/plain', 'hello', 'doc.txt');
        const { messageId } = await chat().post([{ type: 'text', text: 'read this' }, { type: 'file', mediaType: 'text/plain', name: 'doc.txt', url: uri('doc') }], [ADA]);
        const input = await runChatTask('t1', ADA, messageId, [image('old')]);
        expect(input).toEqual([
            { type: 'text', text: 'what is in the picture?' },
            { type: 'text', text: `[file "doc.txt" (text/plain, 1 KB) ${uri('doc')} — read it with chat_file_read]` },
            { type: 'text', text: FILE_UNAVAILABLE }
        ]);
    });

    describe('createActorToolPorts', () => {
        const principal = (agentId: AgentId) => mintAgentPrincipal({ workspaceId: WS, agentId, sessionId: 'session_1' as SessionId, taskId: 't1' as TaskId }) as AgentPrincipal;
        const call = { callId: 'call_1', signal: new AbortController().signal };
        const ports = (agentId: AgentId = ADA) => createActorToolPorts({ principal: principal(agentId), chatId: CHAT, files: store });

        it('reads a text file as text, a binary file as its record, and refuses what the agent cannot see', async () => {
            await chat().addAgent(ADA, 'all');
            await upload('doc', 'text/markdown', '# hi ✓', 'doc.md');
            await upload('pic');
            await chat().post([{ type: 'file', mediaType: 'text/markdown', name: 'doc.md', url: uri('doc') }, image('pic')]);
            const files = ports().files!;
            await expect(files.read(uri('doc'), call)).resolves.toEqual({ file: { id: 'doc', chatId: CHAT, name: 'doc.md', mediaType: 'text/markdown', bytes: 8, at: 1 }, text: '# hi ✓' });
            const gets = store.gets;
            await expect(files.read(uri('pic'), call)).resolves.toEqual({ file: { id: 'pic', chatId: CHAT, name: 'pic.png', mediaType: 'image/png', bytes: 3, at: 1 } });
            expect(store.gets).toBe(gets);
            // Not a member: denied, like a file that does not exist.
            await expect(ports(BOB).files!.read(uri('doc'), call)).rejects.toMatchObject({ name: 'ToolCallError', code: 'forbidden' });
            await expect(files.read(uri('nope'), call)).rejects.toMatchObject({ code: 'forbidden' });
            await expect(files.read('https://example.com/x', call)).rejects.toMatchObject({ code: 'invalid' });
        });

        it('cuts a long text file at CHAT_FILE_TEXT_MAX_BYTES and says so', async () => {
            await chat().addAgent(ADA, 'all');
            await upload('big', 'text/plain', 'é'.repeat(CHAT_FILE_TEXT_MAX_BYTES), 'big.txt');
            await chat().post([{ type: 'file', mediaType: 'text/plain', name: 'big.txt', url: uri('big') }]);
            const read = await ports().files!.read(uri('big'), call);
            expect(read.truncated).toBe(true);
            expect(read.text).toBe('é'.repeat(CHAT_FILE_TEXT_MAX_BYTES / 2));
        });

        it('has no files port without a store', () => {
            expect(createActorToolPorts({ principal: principal(ADA), chatId: CHAT }).files).toBeUndefined();
        });

        it('chat_post attachments re-share a file the agent can see, typed by the chat, and refuse one it cannot', async () => {
            await upload('before');
            await chat().post([image('before')]);
            await chat().addAgent(ADA, 'all');
            await chat().addAgent(BOB, 'from-now');
            const { messageId } = await ports(ADA).chat.post({ text: 'see this', mentions: [], attachments: [uri('before')] }, call);
            const last = (await chat().history()).entries.at(-1)!.entry;
            expect(last).toMatchObject({ t: 'msg', id: messageId, parts: [{ type: 'text', text: 'see this' }, image('before')] });
            // BOB could not see the original — the re-share is a message it can see.
            await expect(ports(BOB).files!.read(uri('before'), call)).resolves.toMatchObject({ file: { id: 'before' } });
            await expect(ports(ADA).chat.post({ text: '', mentions: [], attachments: [uri('missing')] }, call)).rejects.toMatchObject({ code: 'forbidden' });
        });
    });
});
