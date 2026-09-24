/**
 * Registry tool policy (#631; PLG-03, PLG-04, OPS-02, OPS-03): the workspace
 * default allow / ask / deny per plugin tool, stored through `patchPlugin`
 * and audited; the effective map falls back to the manifest's `defaultMode`
 * and then to `allow`; `gate()` hands each connector's ask / deny entries and
 * whether its tools are granted; `revoke` is held to the manifest and audited.
 */
import type { PluginManifest, WorkspaceId } from '@agentic/core';
import { AuditActor, auditKey } from '../../src/audit/index';
import { assertPluginManifest, defineRegistry, isRegistryError, registryKey, type RegistryState } from '../../src/registry/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = registryKey(WS);

const base = { version: '1.0.0', description: '', capabilities: [], config: { type: 'object' }, compat: { platform: '*', core: '*' } } as const;

/** A connector plugin that declares two tools; its connector reports a third at probe time. */
const gmail: PluginManifest = {
    ...base,
    id: 'gmail',
    kind: 'connector',
    name: 'Gmail',
    permissions: [
        { scope: 'network:gmail.googleapis.com', reason: 'reach the API' },
        { scope: 'tools:gmail', reason: 'expose its operations' }
    ],
    tools: [
        { name: 'gmail__search', title: 'Search mail', defaultMode: 'allow' },
        { name: 'gmail__send-email', title: 'Send an email', defaultMode: 'ask' }
    ]
};

/** A built-in with a declared tool: virtual until the first `setToolPolicy`. */
const notes: PluginManifest = { ...base, id: 'notes', kind: 'connector', name: 'Notes', permissions: [{ scope: 'tools:notes', reason: 'expose' }], tools: [{ name: 'notes__delete', defaultMode: 'deny' }] };

const Registry = defineRegistry({ catalogue: [notes] });

let app: TestActorApp;
async function boot(storage?: TestActorApp['storage']): Promise<void> {
    app = testActorApp([Registry, AuditActor], storage ? { storage } : {});
    await app.start();
}
beforeEach(() => boot());
afterEach(() => app.stop());

const reg = (p = owner) => app.as(p).actor(Registry, KEY);
const auditOf = async (kind: 'plugin.tool-policy' | 'plugin.revoked') => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: [kind] })).events;

async function installGmail(): Promise<void> {
    await reg().register(gmail, { enabled: true, grant: 'declared' });
    await reg().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail' });
    await reg().setConnectorStatus('gmail', { state: 'ok' }, ['gmail__search', 'gmail__send-email', 'gmail__archive']);
}

describe('toolPolicy(id): the effective map', () => {
    it('covers every declared and reported tool: the stored mode, else the manifest default, else allow', async () => {
        await installGmail();
        expect(await reg().toolPolicy('gmail')).toEqual({ gmail__archive: 'allow', gmail__search: 'allow', 'gmail__send-email': 'ask' });
        await reg().setToolPolicy('gmail', 'gmail__search', 'deny');
        await reg().setToolPolicy('gmail', 'gmail__archive', 'ask');
        expect(await reg().toolPolicy('gmail')).toEqual({ gmail__archive: 'ask', gmail__search: 'deny', 'gmail__send-email': 'ask' });
        // A stored mode wins over the manifest default, in either direction.
        await reg().setToolPolicy('gmail', 'gmail__send-email', 'allow');
        expect((await reg().toolPolicy('gmail'))['gmail__send-email']).toBe('allow');
    });

    it('a plugin that is not installed is plugin-missing', async () => {
        expect(isRegistryError(await reg().toolPolicy('nope').catch((e: unknown) => e), 'plugin-missing')).toBe(true);
    });
});

describe('setToolPolicy(id, tool, mode)', () => {
    it('persists across a reload and is audited as plugin.tool-policy', async () => {
        await installGmail();
        const policy = await reg().setToolPolicy('gmail', 'gmail__search', 'ask');
        expect(policy.gmail__search).toBe('ask');
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.plugins.gmail!.toolPolicy).toEqual({ gmail__search: 'ask' });

        const storage = app.storage;
        await app.stop();
        await boot(storage);
        expect((await reg().toolPolicy('gmail')).gmail__search).toBe('ask');

        await reg().setToolPolicy('gmail', 'gmail__search', 'deny');
        const events = await auditOf('plugin.tool-policy');
        expect(events.map((e) => e.data)).toEqual([
            { pluginId: 'gmail', tool: 'gmail__search', mode: 'deny' },
            { pluginId: 'gmail', tool: 'gmail__search', mode: 'ask' }
        ]);
        expect(events[0]).toMatchObject({ by: 'user:u1', summary: 'plugin gmail tool gmail__search set to deny' });
    });

    it('setting the mode a tool already runs on records nothing', async () => {
        await installGmail();
        await reg().setToolPolicy('gmail', 'gmail__send-email', 'ask');
        expect(await auditOf('plugin.tool-policy')).toEqual([]);
    });

    it('audits every change even when two land in the same millisecond', async () => {
        await installGmail();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            await reg().setToolPolicy('gmail', 'gmail__search', 'ask');
            await reg().setToolPolicy('gmail', 'gmail__search', 'deny');
            await reg().setToolPolicy('gmail', 'gmail__search', 'ask');
        } finally {
            vi.useRealTimers();
        }
        const modes = (await auditOf('plugin.tool-policy')).map((e) => (e.data as { mode: string }).mode);
        expect(modes.sort()).toEqual(['ask', 'ask', 'deny']);
    });

    it('rejects a tool neither declared nor reported with unknown-tool, and a mode that is not a ToolMode; nothing is stored', async () => {
        await installGmail();
        expect(isRegistryError(await reg().setToolPolicy('gmail', 'gmail__drop-table', 'deny').catch((e: unknown) => e), 'unknown-tool')).toBe(true);
        // A tool of ANOTHER plugin is unknown here too.
        expect(isRegistryError(await reg().setToolPolicy('gmail', 'notes__delete', 'deny').catch((e: unknown) => e), 'unknown-tool')).toBe(true);
        await expect(reg().setToolPolicy('gmail', 'gmail__search', 'maybe' as never)).rejects.toThrow(/allow, ask or deny/);
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.plugins.gmail!.toolPolicy).toBeUndefined();
    });

    it('is the owner’s alone', async () => {
        await installGmail();
        const agent = { kind: 'agent', workspaceId: WS, agentId: 'agent_1', sessionId: 'session_1' } as never;
        expect(await statusOf(reg(agent).setToolPolicy('gmail', 'gmail__search', 'deny'))).toBe(403);
    });

    it('materialises a built-in on the first write, keeping it virtual until then', async () => {
        expect(await reg().toolPolicy('notes')).toEqual({ notes__delete: 'deny' });
        expect(await app.storage.load('Registry', KEY)).toBeNull();
        await reg().setToolPolicy('notes', 'notes__delete', 'ask');
        const stored = (await app.storage.load('Registry', KEY))!.state as RegistryState;
        expect(stored.plugins.notes).toMatchObject({ enabled: true, toolPolicy: { notes__delete: 'ask' }, grantedPermissions: ['tools:notes'] });
    });
});

