/**
 * Switching the active memory plugin with migration (#243, MEM-09, AC-11, PLG-03): `previewActivation` reports what
 * a move would keep and drop without writing; `activate('memory', id, { migrate: true })` moves every scope the
 * workspace's agents imply, verifies the counts and flips `active` last — so a failed move leaves the old plugin
 * active. default → flat → default is the round trip AC-11 proves, now through the Registry.
 */
import type { AgentId, MemoryScope, NewMemoryEntry, WorkspaceId } from '@agentic/core';
import { DEFAULT_MEMORY_PLUGIN_ID, FLAT_MEMORY_PLUGIN_ID, memoryDefaultPlugin, memoryFlatPlugin } from '@agentic/memory';
import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { FlatMemory, Memory, flatMemoryActorImpl, memoryActorImpl, memoryActorKey } from '../../src/memory/index';
import { defineRegistry, isRegistryError, registryKey } from '../../src/registry/index';
import { defineScheduleActor } from '../../src/schedule/index';
import type { MemoryPluginImpl } from '../../src/task/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const Schedule = defineScheduleActor({ trigger: { fired: async () => {} } });

let app: TestActorApp;
let Registry = defineRegistry();

async function boot(memoryPlugins: Readonly<Record<string, MemoryPluginImpl>>): Promise<void> {
    Registry = defineRegistry({ catalogue: [memoryDefaultPlugin, memoryFlatPlugin], memoryPlugins });
    app = testActorApp([Registry, Workspace, AgentActor, Schedule, AuditActor, Memory, FlatMemory]);
    await app.start();
}

afterEach(() => app.stop());

const IMPLS = { [DEFAULT_MEMORY_PLUGIN_ID]: memoryActorImpl(), [FLAT_MEMORY_PLUGIN_ID]: flatMemoryActorImpl() };
const reg = () => app.as(owner).actor(Registry, registryKey(WS));
const memory = (scope: MemoryScope) => app.as(owner).actor(Memory, memoryActorKey(WS, scope));
const flat = (scope: MemoryScope) => app.as(owner).actor(FlatMemory, memoryActorKey(WS, scope));

const entry = (text: string, extra: Partial<NewMemoryEntry> = {}): NewMemoryEntry => ({ kind: 'fact', text, tags: [], confidence: 'stated', provenance: { source: 'agent' }, ...extra });

/** An agent that reads the shared scope `team`, with two memories of its own (one with conditions) and one shared. */
async function seed(): Promise<{ ada: AgentId; own: MemoryScope }> {
    const { agentId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createAgent({ name: 'Ada' });
    const ada = agentId as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, ada)).update({ name: 'Ada', memoryPolicy: { shared: ['team'], autoLearn: 'off' } }, 'setup');
    const own: MemoryScope = `agent:${ada}`;
    await memory(own).put(entry('deploys go out on fridays'));
    await memory(own).put(entry('prefers short answers', { kind: 'lesson', conditions: 'when writing release notes' }));
    await memory('shared:team').put(entry('the release train leaves at noon'));
    return { ada, own };
}

const texts = async (rows: Promise<{ entries: readonly { text: string }[] }>) => (await rows).entries.map((e) => e.text).sort();

