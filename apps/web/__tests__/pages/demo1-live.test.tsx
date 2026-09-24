/**
 * Demo 1 through the pages (#35): the `smoke:demo1` walk-through driven on
 * the live harness with the mock model — `/agents` → New agent → the
 * agent's Config tab (a save is a new version on the actor) → Start chat →
 * the composer → the answer in the thread. The same clicks the Playwright
 * spec makes against a preview Worker, proven offline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentActor, Chat, Workspace, workspaceKey } from '@agentic/platform';
import { agentKeyOf, chatKeyOf } from '../../src/actors/keys';
import { topbarFor } from '../../src/components/topbar';
import { agentHead, newAgentRequest } from '../../src/pages/agent/head';
import { CREATED_REASON } from '../../src/pages/agent/live';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    newAgentRequest.open = false;
    await h.stop();
});

const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label);
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('demo 1 on the live pages', () => {
    it('creates the agent, saves its config, starts a chat and gets the answer', async () => {
        const dom = await mountLive('/agents', h);
        await until(() => dom.querySelector('[data-page="agents"]:not([aria-busy])') !== null, 'the roster');
        expect(dom.querySelectorAll('[data-agent-card]')).toHaveLength(0);
        expect(dom.querySelector('[data-scope="empty-state"][data-part="root"], [data-page="agents"] [data-part="root"]')).not.toBeNull();

        // The topbar's "New agent" raises the dialog the live roster answers.
        const actions = await mountLive('/agents', h, <div>{topbarFor({ name: 'agents', path: '/agents', params: {} })!.actions!()}</div>);
        button(actions, 'New agent').click();
        await until(() => document.querySelector('[data-new-agent-fields]') !== null, 'the new-agent dialog');
        // Confirming with no name keeps the dialog open and marks the field.
        button(document.body, 'Create agent').click();
        await tick();
        expect(document.querySelector('[data-new-agent-fields]')).not.toBeNull();
        type(document.querySelector<HTMLInputElement>('[data-new-agent-fields] input[name="agent-name"]')!, 'Ada');
        type(document.querySelector<HTMLInputElement>('[data-new-agent-fields] input[name="agent-role"]')!, 'Demo assistant');
        button(document.body, 'Create agent').click();

        // The record and its first version exist, and the page moved to the agent's Config tab.
        await until(() => h.app.saves.some((s) => s.type === 'Agent'), 'the agent to be saved');
        const index = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).get();
        expect(index.agents).toHaveLength(1);
        const agentId = index.agents[0]!;
        const agent = h.app.as(owner).actor(AgentActor, agentKeyOf(USER, agentId));
        expect(await agent.listVersions()).toMatchObject([{ version: 1, reason: CREATED_REASON }]);
        expect((await agent.get()).config).toMatchObject({ name: 'Ada', role: 'Demo assistant', execution: { runtime: 'anthropic-api' } });
        await until(() => dom.querySelector(`[data-page="agent"][data-agent="${agentId}"]:not([aria-busy])`) !== null, 'the agent page');
        expect(dom.querySelector('[data-agent-name]')!.textContent).toBe('Ada');
        expect(dom.querySelector('[data-agent-role]')!.textContent).toBe('Demo assistant');
        expect(dom.querySelector('[data-scope="ag-env-line"]')?.getAttribute('title')).toBe('platform / anthropic-api / byo-key');
        expect(dom.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Config');
        expect(agentHead.value).toEqual({ id: agentId, name: 'Ada', role: 'Demo assistant' });
        expect(topbarFor({ name: 'agent', path: `/agents/${agentId}`, params: { id: agentId } })?.crumb).toBe('Ada');

        // The form is bound to the live config; a save is a new version through the actor.
        const form = dom.querySelector<HTMLFormElement>('form[data-form="agent"]')!;
        expect(form.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Ada');
        expect(form.querySelector<HTMLSelectElement>('select[name="runtime"]')!.value).toBe('anthropic-api');
        expect(dom.querySelectorAll('[data-versions-list] [data-scope="ag-version"][data-part="root"]')).toHaveLength(1);
        type(form.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]')!, 'Be brief. Answer in one sentence.');
        await until(() => dom.querySelector('[data-save-card]') !== null, 'the save card');
        expect(button(dom, 'Save as v2')).toBeDefined();
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => dom.querySelectorAll('[data-versions-list] [data-scope="ag-version"][data-part="root"]').length === 2, 'v2 in the rail');
        expect((await agent.get()).config.instructions).toBe('Be brief. Answer in one sentence.');
        expect((await agent.listVersions()).map((v) => v.version)).toEqual([1, 2]);
        await until(() => dom.querySelector('[data-save-card]') === null, 'the save card to go');

        // "Start chat": a direct chat with this agent, and the page moves to it.
        button(dom, 'Start chat').click();
        await until(() => dom.querySelector('[data-page="chat"]') !== null, 'the chat page');
        const chats = (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).get()).chats;
        expect(chats).toHaveLength(1);
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chats[0]!));
        expect(Object.keys((await chat.get()).members)).toEqual([agentId]);
        await until(() => dom.querySelector('[data-scope="ai-composer"] textarea') !== null && (dom.querySelector('[data-scope="ai-composer"][data-part="addressing"]')?.textContent?.includes('Ada') ?? false), 'the composer addressing Ada');

        // Post; the answer lands in the thread, attributed to Ada.
        type(dom.querySelector<HTMLTextAreaElement>('[data-scope="ai-composer"] textarea')!, 'Say hello in five words.');
        dom.querySelector('form[data-scope="ai-composer"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        const bodies = () => texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="body"]'));
        await until(() => bodies().some((t) => t.includes('echo: Say hello in five words.')), 'the answer');
        const names = texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="name"]'));
        expect(names).toContain('Ada');
        const history = await chat.history(null, 50);
        const msgs = history.entries.filter((e) => e.entry.t === 'msg').map((e) => e.entry as Extract<typeof e.entry, { t: 'msg' }>);
        expect(msgs.map((m) => m.author.kind)).toEqual(['user', 'agent']);
    });
});
