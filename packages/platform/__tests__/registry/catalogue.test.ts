/**
 * Registry catalogue (#229): built-ins that exist without being registered,
 * config checked against the manifest, single-slot kinds, and the one-hop
 * reads Routing (`gate`) and the pages (`overview`, `dependentsAll`) use.
 */
import type { AgentId, PluginManifest, Principal, WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { AgentActor, agentKey, defaultAgentConfig } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { defineRegistry, isPluginDisabledError, isRegistryError, registryKey, type BadConfigError, type CatalogueEntry, type RegistryState } from '../../src/registry/index';
import { defineScheduleActor } from '../../src/schedule/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = registryKey(WS);
const agentOfWs: Principal = { kind: 'agent', workspaceId: WS, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as never };

const base = { version: '1.0.0', description: '', capabilities: [], compat: { platform: '*', core: '*' } } as const;

const anthropic: PluginManifest = {
    ...base,
    id: 'anthropic-api',
    kind: 'runtime',
    name: 'Anthropic API',
    config: { type: 'object', properties: { defaultModel: { type: 'string', enum: ['fable', 'opus'], default: 'fable' } } },
    secrets: [{ name: 'anthropic-api-key', title: 'API key', description: '', required: true }],
    permissions: [{ scope: 'secret:anthropic-api-key', reason: 'call the API' }]
};
const claudeCode: PluginManifest = { ...base, id: 'claude-code', kind: 'runtime', name: 'Claude Code', config: { type: 'object' }, permissions: [{ scope: 'machine:*', reason: 'run on a machine' }] };
const memoryDefault: PluginManifest = {
    ...base,
    id: 'memory-default',
    kind: 'memory',
    name: 'Memory',
    config: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, default: 8 } } },
    permissions: [
        { scope: 'memory:read', reason: 'recall' },
        { scope: 'memory:write', reason: 'remember' }
    ]
};
const memoryFlat: PluginManifest = { ...base, id: 'agentic.memory.flat', kind: 'memory', name: 'Flat memory', config: { type: 'object' }, permissions: [{ scope: 'memory:read', reason: 'recall' }] };
const learningDefault: PluginManifest = { ...base, id: 'learning-default', kind: 'learning', name: 'Learning', config: { type: 'object' }, permissions: [{ scope: 'memory:write', reason: 'lessons' }] };
const webPush: PluginManifest = {
    ...base,
    id: 'web-push',
    kind: 'notification',
    name: 'Web Push',
    config: { type: 'object', properties: { subject: { type: 'string', default: 'mailto:ops@example.test' } } },
    permissions: []
};
const a2aServer: PluginManifest = { ...base, id: 'a2a-server', kind: 'a2a', name: 'A2A server', config: { type: 'object' }, permissions: [] };

const CATALOGUE: readonly CatalogueEntry[] = [anthropic, claudeCode, memoryDefault, memoryFlat, learningDefault, webPush, { manifest: a2aServer, enabledByDefault: false }];

const github: PluginManifest = {
    ...base,
    id: 'github',
    kind: 'connector',
    name: 'GitHub MCP',
    config: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] },
    permissions: [{ scope: 'tools:github', reason: 'expose tools' }]
};

const Schedule = defineScheduleActor({ trigger: { fired: async () => {} } });
const kek = () => importWorkspaceKek(generateWorkspaceKek());

let app: TestActorApp;
let Registry = defineRegistry({ kek, catalogue: CATALOGUE });

async function boot(catalogue: readonly CatalogueEntry[] = CATALOGUE, storage?: TestActorApp['storage']): Promise<void> {
    Registry = defineRegistry({ kek, catalogue });
    app = testActorApp([Registry, Workspace, AgentActor, Schedule, AuditActor], storage ? { storage } : {});
    await app.start();
}

beforeEach(() => boot());
afterEach(() => app.stop());

const reg = (p: Principal | null = owner) => app.as(p).actor(Registry, KEY);
const ws = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const registrySaves = () => app.saves.filter((s) => s.type === 'Registry').length;

