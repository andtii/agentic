/**
 * Deleting a chat (#674; CHT-01, PLG-01): `Workspace.deleteChat` marks the Chat deleted, forgets it in the index and
 * drops its files; a chat in a project is released with `reason: 'deleted'`, so the git plugin's `on-chat-leave`
 * cleanup removes a clean worktree and keeps a dirty one — both audited `project.chat-released`. The real git plugin
 * through the real router, one online in-memory machine; the daemon's `worktree-remove` answer is faked, since the
 * in-memory daemon has no worktrees.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, projectFolderKey, type AgentId, type ChatFileStore, type ChatId, type EnvironmentId, type MachineId, type Principal, type ProjectFeatureFs, type ProjectFeaturePlugin, type ProjectId, type SessionId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { GIT_FEATURE_ID, gitFeatureManifest, gitFeaturePlugin } from '@agentic/plugins-git';

import { AgentActor } from '../../src/agent/index';
import { AuditActor, auditKey, capturingAuditPort } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage, defineChatActor } from '../../src/chat/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry } from '../../src/registry/index';
import { defineRoutingActor, routingKey, type RuntimeCatalogue } from '../../src/routing/index';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { TaskActor } from '../../src/task/index';
import { defineWorkspace, Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
const runtimes: RuntimeCatalogue = { 'anthropic-api': { host: 'local', open: () => Promise.reject(new Error('not opened here')) } };

/** What the daemon answers the git plugin's `worktree-remove`, set per test. */
let daemonFs: ProjectFeatureFs;
/** Every op the plugin sent. */
let ops: Parameters<ProjectFeatureFs>[0][];
/** The real git plugin, its daemon answers faked. */
const git: ProjectFeaturePlugin = {
    ...gitFeaturePlugin,
    onChatReleased: (input) =>
        gitFeaturePlugin.onChatReleased!({
            ...input,
            fs: (op) => {
                ops.push(op);
                return daemonFs(op);
            }
        })
};
const removes: ProjectFeatureFs = async (op) => (op.kind === 'worktree-remove' ? { result: { kind: 'worktree-remove', path: op.path, removed: true, branchDeleted: false } } : { error: { code: 'unsupported', message: op.kind } });
const dirty: ProjectFeatureFs = async (op) => ({ error: { code: 'dirty', message: `${op.kind === 'worktree-remove' ? op.path : '?'} has uncommitted changes; it was left as it is` } });

class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let audit: ReturnType<typeof capturingAuditPort>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let filesDeleted: ChatId[];
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    daemonFs = removes;
    ops = [];
    filesDeleted = [];
    sockets = new FakeSockets();
    audit = capturingAuditPort();
    const files: ChatFileStore = {
        put: async () => undefined,
        get: async () => null,
        markPosted: async () => undefined,
        deleteChat: async (_ws, chatId) => {
            filesDeleted.push(chatId);
        },
        sweepOrphans: async () => 0
    };
    const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()), catalogue: [gitFeatureManifest] });
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    const Session = defineSessionActor({ factory: async () => null, commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes, audit, projectFeatures: { [GIT_FEATURE_ID]: git } });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing });
    const RoutedChat = defineChatActor({ routing: () => Routing, files });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, defineWorkspace({ files }), PairingDirectory, RoutedChat, ChatPage, Registry, AuditActor]);
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const workspace = (principal: Principal = owner) => app.as(principal).actor(Workspace, workspaceKey(WS));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const chat = (id: ChatId, principal: Principal = owner) => app.as(principal).actor(Chat, actorKey(WS, 'chat', id));
const released = () => audit.events.filter((e) => e.kind === 'project.chat-released');
/** `chat.deleted` is the Chat's own record, through the Audit actor. */
const deletedRecords = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['chat.deleted'] })).events.map((e) => e.data);

