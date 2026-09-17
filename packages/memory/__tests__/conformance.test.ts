import type { MemoryScope } from '@agentic/core';
import { createMemoryStore, DEFAULT_MEMORY_PLUGIN_ID, memoryPlugin } from '../src/index';
import { memoryConformance } from '../src/testing/index';

const ctx = { now: Date.now, log: () => {} };

describe('memoryConformance: in-memory store', () => {
    for (const c of memoryConformance(() => createMemoryStore())) it(c.name, c.run);
});

describe('memoryConformance: default plugin', () => {
    const plugin = memoryPlugin();
    for (const c of memoryConformance((scope) => plugin.open(scope, ctx))) it(c.name, c.run);
});

describe('memoryPlugin', () => {
    it('declares its capabilities and keeps one store per scope', async () => {
        const plugin = memoryPlugin();
        expect([plugin.id, plugin.version, plugin.capabilities]).toEqual([DEFAULT_MEMORY_PLUGIN_ID, '0.1.0', { semantic: false, export: 'full' }]);
        const a = plugin.open('agent:agent_a' as MemoryScope, ctx);
        const b = plugin.open('agent:agent_b' as MemoryScope, ctx);
        await a.put({ kind: 'fact', text: 'private to a', tags: [], confidence: 'stated', provenance: { source: 'agent' } });
        expect(await b.query({ limit: 10 })).toEqual([]);
        expect(plugin.open('agent:agent_a' as MemoryScope, ctx)).toBe(a);
    });

    it('takes a custom backend', () => {
        const store = createMemoryStore();
        const plugin = memoryPlugin({ id: 'custom', version: '9', open: () => store });
        expect(plugin.open('shared:x', ctx)).toBe(store);
        expect(plugin.id).toBe('custom');
    });
});
