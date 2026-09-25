/**
 * The project Chats page carries a chat's archived flag (#897): a live `/chats` row archived through `Chat.archive`
 * (#884) sits under Archived on the project's Chats page, not under Needs you / Working / Quiet.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Chat, Workspace, workspaceKey } from '@agentic/platform';
import type { ProjectId } from '@agentic/core';
import type { ChatListRow } from '../../src/pages/chat/archive';
import { clientDefs } from '../../src/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { projectChatRow } from '../../src/pages/projects/chats/ProjectChats';
import { chatGroupOf } from '../../src/pages/projects/chats/groups';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const listRow = (over: Partial<ChatListRow> = {}): ChatListRow => ({ id: 'c1', title: 'c1', members: [], lastLine: '', unread: 0, waiting: true, updatedAt: 1, projectId: 'p1', ...over });

describe('projectChatRow (#897)', () => {
    it('carries archived onto the project row, so the chat groups as Archived', () => {
        const row = projectChatRow(listRow({ archived: true }), { roots: ['t1'], working: true });
        expect(row.archived).toBe(true);
        expect(chatGroupOf(row)).toBe('archived');
    });

    it('leaves an open chat without the flag, grouped by who acts next', () => {
        const row = projectChatRow(listRow(), { roots: [], working: false });
        expect('archived' in row).toBe(false);
        expect(chatGroupOf(row)).toBe('needs-you');
    });

    it('takes the move this page made until the chat names its own project', () => {
        expect(projectChatRow(listRow({ projectId: undefined }), { roots: [], working: false }, 'p2').projectId).toBe('p2');
        expect(projectChatRow(listRow(), { roots: [], working: false }, 'p2').projectId).toBe('p1');
    });
});

const rowIds = (root: ParentNode, group: string): string[] => [...root.querySelectorAll<HTMLElement>(`[data-project-chat-group="${group}"] [data-project-chat-row]`)].map((el) => el.dataset.projectChatRow!);

describe('the project Chats page live, archived chats (#897)', () => {
    let h: LiveHarness | undefined;
    afterEach(async () => {
        projectHead.value = null;
        await h?.stop();
        h = undefined;
    });

    it('shows a chat archived live under Archived and not in the open groups', { timeout: 30_000 }, async () => {
        h = await startLive();
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        const { chatId: open } = await ws.createChat({ title: 'Still going' });
        const { chatId: done } = await ws.createChat({ title: 'All done' });
        for (const chatId of [open, done]) await h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId)).setProject(id as ProjectId);
        await h.app.as(owner).actor(Chat, chatKeyOf(USER, done)).archive(true);
        const dom = await mountLive(`/projects/${id}/chats`, h);
        await until(() => rowIds(dom, 'quiet').includes(open), 'the open chat');
        const HEAD = '[data-project-chat-group="archived"] [data-project-chat-group-head]';
        await until(() => dom.querySelector(HEAD) !== null, 'the Archived group');
        dom.querySelector<HTMLButtonElement>(HEAD)!.click();
        await until(() => rowIds(dom, 'archived').includes(done), 'the archived chat under Archived');
        for (const group of ['needs-you', 'working', 'quiet']) expect(rowIds(dom, group)).not.toContain(done);
    });
});
