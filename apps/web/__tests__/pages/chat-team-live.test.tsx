/**
 * The Team view on the platform (#1059, CHT-09, COL-09): the chat moves to Team when a second agent starts
 * working and back to Focus when one is left; each agent at work is one work card fed by its session, its
 * in-flight rows folded in; a coordinator's delegate step is a handoff line and the answer since is a done
 * card; agent-to-agent talk folds; a question says what it blocks and answers through the session; the
 * composer names the coordinator.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import type { MockStep } from '@sigx/ai-agent/testing';
import { chatKeyOf } from '../../src/actors/keys';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';
import { clearViewPrefs } from './chat-view-prefs';

/** Who `split` hands work to: set once the agents exist. */
const roster: { lint?: string } = {};

/**
 * The mock runtime: `slow` runs a build for a minute; `brief` runs lint for a few seconds; `split` delegates to
 * Lint; `ask` asks which bundler; anything else echoes.
 */
const SCRIPT = {
    respond: (input: readonly { type: string; text?: string }[]): MockStep[] => {
        const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text.includes('slow')) return [
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm build' }, output: 'built', delayMs: 60_000 } },
            { text: 'Built.' }
        ];
        if (text.includes('brief')) return [
            { tool: { name: 'Bash', category: 'execute', input: { command: 'pnpm lint' }, output: 'clean', delayMs: 4_000 } },
            { text: 'Lint is clean.' }
        ];
        if (text.includes('split')) return [
            { tool: { name: 'tasks_delegate', input: { assignee: roster.lint, objective: 'Check the fragments', item: 22 }, output: '{"taskId":"t_22"}' } },
            { text: 'Lint checks the fragments.' }
        ];
        if (text.includes('ask')) return [{ request: { kind: 'input', message: 'Which bundler?' } }, { text: 'thanks' }];
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

async function crew() {
    const forge = await h.agent('Forge', 'Builder');
    const lint = await h.agent('Lint', 'Checker');
    roster.lint = lint;
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
    await chat.addAgent(forge, 'all');
    await chat.addAgent(lint, 'all');
    await chat.setCoordinator(forge as AgentId);
    /** A message to one member, its task created and routed — what the composer does. */
    const run = async (agentId: AgentId, text: string, taskId: string) => {
        const { messageId } = await chat.post(text, [agentId]);
        await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId as TaskId)).create({ objective: text, origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        return h.app.as(owner).actor(h.Routing, routingKey(WS)).run(taskId as TaskId);
    };
    return { forge, lint, chatId, chat, run };
}

const settled = async (taskId: string): Promise<void> =>
    until(async () => ['completed', 'failed', 'cancelled'].includes((await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId as TaskId)).get()).status), `task ${taskId} to settle`, 10_000);