async function agentUsing(name: string, patch: Record<string, unknown>): Promise<AgentId> {
    const { agentId } = await ws().createAgent({ name });
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name, ...patch }, 'setup');
    return agentId;
}

describe('configure', () => {
    it('refuses a value the schema forbids, with the paths, and stores nothing', async () => {
        const bad = (await reg()
            .configure('anthropic-api', { defaultModel: 'gpt' })
            .catch((e: unknown) => e)) as BadConfigError;
        expect(isRegistryError(bad, 'bad-config')).toBe(true);
        expect(bad.errors.map((e) => e.path)).toEqual(['defaultModel']);
        const unknown = (await reg()
            .configure('anthropic-api', { nope: 1 })
            .catch((e: unknown) => e)) as BadConfigError;
        expect(unknown.errors.map((e) => e.path)).toEqual(['nope']);
        expect(registrySaves()).toBe(0);

        // A registered plugin is held to its own schema too — at `register` and at `configure`.
        expect(isRegistryError(await reg().register(github, { config: { url: 42 } }).catch((e: unknown) => e), 'bad-config')).toBe(true);
        await reg().register(github, { config: { url: 'https://api.github.com/mcp' } });
        expect(isRegistryError(await reg().configure('github', {}).catch((e: unknown) => e), 'bad-config')).toBe(true);

        const ok = await reg().configure('anthropic-api', { defaultModel: 'opus' });
        expect(ok.config).toEqual({ defaultModel: 'opus' });

        // What is stored is the owner's own keys: an `undefined` is dropped, never kept as a key.
        await reg().configure('anthropic-api', { defaultModel: undefined });
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(Object.keys(stored.plugins['anthropic-api']!.config)).toEqual([]);
        expect((await reg().get('anthropic-api'))!.config).toEqual({ defaultModel: 'fable' });
    });
});

