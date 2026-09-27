/**
 * Settings → Defaults → "Default runtime" (#301, AGT-05) over the real wire:
 * the select lists the enabled runtime plugins (the New agent dialog's
 * source), the choice is written as `defaults.runtime` and New agent opens
 * on it; a saved default whose plugin is turned off stays chosen, marked,
 * and nothing switches it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey, workspaceKey } from '@agentic/platform';
import { anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';
import { MEMORY_PLUGINS } from '@agentic/memory';
import { learningDefaultPlugin } from '@agentic/learning';
import { openNewAgent, closeNewAgent } from '../../src/pages/agent/head';
import { text } from './helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, claudeCodePlugin, ...MEMORY_PLUGINS, learningDefaultPlugin] });

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    closeNewAgent();
    await h.stop();
});

const ws = () => h.app.as(owner).actor(Workspace, workspaceKey(WS));
const runtimeSelect = (dom: ParentNode) => dom.querySelector<HTMLSelectElement>('[data-settings-form] select[name="default-runtime"]');
/** zero's hidden `<select>` carries the empty placeholder first; it is not an option. */
const optionsOf = (select: HTMLSelectElement | null) => (select ? [...select.options].filter((o) => o.value).map((o) => [o.value, text(o)]) : []);
const choose = (select: HTMLSelectElement, value: string): void => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
};
const save = (dom: ParentNode): void => {
    dom.querySelector<HTMLFormElement>('form#settings-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

describe('/settings: the default runtime (live)', () => {
    it('lists the enabled runtime plugins; the choice is saved and New agent opens on it', async () => {
        const dom = await mountLive('/settings', h);
        await until(() => optionsOf(runtimeSelect(dom)).length === 2, 'the runtime plugins in the select');
        expect(optionsOf(runtimeSelect(dom)).map(([v]) => v)).toEqual(['anthropic-api', 'claude-code']);
        expect(runtimeSelect(dom)!.value).toBe('anthropic-api');

        choose(runtimeSelect(dom)!, 'claude-code');
        await until(() => runtimeSelect(dom)!.value === 'claude-code', 'the pick');
        save(dom);
        await until(() => dom.querySelector('[data-settings-status]')!.textContent === 'Saved.', 'the save');
        expect((await ws().get()).settings.defaults).toEqual({ runtime: 'claude-code' });

        // A fresh page — the reload — opens New agent on the saved default.
        const agents = await mountLive('/agents', h);
        await until(() => agents.querySelector('[data-page="agents"]:not([aria-busy])') !== null, 'the roster');
        openNewAgent();
        const select = () => document.querySelector<HTMLSelectElement>('[data-new-agent-fields] select[name="agent-runtime"]');
        await until(() => select()?.value === 'claude-code' && optionsOf(select()).length === 2, 'New agent on the saved default');
    }, 20_000);

    it('a saved default whose plugin is turned off stays chosen and says so; nothing switches it', async () => {
        await ws().updateSettings({ defaults: { runtime: 'claude-code' } });
        await h.app.as(owner).actor(Registry, registryKey(WS)).disable('claude-code');
        const dom = await mountLive('/settings', h);
        await until(() => optionsOf(runtimeSelect(dom)).some(([v, label]) => v === 'claude-code' && label === 'Claude Code — turned off'), 'the turned-off default, marked');
        expect(runtimeSelect(dom)!.value).toBe('claude-code');
        expect(text(runtimeSelect(dom)!.closest('[data-scope="field"][data-part="root"]')!.querySelector('[data-part="description"]'))).toMatch(/turned off/);
        // Saving something else keeps it.
        save(dom);
        await until(() => dom.querySelector('[data-settings-status]')!.textContent === 'Saved.', 'the save');
        expect((await ws().get()).settings.defaults.runtime).toBe('claude-code');
    }, 20_000);
});
