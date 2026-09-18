/**
 * The live chat pages without their literals (#152), over the real wire:
 * the tasks of a chat out of the task index and "Stop task chain", the
 * amber pill while a request is open, unread against this device's marker,
 * search over `Chat.search`, and the settings dialog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, MessageId, TaskId } from '@agentic/core';
import { AgentActor, Chat, TaskActor, Workspace, agentKey, taskKey, workspaceKey } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { topbarFor } from '../../src/components/topbar';
import { chatHead, chatSearchRequest, chatSettingsRequest, openChatSettings, toggleChatSearch } from '../../src/pages/chat/head';
import { readMarks, resetReadMarks } from '../../src/pages/chat/read-marks';
import { buttonNamed, setText } from './helpers';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from './live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('push')) return [{ tool: { name: 'push', category: 'destructive', input: { cmd: 'git push' }, output: 'ok', permissionKey: 'push:origin' } }, { text: 'pushed' }];
            return [{ text: `echo: ${text}` }];
        }
    });
});
afterEach(async () => {
    await h.stop();
    resetReadMarks();
    localStorage.clear();
    chatSearchRequest.open = false;
    chatSettingsRequest.open = false;
});

const asOwner = () => h.app.as(owner);
const panel = (dom: ParentNode): Element => dom.querySelector('[data-page="chat"] > [data-chat-context]')!;
const rowOf = (dom: ParentNode, chatId: string): HTMLElement | null => dom.querySelector<HTMLAnchorElement>(`[data-chat-row] > a[href="/chats/${chatId}"]`)?.closest('[data-chat-row]') ?? null;

/** Atlas (coordinator) and Forge — who asks before a destructive call — in one chat. */
async function seedChat() {
    const atlas = await h.agent('Atlas', 'Personal assistant');
    const forge = await h.agent('Forge', 'Builds things');
    await asOwner().actor(AgentActor, agentKey(WS, forge)).update({ tools: [{ name: 'push' }], approvalPolicy: [{ id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' }] }, 'ask on destructive');
    const { chatId } = await asOwner().actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = asOwner().actor(Chat, chatKeyOf(USER, chatId));
    await chat.addAgent(atlas, 'all');
    await chat.addAgent(forge, 'all');
    await chat.setCoordinator(atlas);
    return { chatId, chat, atlas, forge };
}

/** A task from a message of `chatId` — what a post creates. */
async function createTask(chatId: string, assignee: AgentId, objective: string) {
    const taskId = `t_${objective.replace(/\W+/g, '_')}` as TaskId;
    const task = asOwner().actor(TaskActor, taskKey(WS, taskId));
    await task.create({ objective, origin: { kind: 'user', chatId: chatId as never, messageId: 'm1' as MessageId }, assignee, context: [], constraints: {} }, { owner: assignee });
    return { taskId, task };
}

/** …and run through the router, as a post does next. */
async function runTask(chatId: string, assignee: AgentId, objective: string) {
    const created = await createTask(chatId, assignee, objective);
    await asOwner().actor(h.Routing, `${USER}:routing:main`).run(created.taskId);
    return created;
}

describe('/chats/:id tasks, waiting and stop (live)', () => {
    it('a task of the chat appears in the panel, a task of another chat does not; Stop task chain cancels it and the settled task stays listed', async () => {
        const { chatId, atlas } = await seedChat();
        // Created, not yet routed: a chain that still runs and has no session to wait for.
        const { taskId, task } = await createTask(chatId, atlas, 'plan the release');
        await createTask((await asOwner().actor(Workspace, workspaceKey(WS)).createChat({})).chatId, atlas, 'elsewhere');
        const dom = await mountLive(`/chats/${chatId}`, h);

        await until(() => panel(dom).querySelectorAll('[data-mini-node]').length === 1, 'the task in the panel');
        expect(panel(dom).querySelector('[data-mini-node] a')!.textContent).toBe('plan the release');
        expect(panel(dom).querySelector('[data-mini-node] a')!.getAttribute('href')).toBe(`/tasks/${taskId}`);
        expect(panel(dom).querySelector('[data-mini-node]')!.getAttribute('data-depth')).toBe('0');
        expect(panel(dom).querySelector('[data-context-head] a')!.getAttribute('href')).toBe(`/tasks/${taskId}`);

        buttonNamed(panel(dom), 'Stop task chain').click();
        await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Stop 1 task'), 'the confirm dialog');
        buttonNamed(document, 'Stop 1 task').click();
        await until(async () => (await task.get()).status === 'cancelled', 'the task to be cancelled');
        // A settled task stays in the tree, and there is nothing left to stop.
        await until(() => ![...panel(dom).querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Stop task chain'), 'the stop button to leave');
        expect(panel(dom).querySelectorAll('[data-mini-node]')).toHaveLength(1);
        expect(dom.querySelector('[data-chat-error]')?.textContent ?? '').toBe('');
    });

    it('an open request turns the row and the member amber; answering it clears both', async () => {
        const { chatId, forge } = await seedChat();
        const { task } = await runTask(chatId, forge, 'push it');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => rowOf(dom, chatId)?.hasAttribute('data-waiting') === true, 'the waiting row');
        expect(rowOf(dom, chatId)!.querySelector('[data-scope="ag-pill"][data-status="approval"]')).not.toBeNull();
        await until(() => [...panel(dom).querySelectorAll('[data-member]')].some((m) => m.querySelector('[data-member-name]')!.textContent === 'Forge' && m.querySelector('[data-status="waiting"]')), 'Forge waiting');
        await until(() => chatHead.value?.members.find((m) => m.agentId === forge)?.status === 'waiting', 'the head');
        // The Task parks through the router's follow of the session (throttled), not the chat's status entry: it lands a beat later.
        await until(async () => (await task.get()).status === 'waiting', 'the task to park');

        await until(() => dom.querySelector('[data-scope="ai-approval"][data-part="root"]') !== null, 'the approval card in the thread');
        buttonNamed(dom.querySelector('[data-scope="ai-approval"][data-part="root"]')!, 'Allow once').click();
        await until(() => rowOf(dom, chatId)?.hasAttribute('data-waiting') === false, 'the pill to clear');
        await until(async () => (await task.get()).status === 'completed', 'the task to complete');
        await until(() => panel(dom).querySelector('[data-member] [data-status="waiting"]') === null, 'nobody waiting');
    });

    it('a chat with no tasks says so and offers no stop', async () => {
        const { chatId } = await seedChat();
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => panel(dom).querySelectorAll('[data-member]').length === 2, 'the members');
        expect(panel(dom).querySelector('[data-panel-note]')!.textContent).toBe('No tasks yet.');
        expect([...panel(dom).querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Stop task chain');
    });
});

describe('unread (live)', () => {
    it('rises on an agent reply in another chat and clears when that chat is opened', async () => {
        const { chatId, atlas } = await seedChat();
        const second = await asOwner().actor(Workspace, workspaceKey(WS)).createChat({ title: 'Other' });
        const other = asOwner().actor(Chat, chatKeyOf(USER, second.chatId));
        await other.addAgent(atlas, 'all');
        await other.post('earlier');

        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelectorAll('[data-chat-row]').length === 2, 'two rows');
        // First sight on this device: the other chat starts at its present end, so nothing is unread yet.
        await until(() => readMarks(USER)[second.chatId] !== undefined, 'the baseline');
        expect(dom.querySelector('[data-chat-unread]')).toBeNull();

        const { task } = await runTask(second.chatId, atlas, 'say hi');
        await until(async () => (await task.get()).status === 'completed', 'the reply');
        await until(() => rowOf(dom, second.chatId)?.querySelector('[data-chat-unread]')?.textContent === '1', 'the unread count');
        // The last line is the newest message, not the session bookkeeping after it.
        expect(rowOf(dom, second.chatId)!.querySelector('[data-chat-last]')!.textContent).toBe('Atlas: echo: say hi');
        // The open chat never counts.
        expect(rowOf(dom, chatId)!.querySelector('[data-chat-unread]')).toBeNull();

        // Opening it — in this tab's list, from another tab of the same device — clears it.
        const opened = await mountLive(`/chats/${second.chatId}`, h);
        await until(() => opened.querySelector('[data-chat-row][data-current] [data-chat-title]')?.textContent === 'Other', 'the other chat open');
        await until(() => rowOf(dom, second.chatId)?.querySelector('[data-chat-unread]') === null, 'the count to clear');
        expect(JSON.parse(localStorage.getItem(`agentic:chat-seen:${USER}`)!)[second.chatId]).toBe((await other.get()).seq);
    });
});

describe('search and settings (live)', () => {
    it('the topbar buttons are wired in live mode; search lists what Chat.search finds, in the workspace zone', async () => {
        const { chatId, chat } = await seedChat();
        await chat.post('deploy the drawer fix');
        await chat.post('lunch?');
        await asOwner().actor(Workspace, workspaceKey(WS)).updateSettings({ timeZone: 'Europe/Stockholm' });
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => chatHead.value?.id === chatId, 'the head');
        expect(topbarFor({ name: 'chat', path: `/chats/${chatId}`, params: { id: chatId } })?.actions).toBeTypeOf('function');

        expect(dom.querySelector('[data-chat-find]')).toBeNull();
        toggleChatSearch();
        await until(() => dom.querySelector('[data-chat-find]') !== null, 'the search panel');
        setText(dom.querySelector<HTMLInputElement>('#chat-find')!, 'DRAWER');
        dom.querySelector('[data-chat-find] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => dom.querySelectorAll('[data-chat-hit]').length === 1, 'the hit');
        expect(dom.querySelector('[data-chat-hit] [data-chat-last]')!.textContent).toBe('You: deploy the drawer fix');
        const at = (await chat.history(null, 10)).entries.find((e) => e.entry.t === 'msg')!.entry.at;
        expect(dom.querySelector('[data-chat-hit] time')!.textContent).toBe(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hour12: false }).format(at));
        // The thread prints the same clock face.
        expect(texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="time"]'))[0]).toBe(dom.querySelector('[data-chat-hit] time')!.textContent);

        setText(dom.querySelector<HTMLInputElement>('#chat-find')!, 'nothing like it');
        dom.querySelector('[data-chat-find] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => dom.querySelector('[data-chat-find] [data-panel-note]') !== null, 'the empty answer');
        dom.querySelector<HTMLButtonElement>('[data-chat-find] button[aria-label="Close search"]')!.click();
        await until(() => dom.querySelector('[data-chat-find]') === null, 'the panel to close');
    });

    it('chat settings rename the chat, move the coordinator and remove a member', async () => {
        const { chatId, chat, atlas, forge } = await seedChat();
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => panel(dom).querySelectorAll('[data-member]').length === 2, 'the members');
        openChatSettings();
        await until(() => document.querySelector('[data-chat-settings-title] input') !== null, 'the dialog');
        const title = document.querySelector<HTMLInputElement>('[data-chat-settings-title] input')!;
        const coordinator = document.querySelector<HTMLSelectElement>('[data-chat-settings-coordinator] select')!;
        expect(title.value).toBe('');
        expect(coordinator.value).toBe(atlas);

        setText(title, '  Release   plan ');
        coordinator.value = forge;
        coordinator.dispatchEvent(new Event('change', { bubbles: true }));
        const remove = document.querySelector<HTMLInputElement>(`[data-chat-settings-remove] input[value="${atlas}"]`)!;
        remove.checked = true;
        remove.dispatchEvent(new Event('change', { bubbles: true }));
        buttonNamed(document, 'Save settings').click();

        await until(() => chatHead.value?.title === 'Release plan', 'the renamed head');
        const summary = await chat.get();
        expect(summary.title).toBe('Release plan');
        expect(summary.coordinator).toBe(forge);
        expect(Object.keys(summary.members)).toEqual([forge]);
        await until(() => chatSettingsRequest.open === false, 'the dialog to close');
        await until(() => texts(panel(dom).querySelectorAll('[data-member-name]')).join() === 'Forge', 'the panel to follow');
        expect(texts(panel(dom).querySelectorAll('[data-member-history]'))).toEqual(['Coordinator · sees all history']);
    });
});

describe('the chat list search box', () => {
    it('filters the rows as you type', async () => {
        const { chat, atlas } = await seedChat();
        await chat.post('about drawers');
        const second = await asOwner().actor(Workspace, workspaceKey(WS)).createChat({ title: 'Lunch' });
        await asOwner().actor(Chat, chatKeyOf(USER, second.chatId)).addAgent(atlas, 'all');
        const dom = await mountLive('/chats', h);
        await until(() => dom.querySelectorAll('[data-chat-row]').length === 2, 'two rows');
        setText(dom.querySelector<HTMLInputElement>('#chat-search')!, 'lunch');
        await until(() => dom.querySelectorAll('[data-chat-row]').length === 1, 'one row');
        expect(texts(dom.querySelectorAll('[data-chat-title]'))).toEqual(['Lunch']);
        setText(dom.querySelector<HTMLInputElement>('#chat-search')!, 'DRAWERS');
        await until(() => texts(dom.querySelectorAll('[data-chat-title]')).join() === 'Atlas, Forge', 'the match on the last line');
        setText(dom.querySelector<HTMLInputElement>('#chat-search')!, '');
        await until(() => dom.querySelectorAll('[data-chat-row]').length === 2, 'both rows back');
    });
});
