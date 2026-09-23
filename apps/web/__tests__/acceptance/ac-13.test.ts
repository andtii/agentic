/**
 * AC-13 — A plugin is disabled. Dependent capabilities are identified, and
 * future use is prevented according to defined lifecycle behavior.
 *
 * The app's registry on the in-process host (`host.ts`), the Registry
 * sealed under the test KEK as the Worker seals it: a connector plugin is
 * registered and enabled with a secret; agents depend on it through a
 * connector ref and through a tool in its namespace, a schedule through
 * one of those agents. Disabling it names every dependent, blocks new use
 * (`requireEnabled`, the secret) with a typed error, and leaves the
 * dependents' own records untouched; removal refuses while anything
 * depends on it unless forced. The same for a runtime the build ships
 * (#231): the router refuses a new task on it `plugin-disabled` before any
 * session opens. Deeper: `packages/platform/__tests__/registry/`
 * (manifests, grants never beyond the manifest, connectors, secrets).
 */
import type { AgentId, PluginManifest, TaskId } from '@agentic/core';
import { AgentActor, agentKey, isPluginDisabledError, isRegistryError, registryKey, type RegistryActor, type ScheduleActor } from '@agentic/platform';
import { startHost, type AcceptanceHost } from './host';

const github: PluginManifest = {
    id: 'github',
    version: '1.2.0',
    kind: 'connector',
    name: 'GitHub MCP',
    description: 'MCP server at api.github.com',
    capabilities: ['tools'],
    config: { type: 'object' },
    permissions: [
        { scope: 'network:api.github.com', reason: 'reach the server' },
        { scope: 'secret:github-token', reason: 'bearer token' },
        { scope: 'tools:github', reason: 'expose tools' }
    ],
    compat: { platform: '*', core: '*' }
};

let h: AcceptanceHost;
beforeEach(async () => {
    h = await startHost();
});
afterEach(async () => {
    await h.stop();
});

