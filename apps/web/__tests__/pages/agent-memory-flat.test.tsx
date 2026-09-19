/**
 * The agent Memory tab follows the workspace's ACTIVE memory plugin (#281): with the flat plugin active it lists and
 * acts on the FlatMemory actor of the agent's scope — not the default store — and says which plugin it shows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId } from '@agentic/core';
import { memoryDefaultPlugin, memoryFlatPlugin } from '@agentic/memory';
import { FlatMemory, Memory, defineRegistry, memoryActorKey, registryKey } from '@agentic/platform';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { text } from './helpers';

const Registry = defineRegistry({ catalogue: [memoryDefaultPlugin, memoryFlatPlugin] });

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    await h.stop();
});

const fact = (textOf: string) => ({ kind: 'fact' as const, text: textOf, tags: [], confidence: 'verified' as const, provenance: { source: 'agent' as const } });
const rowOf = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-memory-row][data-memory-id="${id}"]`);
const action = (row: Element, label: string) => [...row.querySelectorAll<HTMLButtonElement>('[data-memory-actions] button')].find((b) => b.getAttribute('aria-label') === label);

describe('/agents/:id Memory tab with the flat memory plugin active (#281)', () => {
    it('lists the flat store, says so, and retires through it', async () => {
        const atlas = await h.agent('Atlas', 'Coordinator');
        const key = memoryActorKey(WS, `agent:${atlas as AgentId}`);
        const inDefault = await h.app.as(owner).actor(Memory, key).put(fact('kept in the default store'));
        const inFlat = await h.app.as(owner).actor(FlatMemory, key).put(fact('kept in the flat store'));
        await h.app.as(owner).actor(Registry, registryKey(WS)).activate('memory', memoryFlatPlugin.id);

        const dom = await mountLive(`/agents/${atlas}?tab=memory`, h);
        await until(() => rowOf(dom, inFlat.id) !== null, 'the flat store’s entry');
        expect(rowOf(dom, inDefault.id)).toBeNull();
        expect(text(dom.querySelector('[data-memory-source]'))).toBe("Stored by Flat memory, the workspace's active memory.");

        action(rowOf(dom, inFlat.id)!, 'Retire this memory')!.click();
        await until(async () => (await h.app.as(owner).actor(FlatMemory, key).get(inFlat.id))?.retired === true, 'the retirement on the FlatMemory actor');
        expect((await h.app.as(owner).actor(Memory, key).get(inDefault.id))?.retired).toBeUndefined();
    });
});
