/**
 * The build's plugins inside workerd (#231): the production wiring — the
 * Registry listing `src/plugins/catalogue.ts`, sealed under the pool's
 * `WORKSPACE_KEK`, the router gating each run on it, the session factory
 * opening the `anthropic-api` key as the workspace's owner — with only the
 * model mocked (`worker.ts`). Every call goes over HTTP, as the pages make it.
 *
 * A fresh workspace lists the built-ins enabled with no key; a run fails
 * `no-api-key` naming the plugin page until the key is set; then it runs;
 * the plugin turned off fails the next run `plugin-disabled` and names the
 * agent that depends on it; turned back on, it runs again.
 */
import type { AgentId, TaskId, WorkspaceId } from '@agentic/core';
import { AgentActor, TaskActor, Workspace, agentKey, taskKey, workspaceKey, type RoutingActor, type TaskView } from '@agentic/platform';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID } from '@agentic/runtimes';
import type { ActorClient } from '@sigx/actors';
import { routingKeyOf } from '../../src/actors/keys';
import { overHttp, registryOverHttp, setAnthropicKey, signIn } from './http';

const Routing = { type: 'routing' } as unknown as RoutingActor;
const KEY = 'sk-ant-workers-plugins-0123456789';

async function settled(task: ActorClient<typeof TaskActor>, timeoutMs = 10_000): Promise<TaskView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const t = await task.get();
        if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return t;
        if (Date.now() > deadline) throw new Error(`task ${t.id} did not settle: ${JSON.stringify({ status: t.status, wait: t.wait, error: t.error })}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

describe('worker: the plugin catalogue and the workspace’s own Anthropic key', () => {
    it('lists the built-ins, runs only with the key, and stops new runs while the runtime plugin is off', async () => {
        const userId = 'gh_7231';
        const WS = userId as WorkspaceId;
        const cookie = await signIn(userId);
        const registry = registryOverHttp(WS, cookie);

        // A fresh workspace: every plugin of the build, enabled but the flat memory plugin (#242), and no key yet.
        const fresh = await registry.overview();
        expect(fresh.plugins.map((p) => [p.manifest.id, p.enabled, p.builtin])).toEqual([
            ['agentic.learning.default', true, true],
            ['agentic.memory.default', true, true],
            ['agentic.memory.flat', false, true],
            // Off until the owner sets it up (#244).
            ['agentic.notify.web-push', false, true],
            [ANTHROPIC_API_PLUGIN_ID, true, true],
            ['claude-code', true, true]
        ]);
        expect(fresh.active).toEqual({ memory: 'agentic.memory.default', learning: 'agentic.learning.default' });
        expect(fresh.secretNames).toEqual([]);
        expect(fresh.hasKek).toBe(true);

        const ws = overHttp(Workspace, workspaceKey(WS), cookie);
        const { agentId } = await ws.createAgent({ name: 'Ada' });
        await overHttp(AgentActor, agentKey(WS, agentId as AgentId), cookie).update({ name: 'Ada', instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        const run = async (id: string): Promise<TaskView> => {
            const task = overHttp(TaskActor, taskKey(WS, id as TaskId), cookie);
            await task.create({ objective: `say hi (${id})`, origin: { kind: 'external', clientId: 'workers' }, assignee: agentId as AgentId, context: [], constraints: {} }, { owner: agentId as AgentId });
            await overHttp(Routing, routingKeyOf(WS), cookie).run(id as TaskId);
            return settled(task);
        };

        // No key: the open fails, and the message says where the key goes — there is no deployment key to fall back to.
        const noKey = await run('task_nokey');
        expect(noKey.status).toBe('failed');
        expect(noKey.error?.message).toContain('no-api-key');
        expect(noKey.error?.message).toContain(`/plugins/${ANTHROPIC_API_PLUGIN_ID}`);

        // The key, set the way the plugin page sets it: sealed, listed by name only.
        await setAnthropicKey(WS, cookie, KEY);
        const withKey = await registry.overview();
        expect(withKey.secretNames).toEqual([ANTHROPIC_API_KEY_SECRET]);
        expect(JSON.stringify(withKey)).not.toContain(KEY);
        expect((await run('task_key')).status).toBe('completed');

        // Turned off: the agent is named as a dependent, and the next run is refused before anything opens.
        const { dependents } = await registry.disable(ANTHROPIC_API_PLUGIN_ID);
        expect(dependents.agents.map((a) => [a.id, a.via])).toEqual([[agentId, ['runtime']]]);
        const off = await run('task_off');
        expect(off.status).toBe('failed');
        expect(off.error).toMatchObject({ code: 'plugin-disabled', recoverable: true });
        expect(off.sessionId).toBeUndefined();

        // Back on: the stored key still works.
        await registry.enable(ANTHROPIC_API_PLUGIN_ID);
        expect((await run('task_on')).status).toBe('completed');
    });
});
