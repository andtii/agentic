/**
 * The chat opens newest-first (#398, CHT-08): a long chat renders its newest
 * page at once and reads nothing older until the reader reaches the top of
 * the thread; older pages arrive one at a time and stop at the caller's
 * `historyFrom`; a turn running when the page opens streams into the thread
 * from where it stands — the feed is tailed from the last turn's end, never
 * from the log's start; a member reads ACTIVE from its work, not from the
 * session it holds. The same at a phone's width — the layout itself (no
 * horizontal scroll at 400 px, the docked composer) is Playwright's
 * `e2e:mobile`, which jsdom cannot measure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { actorKey, type AgentId, type ChatId, type MessageId, type TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import type { ActorTransport } from '@sigx/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { HISTORY_LIMIT } from '../../src/pages/chat/LiveChat';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

/** The mock runtime: ten characters, one per 100 ms — a turn that is mid-way for long enough to open a tab on it. */
const SLOW = { respond: () => [{ text: 'abcdefghij', chunkSize: 1, delayMs: 100 }] };

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(SLOW);
});
afterEach(async () => {
    await h.stop();
});

const bodies = (dom: ParentNode): string[] => texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="body"]'));
const threadRoot = (dom: ParentNode): HTMLElement => dom.querySelector<HTMLElement>('[data-scope="ai-thread"][data-part="root"]')!;
const chip = (dom: ParentNode): HTMLButtonElement | null => dom.querySelector<HTMLButtonElement>('[data-scope="ai-thread"][data-part="earlier"]');
const memberPill = (dom: ParentNode, name: string): string => {
    const row = [...dom.querySelectorAll('[data-page="chat"] > [data-chat-context] [data-member]')].find((el) => el.querySelector('[data-member-name]')?.textContent === name);
    return row?.querySelector('[data-scope="badge"][data-part="root"]')?.textContent?.trim() ?? '';
};

/** Scroll geometry jsdom does not compute: pin it, then scroll. */
function scrollTo(el: HTMLElement, top: number, geometry = { scrollHeight: 4000, clientHeight: 600 }): void {
    Object.defineProperty(el, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: geometry.clientHeight, configurable: true });
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
}

/** The harness's wire, watched: every `Session.tail` a tab opens, with the cursor it asked for (`stream('session#tail', [key, from])`). */
function watched(base: ActorTransport, tails: unknown[]): ActorTransport {
    return {
        name: base.name,
        call: (symbol, args, init) => base.call(symbol, args, init),
        stream: (symbol, args, init) => {
            if (symbol.endsWith('#tail')) tails.push(args[1]);
            return base.stream(symbol, args, init);
        },
        ...(base.live ? { live: () => base.live!() } : {}),
        ...(base.close ? { close: () => base.close!() } : {})
    };
}

async function chatWith(name: string) {
    const agentId = await h.agent(name, 'Assistant');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
    await chat.addAgent(agentId, 'all');
    /** A message to the member, its task created and routed — what the composer does. */
    const run = async (text: string, taskId: string) => {
        const { messageId } = await chat.post(text, [agentId]);
        await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId as TaskId)).create({ objective: text, origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        return h.app.as(owner).actor(h.Routing, routingKey(WS)).run(taskId as TaskId);
    };
    return { agentId, chatId, chat, run };
}

/** The pages down to the first entry, as the reader would take them: each reach of the top widens the window or reads the previous page. */
async function readBack(dom: ParentNode, n: number, reach: () => void): Promise<void> {
    // Newest page: at most one page held, windowed by the thread.
    expect(bodies(dom).at(-1)).toBe(`message ${n - 1}`);
    expect(bodies(dom).length).toBeLessThanOrEqual(HISTORY_LIMIT);
    reach(); // widens the thread's window to the whole page
    await until(() => bodies(dom).length === HISTORY_LIMIT, 'the whole newest page');
    expect(bodies(dom)[0]).toBe(`message ${n - HISTORY_LIMIT}`);
    expect(chip(dom)).not.toBeNull();
    reach(); // the previous page — held, windowed by the thread
    await until(() => bodies(dom).length > HISTORY_LIMIT, 'the previous page');
    reach(); // the window again
    await until(() => bodies(dom).length === 2 * HISTORY_LIMIT, 'both pages shown');
    expect(bodies(dom)[0]).toBe(`message ${n - 2 * HISTORY_LIMIT}`);
    reach(); // the first page — short: the chat starts here
    await until(() => bodies(dom).length === n, 'the first page');
    expect(bodies(dom)[0]).toBe('message 0');
    // The caller's `historyFrom` (a user reads everything: 0) is reached: nothing older is offered.
    await tick();
    expect(chip(dom)).toBeNull();
    // One contiguous conversation, in order.
    expect(bodies(dom)).toEqual(Array.from({ length: n }, (_, i) => `message ${i}`));
}

