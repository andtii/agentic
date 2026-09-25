/**
 * Chat archive state (#774; PRJ-02/04): `Chat.archive(bool)` sets
 * `ChatSummary.archived`, is audited as `chat.archived`, writes nothing into
 * the thread, survives a restart, and `Workspace.projectSummaries` counts an
 * archived chat as archived instead of open.
 */
import { actorKey, type ChatId, type MachineId, type Principal } from '@agentic/core';
import { AuditActor, auditKey } from '../../src/audit/index.js';
import { AgentActor } from '../../src/agent/index.js';
import { workspaceKey } from '../../src/auth/index.js';
import { Chat, ChatPage } from '../../src/chat/index.js';
import { PairingDirectory } from '../../src/pairing/index.js';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index.js';
import { Workspace } from '../../src/workspace/index.js';
import { A, WS, agent, user } from './helpers.js';

const actors = [Chat, ChatPage, Workspace, PairingDirectory, AuditActor, AgentActor];
const wsOwner = userPrincipal(WS);

let app: TestActorApp;
beforeEach(async () => {
    app = testActorApp(actors);
    await app.start();
});
afterEach(async () => {
    await app.stop();
});

const chatAs = (principal: Principal, id: string) => app.as(principal).actor(Chat, actorKey(WS, 'chat', id));
const ws = () => app.as(wsOwner).actor(Workspace, workspaceKey(WS));
const archivedEvents = async () => (await app.as(wsOwner).actor(AuditActor, auditKey(WS)).list({ kinds: ['chat.archived'] })).events;

describe('Chat.archive (#774)', () => {
    it('archives and restores the chat, audited once per change, writing nothing into the thread, and survives a restart', async () => {
        const chat = chatAs(user, 'c1');
        await chat.post('hello');
        const before = (await chat.history()).entries.length;
        expect((await chat.get()).archived).toBeUndefined();

        expect((await chat.archive(true)).archived).toBe(true);
        // Idempotent: archiving again is no change and no record.
        await chat.archive(true);
        expect((await chat.get()).archived).toBe(true);
        expect((await chat.history()).entries).toHaveLength(before);
        expect(await archivedEvents()).toMatchObject([{ by: 'user:u1', data: { chatId: 'c1', archived: true } }]);

        const { storage } = app;
        await app.stop();
        app = testActorApp(actors, { storage });
        await app.start();
        expect((await chatAs(user, 'c1').get()).archived).toBe(true);

        const restored = await chatAs(user, 'c1').archive(false);
        expect('archived' in restored).toBe(false);
        // Newest first.
        expect((await archivedEvents()).map((e) => (e.data as { archived: boolean }).archived)).toEqual([false, true]);
    });

    it('is the user’s call: agents and machines are refused (403), a non-boolean is 400', async () => {
        await chatAs(user, 'c1').addAgent(A);
        expect(await statusOf(chatAs(agent(A), 'c1').archive(true))).toBe(403);
        const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
        expect(await statusOf(chatAs(machine, 'c1').archive(true))).toBe(403);
        expect(await statusOf(chatAs(user, 'c1').archive('yes' as never))).toBe(400);
        expect((await chatAs(user, 'c1').get()).archived).toBeUndefined();
        const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'cli', scopes: ['chats'] };
        expect((await chatAs(external, 'c1').archive(true)).archived).toBe(true);
    });
});

describe('Workspace.projectSummaries — archived chats (#774)', () => {
    it('counts archived chats in archivedChats, not in openChats, and leaves their activity out', async () => {
        const p = await ws().upsertProject({ name: 'P' });
        const { chatId: open } = await ws().createChat({ projectId: p.id });
        const { chatId: shelved } = await ws().createChat({ projectId: p.id });
        const { chatId: loose } = await ws().createChat();
        const chat = (id: ChatId) => chatAs(wsOwner, id);
        await chat(open).post('first');
        await chat(shelved).post('later');
        await chat(shelved).archive(true);
        await chat(loose).archive(true);
        const openAt = (await chat(open).history(null, 1)).entries.at(-1)!.entry.at;

        const summaries = await ws().projectSummaries();
        expect(summaries.projects).toEqual([{ projectId: p.id, openChats: 1, archivedChats: 1, lastActivityAt: openAt }]);
        expect(summaries.unassigned).toEqual({ openChats: 0 });

        await chat(shelved).archive(false);
        expect((await ws().projectSummaries()).projects[0]).toMatchObject({ openChats: 2, archivedChats: 0 });
    });
});
