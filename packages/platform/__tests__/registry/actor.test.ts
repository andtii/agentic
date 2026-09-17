/**
 * Registry actor: plugin lifecycle with dependents (AC-13), grants that never
 * exceed the manifest (PLG-04), sealed secrets, and who may call what.
 */
import type { AgentId, PluginManifest, Principal, ScheduleId, WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { AgentActor, agentKey } from '../../src/agent/index';
import { generateWorkspaceKek, importWorkspaceKek, sameWorkspace, workspaceKey } from '../../src/auth/index';
import {
    defineRegistry,
    isPluginDisabledError,
    isRegistryError,
    parseRegistryKey,
    registryKey,
    requireEnabled,
    Registry as RegistryNoKek,
    type RegistryState
} from '../../src/registry/index';
import { defineScheduleActor } from '../../src/schedule/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = registryKey(WS);

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

const Schedule = defineScheduleActor({ trigger: { fired: async () => {} } });

/** An actor that gates NEW use of a plugin through the helper, as Session / Schedule integrations will. */
const Consumer = defineActor({
    type: 'Consumer',
    authorize: [sameWorkspace],
    state: () => ({}),
    methods: (ctx) => ({
        async use(pluginId: string): Promise<'used'> {
            await requireEnabled(ctx, WS, pluginId);
            return 'used';
        }
    })
});

const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()) });

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([Registry, Workspace, AgentActor, Schedule, Consumer]);
    return app.start();
});
afterEach(() => app.stop());

const reg = (p: Principal | null = owner) => app.as(p).actor(Registry, KEY);
const ws = () => app.as(owner).actor(Workspace, workspaceKey(WS));

async function agentUsing(patch: Record<string, unknown>): Promise<AgentId> {
    const { agentId } = await ws().createAgent({ name: 'Ada' });
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: 'Ada', ...patch }, 'setup');
    return agentId;
}

describe('registry keys', () => {
    it('round-trips and rejects other shapes', () => {
        expect(registryKey(WS)).toBe('u1:registry');
        expect(parseRegistryKey('u1:registry')).toBe('u1');
        expect(parseRegistryKey('u1:registry:x')).toBeNull();
        expect(parseRegistryKey(':registry')).toBeNull();
        expect(parseRegistryKey('u1:agent:a')).toBeNull();
    });
});

