/**
 * Chat attachments on the Chat actor (#205, tracking #203; CHT-04, CHT-10,
 * MEM-11): the upload registry, `post` validation of file parts, `fileAccess`
 * by history visibility, the file index surviving archiving, and the
 * session-event fold never making a file readable.
 */
import { chatFileUri, type ChatId, type MachineId, type Principal, type PromptPart, type SessionId } from '@agentic/core';
import { Chat, ChatPage, MAX_PENDING_UPLOADS, PAGE, PENDING_TTL_MS, WINDOW, pageKey, sessionEvents } from '../../src/chat/index.js';
import { memoryStorage, statusOf, type TestActorApp } from '../../src/testing/index.js';
import { A, B, WS, agent, chatFile, chatKey, countingStorage, memoryFileStore, startChatApp, user, type MemoryFileStore } from './helpers.js';

let app: TestActorApp;
let store: MemoryFileStore;

beforeEach(async () => {
    store = memoryFileStore();
    app = await startChatApp(undefined, store);
});

afterEach(async () => {
    await app.stop();
});

const chatAs = (principal: Principal | null, id = 'c1') => app.as(principal).actor(Chat, chatKey(id));
const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'client_1', scopes: ['chats'] };
const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
const uri = (fileId: string, chatId = 'c1') => chatFileUri(chatId as ChatId, fileId);
const image = (fileId: string, mediaType = 'image/png', chatId = 'c1'): PromptPart => ({ type: 'image', mediaType, url: uri(fileId, chatId) });
const withFile = (fileId: string, mediaType?: string): PromptPart[] => [{ type: 'text', text: 'look' }, image(fileId, mediaType)];