const all = (dom: ParentNode, scope: string, part: string): HTMLElement[] => [...dom.querySelectorAll<HTMLElement>(`[data-scope="${scope}"][data-part="${part}"]`)];
const note = (dom: ParentNode): string => dom.querySelector('[data-chat-view-note] > span')?.textContent ?? '';
const pressed = (dom: ParentNode, control: 'view' | 'detail'): string => dom.querySelector(`[data-chat-control="${control}"] button[aria-pressed="true"]`)?.textContent?.trim() ?? '';
async function press(dom: ParentNode, control: 'view' | 'detail', label: string): Promise<void> {
    const button = [...dom.querySelectorAll<HTMLButtonElement>(`[data-chat-control="${control}"] button`)].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} in ${control}`);
    button.click();
    await tick();
}
const card = (dom: ParentNode, agentId: string): HTMLElement | null => dom.querySelector(`[data-chat-team-agent="${agentId}"] [data-scope="ai-work-card"][data-part="root"]`);

describe('/chats/:id Team (live)', () => {
    it('switches to Team when a second agent starts working, one work card each fed by its session, and back to Focus when one is left', async () => {
        const { forge, lint, chatId, run } = await crew();
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(dom, 'view') === 'Focus', 'the header');
        expect(dom.querySelector('[data-scope="ai-composer"][data-part="hint"]')?.textContent).toBe('Forge answers unless you @ someone');

        await run(forge, 'go slow', 't_1');
        await run(lint, 'go brief', 't_2');
        await until(() => pressed(dom, 'view') === 'Team', 'the switch to Team', 8_000);
        expect(note(dom)).toBe('2 agents working · Team picked automatically');
        expect(pressed(dom, 'detail')).toBe('Messages');
        expect(texts(all(dom, 'ai-crew', 'name'))).toEqual(['Forge', 'Lint']);
        expect(all(dom, 'ai-crew', 'chip').map((c) => c.getAttribute('data-state'))).toEqual(['running', 'running']);

        // One card per agent, its steps from the feed: it updates in place, never a row per step.
        await until(() => card(dom, forge)?.querySelector('[data-scope="ai-steps"][data-part="target"]')?.textContent === 'pnpm build', "Forge's card step", 8_000);
        const forgeCard = card(dom, forge)!;
        expect(forgeCard.getAttribute('data-state')).toBe('running');
        await until(() => card(dom, lint)?.querySelector('[data-scope="ai-steps"][data-part="target"]')?.textContent === 'pnpm lint', "Lint's card step", 8_000);
        expect(dom.querySelectorAll(`[data-chat-team-agent="${forge}"]`)).toHaveLength(1);
        expect(dom.querySelectorAll(`[data-chat-team-agent="${lint}"]`)).toHaveLength(1);
        // The turns in flight are in the cards, not rows of their own.
        expect(texts(all(dom, 'ai-message', 'name'))).toEqual(['You', 'You']);
        expect(card(dom, forge)).toBe(forgeCard);

        // Lint finishes: one agent left, back to Focus.
        await settled('t_2');
        await until(() => pressed(dom, 'view') === 'Focus', 'the switch back to Focus', 8_000);
        expect(note(dom)).toBe('one agent working · Focus picked automatically');
        expect(dom.querySelector('[data-chat-team-crew]')).toBeNull();
    }, 30_000);

    it("the coordinator's delegate step is a handoff line, and the answer since is a done card", async () => {
        const { forge, lint, chatId, run } = await crew();
        await run(forge, 'split it', 't_1');
        await settled('t_1');
        await run(lint, 'report back', 't_2');
        await settled('t_2');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(dom, 'view') === 'Focus', 'the header');
        await press(dom, 'view', 'Team');
        await until(() => dom.querySelector(`[data-chat-team-handoff="${lint}"]`) !== null, 'the handoff line');
        const handoff = dom.querySelector(`[data-chat-team-handoff="${lint}"]`)!;
        expect(handoff.querySelector('[data-part="from"] > span:last-child')?.textContent).toBe('Forge');
        expect(handoff.querySelector('[data-part="to"] > span:last-child')?.textContent).toBe('Lint');
        expect(handoff.querySelector('[data-part="ref"]')?.textContent).toBe('#22');
        const done = card(dom, lint)!;
        expect(done.getAttribute('data-state')).toBe('complete');
        expect(done.querySelector('[data-part="task"]')?.textContent).toBe('#22');
        expect(done.querySelector('[data-part="result"]')?.textContent).toBe('echo: report back');
        // The answer is the card, not a row as well.
        expect(texts(all(dom, 'ai-message', 'name'))).toEqual(['You', 'Forge', 'You']);
    }, 30_000);

    it('agent-to-agent talk folds into one line; show opens it in place', async () => {
        const { forge, chatId, run } = await crew();
        await run(forge, 'tell @Lint the build is green', 't_1');
        await settled('t_1');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(dom, 'view') === 'Focus', 'the header');
        await press(dom, 'view', 'Team');
        await until(() => all(dom, 'ai-folded-talk', 'label').length > 0, 'the folded talk');
        expect(all(dom, 'ai-folded-talk', 'label')[0]!.textContent).toMatch(/^Forge and Lint exchanged \d+ messages? ·$/);
        expect(texts(all(dom, 'ai-message', 'body')).some((t) => t.includes('echo: tell @Lint'))).toBe(false);
        all(dom, 'ai-folded-talk', 'show')[0]!.click();
        await tick();
        expect(all(dom, 'ai-folded-talk', 'show')[0]!.textContent?.trim()).toBe('hide');
        expect(texts(all(dom, 'ai-message', 'body')).some((t) => t.includes('echo: tell @Lint'))).toBe(true);
    }, 30_000);

    it('a question says what it blocks and answers through the session', async () => {
        const { forge, lint, chatId, run } = await crew();
        await run(forge, 'split it', 't_1');
        await settled('t_1');
        await run(lint, 'ask me', 't_2');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => pressed(dom, 'view') !== '', 'the header');
        await press(dom, 'view', 'Team');
        await until(() => dom.querySelector('[data-chat-team-question]') !== null, 'the question', 8_000);
        const q = dom.querySelector('[data-chat-team-question]')!;
        expect(q.querySelector('[data-chat-team-blocks]')?.textContent).toBe('blocks #22');
        expect(q.querySelector('[data-scope="ai-question"][data-part="prompt"]')?.textContent).toBe('Which bundler?');
        expect(all(dom, 'ai-crew', 'chip').map((c) => c.getAttribute('data-state'))).toEqual(['paused', 'loading']);
        (q.querySelector('[data-chat-team-answer-text] button') as HTMLButtonElement).click();
        const box = q.querySelector('textarea')!;
        expect(document.activeElement).toBe(box);
        box.value = 'vite';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        const answer = [...q.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Answer')!;
        await until(() => !answer.disabled, 'the answer button');
        answer.click();
        await settled('t_2');
        expect((await h.app.as(owner).actor(TaskActor, taskKey(WS, 't_2' as TaskId)).get()).result?.text).toBe('thanks');
        await until(() => dom.querySelector('[data-chat-team-question]') === null, 'the question to go', 8_000);
    }, 30_000);
});
