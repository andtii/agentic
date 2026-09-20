/**
 * OPS-10: `Workspace.exportAll` writes one NDJSON file per actor kind through
 * the `ArtifactSink`; `deleteAll` purges every child record through the
 * `WorkspaceStore` and finally itself — nothing of the workspace is left in
 * storage.
 */
import type { AgentId, PluginManifest, TaskId, WorkspaceId } from '@agentic/core';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { AgentActor, agentKey } from '../src/agent/index';
import { defineSessionActor, SESSION_PAGE_TYPE, SessionPage, sessionPageKey, type SessionFactory } from '../src/session/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey, workspaceOfActorKey } from '../src/auth/index';
import { Chat, ChatPage } from '../src/chat/index';
import { FlatMemory, Memory, memoryActorKey } from '../src/memory/index';
import { Inbox, inboxKey } from '../src/notify/index';
import { defineRegistry, registryKey } from '../src/registry/index';
import { defineScheduleActor } from '../src/schedule/index';
import { recordingStorage, testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';
import { PairingDirectory } from '../src/pairing/index';
import { memoryFileStore } from './chat/helpers';
import { defineWorkspace, type ActorRecordRef, type ArtifactSink, type WorkspaceState, type WorkspaceStore } from '../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = workspaceKey(WS);

const Schedule = defineScheduleActor({ trigger: { fired: async () => {} } });
const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()) });

const plugin: PluginManifest = {
    id: 'github',
    version: '1.0.0',
    kind: 'connector',
    name: 'GitHub',
    description: '',
    capabilities: [],
    config: {},
    permissions: [{ scope: 'secret:github-token', reason: 'token' }],
    compat: { platform: '*', core: '*' }
};

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

let app: TestActorApp;
let files: Map<string, string>;
let purged: ActorRecordRef[];
/** Whether the store can enumerate the workspace: off, only what the index and the chats' bindings reach is purged (#399). */
let listing = true;

const sink: ArtifactSink = {
    async put(path, body) {
        files.set(path, body);
    }
};

/** Every distinct record the storage ever saved for the workspace — what a listing storage would enumerate. */
const savedRefs = (): ActorRecordRef[] => {
    const seen = new Map<string, ActorRecordRef>();
    for (const s of app.saves) if (workspaceOfActorKey(s.key) === WS) seen.set(JSON.stringify([s.type, s.key]), { type: s.type, key: s.key });
    return [...seen.values()];
};

/** The app-level port over the test storage: deactivate, then clear the record. */
const store: WorkspaceStore = {
    async purge(ref) {
        purged.push(ref);
        await app.host.deactivate(ref);
        const record = await app.storage.load(ref.type, ref.key);
        if (record) await app.storage.clear(ref.type, ref.key, record.etag);
    },
    async list() {
        return listing ? savedRefs() : [];
    }
};

/** Chat attachment bytes (#203): `deleteAll` deletes every chat's files through it. */
const fileStore = memoryFileStore();

const Workspace = defineWorkspace({ sink, store, files: fileStore });

/** About 700 KB streamed in 1 KB deltas: past `WINDOW_BYTES`, so a session's log rolls a page out of its record (#198). */
const BIG = 'y'.repeat(700_000);
const model = mockAgent({ respond: (input) => (input.some((p) => p.type === 'text' && p.text === 'big') ? [{ text: BIG, chunkSize: 1000 }] : [{ text: 'echo' }]) });
const factory: SessionFactory = async (runtime, c) => {
    if (runtime !== 'anthropic-api') return null;
    const session = await model.session({ policy: allowAll, signal: c.signal });
    return { session, agentId: model.id, capabilities: model.capabilities };
};
/** A Session a chat may bind (#399): opened with a `chatId`, so its `session-started` creates the chat's row. */
const Session = defineSessionActor({ factory });

