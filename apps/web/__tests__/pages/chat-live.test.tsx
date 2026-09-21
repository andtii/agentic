/**
 * `/chats/:id` and `/chats` wired to the actors (#34): the pages over the
 * real wire in-process (`live-harness`), a mock runtime behind the Session
 * actor. Live reads (AC-06), the composer → `Chat.post` → Task → Routing
 * path, membership dialogs, and the topbar contribution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatId, TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, taskKey, workspaceKey } from '@agentic/platform';
import { agentKey, routingKey } from '@agentic/platform';
import { agentKeyOf, chatKeyOf, routingKeyOf, sessionKeyOf, taskKeyOf, workspaceKeyOf } from '../../src/actors/keys';
import { topbarFor } from '../../src/components/topbar';
import { setDataMode } from '../../src/data-mode';
import { chatHead } from '../../src/pages/chat/head';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    await h.stop();
});

const names = (dom: ParentNode) => texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="name"]'));

async function seedChat() {
    const atlas = await h.agent('Atlas', 'Personal assistant');
    const forge = await h.agent('Forge', 'Builds things');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
    await chat.addAgent(atlas, 'all');
    await chat.setCoordinator(atlas);
    return { chatId, atlas, forge, chat };
}

function setDraft(dom: ParentNode, text: string): void {
    const ta = dom.querySelector<HTMLTextAreaElement>('[data-scope="ai-composer"] textarea')!;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('actor keys', () => {
    it('spell the platform keys exactly', () => {
        expect(workspaceKeyOf('u1')).toBe(workspaceKey('u1'));
        expect(agentKeyOf('u1', 'a1')).toBe(agentKey('u1' as never, 'a1' as never));
        expect(taskKeyOf('u1', 't1')).toBe(taskKey('u1' as never, 't1' as never));
        expect(routingKeyOf('u1')).toBe(routingKey('u1'));
        expect(chatKeyOf('u1', 'c1')).toBe('u1:chat:c1');
        expect(sessionKeyOf('u1', 's1')).toBe('u1:session:s1');
    });
});

describe('/chats/:id (live)', () => {
    it('renders the chat from the actors: the title from its first message (#460), the posted message attributed, the composer addressing the coordinator', async () => {
        const { chatId, chat } = await seedChat();
        await chat.post('hello there');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => names(dom).length === 1, 'the posted message');
        // The user reads as "You" on the platform — "Andii" is the mock workspace's person (#152).
        expect(names(dom)).toEqual(['You']);
        expect(dom.querySelector('[data-page="chat"]')!.hasAttribute('data-flush')).toBe(true);
        expect(texts(dom.querySelectorAll('[data-page="chat"] > [data-chat-context] [data-member-name]'))).toEqual(['Atlas']);
        expect(texts(dom.querySelectorAll('[data-page="chat"] > [data-chat-context] [data-member-history]'))).toEqual(['Coordinator · sees all history']);
        expect(dom.querySelector('[data-scope="ai-composer"][data-part="addressing"]')!.textContent).toContain('Atlas answers unless you @ someone');
        // The list column shows this chat, titled by its first message (#460: the chat named itself on the post), current.
        expect(dom.querySelector('[data-chat-row][data-current] [data-chat-title]')!.textContent).toBe('hello there');
        expect(dom.querySelector('[data-chat-row][data-current] [data-chat-last]')!.textContent).toBe('You: hello there');
        // The topbar reads the page's head.
        expect(chatHead.value?.title).toBe('hello there');
        expect(topbarFor({ name: 'chat', path: `/chats/${chatId}`, params: { id: chatId } })?.crumb).toBe('hello there');
    });

    it('two tabs see the same stream: a post by someone else appears in both without a reload (AC-06)', async () => {
        const { chatId, chat } = await seedChat();
        const a = await mountLive(`/chats/${chatId}`, h);
        const b = await mountLive(`/chats/${chatId}`, h);
        expect(a.querySelector('[data-chat-empty]')).not.toBeNull();
        await chat.post('first');
        await until(() => names(a).length === 1 && names(b).length === 1, 'both tabs to show the post');
        expect(texts(a.querySelectorAll('[data-scope="ai-message"][data-part="body"]'))).toEqual(['first']);
        expect(texts(b.querySelectorAll('[data-scope="ai-message"][data-part="body"]'))).toEqual(['first']);
    });

    it('posting from the composer activates the coordinator: a task is created and routed, the session runs and the answer lands in the chat', async () => {
        const { chatId, chat, atlas } = await seedChat();
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelector('[data-scope="ai-composer"] textarea') !== null, 'the composer');
        setDraft(dom, 'what is up');
        dom.querySelector('form[data-scope="ai-composer"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        // The user's row, the status rows and the agent's echo, in order — attributed (CHT-02).
        await until(() => names(dom).some((n) => n === 'Atlas') && texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="body"]')).some((t) => t.includes('echo: what is up')), 'the answer');
        const history = await chat.history(null, 50);
        const kinds = history.entries.map((e) => e.entry.t);
        expect(kinds[0]).toBe('member');
        expect(kinds).toContain('status');
        const msgs = history.entries.filter((e) => e.entry.t === 'msg').map((e) => e.entry as Extract<typeof e.entry, { t: 'msg' }>);
        expect(msgs.map((m) => m.author.kind)).toEqual(['user', 'agent']);
        expect(msgs[1]!.taskId).toBeDefined();
        // The task exists, assigned to the coordinator, with the message as its origin.
        const task = await h.app.as(owner).actor(TaskActor, taskKey(WS, msgs[1]!.taskId as TaskId)).get();
        expect(task.assignee).toBe(atlas);
        expect(task.origin).toEqual({ kind: 'user', chatId: chatId as ChatId, messageId: msgs[0]!.id });
        expect(task.objective).toBe('what is up');
        expect(['active', 'completed']).toContain(task.status);
        // The composer cleared.
        expect(dom.querySelector<HTMLTextAreaElement>('[data-scope="ai-composer"] textarea')!.value).toBe('');
    });

    it('add-agent offers the workspace agents that are not members and posts the history access chosen', async () => {
        const { chatId, chat, forge } = await seedChat();
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => texts(dom.querySelectorAll('[data-page="chat"] > [data-chat-context] [data-member-name]')).includes('Atlas'), 'the members');
        const panel = dom.querySelector('[data-page="chat"] > [data-chat-context]')!;
        panel.querySelector<HTMLButtonElement>('[data-link-button]')!.click();
        await until(() => document.querySelectorAll('[data-agent-pick] option').length >= 1, 'the candidates');
        // Only agents that are not members yet are offered; the dialog is zero's, so look from the document.
        const dialog = (): Element => document.querySelector('[data-agent-pick]')!.closest('[data-scope="dialog"]') ?? document.body;
        expect(texts(dialog().querySelectorAll('[data-agent-pick] option'))).toEqual(['Forge · Builds things']);
        dialog().querySelector<HTMLInputElement>('input[name="history-access"][value="from"]')!.click();
        [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Add agent')!.click();
        await until(() => texts(panel.querySelectorAll('[data-member-name]')).includes('Forge'), 'the member to appear');
        const summary = await chat.get();
        expect(summary.members[forge]!.historyFrom).toBeGreaterThan(0);
        expect(texts(panel.querySelectorAll('[data-member-history]'))[1]).toMatch(/^Added \d\d:\d\d · sees history from then$/);
    });

    it('new chat: creates the chat with the picked members and coordinator and navigates to it', async () => {
        const { chatId, forge, atlas } = await seedChat();
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelectorAll('[data-new-chat-members] input[name="member"]').length === 2, 'the agents');
        const pick = (id: string) => {
            const box = dom.querySelector<HTMLInputElement>(`[data-new-chat-members] input[name="member"][value="${id}"]`)!;
            box.checked = !box.checked;
            box.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // Two picked: a group, so each picked card offers the coordinator radio; then back to one.
        pick(forge);
        pick(atlas);
        await tick();
        expect(dom.querySelector('[data-new-chat-agent][data-picked]')).not.toBeNull();
        const radio = dom.querySelector<HTMLInputElement>(`[data-new-chat-agent="${forge}"] input[name="coordinator"]`)!;
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(dom.querySelector('[data-new-chat-summary]')!.textContent).toContain('Forge answers unless you mention someone');
        pick(atlas);
        await tick();
        expect(dom.querySelector('[data-new-chat-summary]')!.textContent).toBe('A direct chat with Forge.');
        [...dom.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Create chat')!.click();
        await until(() => (h.app.saves.some((s) => s.type === 'Chat' && s.key !== chatKeyOf(USER, chatId))), 'the new chat');
        const ws = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).get();
        expect(ws.chats).toHaveLength(2);
        const created = ws.chats.find((c) => c !== chatId)!;
        const summary = await h.app.as(owner).actor(Chat, chatKeyOf(USER, created)).get();
        expect(Object.keys(summary.members)).toEqual([forge]);
        expect(summary.coordinator).toBe(forge);
        await until(() => dom.querySelector('[data-chat-row][data-current] [data-chat-title]')?.textContent === 'Forge', 'navigation to the new chat');
    });
});

describe('/chats (live)', () => {
    it('lists the workspace chats newest first, each titled by its first message (#460)', async () => {
        const { chat, atlas, forge } = await seedChat();
        await chat.post('older');
        const second = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const other = h.app.as(owner).actor(Chat, chatKeyOf(USER, second.chatId));
        await other.addAgent(atlas, 'all');
        await other.addAgent(forge, 'all');
        await other.post('newer');
        const dom = await mountLive('/chats', h);
        await until(() => dom.querySelectorAll('[data-chat-row]').length === 2, 'two rows');
        expect(dom.querySelector('[data-chat-list][data-wide]')).not.toBeNull();
        expect(texts(dom.querySelectorAll('[data-chat-title]'))).toEqual(['newer', 'older']);
        expect(texts(dom.querySelectorAll('[data-chat-last]'))).toEqual(['You: newer', 'You: older']);
        setDataMode('mock');
    });

    it('orders chats whose last activity shares a millisecond by creation, newest first (#175)', async () => {
        const now = Date.now();
        const fixed = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            const { chat, atlas } = await seedChat();
            await chat.post('first');
            const second = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({ title: 'Second' });
            const other = h.app.as(owner).actor(Chat, chatKeyOf(USER, second.chatId));
            await other.addAgent(atlas, 'all');
            await other.post('second');
            const dom = await mountLive('/chats', h);
            await until(() => dom.querySelectorAll('[data-chat-row]').length === 2, 'two rows');
            expect(texts(dom.querySelectorAll('[data-chat-last]'))).toEqual(['You: second', 'You: first']);
        } finally {
            fixed.mockRestore();
        }
        setDataMode('mock');
    });

    it('a chat created with a title shows it in the list and the topbar instead of its members, and follows a rename (#124)', async () => {
        const { chat, atlas } = await seedChat();
        await chat.post('untitled');
        const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        const { chatId } = await ws.createChat({ title: 'Release plan' });
        const titled = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await titled.addAgent(atlas, 'all');
        await titled.post('titled');
        expect((await titled.get()).title).toBe('Release plan');

        const list = await mountLive('/chats', h);
        await until(() => list.querySelectorAll('[data-chat-row]').length === 2, 'two rows');
        expect(texts(list.querySelectorAll('[data-chat-title]'))).toEqual(['Release plan', 'untitled']);

        const page = await mountLive(`/chats/${chatId}`, h);
        await until(() => page.querySelector('[data-chat-row][data-current] [data-chat-title]')?.textContent === 'Release plan', 'the titled row');
        // The head follows the page's own summary read, a separate read from the list's batch.
        await until(() => chatHead.value?.id === chatId && chatHead.value.title === 'Release plan', 'the titled head');
        expect(topbarFor({ name: 'chat', path: `/chats/${chatId}`, params: { id: chatId } })?.crumb).toBe('Release plan');

        // The page's summary is live, so a rename reaches the topbar without a reload (the list rows are one batch read, #34).
        await titled.rename('Release plan v2');
        await until(() => chatHead.value?.title === 'Release plan v2', 'the renamed head');
        setDataMode('mock');
    });
});
