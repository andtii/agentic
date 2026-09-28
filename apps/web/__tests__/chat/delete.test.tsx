/**
 * Delete a chat (#674, `Workspace.deleteChat`): the chat's settings offer "Delete chat" behind a confirmation that
 * says what happens to its worktree under the project's cleanup policy; confirming deletes it and leaves the page for
 * the chat list — live over the in-process wire.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectRecord } from '@agentic/core';
import { GIT_FEATURE_ID } from '@agentic/plugins-git';
import { Chat, Workspace, workspaceKey } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { deleteChatText } from '../../src/pages/chat/delete';
import { closeChatSettings, openChatSettings } from '../../src/pages/chat/head';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const project = (git?: Record<string, unknown>): Pick<ProjectRecord, 'name' | 'features'> => ({ name: 'Agentic', features: git ? { [GIT_FEATURE_ID]: git } : {} });

describe('deleteChatText', () => {
    it('says nothing about a worktree outside a project, or in one without a worktree per chat', () => {
        expect(deleteChatText(undefined)).not.toMatch(/worktree/);
        expect(deleteChatText(project())).not.toMatch(/worktree/);
        expect(deleteChatText(project({ worktreePerChat: false, worktreeCleanup: 'on-chat-leave' }))).not.toMatch(/worktree/);
    });

    it('names what the cleanup policy does with the chat’s worktree', () => {
        expect(deleteChatText(project({ worktreePerChat: true, worktreeCleanup: 'on-chat-leave' }))).toMatch(/worktree in Agentic is removed .* unless it has uncommitted changes/);
        expect(deleteChatText(project({ worktreePerChat: true, worktreeCleanup: 'on-merge' }))).toMatch(/worktree in Agentic is removed/);
        expect(deleteChatText(project({ worktreePerChat: true }))).toMatch(/worktree in Agentic stays/);
        expect(deleteChatText(project({ worktreePerChat: true, worktreeCleanup: 'never' }))).toMatch(/worktree in Agentic stays/);
    });
});

describe('delete a chat (live)', () => {
    let h: LiveHarness;
    beforeEach(async () => {
        h = await startLive();
    });
    afterEach(async () => {
        closeChatSettings();
        await h.stop();
    });

    it('the chat’s settings delete it once confirmed, and the page leaves for the chat list', async () => {
        const workspace = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        const { chatId } = await workspace.createChat({ title: 'throwaway' });
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await chat.post('soon gone');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.textContent?.includes('soon gone') === true, 'the page');

        openChatSettings();
        await until(() => document.querySelector('[data-chat-settings-delete] button') !== null, 'the dialog');
        document.querySelector<HTMLElement>('[data-chat-settings-delete] button')!.click();
        const confirm = (): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find((d) => d.textContent?.includes('Delete this chat?'));
        await until(() => confirm() !== undefined, 'the confirm');
        const dialog = confirm()!;
        expect(dialog.textContent).toContain('cannot be undone');
        // Nothing is deleted until it is confirmed.
        expect((await workspace.get()).chats).toContain(chatId);
        [...dialog.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Delete chat')!.click();

        await until(async () => (await chat.get()).deleted === true, 'Workspace.deleteChat');
        expect((await workspace.get()).chats).not.toContain(chatId);
        await until(() => !dom.textContent?.includes('soon gone'), 'the page to leave the chat');
    }, 20_000);
});
