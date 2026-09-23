/**
 * #234 over the real wire, against a Registry that carries the build's
 * catalogue (what the app's Registry is once #231 wires it in): Home names
 * the first step while no runtime is ready and drops it the moment a key is
 * set; the agent form offers only enabled runtime plugins — an unready one
 * with its hint, the agent's own runtime kept (marked) when it is turned off;
 * "New agent" opens on the workspace's default runtime; Settings lists the
 * keys the plugins need, each linking to where it is set.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId } from '@agentic/core';
import { AgentActor, Workspace, agentKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey, workspaceKey } from '@agentic/platform';
import { anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';
import { MEMORY_PLUGINS } from '@agentic/memory';
import { learningDefaultPlugin } from '@agentic/learning';
import { openNewAgent, closeNewAgent } from '../../src/pages/agent/head';
import { buttonNamed, setText, text } from './helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
/** The runtimes the setup flows are written against: one model runtime, one daemon-hosted harness — not every runtime this build ships. */
const SETUP_RUNTIMES = [anthropicApiPlugin, claudeCodePlugin];
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [...SETUP_RUNTIMES, ...MEMORY_PLUGINS, learningDefaultPlugin] });

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    closeNewAgent();
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const agentOf = (id: AgentId) => h.app.as(owner).actor(AgentActor, agentKey(WS, id));
const runtimeSelect = (dom: ParentNode) => dom.querySelector<HTMLSelectElement>('form[data-form="agent"] select[name="runtime"]');
/** The options a select offers — zero's hidden `<select>` always carries the empty placeholder first; it is not one. */
const optionsOf = (select: HTMLSelectElement | null) => (select ? [...select.options].filter((o) => o.value).map((o) => [o.value, text(o)]) : []);
/** zero's Select posts through a hidden `<select>`; the control a screen reader announces is its trigger. */
const controlOf = (el: Element | null) => el?.closest('[data-scope="select"][data-part="root"]')?.querySelector('[data-part="trigger"]') ?? el;
/** What a screen reader announces with the control: the text of every element its `aria-describedby` names. */
const describedBy = (el: Element | null) => (controlOf(el)?.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => text(document.getElementById(id))).join(' ');

describe('Home: the setup checklist (live)', () => {
    it('a fresh workspace is told to add the Anthropic key or pair a machine; the list goes once the key is set, without a reload', async () => {
        const dom = await mountLive('/', h);
        await until(() => dom.querySelector('[data-home-setup]') !== null, 'the checklist');
        const steps = [...dom.querySelectorAll<HTMLElement>('[data-setup-step]')];
        expect(steps.map((s) => s.getAttribute('data-setup-step'))).toEqual(['anthropic-api', 'claude-code']);
        expect(text(steps[0]!.querySelector('[data-setup-title]'))).toBe('Add your Anthropic API key');
        expect(steps[0]!.querySelector('a')!.getAttribute('href')).toBe('/plugins/anthropic-api');
        expect(text(steps[1]!.querySelector('[data-setup-title]'))).toBe('Pair a machine');
        expect(steps[1]!.querySelector('a')!.getAttribute('href')).toBe('/pair');

        await registry().setSecret('anthropic-api-key', 'sk-ant-test');
        await until(() => dom.querySelector('[data-home-setup]') === null, 'the checklist to go once a runtime is ready');
    }, 20_000);
});