describe('plugin lifecycle', () => {
    it('registers disabled with no grants, then enables, configures and grants declared scopes only', async () => {
        const p = await reg().register(github);
        expect(p).toMatchObject({ enabled: false, grantedPermissions: [], config: {} });
        expect(await reg().isEnabled('github')).toBe(false);

        await reg().enable('github');
        await reg().configure('github', { url: 'https://api.github.com/mcp' });
        const granted = await reg().grant('github', ['secret:github-token', 'tools:github']);
        expect(granted.enabled).toBe(true);
        expect(granted.config).toEqual({ url: 'https://api.github.com/mcp' });
        expect(granted.grantedPermissions).toEqual(['secret:github-token', 'tools:github']);

        // PLG-04: a scope the manifest never declared cannot be granted.
        const notDeclared = await reg()
            .grant('github', ['machine:*'])
            .catch((e: unknown) => e);
        expect(isRegistryError(notDeclared, 'not-declared')).toBe(true);

        const revoked = await reg().revoke('github', ['tools:github']);
        expect(revoked.grantedPermissions).toEqual(['secret:github-token']);

        // Persisted, and readable through a fresh host.
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.plugins.github!.grantedPermissions).toEqual(['secret:github-token']);
        expect(await reg().list()).toHaveLength(1);
    });

    it('re-registering keeps enabled/config and drops grants the new manifest no longer declares', async () => {
        await reg().register(github, { enabled: true, grant: 'declared', config: { a: 1 } });
        const v2 = { ...github, version: '2.0.0', permissions: github.permissions.filter((p) => p.scope !== 'secret:github-token') };
        const p = await reg().register(v2);
        expect(p.manifest.version).toBe('2.0.0');
        expect(p.enabled).toBe(true);
        expect(p.config).toEqual({ a: 1 });
        expect(p.grantedPermissions).toEqual(['network:api.github.com', 'tools:github']);
    });

    it('refuses a bad manifest before anything is stored', async () => {
        const bad = await reg()
            .register({ ...github, permissions: [{ scope: 'root:everything', reason: '' }] } as never)
            .catch((e: unknown) => e);
        expect(isRegistryError(bad, 'bad-manifest')).toBe(true);
        expect(await reg().list()).toEqual([]);
        expect(await app.storage.load('Registry', KEY)).toBeNull();
    });

    it('AC-13: disabling lists dependents and blocks new use; running references are untouched', async () => {
        await reg().register(github, { enabled: true });
        const byConnector = await agentUsing({ connectors: [{ id: 'github' }] });
        const byTool = await agentUsing({ tools: [{ name: 'github.search' }] });
        await agentUsing({ tools: [{ name: 'slack.post' }] });
        const { scheduleId } = await ws().createSchedule();
        await app.as(owner).actor(Schedule, `${WS}:schedule:${scheduleId}`).create({
            kind: 'agent-task',
            title: 'nightly triage',
            recurrence: { kind: 'at', at: Date.now() + 86_400_000 },
            agentId: byTool
        });
        // An indexed schedule that was never created does not break the walk.
        await ws().createSchedule();

        const consumer = app.as(owner).actor(Consumer, `${WS}:consumer:1`);
        expect(await consumer.use('github')).toBe('used');

        const { plugin, dependents } = await reg().disable('github');
        expect(plugin.enabled).toBe(false);
        expect(dependents.agents.map((a) => [a.id, a.name, a.via])).toEqual([
            [byConnector, 'Ada', ['connector']],
            [byTool, 'Ada', ['tool']]
        ]);
        expect(dependents.schedules).toEqual([{ id: scheduleId, title: 'nightly triage', agentId: byTool }]);
        expect(await reg().dependents('github')).toEqual(dependents);

        // New use is refused from now on, with a typed error the caller can show.
        const refused = await consumer.use('github').catch((e: unknown) => e);
        expect(isPluginDisabledError(refused)).toBe(true);
        expect(refused).toMatchObject({ pluginId: 'github', state: 'disabled', code: 'plugin-disabled' });
        const missing = await consumer.use('nope').catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(Error);
        expect(missing).toMatchObject({ pluginId: 'nope', state: 'missing' });

        // The agents keep their config — only new use is gated.
        const a = await app.as(owner).actor(AgentActor, agentKey(WS, byConnector)).get();
        expect(a.config.connectors).toEqual([{ id: 'github' }]);

        // Remove refuses while anything depends on it, unless forced.
        const inUse = await reg()
            .remove('github')
            .catch((e: unknown) => e);
        expect(isRegistryError(inUse, 'plugin-in-use')).toBe(true);
        expect(await reg().get('github')).not.toBeNull();
        const removed = await reg().remove('github', { force: true });
        expect(removed.dependents.agents).toHaveLength(2);
        expect(await reg().get('github')).toBeNull();
        expect(isPluginDisabledError(await consumer.use('github').catch((e: unknown) => e))).toBe(true);
    });
});

describe('connectors', () => {
    it('stores a connector under an installed plugin and records probes', async () => {
        await reg().register(github);
        const c = await reg().putConnector({ id: 'github', pluginId: 'github', transport: 'streamable-http', url: 'https://api.github.com/mcp', secrets: ['github-token'] });
        expect(c).toMatchObject({ tools: [], status: { state: 'unknown' } });
        const probed = await reg().setConnectorStatus('github', { state: 'ok' }, ['github.search', 'github.issues']);
        expect(probed.tools).toEqual(['github.search', 'github.issues']);
        expect(probed.status.state).toBe('ok');
        expect(probed.status.checkedAt).toBeTypeOf('number');
        // A replace keeps what was discovered.
        const replaced = await reg().putConnector({ id: 'github', pluginId: 'github', transport: 'streamable-http', url: 'https://api.github.com/mcp2' });
        expect(replaced.tools).toEqual(['github.search', 'github.issues']);
        expect(await reg().connectors()).toHaveLength(1);

        const orphan = await reg()
            .putConnector({ id: 'x', pluginId: 'missing', transport: 'stdio', command: 'x' })
            .catch((e: unknown) => e);
        expect(isPluginDisabledError(orphan)).toBe(true);

        // Removing the plugin drops its connectors.
        await reg().remove('github');
        expect(await reg().connectors()).toEqual([]);
        expect(await reg().removeConnector('github')).toBe(false);
    });
});

