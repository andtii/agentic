/**
 * `/plugins/:id` for a memory plugin (#243): "Make active" shows what moving the memories keeps and drops — the
 * Registry's dry run — before anything moves; confirming moves them and makes the plugin active, cancelling changes
 * nothing. Over the real wire, against a Registry carrying the build's memory implementations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId } from '@agentic/core';
import { DEFAULT_MEMORY_PLUGIN_ID, FLAT_MEMORY_PLUGIN_ID, MEMORY_PLUGINS } from '@agentic/memory';
import { FlatMemory, Memory, defineRegistry, memoryActorKey, registryKey } from '@agentic/platform';
import { memoryCatalogue } from '../../src/plugins/catalogue';
import { buttonNamed } from './helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const Registry = defineRegistry({ catalogue: MEMORY_PLUGINS, memoryPlugins: memoryCatalogue });

let h: LiveHarness;
let ada: AgentId;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
    ada = (await h.agent('Ada')) as AgentId;
    const own = h.app.as(owner).actor(Memory, memoryActorKey(WS, `agent:${ada}`));
    await own.put({ kind: 'fact', text: 'deploys go out on fridays', tags: [], confidence: 'stated', provenance: { source: 'agent' } });
    await own.put({ kind: 'lesson', text: 'keep answers short', tags: [], confidence: 'stated', conditions: 'when writing release notes', provenance: { source: 'agent' } });
});
afterEach(async () => {
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const activateButton = (dom: ParentNode) => dom.querySelector<HTMLButtonElement>('[data-plugin-action="activate"] button');

describe('/plugins/:id — making a memory plugin active (#243)', () => {
    it('shows the dry run first — what moves, what is dropped, by agent — and moves the memories on confirm', async () => {
        const dom = await mountLive(`/plugins/${FLAT_MEMORY_PLUGIN_ID}`, h);
        await until(() => activateButton(dom) !== null, 'the Make active button');
        activateButton(dom)!.click();
        await until(() => dialog() !== null, 'the confirmation with the dry run');
        const text = dialog()!.textContent ?? '';
        expect(text).toContain('Make Flat memory active?');
        expect(text).toContain('2 memories of 2 move from Memory to Flat memory.');
        expect(text).toContain('conditions is dropped');
        expect(text).toContain('Ada · 2 memories');
        // Nothing moved yet.
        expect((await h.app.as(owner).actor(FlatMemory, memoryActorKey(WS, `agent:${ada}`)).exportPage(null, 10)).entries).toEqual([]);

        buttonNamed(dialog()!, 'Move 2 memories and make active').click();
        await until(async () => (await registry().overview()).active.memory === FLAT_MEMORY_PLUGIN_ID, 'the flat plugin to become active');
        const moved = await h.app.as(owner).actor(FlatMemory, memoryActorKey(WS, `agent:${ada}`)).exportPage(null, 10);
        expect(moved.entries.map((e) => e.text).sort()).toEqual(['deploys go out on fridays', 'keep answers short']);
    }, 20_000);

    it('cancelling keeps the old plugin active and moves nothing', async () => {
        const dom = await mountLive(`/plugins/${FLAT_MEMORY_PLUGIN_ID}`, h);
        await until(() => activateButton(dom) !== null, 'the Make active button');
        activateButton(dom)!.click();
        await until(() => dialog() !== null, 'the confirmation');
        buttonNamed(dialog()!, 'Keep Memory').click();
        await until(() => dialog() === null, 'the dialog to close');
        expect((await registry().overview()).active.memory).toBe(DEFAULT_MEMORY_PLUGIN_ID);
        expect((await h.app.as(owner).actor(FlatMemory, memoryActorKey(WS, `agent:${ada}`)).exportPage(null, 10)).entries).toEqual([]);
    }, 20_000);
});