describe('/chats/:id opens newest-first (#398)', () => {
    const n = 2 * HISTORY_LIMIT + 50;

    async function longChat() {
        const { chatId, chat } = await chatWith('Atlas');
        for (let i = 0; i < n; i++) await chat.post(`message ${i}`);
        return chatId;
    }

    it('renders the newest page at once, reads the previous page when the reader reaches the top, and stops at the first entry', async () => {
        const chatId = await longChat();
        const tails: unknown[] = [];
        const dom = await mountLive(`/chats/${chatId}`, { ...h, transport: watched(h.transport, tails) });
        await until(() => bodies(dom).length > 0, 'the newest page');
        await readBack(dom, n, () => chip(dom)!.click());
        // No member has run: nothing was tailed, and nothing was read from the log's start.
        expect(tails).toEqual([]);
    });

    it('at a phone’s width the scroll to the top reads the previous page, and the chip does the same', async () => {
        const chatId = await longChat();
        const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
        Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
        try {
            const dom = await mountLive(`/chats/${chatId}`, h);
            await until(() => bodies(dom).length > 0, 'the newest page');
            const root = threadRoot(dom);
            // A scroll to the top asks once; scrolling away re-arms it — a finger dragging back and forth.
            await readBack(dom, n, () => {
                scrollTo(root, 400);
                scrollTo(root, 0);
            });
            expect(root.getAttribute('data-state')).toBe('off');
        } finally {
            if (width) Object.defineProperty(window, 'innerWidth', width);
            else delete (window as { innerWidth?: number }).innerWidth;
        }
    });

    it('a turn running when the chat opens streams into the thread from where it stands — the feed is tailed from the last turn’s end, never from the log’s start — and the member reads ACTIVE from its work, idle once it settles, its session still bound', async () => {
        const { agentId, chatId, chat, run } = await chatWith('Atlas');
        // A first turn, to completion: the session has a past.
        const first = await run('first', 't_1');
        const sessionId = first.sessionId!;
        const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId));
        // The task settles after the session goes idle (the router reads the turn's end); a second message before that is refused as busy.
        await until(async () => (await h.app.as(owner).actor(TaskActor, taskKey(WS, 't_1' as TaskId)).get()).status === 'completed', 'the first task to settle', 5_000);
        expect((await session.get()).status).toBe('idle');
        const anchor = (await session.get()).transcriptAt;
        expect(anchor).toBeDefined();
        expect(anchor).not.toEqual({ epoch: 0, seq: 0 });
        // A second turn in the same session (#393), and the tab opens on it mid-way.
        const second = await run('second', 't_2');
        expect(second.sessionId).toBe(sessionId);
        const tails: unknown[] = [];
        const dom = await mountLive(`/chats/${chatId}`, { ...h, transport: watched(h.transport, tails) });
        await until(() => bodies(dom).some((t) => t.startsWith('abc') && t.length < 10), 'the running turn to stream into the thread', 5_000);
        await until(() => /active/i.test(memberPill(dom, 'Atlas')), 'the member to read active from its task');
        // One tail, from the anchor: the first turn is not replayed — its answer is an entry already.
        expect(tails).toEqual([anchor]);
        // The turn ends: its answer is an entry, once; the in-flight rows are gone.
        await until(() => bodies(dom).filter((t) => t === 'abcdefghij').length === 2, 'both answers as entries', 5_000);
        await tick(20);
        expect(bodies(dom).filter((t) => t.startsWith('abc'))).toHaveLength(2);
        // The work settled, so the member reads idle — while the chat still binds its session.
        await until(() => /idle/i.test(memberPill(dom, 'Atlas')), 'the member to read idle', 5_000);
        expect((await chat.get()).sessions[agentId as AgentId]?.sessionId).toBe(sessionId);
        expect(tails).toEqual([anchor]);
    }, 20_000);
});
