/**
 * Archive and restore chats (#884, `Chat.archive` from #774): the row's overflow menu and the chat's settings archive
 * a chat, which leaves the default list for its collapsed Archived group; Restore brings it back — on mock data and
 * live over the in-process wire.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Chat, Workspace, workspaceKey, type ChatSummary } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { mockArchive, splitArchived, withMockArchive, type ChatListRow } from '../../src/pages/chat/archive';
import { chatRow, lookupOver } from '../../src/pages/chat/live';
import { closeChatSettings, openChatSettings } from '../../src/pages/chat/head';
import { mountRoute } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const row = (id: string, archived?: boolean): ChatListRow => ({ id, title: id, members: [], lastLine: '', unread: 0, waiting: false, updatedAt: 0, ...(archived ? { archived } : {}) });

const titles = (root: ParentNode, sel: string): string[] => [...root.querySelectorAll(`${sel} [data-chat-title]`)].map((el) => el.textContent?.trim() ?? '');
const openTitles = (root: ParentNode): string[] => titles(root, '[data-chat-list] [data-chat-rows]:not(#chat-group-archived)');
const archivedTitles = (root: ParentNode): string[] => titles(root, '#chat-group-archived');
const archivedCount = (root: ParentNode): string | undefined => root.querySelector('[data-chat-archived] [data-chat-group-count]')?.textContent?.trim();

/** Open a row's overflow menu and pick its one item. */
async function pickFromRowMenu(root: ParentNode, title: string, item: 'archive' | 'restore'): Promise<void> {
    const li = [...root.querySelectorAll<HTMLElement>('[data-chat-row]')].find((el) => el.querySelector('[data-chat-title]')?.textContent?.trim() === title);
    if (!li) throw new Error(`no row titled ${title}`);
    li.querySelector<HTMLElement>('[data-chat-row-menu]')!.click();
    await until(() => li.querySelector(`[data-chat-${item}]`) !== null, `the ${item} item`);
    li.querySelector<HTMLElement>(`[data-chat-${item}]`)!.click();
}

const expandArchived = (root: ParentNode): void => root.querySelector<HTMLElement>('[data-chat-archived-toggle]')!.click();

describe('archive model', () => {
    it('splits open chats from archived ones, keeping the order', () => {
        const { open, archived } = splitArchived([row('a'), row('b', true), row('c'), row('d', true)]);
        expect(open.map((c) => c.id)).toEqual(['a', 'c']);
        expect(archived.map((c) => c.id)).toEqual(['b', 'd']);
    });

    it('applies the mock visit’s archives and restores over each row’s own flag', () => {
        const rows = withMockArchive([row('a'), row('b', true), row('c')], { a: true, b: false, c: false });
        expect(rows.map((c) => c.archived ?? false)).toEqual([true, false, false]);
        expect('archived' in rows[1]!).toBe(false);
    });

    it('carries ChatSummary.archived onto the live row', () => {
        const summary = { seq: 0, members: {}, coordinator: null, sessions: {} } as unknown as ChatSummary;
        const lookup = lookupOver({});
        expect(chatRow('c1', summary, [], lookup).archived).toBeUndefined();
        expect(chatRow('c1', { ...summary, archived: true }, [], lookup).archived).toBe(true);
    });
});

describe('/chats (mock): archive and restore from the row menu', () => {
    afterEach(() => {
        mockArchive.map = {};
    });

    it('archiving moves the row into the collapsed Archived group; Restore brings it back', async () => {
        const dom = await mountRoute('/chats');
        expect(openTitles(dom)).toContain('Release checklist');
        expect(dom.querySelector('[data-chat-archived]')).toBeNull();

        await pickFromRowMenu(dom, 'Release checklist', 'archive');
        await until(() => !openTitles(dom).includes('Release checklist'), 'the row to leave the list');
        expect(archivedCount(dom)).toBe('1');
        // Collapsed until asked.
        expect(archivedTitles(dom)).toEqual([]);
        expandArchived(dom);
        await until(() => archivedTitles(dom).length === 1, 'the archived group to open');
        expect(archivedTitles(dom)).toEqual(['Release checklist']);

        await pickFromRowMenu(dom, 'Release checklist', 'restore');
        await until(() => openTitles(dom).includes('Release checklist'), 'the row to come back');
        expect(dom.querySelector('[data-chat-archived]')).toBeNull();
    });
});

describe('archive and restore (live)', () => {
    let h: LiveHarness;
    beforeEach(async () => {
        h = await startLive();
    });
    afterEach(async () => {
        closeChatSettings();
        await h.stop();
    });

    async function seedChat(text: string) {
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await chat.post(text);
        return { chatId, chat };
    }

    it('the row menu on /chats calls Chat.archive and back; the row moves both ways', async () => {
        const { chat } = await seedChat('keep me around');
        await seedChat('another chat');
        const dom = await mountLive('/chats', h);
        await until(() => openTitles(dom).includes('keep me around'), 'the row');

        await pickFromRowMenu(dom, 'keep me around', 'archive');
        await until(async () => (await chat.get()).archived === true, 'Chat.archive(true)');
        await until(() => !openTitles(dom).includes('keep me around') && archivedCount(dom) === '1', 'the row to move to Archived');
        expect(openTitles(dom)).toEqual(['another chat']);

        expandArchived(dom);
        await until(() => archivedTitles(dom).includes('keep me around'), 'the archived group');
        await pickFromRowMenu(dom, 'keep me around', 'restore');
        await until(async () => (await chat.get()).archived === undefined, 'Chat.archive(false)');
        await until(() => openTitles(dom).includes('keep me around') && dom.querySelector('[data-chat-archived]') === null, 'the row to come back');
    }, 20_000);

    it('the chat’s settings archive it; the archived note restores it', async () => {
        const { chatId, chat } = await seedChat('settings archive');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => openTitles(dom).includes('settings archive'), 'the page');

        openChatSettings();
        await until(() => document.querySelector('[data-chat-settings-archive] button') !== null, 'the dialog');
        const button = document.querySelector<HTMLElement>('[data-chat-settings-archive] button')!;
        expect(button.textContent).toContain('Archive chat');
        button.click();
        await until(async () => (await chat.get()).archived === true, 'Chat.archive(true)');
        await until(() => dom.querySelector('[data-chat-archived-note]') !== null, 'the archived note');
        // The chat on screen sits in the list's Archived group, opened around it.
        await until(() => archivedTitles(dom).includes('settings archive'), 'the row under Archived');

        dom.querySelector<HTMLElement>('[data-chat-restore-note]')!.click();
        await until(async () => (await chat.get()).archived === undefined, 'Chat.archive(false)');
        await until(() => dom.querySelector('[data-chat-archived-note]') === null && openTitles(dom).includes('settings archive'), 'the chat restored');
    }, 20_000);
});