describe('/agents/:id Config tab: runtimes and models from the plugins (live)', () => {
    it('a disabled runtime is absent; an unready one carries its hint; its models fill the model select', async () => {
        const atlas = await h.agent('Atlas');
        await registry().disable('claude-code');
        const dom = await mountLive(`/agents/${atlas}?tab=config`, h);
        await until(() => optionsOf(runtimeSelect(dom)).some(([, label]) => label === 'Anthropic API — needs a key'), 'the runtime plugins in the select');

        expect(optionsOf(runtimeSelect(dom))).toEqual([['anthropic-api', 'Anthropic API — needs a key']]);
        expect(describedBy(runtimeSelect(dom))).toContain('anthropic-api-key');
        expect(dom.querySelector('[data-runtime-hint="anthropic-api"] [data-runtime-fix] a')!.getAttribute('href')).toBe('/plugins/anthropic-api');
        const models = [...dom.querySelector<HTMLSelectElement>('form[data-form="agent"] select[name="model"]')!.options].map((o) => o.value);
        expect(models[0]).toBe('');
        expect(models).toContain('claude-opus-5');
        expect(models.at(-1)).toBe('__custom');

        // The key set elsewhere: the hint goes, live.
        await registry().setSecret('anthropic-api-key', 'sk-ant-test');
        await until(() => dom.querySelector('[data-runtime-hint]') === null, 'the hint to go once the runtime is ready');
        expect(optionsOf(runtimeSelect(dom))).toEqual([['anthropic-api', 'Anthropic API']]);
    }, 20_000);

    it('the agent’s own runtime stays in the select, marked, when its plugin is turned off — the form never switches it', async () => {
        const forge = await h.agent('Forge');
        await agentOf(forge).update({ execution: { runtime: 'claude-code', offlinePolicy: 'queue' } }, 'on a machine');
        await registry().disable('claude-code');
        const dom = await mountLive(`/agents/${forge}?tab=config`, h);
        await until(() => optionsOf(runtimeSelect(dom)).some(([v]) => v === 'claude-code' && optionsOf(runtimeSelect(dom)).length > 1), 'the runtime plugins in the select');

        expect(runtimeSelect(dom)!.value).toBe('claude-code');
        expect(optionsOf(runtimeSelect(dom))).toContainEqual(['claude-code', 'Claude Code — turned off']);
        expect(dom.querySelector('[data-runtime-hint="claude-code"]')).not.toBeNull();
        expect(describedBy(runtimeSelect(dom))).toMatch(/turned off/);
        // Nothing moved: the form is clean, so no save card offers to write another runtime.
        expect(dom.querySelector('[data-save-card]')).toBeNull();
    }, 20_000);
});

describe('/agents: New agent opens on the workspace default runtime (live)', () => {
    it('prefills the workspace’s defaults.runtime and creates the agent on it', async () => {
        await h.app.as(owner).actor(Workspace, workspaceKey(WS)).updateSettings({ defaults: { runtime: 'claude-code' } });
        const dom = await mountLive('/agents', h);
        await until(() => dom.querySelector('[data-page="agents"]:not([aria-busy])') !== null, 'the roster');
        openNewAgent();
        const select = () => document.querySelector<HTMLSelectElement>('[data-new-agent-fields] select[name="agent-runtime"]');
        await until(() => select()?.value === 'claude-code' && optionsOf(select()).length === 2, 'the runtime select on the workspace default');
        // Nothing is paired, so the default runtime says what it still needs.
        expect(text(select()!.closest('[data-scope="field"][data-part="root"]')!.querySelector('[data-part="description"]'))).toMatch(/No paired machine/);
        expect(text(document.querySelector('[data-scope="dialog"] [data-part="description"], dialog p'))).toContain('Claude Code');

        setText(document.querySelector<HTMLInputElement>('[data-new-agent-fields] input[name="agent-name"]')!, 'Forge');
        buttonNamed(document, 'Create agent').click();
        await until(async () => (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).get()).agents.length === 1, 'the agent');
        const [agentId] = (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).get()).agents;
        await until(async () => (await agentOf(agentId as AgentId).get()).configVersion === 1, 'its first version');
        expect((await agentOf(agentId as AgentId).get()).config.execution).toMatchObject({ runtime: 'claude-code', offlinePolicy: 'queue' });
    }, 20_000);
});

describe('/settings: API keys are the plugins’ (live)', () => {
    it('lists each declared key, set or not, linking to its plugin — and never a value', async () => {
        const dom = await mountLive('/settings', h);
        const row = () => dom.querySelector<HTMLElement>('[data-api-key][data-secret="anthropic-api-key"]');
        await until(() => row() !== null, 'the Anthropic key row');
        expect(row()!.hasAttribute('data-set')).toBe(false);
        expect(text(row()!.querySelector('[data-scope="ag-pill"] [data-part="label"]'))).toBe('NEEDED');
        expect(row()!.querySelector('a')!.getAttribute('href')).toBe('/plugins/anthropic-api');
        expect(dom.querySelectorAll('input[type="password"]').length).toBe(0);

        await registry().setSecret('anthropic-api-key', 'sk-ant-SETTINGS-NEVER-SHOWN');
        await until(() => row()?.hasAttribute('data-set') === true, 'the row to say it is stored');
        expect(text(row()!.querySelector('[data-scope="ag-pill"] [data-part="label"]'))).toBe('STORED');
        expect(dom.innerHTML).not.toContain('SETTINGS-NEVER-SHOWN');
    }, 20_000);
});

