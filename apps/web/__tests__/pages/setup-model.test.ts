/**
 * The runtime options and the Home checklist as pure functions (#234): the
 * agent form offers enabled runtime plugins with what each still needs, the
 * agent's current runtime is never dropped silently, and the checklist names
 * the next step until one runtime is ready.
 */
import { describe, expect, it } from 'vitest';
import type { PluginReadiness } from '@agentic/core';
import type { PluginView } from '@agentic/platform';
import { opsPlugins } from '../../src/mock/ops';
import { initialRuntime, modelsOf, runtimeOptions } from '../../src/pages/agent/runtimes';
import { setupSteps } from '../../src/pages/home/setup';

const plugin = (id: string): PluginView => opsPlugins.find((p) => p.manifest.id === id)!;
const off = (p: PluginView): PluginView => ({ ...p, enabled: false });
const NEEDS_KEY: PluginReadiness = { status: 'needs-secret', missing: ['anthropic-api-key'] };
const NEEDS_MACHINE: PluginReadiness = { status: 'needs-machine' };
const READY: PluginReadiness = { status: 'ready' };

describe('runtimeOptions', () => {
    it('offers each enabled runtime plugin by name, with its models and default, and a hint only when it is not ready', () => {
        const options = runtimeOptions(opsPlugins, { 'anthropic-api': NEEDS_KEY, 'claude-code': READY, 'copilot-cli': READY, 'codex-cli': NEEDS_MACHINE })!;
        expect(options.map((o) => o.value)).toEqual(['anthropic-api', 'claude-code', 'copilot-cli', 'codex-cli']);
        const api = options[0]!;
        expect(api.label).toBe('Anthropic API — needs a key');
        expect(api.hint).toContain('anthropic-api-key');
        expect(api).toMatchObject({ href: '/plugins/anthropic-api', hrefLabel: 'Add the key', defaultModel: 'claude-opus-5' });
        expect(api.models).toEqual(modelsOf(plugin('anthropic-api')));
        expect(api.models).toContain('claude-sonnet-5');
        expect(options[1]).toEqual({ value: 'claude-code', label: 'Claude Code' });
        expect(options[2]).toEqual({ value: 'copilot-cli', label: 'Copilot CLI' });
        expect(options[3]).toMatchObject({ value: 'codex-cli', label: 'Codex — needs a machine', href: '/pair' });
    });

    it('a runtime that needs a machine links to pairing', () => {
        const cc = runtimeOptions(opsPlugins, { 'claude-code': NEEDS_MACHINE })!.find((o) => o.value === 'claude-code')!;
        expect(cc).toMatchObject({ label: 'Claude Code — needs a machine', href: '/pair', hrefLabel: 'Pair a machine' });
    });

    it('a disabled runtime is not offered — unless the agent is on it, then it stays, marked turned off', () => {
        const plugins = opsPlugins.map((p) => (p.manifest.id === 'claude-code' ? off(p) : p));
        expect(runtimeOptions(plugins, {})!.map((o) => o.value)).toEqual(['anthropic-api', 'copilot-cli', 'codex-cli']);
        const kept = runtimeOptions(plugins, {}, 'claude-code')!;
        // The agent's own runtime is kept at the end, after the ones on offer.
        expect(kept.map((o) => o.value)).toEqual(['anthropic-api', 'copilot-cli', 'codex-cli', 'claude-code']);
        expect(kept[3]).toMatchObject({ label: 'Claude Code — turned off', href: '/plugins/claude-code', hrefLabel: 'Turn it on' });
        expect(kept[3]!.hint).toMatch(/turned off/);
    });

    it('a runtime no plugin provides stays when it is the agent’s, marked not installed', () => {
        const kept = runtimeOptions(opsPlugins, {}, 'a2a:elsewhere')!;
        expect(kept.at(-1)).toMatchObject({ value: 'a2a:elsewhere', label: 'a2a:elsewhere — not installed', href: '/plugins' });
    });

    it('a Registry with no runtime plugin (no catalogue behind it) leaves the form its own list', () => {
        expect(runtimeOptions(opsPlugins.filter((p) => p.manifest.kind !== 'runtime'), {}, 'anthropic-api')).toBeUndefined();
    });

    it('a new agent opens on the workspace default when offered, else the first ready runtime', () => {
        const options = runtimeOptions(opsPlugins, { 'anthropic-api': NEEDS_KEY, 'claude-code': READY })!;
        expect(initialRuntime(options, 'anthropic-api')).toBe('anthropic-api');
        expect(initialRuntime(options, 'gone')).toBe('claude-code');
        expect(initialRuntime(options, undefined)).toBe('claude-code');
    });
});

describe('setupSteps', () => {
    const runtimes = [plugin('anthropic-api'), plugin('claude-code')];

    it('a fresh workspace: add the key, or pair a machine', () => {
        const steps = setupSteps({ plugins: opsPlugins, readiness: { 'anthropic-api': NEEDS_KEY, 'claude-code': NEEDS_MACHINE }, machines: [] })!;
        expect(steps.map((s) => [s.title, s.href])).toEqual([
            ['Add your Anthropic API key', '/plugins/anthropic-api'],
            ['Pair a machine', '/pair']
        ]);
    });

    it('a paired machine without an environment: add one on its page (a pending pairing does not count)', () => {
        const machines = [{ id: 'm_pending', name: 'new', status: 'pending' }, { id: 'm1', name: 'alien01', status: 'paired' }];
        const steps = setupSteps({ plugins: runtimes, readiness: { 'anthropic-api': NEEDS_KEY, 'claude-code': NEEDS_MACHINE }, machines })!;
        expect(steps[1]).toMatchObject({ title: 'Add an environment', href: '/machines/m1' });
        expect(steps[1]!.detail).toContain('alien01');
    });

    it('is gone once any runtime is ready, and not shown without runtime plugins', () => {
        expect(setupSteps({ plugins: runtimes, readiness: { 'anthropic-api': READY, 'claude-code': NEEDS_MACHINE }, machines: [] })).toBeNull();
        expect(setupSteps({ plugins: opsPlugins.filter((p) => p.manifest.kind !== 'runtime'), readiness: {}, machines: [] })).toBeNull();
    });

    it('every runtime turned off: turn one on', () => {
        const steps = setupSteps({ plugins: runtimes.map(off), readiness: { 'anthropic-api': { status: 'disabled' }, 'claude-code': { status: 'disabled' } }, machines: [] })!;
        expect(steps).toEqual([expect.objectContaining({ title: 'Turn a runtime on', href: '/plugins' })]);
    });

    it('a deployment that cannot seal keys says so, with nothing to click', () => {
        const steps = setupSteps({ plugins: [plugin('anthropic-api')], readiness: { 'anthropic-api': { status: 'no-kek' } }, machines: [] })!;
        expect(steps[0]).toMatchObject({ title: 'This deployment cannot store keys' });
        expect(steps[0]!.href).toBeUndefined();
    });
});