beforeEach(() => {
    files = new Map();
    purged = [];
    listing = true;
    fileStore.deleted.length = 0;
    app = testActorApp([Workspace, AgentActor, Memory, FlatMemory, Chat, ChatPage, Schedule, Inbox, Registry, PairingDirectory, Session, SessionPage], { storage: recordingStorage() });
    return app.start();
});
afterEach(() => app.stop());

const ws = () => app.as(owner).actor(Workspace, KEY);

/** A workspace with one of everything. */
async function populate() {
    const { agentId } = await ws().createAgent({ name: 'Ada' });
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: 'Ada', memoryPolicy: { shared: ['team'] }, connectors: [{ id: 'github' }] }, 'setup');
    await app.as(owner).actor(Memory, memoryActorKey(WS, `agent:${agentId}`)).put({ kind: 'fact', text: 'deploys on fridays', tags: [], confidence: 'stated', provenance: { source: 'agent' } });
    await app.as(owner).actor(Memory, memoryActorKey(WS, 'shared:team')).put({ kind: 'fact', text: 'shared fact', tags: [], confidence: 'stated', provenance: { source: 'user' } });
    // The flat memory plugin's store of the same scope is its own record (#281).
    await app.as(owner).actor(FlatMemory, memoryActorKey(WS, `agent:${agentId}`)).put({ kind: 'fact', text: 'flat fact', tags: [], confidence: 'stated', provenance: { source: 'agent' } });
    const { chatId } = await ws().createChat({ title: 'general' });
    const chat = app.as(owner).actor(Chat, `${WS}:chat:${chatId}`);
    await chat.addAgent(agentId, 'all');
    await chat.post('hello');
    await chat.post('world');
    const { scheduleId } = await ws().createSchedule();
    await app.as(owner).actor(Schedule, `${WS}:schedule:${scheduleId}`).create({ kind: 'reminder', title: 'stand-up', recurrence: { kind: 'at', at: Date.now() + 86_400_000 } });
    await app.as(owner).actor(Inbox, inboxKey(WS)).append({ kind: 'reminder', title: 'Stand-up' });
    const registry = app.as(owner).actor(Registry, registryKey(WS));
    await registry.register(plugin, { enabled: true, grant: 'declared' });
    await registry.setSecret('github-token', 'ghp_secret');
    const { pairingCode } = await ws().registerMachinePending({ name: 'laptop' });
    return { agentId, chatId, scheduleId, pairingCode };
}

