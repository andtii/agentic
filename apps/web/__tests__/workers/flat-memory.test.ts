/**
 * The flat memory plugin on Durable Object storage (#281): the FlatMemory actor passes the `memoryConformance` core
 * over the Worker's HTTP mount, and a workspace that makes the flat plugin its active memory keeps what its sessions
 * remember across an eviction — in the flat store, not the default one.
 */
import { env, evictDurableObject } from 'cloudflare:test';
import type { AgentId, MemoryScope, TaskId, WorkspaceId } from '@agentic/core';
import { FLAT_MEMORY_PLUGIN_ID } from '@agentic/memory';
import { memoryConformance, type MemoryFeature } from '@agentic/memory/testing';
import { AgentActor, FlatMemory, Memory, TaskActor, Workspace, actorMemoryStore, agentKey, memoryActorKey, taskKey, workspaceKey, type MemoryStoreClient, type RoutingActor, type TaskView } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import type { ActorClient } from '@sigx/actors';
import { routingKeyOf } from '../../src/actors/keys';
import { overHttp, registryOverHttp, setAnthropicKey, signIn } from './http';

const Routing = { type: 'routing' } as unknown as RoutingActor;
const FLAT_WITHOUT: readonly MemoryFeature[] = ['conditions', 'kindWeights', 'ttl', 'supersedes'];

async function settled(task: ActorClient<typeof TaskActor>, timeoutMs = 10_000): Promise<TaskView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const t = await task.get();
        if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return t;
        if (Date.now() > deadline) throw new Error(`task ${t.id} did not settle: ${JSON.stringify({ status: t.status, error: t.error })}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await read();
        if (ok(v)) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

describe('memoryConformance: FlatMemory actor on Durable Object storage', () => {
    const userId = 'gh_flat_conformance';
    const WS = userId as WorkspaceId;
    let cookie = '';
    beforeAll(async () => {
        cookie = await signIn(userId);
    });

    // A small wire batch so the export/import cases cross page boundaries.
    const make = (scope: MemoryScope) => actorMemoryStore(overHttp(FlatMemory, memoryActorKey(WS, scope), cookie) as unknown as MemoryStoreClient, 2);
    for (const c of memoryConformance(make, { without: FLAT_WITHOUT })) it(c.name, c.run);
});

describe('worker: the flat memory plugin as a workspace’s active memory', () => {
    it('keeps what a session remembers across an eviction, in the flat store', async () => {
        const userId = 'gh_7281';
        const WS = userId as WorkspaceId;
        const cookie = await signIn(userId);
        const registry = registryOverHttp(WS, cookie);

        // Enabled out of the box, not active until the owner says so.
        expect((await registry.overview()).active.memory).toBe('agentic.memory.default');
        await registry.activate('memory', FLAT_MEMORY_PLUGIN_ID);
        expect((await registry.overview()).active.memory).toBe(FLAT_MEMORY_PLUGIN_ID);
        await setAnthropicKey(WS, cookie);

        const { agentId } = await overHttp(Workspace, workspaceKey(WS), cookie).createAgent({ name: 'Ada' });
        await overHttp(AgentActor, agentKey(WS, agentId as AgentId), cookie).update({ name: 'Ada', instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        const task = overHttp(TaskActor, taskKey(WS, 'task_flat' as TaskId), cookie);
        await task.create({ objective: 'say hi', origin: { kind: 'external', clientId: 'workers' }, assignee: agentId as AgentId, context: [], constraints: {} }, { owner: agentId as AgentId });
        await overHttp(Routing, routingKeyOf(WS), cookie).run('task_flat' as TaskId);
        expect((await settled(task)).status).toBe('completed');

        // The task's record lands in the flat store of the agent's scope — and not in the default one.
        const key = memoryActorKey(WS, `agent:${agentId}`);
        const flat = overHttp(FlatMemory, key, cookie);
        const before = await until(() => flat.exportPage(null), (p) => p.entries.length > 0, 'the task record in the flat store');
        expect(before.entries.map((e) => e.kind)).toEqual(['record']);
        expect((await overHttp(Memory, key, cookie).exportPage(null)).entries).toEqual([]);

        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        await evictDurableObject(namespace.get(namespace.idFromName(durableObjectName({ type: 'FlatMemory', key }))));

        expect((await flat.exportPage(null)).entries).toEqual(before.entries);
        expect(await flat.stats()).toMatchObject({ entries: 1, live: 1 });
    });
});
