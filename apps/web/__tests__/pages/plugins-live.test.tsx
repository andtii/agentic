/**
 * `/plugins` and `/plugins/:id` over the real wire against a Registry that
 * carries the build's catalogue (#233) — what the app's Registry will be
 * once #231 wires the catalogue in: a fresh workspace lists every built-in
 * with its readiness, a key set elsewhere turns "Needs key" into "Ready"
 * without a reload, a key set on the plugin's page is written once and shown
 * nowhere (not the DOM, not the URL, not the audit), and a config the schema
 * forbids is refused on the form with nothing written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginManifest } from '@agentic/core';
import { AuditActor, auditKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey } from '@agentic/platform';
import { RUNTIME_PLUGINS } from '@agentic/runtimes';
import { MEMORY_PLUGINS } from '@agentic/memory';
import { learningDefaultPlugin } from '@agentic/learning';
import { setText } from './helpers';
import { WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [...RUNTIME_PLUGINS, ...MEMORY_PLUGINS, learningDefaultPlugin] });

/**
 * A plugin with one checked setting — what the form refuses before anything
 * is written. (A bounded NUMBER cannot be typed out of range: zero's number
 * input clamps on blur, so the URI is the value a person can get wrong.)
 */
const tuner: PluginManifest = {
    id: 'tuner',
    version: '0.1.0',
    kind: 'connector',
    name: 'Tuner',
    description: 'A connector with an endpoint.',
    capabilities: [],
    config: { type: 'object', properties: { endpoint: { type: 'string', format: 'uri', title: 'Endpoint' } }, additionalProperties: false },
    permissions: [],
    compat: { platform: '*', core: '*' }
};

const SECRET = 'sk-ant-api03-DO-NOT-SHOW-7f3a9c';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const card = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-scope="ag-plugin-card"][data-part="root"][data-plugin="${id}"]`);
const readinessOf = (el: ParentNode | null) => el?.querySelector('[data-part="readiness"]')?.getAttribute('data-readiness') ?? null;

describe('/plugins (live, with the catalogue)', () => {
    it('a fresh workspace lists every built-in by kind; a key set elsewhere turns anthropic-api from Needs key to Ready without a reload', async () => {
        const dom = await mountLive('/plugins', h);
        await until(() => readinessOf(card(dom, 'anthropic-api')) !== null, 'the catalogue with readiness');
        expect([...dom.querySelectorAll('[data-plugin-group]')].map((g) => g.getAttribute('data-plugin-group'))).toEqual(['runtime:harness', 'runtime:model', 'memory', 'learning']);
        for (const id of ['anthropic-api', 'claude-code', 'agentic.memory.default', 'agentic.memory.flat', 'agentic.learning.default']) expect(card(dom, id), id).not.toBeNull();
        expect(readinessOf(card(dom, 'anthropic-api'))).toBe('needs-secret');
        expect(card(dom, 'anthropic-api')!.textContent).toContain('NEEDS KEY');
        // No machine is paired, so the daemon-hosted runtime has nowhere to run.
        expect(readinessOf(card(dom, 'claude-code'))).toBe('needs-machine');
        // The active memory plugin, marked; the configure link goes to its page.
        expect(card(dom, 'agentic.memory.default')!.hasAttribute('data-mod-selected')).toBe(true);
        expect(card(dom, 'anthropic-api')!.querySelector('a[href="/plugins/anthropic-api"]')).not.toBeNull();

        await registry().setSecret('anthropic-api-key', SECRET);
        await until(() => readinessOf(card(dom, 'anthropic-api')) === 'ready', 'the live overview to flip the badge');
        expect(dom.querySelector('[data-plugin-secrets]')!.textContent).toContain('anthropic-api-key');
        expect(dom.innerHTML).not.toContain(SECRET);
    }, 20_000);
});

describe('/plugins/:id (live, with the catalogue)', () => {
    it('the key is written once from its field and shown nowhere — not the DOM, not the URL, not the audit', async () => {
        const dom = await mountLive('/plugins/anthropic-api', h);
        const field = () => dom.querySelector<HTMLElement>('[data-scope="ag-secret"][data-part="root"][data-secret="anthropic-api-key"]');
        const box = () => field()?.querySelector<HTMLInputElement>('input[type="password"]') ?? null;
        await until(() => box() !== null && !box()!.disabled, 'the key field, enabled once mounted');
        expect(readinessOf(dom)).toBe('needs-secret');
        // Write-only by construction: no form name, nothing autofilled.
        expect(box()!.hasAttribute('name')).toBe(false);
        expect(box()!.getAttribute('autocomplete')).toBe('off');

        setText(box()!, SECRET);
        field()!.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => (await registry().overview()).secretNames.includes('anthropic-api-key'), 'the Registry to hold the key');
        await until(() => field()?.hasAttribute('data-set') === true && readinessOf(dom) === 'ready', 'the field to say it is set, and the plugin ready');

        expect(dom.innerHTML).not.toContain(SECRET);
        expect(window.location.href).not.toContain(SECRET);
        const audit = await h.app.as(owner).actor(AuditActor, auditKey(WS)).list();
        expect(JSON.stringify(audit)).not.toContain(SECRET);
    }, 20_000);

    it('a config the schema forbids shows its field error and writes nothing; a valid one saves', async () => {
        await registry().register(tuner, { enabled: true });
        const dom = await mountLive('/plugins/tuner', h);
        const endpoint = () => dom.querySelector<HTMLInputElement>('form[data-form="schema"] input[name$="endpoint"]');
        const form = () => dom.querySelector<HTMLFormElement>('form[data-form="schema"]')!;
        const type = (value: string) => setText(endpoint()!, value);
        await until(() => endpoint() !== null, 'the settings form');

        type('not a url');
        form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => form().querySelector('[role="alert"]') !== null, 'the field error');
        await tick();
        expect(form().querySelector('[role="alert"]')!.textContent).not.toBe('');
        expect(dom.querySelector('[data-plugin-saved]')).toBeNull();
        expect((await registry().get('tuner'))!.config).toEqual({});

        type('https://tuner.example/mcp');
        form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => dom.querySelector('[data-plugin-saved]') !== null, 'the save');
        expect((await registry().get('tuner'))!.config).toEqual({ endpoint: 'https://tuner.example/mcp' });
    }, 20_000);
});