const rows = (path: string): Record<string, unknown>[] =>
    files
        .get(path)!
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('Workspace.exportAll', () => {
    it('writes one NDJSON file per actor kind through the sink, via each actor, with nothing sensitive', async () => {
        const { agentId, chatId, scheduleId, pairingCode } = await populate();
        await ws().exportAll();
        await until(async () => (await ws().get()).ops?.export?.finishedAt !== undefined, 'the export');
        const op = (await ws().get()).ops!.export!;
        expect(op.error).toBeUndefined();
        expect(op.prefix).toMatch(new RegExp(`^${WS}/\\d{4}-`));

        const paths = [...files.keys()].map((p) => p.slice(op.prefix!.length + 1)).sort();
        expect(paths).toEqual(['agents.ndjson', 'chats.ndjson', 'inbox.ndjson', 'manifest.json', 'memory.ndjson', 'registry.ndjson', 'schedules.ndjson', 'sessions.ndjson', 'tasks.ndjson', 'workspace.ndjson']);
        const at = (kind: string) => rows(`${op.prefix}/${kind}.ndjson`);

        expect(at('workspace')[0]).toMatchObject({ kind: 'workspace', workspace: { owner: 'u1', agents: [agentId], chats: [chatId], schedules: [scheduleId] } });
        expect(at('agents')).toMatchObject([{ kind: 'agent', agent: { id: agentId, configVersion: 1, config: { name: 'Ada' }, versions: [{ version: 1, reason: 'setup' }] } }]);
        expect(at('memory').map((r) => [r.scope, (r.entry as { text: string }).text, r.plugin])).toEqual([
            [`agent:${agentId}`, 'deploys on fridays', undefined],
            ['shared:team', 'shared fact', undefined],
            [`agent:${agentId}`, 'flat fact', 'agentic.memory.flat']
        ]);
        const chats = at('chats');
        // The title (#124) is the chat's first entry and rides in its summary.
        expect(chats[0]).toMatchObject({ kind: 'chat', id: chatId, chat: { title: 'general' } });
        expect(chats.slice(1).map((r) => r.kind)).toEqual(['chat-entry', 'chat-entry', 'chat-entry', 'chat-entry']);
        expect(chats.slice(1).map((r) => r.seq)).toEqual([0, 1, 2, 3]);
        expect(chats[1]).toMatchObject({ entry: { t: 'rename', title: 'general' } });
        expect(at('schedules')).toMatchObject([{ kind: 'schedule', id: scheduleId, schedule: { title: 'stand-up' } }]);
        expect(at('inbox')).toMatchObject([{ kind: 'notification', notification: { title: 'Stand-up' } }]);
        expect(at('registry').map((r) => r.kind)).toEqual(['plugin', 'secret']);

        const everything = [...files.values()].join('\n');
        expect(everything).not.toContain('ghp_secret');
        expect(everything).not.toContain('kek1.');
        expect(everything).not.toContain(pairingCode);

        const manifest = JSON.parse(files.get(`${op.prefix}/manifest.json`)!) as { files: { path: string; rows: number }[]; retention: unknown; notExported: unknown[] };
        expect(manifest.files).toHaveLength(9);
        expect(manifest.retention).toEqual({ sessionLogDays: 90, artifactDays: 30 });
        expect(manifest.notExported).toEqual([]);
    });

    it('records the failure when no sink is configured and changes nothing', async () => {
        await app.stop();
        const Bare = defineWorkspace();
        app = testActorApp([Bare]);
        await app.start();
        const bare = app.as(owner).actor(Bare, KEY);
        await bare.exportAll();
        await until(async () => (await bare.get()).ops?.export?.finishedAt !== undefined, 'the export');
        expect((await bare.get()).ops!.export!.error).toMatch(/no ArtifactSink/);
        await bare.deleteAll();
        await until(async () => (await bare.get()).ops?.delete?.finishedAt !== undefined, 'the delete');
        expect((await bare.get()).ops!.delete!.error).toMatch(/no WorkspaceStore/);
        expect((await bare.get()).owner).toBe('u1');
    });
});

