/**
 * The Follow panel on the platform (#1060, CHT-09, AGT-09): a crew chip opens it over the member's session
 * feed — the task (the turn's prompt), the last steps, the live output updating as the calls produce it;
 * Message puts `@Forge ` into the composer; Stop cancels the turn through the feed; a finished turn shows
 * its result and the panel stays open; following adds nothing to the thread; below 1280 px it is a drawer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatId, MessageId, TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import type { MockStep } from '@sigx/ai-agent/testing';
import { chatKeyOf } from '../../src/actors/keys';
import { USER, WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';
import { clearViewPrefs } from './chat-view-prefs';
import { crewChip, withCrewStrip } from './chat-follow-crew';

/** `build`: two calls whose output lands one after the other, then a longer one, then the answer; `hang`: a call that takes a minute. */
const SCRIPT = {
    respond: (input: readonly { type: string; text?: string }[]): MockStep[] => {
        const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text.includes('hang')) return [
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm dev' }, output: 'never', delayMs: 60_000 } },
            { text: 'Stopped?' }
        ];
        if (text.includes('build')) return [
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm --filter @agentic/ui build' }, output: 'vite v7 building\nbuilt 111 artifacts', delayMs: 300 } },
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm --filter @agentic/ui test anatomy' }, output: 'anatomy: 43 scopes\n41 of 43 pass', delayMs: 1_200 } },
            { tool: { name: 'Read', category: 'read', input: { path: 'packages/ui/src/fragment/scopes.ts' }, output: 'export const scopes = [];', delayMs: 3_000 } },
            { text: 'The register builds; 41 of 43 parts pass.' }
        ];
        return [{ text: `echo: ${text}` }];
    }
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

async function chatWith(name: string) {
    const agentId = await h.agent(name, 'Builder');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
    await chat.addAgent(agentId, 'all');
    const run = async (text: string, taskId: string) => {
        const { messageId } = await chat.post(text, [agentId]);
        await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId as TaskId)).create({ objective: text, origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        return h.app.as(owner).actor(h.Routing, routingKey(WS)).run(taskId as TaskId);
    };
    return { agentId, chatId, chat, run };
}

const statusOf = async (taskId: string): Promise<string> => (await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId as TaskId)).get()).status;
const panel = (dom: ParentNode): HTMLElement | null => dom.querySelector<HTMLElement>('[data-scope="ai-follow"][data-part="root"]');
const part = (dom: ParentNode, name: string): string => panel(dom)?.querySelector(`[data-scope="ai-follow"][data-part="${name}"]`)?.textContent ?? '';
const rows = (dom: ParentNode): number => dom.querySelectorAll('[data-scope="ai-thread"][data-part="list"] > li').length;
const button = (root: ParentNode, label: string): HTMLButtonElement | undefined =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label || x.getAttribute('aria-label') === label);

describe('the Follow panel (live)', () => {
    it('opens from a crew chip over the feed: the task, the steps, the live output as it updates, then the result — and stays open', async () => {
        setWidth(1440);
        const { chatId, run } = await chatWith('Forge');
        await run('build the register', 't_1');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelector('[data-scope="ai-live-line"][data-part="root"]') !== null, 'Forge at work', 8_000);
        const before = rows(dom);
        crewChip(dom, 'Forge').click();
        await tick();
        expect(panel(dom)).not.toBeNull();
        expect(dom.querySelector('[data-page="chat"] > [data-chat-follow]')).not.toBeNull();
        expect(part(dom, 'title')).toBe('Following Forge');
        expect(part(dom, 'task')).toContain('build the register');
        // Following added nothing to the thread.
        expect(rows(dom)).toBe(before);

        // The live output: the first call's lines, then the next call's as they land, with the cursor.
        await until(() => part(dom, 'output').includes('built 111 artifacts'), 'the first output', 8_000);
        expect(panel(dom)!.querySelector('[data-part="cursor"]')).not.toBeNull();
        await until(() => part(dom, 'output').includes('41 of 43 pass'), 'the output to update', 8_000);
        expect(panel(dom)!.querySelectorAll('[data-scope="ai-steps"][data-part="step"]').length).toBeGreaterThanOrEqual(2);

        // Done: the result, no cursor, no Stop, and the panel still open.
        await until(() => part(dom, 'result').includes('41 of 43 parts pass'), 'the result', 10_000);
        expect(panel(dom)!.querySelector('[data-part="cursor"]')).toBeNull();
        expect(button(panel(dom)!, 'Stop')).toBeUndefined();
        expect(await statusOf('t_1')).toBe('completed');
    }, 30_000);

    it('Message puts the mention into the composer; Stop cancels the turn through the feed', async () => {
        setWidth(1440);
        const { chatId, run } = await chatWith('Forge');
        await run('hang on', 't_1');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelector('[data-scope="ai-live-line"][data-part="root"]') !== null, 'Forge at work', 8_000);
        crewChip(dom, 'Forge').click();
        await tick();
        button(panel(dom)!, 'Message Forge')!.click();
        await tick();
        await tick();
        expect(dom.querySelector<HTMLTextAreaElement>('[data-chat-composer] textarea')!.value).toContain('@Forge ');

        await until(() => button(panel(dom)!, 'Stop') !== undefined, 'Stop');
        button(panel(dom)!, 'Stop')!.click();
        await until(() => dom.querySelector('[data-scope="ai-live-line"]') === null, 'the live line to go once the turn is cancelled', 8_000);
        await until(async () => ['completed', 'failed', 'cancelled'].includes(await statusOf('t_1')), 'the task to settle', 8_000);
        expect(panel(dom)).not.toBeNull();
    }, 30_000);

    it('opens as a drawer at 1024 px and as a bottom sheet at 400 px', async () => {
        const { chatId, run } = await chatWith('Forge');
        await run('hang on', 't_1');
        for (const [width, placement] of [[1024, 'drawer'], [400, 'sheet']] as const) {
            setWidth(width);
            const dom = await mountLive(`/chats/${chatId}`, h);
            await until(() => dom.querySelector('[data-scope="ai-live-line"][data-part="root"]') !== null, 'Forge at work', 8_000);
            crewChip(dom, 'Forge').click();
            await tick();
            const drawer = document.querySelector<HTMLElement>(`[data-follow-drawer="${placement}"]`);
            expect(drawer?.querySelector('[data-scope="ai-follow"][data-part="root"]')).not.toBeNull();
            expect(drawer!.closest('[data-scope="drawer"][data-part="panel"]')?.getAttribute('data-state')).toBe('open');
            expect(dom.querySelector('[data-page="chat"] > [data-chat-follow]')).toBeNull();
            button(drawer!, 'Close')!.click();
            await tick();
            expect(document.querySelector('[data-follow-drawer]')).toBeNull();
        }
    }, 30_000);
});