describe('AC-13: a plugin is disabled', () => {
    it('names its dependents, refuses new use with a typed error, and leaves running references as they are', async () => {
        const me = h.user('ac13_user');
        const registry = h.as(me.principal).actor(h.Registry as RegistryActor, registryKey(me.ws));
        await registry.register(github, { enabled: true, grant: 'declared' });
        await registry.setSecret('github-token', 'ghp_secret');
        expect(await registry.openSecret('github-token', 'github')).toBe('ghp_secret');
        await registry.putConnector({ id: 'github', pluginId: 'github', transport: 'streamable-http', url: 'https://api.github.com/mcp', secrets: ['github-token'] });

        // Who depends on it: an agent through the connector, an agent through a tool in the plugin's namespace, a schedule through that agent.
        const byConnector = await me.agent('Ada', { connectors: [{ id: 'github' }] });
        const byTool = await me.agent('Bob', { tools: [{ name: 'github.search' }] });
        await me.agent('Eve', { tools: [{ name: 'slack.post' }] });
        const { scheduleId } = await me.workspace().createSchedule();
        await h.as(me.principal).actor(h.Schedule as ScheduleActor, `${me.ws}:schedule:${scheduleId}`).create({ kind: 'agent-task', title: 'nightly triage', prompt: 'Triage the issues', recurrence: { kind: 'at', at: Date.now() + 86_400_000 }, agentId: byTool });
        await expect(registry.requireEnabled('github')).resolves.toBeUndefined();

        const builtins = async () => (await registry.list()).filter((p) => p.builtin).map((p) => [p.manifest.id, p.enabled]);
        const builtinsBefore = await builtins();
        const { plugin, dependents } = await registry.disable('github');
        expect(plugin.enabled).toBe(false);
        expect(dependents.agents.map((a) => [a.id, a.name, a.via])).toEqual([
            [byConnector, 'Ada', ['connector']],
            [byTool, 'Bob', ['tool']]
        ]);
        expect(dependents.schedules).toEqual([{ id: scheduleId, title: 'nightly triage', agentId: byTool }]);
        expect(await registry.dependents('github')).toEqual(dependents);
        // Beside the build's own plugins (#231), which stay as they were.
        expect((await registry.list()).filter((p) => !p.builtin).map((p) => [p.manifest.id, p.enabled])).toEqual([['github', false]]);
        // Web Push (#244), the A2A server (#245) and Gmail (#533) ship turned off (the flat memory plugin is on now that it is durable, #281); every other built-in is on — and all stay as they were.
        expect(await builtins()).toEqual(builtinsBefore);
        expect(builtinsBefore.filter(([, on]) => !on).map(([id]) => id)).toEqual(['agentic.a2a.server', 'agentic.notify.web-push', 'gmail']);
        expect((await registry.overview()).active.memory).toBe('agentic.memory.default');

        // New use is refused from now on, with a typed error a caller can show — the gate and the secret alike.
        const refused = await registry.requireEnabled('github').catch((e: unknown) => e);
        expect(isPluginDisabledError(refused)).toBe(true);
        expect(refused).toMatchObject({ pluginId: 'github', state: 'disabled', code: 'plugin-disabled' });
        const secret = await registry.openSecret('github-token', 'github').catch((e: unknown) => e);
        expect(isRegistryError(secret, 'plugin-disabled')).toBe(true);
        expect(await registry.isEnabled('github')).toBe(false);

        // The dependents keep their own records: only new use is gated, nothing running is interrupted.
        expect((await h.as(me.principal).actor(AgentActor, agentKey(me.ws, byConnector as AgentId)).get()).config.connectors).toEqual([{ id: 'github' }]);
        expect((await h.as(me.principal).actor(AgentActor, agentKey(me.ws, byTool as AgentId)).get()).config.tools).toEqual([{ name: 'github.search' }]);
        expect((await h.as(me.principal).actor(h.Schedule as ScheduleActor, `${me.ws}:schedule:${scheduleId}`).get()).agentId).toBe(byTool);

        // Removal refuses while anything depends on it, unless forced; re-enabling restores use.
        const inUse = await registry.remove('github').catch((e: unknown) => e);
        expect(isRegistryError(inUse, 'plugin-in-use')).toBe(true);
        expect(await registry.get('github')).not.toBeNull();
        expect((await registry.enable('github')).enabled).toBe(true);
        await expect(registry.requireEnabled('github')).resolves.toBeUndefined();
        const removed = await registry.remove('github', { force: true });
        expect(removed.dependents.agents).toHaveLength(2);
        expect(await registry.get('github')).toBeNull();
        expect(await registry.connectors()).toEqual([]);
        expect(await registry.requireEnabled('github').catch((e: unknown) => e)).toMatchObject({ pluginId: 'github', state: 'missing' });
    });

    it('a runtime the build ships (#231): its agents are named, a new task on it is refused before it opens, and turning it back on restores use', async () => {
        const me = h.user('ac13_runtime');
        const registry = h.as(me.principal).actor(h.Registry as RegistryActor, registryKey(me.ws));
        // Listed with no install step, enabled (PLG-05).
        expect(await registry.get('anthropic-api')).toMatchObject({ builtin: true, enabled: true });
        const ada = await me.agent('Ada');
        await me.createTask('t_before', ada);
        await me.routing().run('t_before' as TaskId);
        expect((await me.settled('t_before')).status).toBe('completed');

        const { dependents } = await registry.disable('anthropic-api');
        expect(dependents.agents.map((a) => [a.id, a.via])).toEqual([[ada, ['runtime']]]);
        await me.createTask('t_off', ada);
        await me.routing().run('t_off' as TaskId);
        const off = await me.settled('t_off');
        expect(off.status).toBe('failed');
        expect(off.error).toMatchObject({ code: 'plugin-disabled', recoverable: true });
        expect(off.sessionId).toBeUndefined();
        // A built-in is turned off, never removed.
        expect(isRegistryError(await registry.remove('anthropic-api', { force: true }).catch((e: unknown) => e), 'builtin')).toBe(true);

        await registry.enable('anthropic-api');
        await me.createTask('t_after', ada);
        await me.routing().run('t_after' as TaskId);
        expect((await me.settled('t_after')).status).toBe('completed');
    });
});