describe('Workspace.deleteAll', () => {
    it('leaves no actor state for the workspace in storage', async () => {
        const { agentId, chatId } = await populate();
        const before = savedRefs();
        expect(before.map((r) => r.type).sort()).toEqual(['Agent', 'Chat', 'FlatMemory', 'Inbox', 'Memory', 'Memory', 'Registry', 'Schedule', 'Workspace']);
        for (const ref of before) expect(await app.storage.load(ref.type, ref.key)).not.toBeNull();

        await ws().deleteAll();
        await until(async () => (await app.storage.load('Workspace', KEY)) === null, 'the delete');

        // Every record ever written for the workspace is gone — the root included.
        for (const ref of savedRefs()) expect(await app.storage.load(ref.type, ref.key), `${ref.type} ${ref.key}`).toBeNull();
        // Children were purged before the root, chat pages included, once each.
        const purgedKeys = purged.map((r) => `${r.type} ${r.key}`);
        expect(new Set(purgedKeys).size).toBe(purgedKeys.length);
        expect(purgedKeys).toContain(`Agent ${agentKey(WS, agentId)}`);
        expect(purgedKeys).toContain(`Chat ${WS}:chat:${chatId}`);
        expect(purgedKeys).toContain(`ChatPage ${WS}:chat:${chatId}:p0`);
        expect(purgedKeys).toContain(`Memory ${memoryActorKey(WS, 'shared:team')}`);
        expect(purgedKeys).toContain(`FlatMemory ${memoryActorKey(WS, `agent:${agentId}`)}`);
        expect(purgedKeys).toContain(`Registry ${registryKey(WS)}`);
        expect(purgedKeys).not.toContain(`Workspace ${KEY}`);
        // Every chat's attachments went through the file store (#205).
        expect(fileStore.deleted).toEqual([`${WS}/${chatId}`]);

        // A fresh activation is an empty workspace, and the children are empty too.
        const fresh = await ws().get();
        expect(fresh.agents).toEqual([]);
        expect(fresh.chats).toEqual([]);
        expect(fresh.ops).toEqual({});
        expect(await app.as(owner).actor(Registry, registryKey(WS)).list()).toEqual([]);
        expect((await app.as(owner).actor(AgentActor, agentKey(WS, agentId as AgentId)).get()).configVersion).toBe(0);
        expect((await app.storage.load('Workspace', KEY)) satisfies { state: unknown } | null).toBeNull();
        void (undefined as unknown as WorkspaceState);
    });

    it('reaches a chat’s live session and every one of its pages through the binding, with no listing to help (#399)', async () => {
        const { agentId, chatId } = await populate();
        const chat = app.as(owner).actor(Chat, `${WS}:chat:${chatId}`);
        const sessionKey = `${WS}:session:s_live`;
        const session = app.as(owner).actor(Session, sessionKey);
        const config = await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).snapshotForSession();
        // The member's live session: opened for this chat, its first turn streaming past the window so the log has a page.
        await session.open({ agentId, runtime: 'anthropic-api', chatId, taskId: 't_1' as TaskId, config, objective: 'big', context: [], tools: [] });
        await until(async () => (await chat.get()).sessions[agentId]?.sessionId === 's_live', 'the binding');
        await session.prompt([{ type: 'text', text: 'big' }], 't_1:turn:1');
        await until(async () => {
            const info = await session.get();
            return info.pages >= 1 && info.status === 'idle';
        }, 'the turn to end with a page rolled out', 20_000);
        const pages = (await session.get()).pages;
        expect(await app.storage.load('session', sessionKey)).not.toBeNull();
        for (let p = 0; p < pages; p++) expect(await app.storage.load(SESSION_PAGE_TYPE, sessionPageKey(sessionKey, p))).not.toBeNull();

        // Nothing but the index and the bindings: a Durable Object namespace cannot be listed either.
        listing = false;
        await ws().deleteAll();
        await until(async () => (await app.storage.load('Workspace', KEY)) === null, 'the delete');

        const purgedKeys = purged.map((r) => `${r.type} ${r.key}`);
        expect(purgedKeys).toContain(`session ${sessionKey}`);
        for (let p = 0; p < pages; p++) expect(purgedKeys).toContain(`${SESSION_PAGE_TYPE} ${sessionPageKey(sessionKey, p)}`);
        // The pages go before their record, and the record before its chat.
        expect(purgedKeys.indexOf(`session ${sessionKey}`)).toBeGreaterThan(purgedKeys.indexOf(`${SESSION_PAGE_TYPE} ${sessionPageKey(sessionKey, 0)}`));
        expect(purgedKeys.indexOf(`Chat ${WS}:chat:${chatId}`)).toBeGreaterThan(purgedKeys.indexOf(`session ${sessionKey}`));
        expect(await app.storage.load('session', sessionKey)).toBeNull();
        for (let p = 0; p < pages; p++) expect(await app.storage.load(SESSION_PAGE_TYPE, sessionPageKey(sessionKey, p))).toBeNull();
        // Every record ever written for the workspace is gone, the session's included.
        for (const ref of savedRefs()) expect(await app.storage.load(ref.type, ref.key), `${ref.type} ${ref.key}`).toBeNull();
    });
});