describe('registerUpload', () => {
    it('records a pending upload the uploader alone can see, and is idempotent', async () => {
        const file = chatFile('f1');
        await expect(chatAs(user).registerUpload(file)).resolves.toEqual(file);
        await expect(chatAs(user).registerUpload(file)).resolves.toEqual(file);
        expect(await chatAs(user).fileAccess('f1')).toEqual(file);
        expect(await chatAs(external).fileAccess('f1')).toBeNull();
        await chatAs(user).addAgent(A, 'all');
        expect(await chatAs(agent(A)).fileAccess('f1')).toBeNull();
        // Another principal cannot claim the same id.
        expect(await statusOf(chatAs(external).registerUpload(file))).toBe(409);
    });

    it('is for users and external clients only — never agents or machines', async () => {
        await chatAs(user).addAgent(A, 'all');
        expect(await statusOf(chatAs(agent(A)).registerUpload(chatFile('f1')))).toBe(403);
        expect(await statusOf(chatAs(machine).registerUpload(chatFile('f1')))).toBe(403);
        await expect(chatAs(external).registerUpload(chatFile('f1'))).resolves.toMatchObject({ id: 'f1' });
    });

    it('rejects a file of another chat, a bad id and an oversize file', async () => {
        expect(await statusOf(chatAs(user).registerUpload(chatFile('f1', {}, 'c2')))).toBe(400);
        expect(await statusOf(chatAs(user).registerUpload(chatFile('bad/id')))).toBe(400);
        expect(await statusOf(chatAs(user).registerUpload(chatFile('f1', { name: ' ' })))).toBe(400);
        expect(await statusOf(chatAs(user).registerUpload(chatFile('f1', { bytes: 11 * 1024 * 1024 })))).toBe(413);
    });

    it(`caps an uploader at ${MAX_PENDING_UPLOADS} pending files, and forgets pending uploads after PENDING_TTL_MS`, async () => {
        for (let i = 0; i < MAX_PENDING_UPLOADS; i++) await chatAs(user).registerUpload(chatFile(`f${i}`));
        expect(await statusOf(chatAs(user).registerUpload(chatFile('one-more')))).toBe(429);
        // Another uploader has a cap of their own.
        await expect(chatAs(external).registerUpload(chatFile('theirs'))).resolves.toMatchObject({ id: 'theirs' });
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + PENDING_TTL_MS + 1);
        try {
            expect(await chatAs(user).fileAccess('f0')).toBeNull();
            await expect(chatAs(user).registerUpload(chatFile('one-more'))).resolves.toMatchObject({ id: 'one-more' });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('ends in one save', async () => {
        const before = app.saves.filter((s) => s.type === 'Chat').length;
        await chatAs(user).registerUpload(chatFile('f1'));
        expect(app.saves.filter((s) => s.type === 'Chat').length).toBe(before + 1);
    });
});

describe('post with file parts', () => {
    it('moves the pending upload into the index and marks it posted in the store', async () => {
        await chatAs(user).registerUpload(chatFile('f1'));
        const { messageId } = await chatAs(user).post(withFile('f1'));
        expect(store.posted).toEqual([`${WS}/c1/f1`]);
        expect(await chatAs(external).fileAccess('f1')).toMatchObject({ id: 'f1', chatId: 'c1', name: 'f1.png', mediaType: 'image/png', bytes: 3 });
        const last = (await chatAs(user).history()).entries.at(-1)!.entry;
        expect(last).toMatchObject({ t: 'msg', id: messageId, parts: withFile('f1') });
    });

    it('rejects a foreign chat, an unknown file, another principal’s pending upload, a mismatched type, a malformed reference', async () => {
        await chatAs(user).registerUpload(chatFile('mine'));
        await chatAs(external).registerUpload(chatFile('theirs'));
        expect(await statusOf(chatAs(user).post([image('mine', 'image/png', 'c2')]))).toBe(400);
        expect(await statusOf(chatAs(user).post(withFile('nope')))).toBe(404);
        expect(await statusOf(chatAs(user).post(withFile('theirs')))).toBe(404);
        expect(await statusOf(chatAs(user).post(withFile('mine', 'image/jpeg')))).toBe(400);
        expect(await statusOf(chatAs(user).post([{ type: 'file', mediaType: 'text/plain', url: 'agentic-file:c1' }]))).toBe(400);
        // Nothing was stored, nothing marked.
        expect((await chatAs(user).get()).seq).toBe(0);
        expect(store.posted).toEqual([]);
    });

    it('rejects a re-share of a file the caller cannot see, and allows one it can', async () => {
        await chatAs(user).registerUpload(chatFile('f1'));
        await chatAs(user).post(withFile('f1'));
        await chatAs(user).addAgent(A, 'from-now');
        await chatAs(user).addAgent(B, 'all');
        expect(await statusOf(chatAs(agent(A)).post(withFile('f1')))).toBe(403);
        await chatAs(agent(B)).post(withFile('f1'));
        // B's re-share is a message A can see: A may read the file now.
        expect(await chatAs(agent(A)).fileAccess('f1')).toMatchObject({ id: 'f1' });
        // A re-share is not a new upload: the store heard `markPosted` once.
        expect(store.posted).toHaveLength(1);
    });

    it('stores nothing when the store cannot mark the file posted', async () => {
        await chatAs(user).registerUpload(chatFile('f1'));
        store.failMarks = true;
        await expect(chatAs(user).post(withFile('f1'))).rejects.toThrow(/store down/);
        expect((await chatAs(user).get()).seq).toBe(0);
        expect(await chatAs(user).fileAccess('f1')).toMatchObject({ id: 'f1' });
    });
});

describe('fileAccess (CHT-04, MEM-11)', () => {
    it('allows a user; a member agent from historyFrom on; never a non-member', async () => {
        await chatAs(user).addAgent(B, 'all');
        await chatAs(user).registerUpload(chatFile('early'));
        await chatAs(user).post(withFile('early'));
        await chatAs(user).addAgent(A, 'from-now');
        await chatAs(user).registerUpload(chatFile('late'));
        await chatAs(user).post(withFile('late'));

        expect(await chatAs(user).fileAccess('early')).toMatchObject({ id: 'early' });
        expect(await chatAs(agent(A)).fileAccess('early')).toBeNull();
        expect(await chatAs(agent(A)).fileAccess('late')).toMatchObject({ id: 'late' });
        expect(await chatAs(agent(B)).fileAccess('early')).toMatchObject({ id: 'early' });
        expect(await chatAs(agent('agent_x' as never)).fileAccess('late')).toBeNull();
        expect(await chatAs(user).fileAccess('missing')).toBeNull();
        // A removed member loses access with its membership.
        await chatAs(user).removeAgent(A);
        expect(await chatAs(agent(A)).fileAccess('late')).toBeNull();
    });

    it('is closed to machines', async () => {
        expect(await statusOf(chatAs(machine).fileAccess('f1'))).toBe(403);
    });
});

describe('the index outlives archiving', () => {
    it('keeps every posted file readable after its message is archived to a ChatPage, and after a reload', async () => {
        const { storage, writes } = countingStorage();
        await app.stop();
        app = await startChatApp(storage, store);
        await chatAs(user).addAgent(A, 'all');
        await chatAs(user).registerUpload(chatFile('f1'));
        await chatAs(user).post(withFile('f1'));
        for (let i = 0; i < WINDOW + PAGE; i++) await chatAs(user).post(`m${i}`);
        expect(writes.some((w) => w.type === 'ChatPage' && w.key === pageKey(chatKey(), 0))).toBe(true);
        expect(await chatAs(agent(A)).fileAccess('f1')).toMatchObject({ id: 'f1' });

        await app.stop();
        app = await startChatApp(storage, store);
        expect(await chatAs(agent(A)).fileAccess('f1')).toMatchObject({ id: 'f1', name: 'f1.png' });
    });

    it('rebuilds the index from the entries through the reducer (replay)', async () => {
        const storage = memoryStorage();
        await app.stop();
        app = await startChatApp(storage, store);
        await chatAs(user).registerUpload(chatFile('f1'));
        await chatAs(user).post(withFile('f1'));
        await app.stop();
        app = await startChatApp(storage, store);
        expect(await chatAs(user).fileAccess('f1')).toMatchObject({ id: 'f1' });
    });
});

describe('session events', () => {
    const sessionId = 'session_1' as SessionId;
    it("keeps a file the agent can see in its final message and blanks any other", async () => {
        await chatAs(user).addAgent(A, 'from-now');
        await chatAs(user).registerUpload(chatFile('seen'));
        await chatAs(user).post(withFile('seen'));
        await chatAs(user).registerUpload(chatFile('pending'));
        const report = await app.host.publish(sessionEvents(chatKey()), {
            kind: 'message',
            agentId: A,
            sessionId,
            parts: [{ type: 'text', text: 'here' }, image('seen'), image('pending'), image('seen', 'image/png', 'c2')],
            at: Date.now()
        });
        expect(report).toMatchObject({ delivered: 1, failures: [] });
        const last = (await chatAs(user).history()).entries.at(-1)!.entry;
        expect(last.t === 'msg' && last.parts).toEqual([
            { type: 'text', text: 'here' },
            image('seen'),
            { type: 'text', text: '[file unavailable]' },
            { type: 'text', text: '[file unavailable]' }
        ]);
        // The pending upload stays the uploader's.
        expect(await chatAs(external).fileAccess('pending')).toBeNull();
        expect(await chatAs(user).fileAccess('pending')).toMatchObject({ id: 'pending' });
    });
});

it('ChatPage stays closed', async () => {
    expect(await statusOf(app.as(user).actor(ChatPage, pageKey(chatKey(), 0)).read())).toBe(403);
});