describe('gate() carries the tool policy', () => {
    it('lists only the ask / deny tools, and whether the tools:<ns> scope is granted', async () => {
        await installGmail();
        await reg().setToolPolicy('gmail', 'gmail__archive', 'deny');
        const [ready] = (await reg().gate({ connectors: ['gmail'] })).connectors!;
        expect(ready).toMatchObject({ state: 'ready', toolPolicy: { 'gmail__send-email': 'ask', gmail__archive: 'deny' }, toolsGranted: true });
        expect(ready!.toolPolicy).not.toHaveProperty('gmail__search');

        await reg().revoke('gmail', ['tools:gmail']);
        expect((await reg().gate({ connectors: ['gmail'] })).connectors![0]!.toolsGranted).toBe(false);
    });

    it('an MCP connector carries them too; tools:* covers the namespace once granted', async () => {
        const wide: PluginManifest = { ...base, id: 'wide', kind: 'connector', name: 'Wide', permissions: [{ scope: 'tools:*', reason: 'everything' }] };
        await reg().register(wide, { enabled: true });
        await reg().putConnector({ id: 'wide', pluginId: 'wide', transport: 'streamable-http', url: 'https://wide.test/mcp' });
        expect((await reg().gate({ connectors: ['wide'] })).connectors![0]).toMatchObject({ state: 'ready', transport: 'streamable-http', toolPolicy: {}, toolsGranted: false });
        await reg().grant('wide', ['tools:*']);
        expect((await reg().gate({ connectors: ['wide'] })).connectors![0]!.toolsGranted).toBe(true);
    });

    it('a plugin that never asked for a tools scope has its tools ungranted', async () => {
        const bare: PluginManifest = { ...base, id: 'bare', kind: 'connector', name: 'Bare', permissions: [] };
        await reg().register(bare, { enabled: true, grant: 'declared' });
        await reg().putConnector({ id: 'bare', pluginId: 'bare', transport: 'streamable-http', url: 'https://bare.test/mcp' });
        expect((await reg().gate({ connectors: ['bare'] })).connectors![0]!.toolsGranted).toBe(false);
    });
});

describe('revoke', () => {
    it('rejects a scope the manifest never declared, like grant', async () => {
        await installGmail();
        expect(isRegistryError(await reg().revoke('gmail', ['machine:*']).catch((e: unknown) => e), 'not-declared')).toBe(true);
        expect(isRegistryError(await reg().revoke('gmail', ['nonsense' as never]).catch((e: unknown) => e), 'not-declared')).toBe(true);
        expect((await reg().get('gmail'))!.grantedPermissions).toEqual(['network:gmail.googleapis.com', 'tools:gmail']);
    });

    it('is audited as plugin.revoked with the scopes it took away; revoking what is not held records nothing', async () => {
        await installGmail();
        await reg().revoke('gmail', ['tools:gmail']);
        await reg().revoke('gmail', ['tools:gmail']);
        const events = await auditOf('plugin.revoked');
        expect(events.map((e) => e.data)).toEqual([{ pluginId: 'gmail', scopes: ['tools:gmail'] }]);
        expect(events[0]).toMatchObject({ by: 'user:u1', summary: 'plugin gmail revoked tools:gmail' });
    });
});

describe('assertPluginManifest: tools[]', () => {
    it('accepts unique names with a ToolMode default, and no tools at all', () => {
        expect(() => assertPluginManifest(gmail)).not.toThrow();
        expect(() => assertPluginManifest({ ...gmail, tools: undefined })).not.toThrow();
    });

    it('refuses duplicate names, a defaultMode that is not a ToolMode, and a tools that is not a list', () => {
        const bad = (tools: unknown) => isRegistryError((() => { try { assertPluginManifest({ ...gmail, tools }); } catch (e) { return e; } })(), 'bad-manifest');
        expect(bad([{ name: 'a' }, { name: 'a' }])).toBe(true);
        expect(bad([{ name: 'a', defaultMode: 'maybe' }])).toBe(true);
        expect(bad([{ name: '' }])).toBe(true);
        expect(bad([{ name: '   ' }])).toBe(true);
        expect(bad([{ name: 'a', title: 3 }])).toBe(true);
        expect(bad(null)).toBe(true);
        expect(bad({ a: 1 })).toBe(true);
    });
});