/** A paired machine reporting E1 (root `/work`), its daemon connected. */
async function onlineMachine(): Promise<MachineId> {
    const { machineId, pairingCode } = await workspace().registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const d = inMemoryHarness({ machineId, environments: [{ ...inMemoryEnvironment(machineId, E1), cwdRoots: ['/work'] }] }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(machineId, asMachine(machineId));
    void (async () => {
        try {
            for (;;) await asDaemon.socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
    })();
    await until(async () => (await machine(machineId).get()).online, 'the machine to come online');
    return machineId;
}

/** A project with a folder on the machine's E1 and a worktree per chat, cleaned up when a chat leaves. */
async function project(machineId: MachineId): Promise<ProjectId> {
    const p = await workspace().upsertProject({
        name: 'Agentic',
        folders: { [projectFolderKey(machineId, E1)]: '/work/agentic' },
        connectors: [],
        features: { [GIT_FEATURE_ID]: { worktreePerChat: true, worktreeCleanup: 'on-chat-leave' } }
    });
    return p.id;
}

describe('deleting a chat (#674)', () => {
    it("removes a clean worktree and keeps a dirty one under on-chat-leave, auditing both as 'deleted' releases", async () => {
        const projectId = await project(await onlineMachine());
        const { chatId: clean } = await workspace().createChat({ projectId });
        const { chatId: changed } = await workspace().createChat({ projectId });

        await workspace().deleteChat(clean);
        await until(() => released().length === 1, 'the clean release to be audited');
        daemonFs = dirty;
        await workspace().deleteChat(changed);
        await until(() => released().length === 2, 'the dirty release to be audited');

        expect(ops.map((op) => op.kind)).toEqual(['worktree-remove', 'worktree-remove']);
        const [removed, kept] = released().map((e) => e.data);
        expect(removed).toMatchObject({ chatId: clean, projectId, pluginId: GIT_FEATURE_ID, environmentId: E1, reason: 'deleted', outcome: expect.stringMatching(/^removed /) });
        expect(kept).toMatchObject({ chatId: changed, projectId, pluginId: GIT_FEATURE_ID, environmentId: E1, reason: 'deleted', error: expect.stringContaining('git worktree dirty') });

        // Gone from the index, its files dropped, the record left as the deleted mark; a post is refused.
        expect((await workspace().get()).chats).toEqual([]);
        expect(filesDeleted).toEqual([clean, changed]);
        expect((await chat(clean).get()).deleted).toBe(true);
        await expect(chat(clean).post('hello?')).rejects.toThrow(/deleted/);
        expect(await deletedRecords()).toEqual(expect.arrayContaining([
            { chatId: clean, projectId },
            { chatId: changed, projectId }
        ]));
    });

    it('a chat in no project touches no machine', async () => {
        await project(await onlineMachine());
        const { chatId } = await workspace().createChat({ title: 'Scratch' });
        await workspace().deleteChat(chatId);
        expect((await workspace().get()).chats).toEqual([]);
        expect(ops).toEqual([]);
        expect(released()).toEqual([]);
        expect(await deletedRecords()).toEqual([{ chatId, title: 'Scratch' }]);
    });

    it('a member agent or another user cannot delete a chat (403); an unknown chat is 404', async () => {
        const { chatId } = await workspace().createChat({});
        await workspace().createAgent({ name: 'a' });
        const a = (await workspace().get()).agents[0] as AgentId;
        await chat(chatId).addAgent(a, 'all');
        const asAgent = mintAgentPrincipal({ workspaceId: WS, agentId: a, sessionId: 'sess_a' as SessionId });
        await expect(workspace(asAgent).deleteChat(chatId)).rejects.toMatchObject({ status: 403 });
        await expect(chat(chatId, asAgent).delete()).rejects.toMatchObject({ status: 403 });
        const stranger = userPrincipal('u2');
        await expect(app.as(stranger).actor(Workspace, workspaceKey(WS)).deleteChat(chatId)).rejects.toMatchObject({ status: 403 });
        await expect(chat(chatId, stranger).delete()).rejects.toMatchObject({ status: 403 });
        expect((await chat(chatId).get()).deleted).toBeUndefined();
        expect((await workspace().get()).chats).toEqual([chatId]);
        await expect(workspace().deleteChat('chat_nope' as ChatId)).rejects.toMatchObject({ status: 404 });
    });

    it("a stray 'deleted' release of a live chat changes nothing", async () => {
        const projectId = await project(await onlineMachine());
        const { chatId } = await workspace().createChat({ projectId });
        await app.as(owner).actor(Routing, routingKey(WS)).chatReleased(chatId, projectId, 'deleted');
        expect(ops).toEqual([]);
        expect(released()).toEqual([]);
    });
});