describe('switching the active memory plugin with migration (#243)', () => {
    it('previews the move without writing, then moves default → flat → default with only the flat plugin’s limits lost', async () => {
        await boot(IMPLS);
        const { own } = await seed();

        const preview = await reg().previewActivation('memory', FLAT_MEMORY_PLUGIN_ID);
        expect(preview).toMatchObject({ from: DEFAULT_MEMORY_PLUGIN_ID, to: FLAT_MEMORY_PLUGIN_ID, dryRun: true, targetExport: 'partial', entries: 3, imported: 3, skipped: 0, droppedFields: ['conditions'] });
        expect(preview.scopes.map((s) => [s.scope, s.report.entries])).toEqual([
            [own, 2],
            ['shared:team', 1]
        ]);
        expect(await texts(flat(own).exportPage(null, 10))).toEqual([]);
        expect((await reg().overview()).active.memory).toBe(DEFAULT_MEMORY_PLUGIN_ID);

        const moved = await reg().activate('memory', FLAT_MEMORY_PLUGIN_ID, { migrate: true });
        expect(moved.active).toBe(true);
        expect(moved.migration).toMatchObject({ dryRun: false, entries: 3, imported: 3, skipped: 0, droppedFields: ['conditions'] });
        expect((await reg().overview()).active.memory).toBe(FLAT_MEMORY_PLUGIN_ID);
        expect(await texts(flat(own).exportPage(null, 10))).toEqual(['deploys go out on fridays', 'prefers short answers']);
        expect(await texts(flat('shared:team').exportPage(null, 10))).toEqual(['the release train leaves at noon']);
        // The source is never touched.
        expect(await texts(memory(own).exportPage(null, 10))).toEqual(['deploys go out on fridays', 'prefers short answers']);

        // Back to the default: its store still holds everything, so the ids already there are skipped, not doubled.
        await flat(own).put(entry('learned while flat'));
        const back = await reg().activate('memory', DEFAULT_MEMORY_PLUGIN_ID, { migrate: true });
        expect(back.migration).toMatchObject({ entries: 4, imported: 1, skipped: 3, droppedFields: [] });
        expect((await reg().overview()).active.memory).toBe(DEFAULT_MEMORY_PLUGIN_ID);
        expect(await texts(memory(own).exportPage(null, 10))).toEqual(['deploys go out on fridays', 'learned while flat', 'prefers short answers']);

        const events = await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['plugin.activated'] });
        expect(events.events.map((e) => e.summary)).toEqual(
            expect.arrayContaining([expect.stringContaining('3 of 3 memories moved from agentic.memory.default (dropped: conditions)'), expect.stringContaining('1 of 4 memories moved from agentic.memory.flat')])
        );
    });

    it('a failed import leaves the old plugin active, and so does an import that does not verify', async () => {
        const flatImpl = flatMemoryActorImpl();
        const failing: MemoryPluginImpl = (config) => {
            const inner = flatImpl(config);
            return { ...inner, open: (scope, principal) => ({ ...inner.open(scope, principal), import: async () => Promise.reject(new Error('disk full')) }) };
        };
        await boot({ ...IMPLS, [FLAT_MEMORY_PLUGIN_ID]: failing });
        await seed();
        const refused = await reg()
            .activate('memory', FLAT_MEMORY_PLUGIN_ID, { migrate: true })
            .catch((e: unknown) => e);
        expect(isRegistryError(refused, 'migration-failed')).toBe(true);
        expect(String((refused as Error).message)).toMatch(/disk full/);
        expect((await reg().overview()).active.memory).toBe(DEFAULT_MEMORY_PLUGIN_ID);
        await app.stop();

        // An import that claims rows it never wrote fails the count check.
        const lying: MemoryPluginImpl = (config) => {
            const inner = flatImpl(config);
            return { ...inner, open: (scope, principal) => ({ ...inner.open(scope, principal), import: async () => ({ imported: 2, skipped: 0, droppedFields: [] }) }) };
        };
        await boot({ ...IMPLS, [FLAT_MEMORY_PLUGIN_ID]: lying });
        await seed();
        const unverified = await reg()
            .activate('memory', FLAT_MEMORY_PLUGIN_ID, { migrate: true })
            .catch((e: unknown) => e);
        expect(isRegistryError(unverified, 'migration-failed')).toBe(true);
        expect(String((unverified as Error).message)).toMatch(/expected 4 new entries in agentic.memory.flat, found 0/);
        expect((await reg().overview()).active.memory).toBe(DEFAULT_MEMORY_PLUGIN_ID);
    });

    it('refuses what it cannot move: no implementation, a non-memory kind, and anyone but the owner', async () => {
        await boot({ [DEFAULT_MEMORY_PLUGIN_ID]: memoryActorImpl() });
        await seed();
        expect(isRegistryError(await reg().previewActivation('memory', FLAT_MEMORY_PLUGIN_ID).catch((e: unknown) => e), 'no-migration')).toBe(true);
        expect(isRegistryError(await reg().activate('memory', FLAT_MEMORY_PLUGIN_ID, { migrate: true }).catch((e: unknown) => e), 'no-migration')).toBe(true);
        expect((await reg().overview()).active.memory).toBe(DEFAULT_MEMORY_PLUGIN_ID);
        expect(isRegistryError(await reg().previewActivation('learning', 'x').catch((e: unknown) => e), 'wrong-kind')).toBe(true);
        const agent = { kind: 'agent' as const, workspaceId: WS, agentId: 'agent_x' as AgentId, sessionId: 'session_x' as never };
        expect(await statusOf(app.as(agent).actor(Registry, registryKey(WS)).previewActivation('memory', FLAT_MEMORY_PLUGIN_ID))).toBe(403);
        // Without migrate the switch stays what it was: nothing moves.
        await reg().activate('memory', FLAT_MEMORY_PLUGIN_ID);
        expect((await reg().overview()).active.memory).toBe(FLAT_MEMORY_PLUGIN_ID);
    });
});
