/**
 * The Lanes view on the platform (#1061, CHT-09, COL-09): pinned on a chat where four agents run a turn and
 * one asks a question, every agent at work gets a lane — its step read off its feed — and the idle member none;
 * more than three lanes scroll sideways; the question in a lane's footer is answered with its buttons
 * through the session; below 1024 px the pin shows Team.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatId, MessageId, TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import type { MockStep } from '@sigx/ai-agent/testing';
import { chatKeyOf } from '../../src/actors/keys';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';
import { clearViewPrefs } from './chat-view-prefs';

/** The mock runtime: `slow` runs a long command; `ask` asks which bundler, with two answers; anything else echoes. */
const SCRIPT = {
    respond: (input: readonly { type: string; text?: string }[]): MockStep[] => {
        const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text.includes('slow')) return [
            { text: 'Building.' },
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm build' }, output: 'built', delayMs: 30_000 } },
            { text: 'Built.' }
        ];
        if (text.includes('ask')) return [
            { request: { kind: 'input', message: 'Keep vite or try the sigx bundler?', options: [{ id: 'vite', label: 'Keep vite' }, { id: 'sigx', label: 'Try sigx' }] } },
            { text: 'Thanks.' }
        ];
        return [{ text: `echo: ${text}` }];
    }
};

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(SCRIPT);
});
afterEach(async () => {
    clearViewPrefs();
    await h.stop();
});

const all = (dom: ParentNode, scope: string, part: string): HTMLElement[] => [...dom.querySelectorAll<HTMLElement>(`[data-scope="${scope}"][data-part="${part}"]`)];
const pressed = (dom: ParentNode, control: 'view' | 'detail'): string => dom.querySelector(`[data-chat-control="${control}"] button[aria-pressed="true"]`)?.textContent?.trim() ?? '';
async function press(dom: ParentNode, control: 'view' | 'detail', label: string): Promise<void> {
    const button = [...dom.querySelectorAll<HTMLButtonElement>(`[data-chat-control="${control}"] button`)].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} in ${control}`);
    button.click();
    await tick();
}
const laneNames = (dom: ParentNode): string[] => texts(all(dom, 'ai-lane', 'name'));

/** A chat with `names` as members; `run(agentId, text)` posts to one and routes its task — what the composer does. */
async function chatOf(names: readonly string[]) {
    const ids: Record<string, string> = {};
    for (const n of names) ids[n] = await h.agent(n, 'Builder');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
    for (const n of names) await chat.addAgent(ids[n] as never, 'all');
    let seq = 0;
    const run = async (name: string, text: string) => {
        const agentId = ids[name]!;
        const taskId = `t_${++seq}` as TaskId;
        const { messageId } = await chat.post(text, [agentId as never]);
        await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective: text, origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId as never, context: [], constraints: {} }, { owner: agentId as never });
        await h.app.as(owner).actor(h.Routing, routingKey(WS)).run(taskId);
        return taskId;
    };
    return { chatId, run };
}

describe('/chats/:id Lanes (live)', () => {
    it('a lane per agent at work and none for the idle member; more than three scroll sideways; a question is answered from its footer', async () => {
        const { chatId, run } = await chatOf(['Forge', 'Lint', 'Probe', 'Scout', 'Idle']);
        await run('Forge', 'go slow');
        await run('Lint', 'go slow');
        await run('Probe', 'go slow');
        await run('Scout', 'ask me');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(dom, 'view') !== '', 'the header');
        await press(dom, 'view', 'Lanes');
        expect(pressed(dom, 'detail')).toBe('Steps');
        await until(() => laneNames(dom).length === 4, 'four lanes', 8_000);
        expect(laneNames(dom)).toEqual(['Forge', 'Lint', 'Probe', 'Scout']);
        expect(laneNames(dom)).not.toContain('Idle');
        expect(dom.querySelector('[data-chat-lanes-row]')!.getAttribute('data-scroll')).toBe('x');
        // A working lane shows its step off the feed.
        const forge = dom.querySelector('[data-chat-lane]')!;
        await until(() => texts(all(forge, 'ai-steps', 'target')).includes('pnpm build'), "Forge's step", 8_000);

        const scout = (): Element | undefined => [...dom.querySelectorAll('[data-chat-lane]')].find((l) => l.querySelector('[data-scope="ai-lane"][data-part="name"]')?.textContent === 'Scout');
        await until(() => scout()?.querySelector('[data-scope="ai-lane"][data-part="question"]') != null, "Scout's question", 8_000);
        const q = scout()!.querySelector('[data-scope="ai-lane"][data-part="question"]')!;
        expect(q.textContent).toContain('Keep vite or try the sigx bundler?');
        expect(texts([...q.querySelectorAll('button')])).toEqual(['Keep vite', 'Try sigx']);
        [...q.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Try sigx')!.click();
        // Answered: Scout finishes its turn and, handed nothing, its lane goes.
        await until(() => !laneNames(dom).includes('Scout'), "Scout's lane to go once it answered", 8_000);
        expect(laneNames(dom)).toEqual(['Forge', 'Lint', 'Probe']);
        expect(dom.querySelector('[data-chat-lanes-row]')!.hasAttribute('data-scroll')).toBe(false);
    }, 30_000);

    it('falls back to Team below 1024 px', async () => {
        const { chatId, run } = await chatOf(['Forge', 'Lint']);
        await run('Forge', 'go slow');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(dom, 'view') !== '', 'the header');
        await press(dom, 'view', 'Lanes');
        await until(() => dom.querySelector('[data-chat-lanes]') !== null, 'the lanes');
        const width = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
        try {
            const narrow = await mountLive(`/chats/${chatId}`, h);
            await until(() => pressed(narrow, 'view') === 'Team', 'Team in place of the pinned Lanes');
            expect(narrow.querySelector('[data-chat-lanes]')).toBeNull();
            expect(narrow.querySelector('[data-chat-view-note] > span')?.textContent).toBe('pinned by you · Lanes needs a wider screen, showing Team');
        } finally {
            Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
        }
    }, 20_000);
});