describe('built-ins are virtual until touched', () => {
    it('lists the catalogue enabled with declared grants and schema defaults — and no read saves', async () => {
        const list = await reg().list();
        expect(list.map((p) => [p.manifest.id, p.enabled, p.builtin])).toEqual([
            ['a2a-server', false, true],
            ['agentic.memory.flat', true, true],
            ['anthropic-api', true, true],
            ['claude-code', true, true],
            ['learning-default', true, true],
            ['memory-default', true, true],
            ['web-push', true, true]
        ]);
        const api = (await reg().get('anthropic-api'))!;
        expect(api).toMatchObject({ config: { defaultModel: 'fable' }, grantedPermissions: ['secret:anthropic-api-key'], registeredAt: 0 });
        expect(await reg().isEnabled('anthropic-api')).toBe(true);
        expect(await reg().isEnabled('a2a-server')).toBe(false);
        await reg().requireEnabled('claude-code');
        expect(isPluginDisabledError(await reg().requireEnabled('a2a-server').catch((e: unknown) => e))).toBe(true);
        await reg().overview();
        await reg().gate({ runtime: 'anthropic-api' });
        await reg().dependentsAll();
        await reg().exportRows();

        expect(registrySaves()).toBe(0);
        expect(await app.storage.load('Registry', KEY)).toBeNull();
    });

    it('opens a secret for a built-in that was never materialised', async () => {
        await reg().setSecret('anthropic-api-key', 'sk-ant-test');
        expect(await reg(agentOfWs).openSecret('anthropic-api-key', 'anthropic-api')).toBe('sk-ant-test');
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.plugins).toEqual({});
        // Another built-in never declared the scope.
        expect(isRegistryError(await reg().openSecret('anthropic-api-key', 'claude-code').catch((e: unknown) => e), 'secret-denied')).toBe(true);
    });

    it('materialises on the first mutation, saves in the turn, and reads the same after an eviction', async () => {
        const { plugin } = await reg().disable('anthropic-api');
        expect(plugin.enabled).toBe(false);
        expect(registrySaves()).toBe(1);
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.plugins['anthropic-api']).toMatchObject({ enabled: false, config: {}, grantedPermissions: ['secret:anthropic-api-key'], seenScopes: ['secret:anthropic-api-key'] });
        expect(Object.keys(stored.plugins)).toEqual(['anthropic-api']);

        const before = await reg().list();
        const storage = app.storage;
        await app.stop();
        await boot(CATALOGUE, storage);
        expect(await reg().list()).toEqual(before);
        expect((await reg().get('anthropic-api'))!.config).toEqual({ defaultModel: 'fable' });

        const on = await reg().enable('anthropic-api');
        expect(on.enabled).toBe(true);
        // A built-in cannot be removed or shadowed; only disabled.
        expect(isRegistryError(await reg().remove('anthropic-api', { force: true }).catch((e: unknown) => e), 'builtin')).toBe(true);
        expect(isRegistryError(await reg().register({ ...github, id: 'anthropic-api' }).catch((e: unknown) => e), 'builtin')).toBe(true);
        expect(await statusOf(reg(agentOfWs).configure('anthropic-api', {}))).toBe(403);
    });

    it('a new build overlays the manifest: undeclared grants lapse, an unseen scope is granted once, a revoked one stays revoked', async () => {
        const v1: PluginManifest = {
            ...anthropic,
            permissions: [
                { scope: 'secret:anthropic-api-key', reason: 'call the API' },
                { scope: 'network:api.anthropic.com', reason: 'reach the API' },
                { scope: 'tools:legacy', reason: 'going away' }
            ]
        };
        await app.stop();
        await boot([v1]);
        const revoked = await reg().revoke('anthropic-api', ['network:api.anthropic.com']);
        expect(revoked.grantedPermissions).toEqual(['secret:anthropic-api-key', 'tools:legacy']);

        const v2: PluginManifest = {
            ...anthropic,
            version: '2.0.0',
            permissions: [
                { scope: 'secret:anthropic-api-key', reason: 'call the API' },
                { scope: 'network:api.anthropic.com', reason: 'reach the API' },
                { scope: 'memory:read', reason: 'new in v2' }
            ]
        };
        const storage = app.storage;
        await app.stop();
        await boot([v2], storage);
        const saves = registrySaves();
        const p = (await reg().get('anthropic-api'))!;
        expect(p.manifest.version).toBe('2.0.0');
        expect(p.enabled).toBe(true);
        expect(p.grantedPermissions).toEqual(['secret:anthropic-api-key', 'memory:read']);
        expect(registrySaves()).toBe(saves);

        // Once seen, a scope the owner takes away is not handed back by the next read or the next build.
        await reg().revoke('anthropic-api', ['memory:read']);
        await app.stop();
        await boot([{ ...v2, version: '2.0.1' }], storage);
        expect((await reg().get('anthropic-api'))!.grantedPermissions).toEqual(['secret:anthropic-api-key']);
        const back = await reg().grant('anthropic-api', ['memory:read']);
        expect(back.grantedPermissions).toEqual(['secret:anthropic-api-key', 'memory:read']);
    });

    it('a plugin the build no longer ships falls back to what was stored; one it never stored is gone', async () => {
        await reg().disable('web-push');
        const storage = app.storage;
        await app.stop();
        await boot([anthropic], storage);
        expect((await reg().list()).map((p) => [p.manifest.id, p.builtin])).toEqual([
            ['anthropic-api', true],
            ['web-push', false]
        ]);
        await reg().remove('web-push');
        expect(await reg().get('web-push')).toBeNull();
    });

    it('exports effective rows', async () => {
        await reg().register(github, { config: { url: 'https://api.github.com/mcp' } });
        const rows = await reg().exportRows();
        expect(rows.filter((r) => r.kind === 'plugin').map((r) => (r.kind === 'plugin' ? r.plugin.manifest.id : ''))).toEqual([
            'a2a-server',
            'agentic.memory.flat',
            'anthropic-api',
            'claude-code',
            'github',
            'learning-default',
            'memory-default',
            'web-push'
        ]);
    });
});

