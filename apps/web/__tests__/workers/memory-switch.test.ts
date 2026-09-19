/**
 * Switching the active memory plugin with migration on Durable Objects (#243): the Registry's dry run, then the move
 * — the Registry object hopping to each scope's Memory and FlatMemory objects — and the moved memories survive an
 * eviction of the store they moved into.
 */
import { env, evictDurableObject } from 'cloudflare:test';
import type { AgentId, WorkspaceId } from '@agentic/core';
import { DEFAULT_MEMORY_PLUGIN_ID, FLAT_MEMORY_PLUGIN_ID } from '@agentic/memory';
import { AgentActor, FlatMemory, Memory, Workspace, agentKey, memoryActorKey, workspaceKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { overHttp, registryOverHttp, signIn } from './http';

describe('worker: switching the active memory plugin moves the memories (#243)', () => {
    it('previews, moves default → flat, and the moved memories outlive an eviction', async () => {
        const userId = 'gh_7243';
        const WS = userId as WorkspaceId;
        const cookie = await signIn(userId);
        const registry = registryOverHttp(WS, cookie);

        const { agentId } = await overHttp(Workspace, workspaceKey(WS), cookie).createAgent({ name: 'Ada' });
        await overHttp(AgentActor, agentKey(WS, agentId as AgentId), cookie).update({ name: 'Ada', memoryPolicy: { shared: ['team'], autoLearn: 'off' } }, 'setup');
        const own = memoryActorKey(WS, `agent:${agentId}`);
        await overHttp(Memory, own, cookie).put({ kind: 'fact', text: 'deploys go out on fridays', tags: [], confidence: 'stated', provenance: { source: 'agent' } });
        await overHttp(Memory, own, cookie).put({ kind: 'lesson', text: 'keep answers short', tags: [], confidence: 'stated', conditions: 'when writing release notes', provenance: { source: 'agent' } });
        await overHttp(Memory, memoryActorKey(WS, 'shared:team'), cookie).put({ kind: 'fact', text: 'the release train leaves at noon', tags: [], confidence: 'stated', provenance: { source: 'user' } });

        const preview = await registry.previewActivation('memory', FLAT_MEMORY_PLUGIN_ID);
        expect(preview).toMatchObject({ from: DEFAULT_MEMORY_PLUGIN_ID, to: FLAT_MEMORY_PLUGIN_ID, dryRun: true, entries: 3, imported: 3, droppedFields: ['conditions'] });
        expect((await overHttp(FlatMemory, own, cookie).exportPage(null)).entries).toEqual([]);

        const moved = await registry.activate('memory', FLAT_MEMORY_PLUGIN_ID, { migrate: true });
        expect(moved.migration).toMatchObject({ dryRun: false, entries: 3, imported: 3, skipped: 0 });
        expect((await registry.overview()).active.memory).toBe(FLAT_MEMORY_PLUGIN_ID);

        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        await evictDurableObject(namespace.get(namespace.idFromName(durableObjectName({ type: 'FlatMemory', key: own }))));
        const kept = await overHttp(FlatMemory, own, cookie).exportPage(null);
        expect(kept.entries.map((e) => e.text).sort()).toEqual(['deploys go out on fridays', 'keep answers short']);
        expect((await overHttp(FlatMemory, memoryActorKey(WS, 'shared:team'), cookie).exportPage(null)).entries.map((e) => e.text)).toEqual(['the release train leaves at noon']);
    });
});
