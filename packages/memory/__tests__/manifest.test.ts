import { configDefaults, isSingleSlot, validateConfig, type PluginManifest } from '@agentic/core';
import { MEMORY_PLUGINS, flatMemoryPlugin, memoryDefaultPlugin, memoryFlatPlugin, memoryPlugin } from '../src/index';

const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** The Registry's `assertPluginManifest` rules, restated: this package sits below `@agentic/platform` and cannot import it. */
function expectRegistrable(m: PluginManifest): void {
    expect(m.id).toMatch(NAME_RE);
    expect(m.version).not.toBe('');
    expect(m.name.trim()).not.toBe('');
    expect(typeof m.description).toBe('string');
    expect(m.capabilities.every((c) => typeof c === 'string')).toBe(true);
    for (const p of m.permissions) expect(p.reason.trim()).not.toBe('');
    // Every declared secret can be opened: it has its own `secret:<name>` scope (PLG-04).
    for (const s of m.secrets ?? []) expect(m.permissions.map((p) => p.scope)).toContain(`secret:${s.name}`);
    expect(validateConfig(m.config, configDefaults(m.config))).toMatchObject({ ok: true });
    expect(validateConfig(m.config, { ...configDefaults(m.config), stray: true }).ok).toBe(false);
}

describe('memory plugin manifests', () => {
    it.each(MEMORY_PLUGINS.map((m) => [m.id, m] as const))('%s is registrable', (_id, m) => {
        expect(m.kind).toBe('memory');
        expect(isSingleSlot(m.kind)).toBe(true);
        expect(m.permissions.map((p) => p.scope)).toEqual(['memory:read', 'memory:write']);
        expectRegistrable(m);
    });

    it('each manifest names the plugin it describes', () => {
        const live = [memoryPlugin(), flatMemoryPlugin()];
        expect([memoryDefaultPlugin, memoryFlatPlugin].map((m) => [m.id, m.version])).toEqual(live.map((p) => [p.id, p.version]));
    });

    it('says what each plugin exports, as the plugin does', () => {
        expect(memoryDefaultPlugin.capabilities).toContain(`export:${memoryPlugin().capabilities.export}`);
        expect(memoryFlatPlugin.capabilities).toContain(`export:${flatMemoryPlugin().capabilities.export}`);
    });

    it('the default comes first', () => {
        expect(MEMORY_PLUGINS[0]).toBe(memoryDefaultPlugin);
    });
});
