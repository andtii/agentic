/**
 * The chat's views on the platform (#1058, CHT-09): a finished turn's steps come from its chat entry
 * (`msg.steps`, #1055) and fold into one steps box — open by itself when a failure stopped the work; Messages
 * drops it; Raw reads the turn's calls back from the Session; a pin survives a remount; the turn in flight
 * shows its live line, whose Stop cancels it through the feed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatId, MessageId, TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import type { MockStep } from '@sigx/ai-agent/testing';
import { chatKeyOf } from '../../src/actors/keys';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';
import { clearViewPrefs } from './chat-view-prefs';

/** The mock runtime: `fail` runs a failing command and says so; `slow` runs a command that takes a minute; anything else echoes. */
const SCRIPT = {
    respond: (input: readonly { type: string; text?: string }[]): MockStep[] => {
        const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text.includes('fail')) return [
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm test' }, status: 'failed', error: 'Error: 2 tests failed\nexit 1' } },
            { text: 'The tests fail.' }
        ];
        if (text.includes('slow')) return [
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm build' }, output: 'built', delayMs: 60_000 } },
            { text: 'Built.' }
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

async function chatWith(name: string) {
    const agentId = await h.agent(name, 'Builder');
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

const settled = async (taskId: string): Promise<void> =>
    until(async () => ['completed', 'failed', 'cancelled'].includes((await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId as TaskId)).get()).status), `task ${taskId} to settle`, 8_000);

const all = (dom: ParentNode, scope: string, part: string): HTMLElement[] => [...dom.querySelectorAll<HTMLElement>(`[data-scope="${scope}"][data-part="${part}"]`)];
const pressed = (dom: ParentNode, control: 'view' | 'detail'): string => dom.querySelector(`[data-chat-control="${control}"] button[aria-pressed="true"]`)?.textContent?.trim() ?? '';
async function press(dom: ParentNode, control: 'view' | 'detail', label: string): Promise<void> {
    const button = [...dom.querySelectorAll<HTMLButtonElement>(`[data-chat-control="${control}"] button`)].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} in ${control}`);
    button.click();
    await tick();
}

describe('/chats/:id views (live)', () => {
    it('a finished turn is one steps box from its entry, open by itself when its failure stopped the work; Messages drops it; Raw reads its calls back from the Session', async () => {
        const { chatId, run } = await chatWith('Forge');
        await run('please fail', 't_1');
        await settled('t_1');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => all(dom, 'ai-steps', 'label').length === 1, 'the steps box');
        expect(dom.querySelector('[data-chat-view-note] > span')?.textContent).toBe('no agent working · Focus picked automatically');
        expect(pressed(dom, 'view')).toBe('Focus');
        expect(pressed(dom, 'detail')).toBe('Steps');
        expect(texts(all(dom, 'ai-steps', 'label'))).toEqual(['1 step · 1 command · 1 failed']);
        expect(all(dom, 'ai-steps', 'summary')[0]!.getAttribute('aria-expanded')).toBe('true');
        expect(texts(all(dom, 'ai-steps', 'target'))[0]).toContain('pnpm test');
        // Full output: the call in its session.
        const full = all(dom, 'ai-steps', 'full')[0]!.getAttribute('href')!;
        expect(full).toMatch(/^\/sessions\/[^?]+\?call=/);
        expect(all(dom, 'ai-tool-call', 'root')).toHaveLength(0);

        await press(dom, 'detail', 'Messages');
        expect(all(dom, 'ai-steps', 'root')).toHaveLength(0);
        expect(texts(all(dom, 'ai-message', 'body')).some((t) => t.includes('The tests fail.'))).toBe(true);

        await press(dom, 'detail', 'Raw');
        await until(() => all(dom, 'ai-tool-call', 'root').length === 1, 'the call read back from the Session');
        expect(all(dom, 'ai-steps', 'root')).toHaveLength(0);
    }, 20_000);

    it('a pinned view survives a remount', async () => {
        const { chatId, chat } = await chatWith('Forge');
        await chat.post('hello');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(dom, 'view') === 'Focus', 'the header');
        await press(dom, 'view', 'Team');
        expect(pressed(dom, 'view')).toBe('Team');
        expect(pressed(dom, 'detail')).toBe('Messages');
        const again = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(again, 'view') === 'Team', 'the pin read back');
        expect(again.querySelector('[data-chat-view-note] > span')?.textContent).toBe('pinned by you · a work card per agent at work');
    });

    it('the turn in flight has its live line under the last turn, and Stop cancels it through the feed', async () => {
        const { chatId, run } = await chatWith('Forge');
        await run('go slow', 't_1');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelector('[data-scope="ai-live-line"][data-part="root"]') !== null, 'the live line', 8_000);
        const line = dom.querySelector('[data-scope="ai-live-line"][data-part="root"]')!;
        expect(line.querySelector('[data-part="agent"]')?.textContent).toContain('Forge');
        await until(() => line.querySelector('[data-part="step"]')?.textContent === 'Bash · pnpm build', 'the current step');
        expect(dom.querySelector('[data-chat-view-note] > span')?.textContent).toBe('one agent working · Focus picked automatically');
        // The turn in flight folds its tool parts into a steps box too.
        expect(texts(all(dom, 'ai-steps', 'label'))).toEqual(['1 step · 1 command']);
        (line.querySelector('[data-part="stop"] button') as HTMLButtonElement).click();
        await until(() => dom.querySelector('[data-scope="ai-live-line"]') === null, 'the line to go once the turn is cancelled', 8_000);
        await settled('t_1');
    }, 20_000);
});