describe('manifest secrets', () => {
    it('requires a secret:<name> (or secret:*) permission for every declared secret', async () => {
        const undeclared = await reg()
            .register({ ...github, secrets: [{ name: 'github-token', title: 'Token', description: '', required: true }] })
            .catch((e: unknown) => e);
        expect(isRegistryError(undeclared, 'bad-manifest')).toBe(true);
        const star = await reg().register({
            ...github,
            config: { type: 'object' },
            secrets: [{ name: 'github-token', title: 'Token', description: '', required: true }],
            permissions: [...github.permissions, { scope: 'secret:*', reason: 'tokens' }]
        });
        expect(star.manifest.secrets).toHaveLength(1);
        // Optional means absent, not null.
        expect(isRegistryError(await reg().register({ ...github, id: 'gh2', config: { type: 'object' }, secrets: null } as never).catch((e: unknown) => e), 'bad-manifest')).toBe(true);
        // A catalogue that breaks the rule is a build error, not a runtime surprise.
        expect(() => defineRegistry({ catalogue: [{ ...anthropic, permissions: [] }] })).toThrow(/bad plugin manifest/);
        expect(() => defineRegistry({ catalogue: [anthropic, anthropic] })).toThrow(/twice/);
    });
});

describe('single-slot kinds', () => {
    it('defaults to the first catalogue plugin of the kind; activate is the owner’s, audited, and refuses what cannot serve', async () => {
        expect((await reg().overview()).active).toEqual({ memory: 'memory-default', learning: 'learning-default' });
        expect((await reg().get('memory-default'))!.active).toBe(true);
        expect((await reg().get('agentic.memory.flat'))!.active).toBe(false);
        expect((await reg().get('anthropic-api'))!.active).toBeUndefined();

        expect(await statusOf(reg(agentOfWs).activate('memory', 'agentic.memory.flat'))).toBe(403);
        expect(isRegistryError(await reg().activate('memory', 'learning-default').catch((e: unknown) => e), 'wrong-kind')).toBe(true);
        expect(isRegistryError(await reg().activate('runtime' as never, 'anthropic-api').catch((e: unknown) => e), 'wrong-kind')).toBe(true);
        expect(isPluginDisabledError(await reg().activate('memory', 'nope').catch((e: unknown) => e))).toBe(true);
        await reg().disable('agentic.memory.flat');
        expect(isPluginDisabledError(await reg().activate('memory', 'agentic.memory.flat').catch((e: unknown) => e))).toBe(true);
        await reg().enable('agentic.memory.flat');

        const p = await reg().activate('memory', 'agentic.memory.flat');
        expect(p.active).toBe(true);
        expect((await reg().overview()).active).toEqual({ memory: 'agentic.memory.flat', learning: 'learning-default' });
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.active).toEqual({ memory: 'agentic.memory.flat' });

        const events = await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['plugin.activated'] });
        expect(events.events.map((e) => e.data)).toEqual([{ pluginId: 'agentic.memory.flat', kind: 'memory', previous: 'memory-default' }]);
        // Activating what is already active changes nothing and records nothing.
        const saves = registrySaves();
        await reg().activate('memory', 'agentic.memory.flat');
        expect(registrySaves()).toBe(saves);
    });
});

describe('gate', () => {
    it('answers the runtime, the active slots and the channels in one call, config merged over defaults', async () => {
        await reg().configure('memory-default', { limit: 3 });
        const gate = await reg(agentOfWs).gate({ runtime: 'anthropic-api' });
        expect(gate).toEqual({
            runtime: { id: 'anthropic-api', enabled: true, config: { defaultModel: 'fable' } },
            memory: { id: 'memory-default', enabled: true, config: { limit: 3 } },
            learning: { id: 'learning-default', enabled: true, config: {} },
            channels: [{ id: 'web-push', config: { subject: 'mailto:ops@example.test' } }]
        });

        await reg().disable('anthropic-api');
        await reg().disable('memory-default');
        await reg().disable('web-push');
        const off = await reg().gate({ runtime: 'anthropic-api' });
        expect(off.runtime).toMatchObject({ enabled: false });
        expect(off.memory).toMatchObject({ id: 'memory-default', enabled: false });
        expect(off.channels).toEqual([]);

        expect((await reg().gate({ runtime: 'nope' })).runtime).toBeNull();
        // A plugin of another kind is not a runtime.
        expect((await reg().gate({ runtime: 'memory-default' })).runtime).toBeNull();
        expect((await reg().gate()).runtime).toBeNull();
    });

    it('has no slots to report without a catalogue', async () => {
        await app.stop();
        await boot([]);
        expect(await reg().gate({ runtime: 'anthropic-api' })).toEqual({ runtime: null, memory: null, learning: null, channels: [] });
    });
});

