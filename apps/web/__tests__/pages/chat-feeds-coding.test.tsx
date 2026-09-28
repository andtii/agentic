/**
 * The session feeds fold `coding.*` events (#1106, CHT-09, AGT-09): a member's `coding.terminal` deltas
 * reach the Follow panel's live output — the terminal's tail, not the tool calls' output — and the output
 * updates as more deltas arrive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatId, MessageId, TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import type { MockStep } from '@sigx/ai-agent/testing';
import { chatKeyOf } from '../../src/actors/keys';
import { USER, WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';
import { clearViewPrefs } from './chat-view-prefs';
import { crewChip, withCrewStrip } from './chat-follow-crew';

const terminal = (delta: string): MockStep => ({ ext: { ns: 'coding', name: 'terminal', data: { terminalId: 'term_1', stream: 'stdout', delta } } });

/** A terminal line, a pause, a second line, then a call that hangs so the turn stays live. */
const SCRIPT = {
    respond: (): MockStep[] => [
        terminal('$ pnpm build\nvite v7 building\n'),
        { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm build' }, output: 'tool output, not the terminal', delayMs: 1_500 } },
        terminal('built 111 artifacts\n'),
        { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm dev' }, output: 'never', delayMs: 60_000 } },
        { text: 'done' }
    ]
};

const WIDTH = window.innerWidth;
const setWidth = (width: number): void => { Object.defineProperty(window, 'innerWidth', { value: width, configurable: true }); };

let h: LiveHarness;
let undo: () => void;
beforeEach(async () => {
    undo = withCrewStrip();
    h = await startLive(SCRIPT);
});
afterEach(async () => {
    undo();
    clearViewPrefs();
    setWidth(WIDTH);
    await h.stop();
});

const panel = (dom: ParentNode): HTMLElement | null => dom.querySelector<HTMLElement>('[data-scope="ai-follow"][data-part="root"]');
const output = (dom: ParentNode): string => panel(dom)?.querySelector('[data-scope="ai-follow"][data-part="output"]')?.textContent ?? '';

describe('chat session feeds fold coding events', () => {
    it('shows the coding.terminal output in the Follow panel and updates it as deltas arrive', async () => {
        setWidth(1440);
        const agentId = await h.agent('Forge', 'Builder');
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await chat.addAgent(agentId, 'all');
        const { messageId } = await chat.post('build it', [agentId]);
        await h.app.as(owner).actor(TaskActor, taskKey(WS, 't_1' as TaskId)).create({ objective: 'build it', origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        await h.app.as(owner).actor(h.Routing, routingKey(WS)).run('t_1' as TaskId);

        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelector('[data-scope="ai-live-line"][data-part="root"]') !== null, 'Forge at work', 8_000);
        crewChip(dom, 'Forge').click();
        await tick();
        expect(panel(dom)).not.toBeNull();

        await until(() => output(dom).includes('vite v7 building'), 'the first terminal delta', 8_000);
        await until(() => output(dom).includes('built 111 artifacts'), 'the next terminal delta', 8_000);
        expect(output(dom)).toContain('vite v7 building');
        // The terminal wins over the tool calls' output.
        expect(output(dom)).not.toContain('tool output, not the terminal');
    }, 30_000);
});