describe('secrets', () => {
    it('seals under the KEK, never returns plaintext through reads, and opens only for an enabled plugin with the grant', async () => {
        await reg().register(github, { enabled: true });
        const info = await reg().setSecret('github-token', 'ghp_secret');
        expect(info.name).toBe('github-token');
        expect(await reg().secrets()).toEqual([info]);

        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.secrets['github-token']!.sealed).toMatch(/^kek1\./);
        expect(JSON.stringify(stored)).not.toContain('ghp_secret');
        expect(JSON.stringify(await reg().exportRows())).not.toContain('kek1.');

        // No grant → denied; granted → the plaintext; disabled → refused.
        expect(isRegistryError(await reg().openSecret('github-token', 'github').catch((e: unknown) => e), 'secret-denied')).toBe(true);
        await reg().grant('github', ['secret:github-token']);
        expect(await reg().openSecret('github-token', 'github')).toBe('ghp_secret');
        // The grant is checked before existence, so a name outside the grant reveals nothing.
        expect(isRegistryError(await reg().openSecret('other', 'github').catch((e: unknown) => e), 'secret-denied')).toBe(true);
        await reg().disable('github');
        expect(isPluginDisabledError(await reg().openSecret('github-token', 'github').catch((e: unknown) => e))).toBe(true);

        expect(await reg().deleteSecret('github-token')).toBe(true);
        expect(await reg().secrets()).toEqual([]);
        await reg().enable('github');
        expect(isRegistryError(await reg().openSecret('github-token', 'github').catch((e: unknown) => e), 'secret-missing')).toBe(true);
    });

    it('refuses to store a secret with no KEK configured', async () => {
        await app.stop();
        app = testActorApp([RegistryNoKek]);
        await app.start();
        const noKek = await app
            .as(owner)
            .actor(RegistryNoKek, KEY)
            .setSecret('x', 'y')
            .catch((e: unknown) => e);
        expect(isRegistryError(noKek, 'no-kek')).toBe(true);
    });
});

describe('authorization', () => {
    const stranger = userPrincipal('u2');
    const agentOfWs: Principal = { kind: 'agent', workspaceId: WS, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as never };

    it('refuses another workspace on every method and anonymous callers with 401', async () => {
        expect(await statusOf(reg(stranger).list())).toBe(403);
        expect(await statusOf(reg(stranger).register(github))).toBe(403);
        expect(await statusOf(reg(null).list())).toBe(401);
    });

    it('lets a same-workspace agent read and open a granted secret, never mutate', async () => {
        await reg().register(github, { enabled: true, grant: 'declared' });
        await reg().setSecret('github-token', 'ghp_secret');
        expect(await reg(agentOfWs).isEnabled('github')).toBe(true);
        expect((await reg(agentOfWs).list()).map((p) => p.manifest.id)).toEqual(['github']);
        expect(await reg(agentOfWs).openSecret('github-token', 'github')).toBe('ghp_secret');
        expect(await statusOf(reg(agentOfWs).disable('github'))).toBe(403);
        expect(await statusOf(reg(agentOfWs).setSecret('a', 'b'))).toBe(403);
        expect(await statusOf(reg(agentOfWs).grant('github', ['tools:github']))).toBe(403);
        expect(await reg().isEnabled('github')).toBe(true);
        void ('schedule_x' as ScheduleId);
    });
});