describe('overview', () => {
    it('is what a page needs in one read: plugins, active slots, secret names, whether secrets can be sealed', async () => {
        await reg().setSecret('anthropic-api-key', 'sk-ant-test');
        const o = await reg().overview();
        expect(o.plugins).toEqual(await reg().list());
        expect(o.secretNames).toEqual(['anthropic-api-key']);
        expect(o.hasKek).toBe(true);
        expect(JSON.stringify(o)).not.toContain('sk-ant-test');
        expect(JSON.stringify(o)).not.toContain('kek1.');
    });
});

describe('dependentsAll', () => {
    it('covers every plugin, with the fallback-api edge and a workspace-wide marker for the active slots', async () => {
        const onApi = await agentUsing('Ada', {});
        const onCode = await agentUsing('Bob', { execution: { ...defaultAgentConfig().execution, runtime: 'claude-code', offlinePolicy: 'fallback-api' } });
        const { scheduleId } = await ws().createSchedule();
        await app.as(owner).actor(Schedule, `${WS}:schedule:${scheduleId}`).create({ kind: 'agent-task', title: 'nightly', recurrence: { kind: 'at', at: Date.now() + 86_400_000 }, agentId: onCode });

        const all = await reg().dependentsAll();
        expect(all.map((d) => d.pluginId)).toEqual((await reg().list()).map((p) => p.manifest.id));
        const of = (id: string) => all.find((d) => d.pluginId === id)!;
        expect(of('anthropic-api').agents.map((a) => [a.id, a.via])).toEqual([
            [onApi, ['runtime']],
            [onCode, ['fallback']]
        ]);
        expect(of('claude-code').agents.map((a) => [a.id, a.via])).toEqual([[onCode, ['runtime']]]);
        expect(of('anthropic-api').schedules.map((s) => s.id)).toEqual([scheduleId]);
        expect(of('memory-default')).toEqual({ pluginId: 'memory-default', agents: [], schedules: [], workspaceWide: true });
        expect(of('agentic.memory.flat').workspaceWide).toBeUndefined();
        expect(of('learning-default').workspaceWide).toBe(true);
        expect(await reg().dependents('anthropic-api')).toEqual(of('anthropic-api'));
        expect((await reg().disable('memory-default')).dependents.workspaceWide).toBe(true);
    });

    it('walks the workspace once, whatever the number of plugins', async () => {
        const calls = { workspace: 0, agent: 0, schedule: 0 };
        const agentIds = ['agent_a', 'agent_b', 'agent_c'];
        const FakeWorkspace = defineActor({
            type: 'Workspace',
            state: () => ({}),
            methods: () => ({
                async get() {
                    calls.workspace++;
                    return { agents: agentIds, schedules: ['schedule_a'] };
                }
            })
        });
        const FakeAgent = defineActor({
            type: 'Agent',
            state: () => ({}),
            methods: (ctx) => ({
                async get() {
                    calls.agent++;
                    const id = ctx.key.split(':').pop()!;
                    return { id, config: { ...defaultAgentConfig(), name: id } };
                }
            })
        });
        const FakeSchedule = defineActor({
            type: 'Schedule',
            state: () => ({}),
            methods: () => ({
                async get() {
                    calls.schedule++;
                    return { id: 'schedule_a', title: 'nightly', agentId: 'agent_a' };
                }
            })
        });
        await app.stop();
        app = testActorApp([Registry, FakeWorkspace, FakeAgent, FakeSchedule]);
        await app.start();

        const all = await reg().dependentsAll();
        expect(all).toHaveLength(CATALOGUE.length);
        expect(all.find((d) => d.pluginId === 'anthropic-api')!.agents).toHaveLength(3);
        expect(calls).toEqual({ workspace: 1, agent: 3, schedule: 1 });
    });
});
