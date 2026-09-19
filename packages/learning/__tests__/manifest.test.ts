import { configDefaults, isSingleSlot, validateConfig } from '@agentic/core';
import { learningDefaultPlugin, learningPlugin } from '../src/index';

describe('learning plugin manifest', () => {
    // The Registry's `assertPluginManifest` rules, restated: this package sits below `@agentic/platform` and cannot import it.
    it('is registrable', () => {
        const m = learningDefaultPlugin;
        expect(m.kind).toBe('learning');
        expect(isSingleSlot(m.kind)).toBe(true);
        expect(m.id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
        expect(m.name.trim()).not.toBe('');
        for (const p of m.permissions) expect(p.reason.trim()).not.toBe('');
        expect(validateConfig(m.config, configDefaults(m.config))).toMatchObject({ ok: true });
        expect(validateConfig(m.config, { stray: true }).ok).toBe(false);
    });

    it('names the plugin it describes', () => {
        const plugin = learningPlugin();
        expect([learningDefaultPlugin.id, learningDefaultPlugin.version]).toEqual([plugin.id, plugin.version]);
    });

    it('asks for memory and nothing else', () => {
        expect(learningDefaultPlugin.permissions.map((p) => p.scope)).toEqual(['memory:read', 'memory:write']);
        expect(learningDefaultPlugin.secrets).toBeUndefined();
    });
});
