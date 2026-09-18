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
 * depends on it unless forced. Deeper: `packages/platform/__tests__/registry/`
 * (manifests, grants never beyond the manifest, connectors, secrets).
 */
import type { AgentId, PluginManifest } from '@agentic/core';
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

        const { plugin, dependents } = await registry.disable('github');
        expect(plugin.enabled).toBe(false);
        expect(dependents.agents.map((a) => [a.id, a.name, a.via])).toEqual([
            [byConnector, 'Ada', ['connector']],
            [byTool, 'Bob', ['tool']]
        ]);
        expect(dependents.schedules).toEqual([{ id: scheduleId, title: 'nightly triage', agentId: byTool }]);
        expect(await registry.dependents('github')).toEqual(dependents);
        expect((await registry.list()).map((p) => [p.manifest.id, p.enabled])).toEqual([['github', false]]);

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
});
