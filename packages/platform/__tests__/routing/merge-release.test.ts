/**
 * A merged pull request releases its chat (#675): `pullMergeRelease` tells the router `chatReleased(…, 'merged')`
 * for the PR's chat, which runs the git plugin's cleanup under `worktreeCleanup: 'on-merge'` — the clean worktree
 * removed, a dirty one kept, both audited — and leaves a chat that moved out, was deleted, or is in a project whose
 * policy is `on-chat-leave` alone. The real git plugin through the real router; the daemon's answer is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, projectFolderKey, type AgentId, type ChatFileStore, type ChatId, type EnvironmentId, type MachineId, type Principal, type ProjectFeatureFs, type ProjectFeaturePlugin, type ProjectId, type PullRequest, type SessionId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { GIT_FEATURE_ID, gitFeatureManifest, gitFeaturePlugin } from '@agentic/plugins-git';

import { AgentActor } from '../../src/agent/index';
import { AuditActor, auditKey, capturingAuditPort } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage, defineChatActor } from '../../src/chat/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry } from '../../src/registry/index';
import { defineRoutingActor, pullMergeRelease, routingKey, type RuntimeCatalogue } from '../../src/routing/index';
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

/** A project with a folder on the machine's E1 and a worktree per chat, cleaned up by `worktreeCleanup`. */
async function project(machineId: MachineId, worktreeCleanup = 'on-merge', name = 'Agentic'): Promise<ProjectId> {
    const p = await workspace().upsertProject({
        name,
        folders: { [projectFolderKey(machineId, E1)]: '/work/agentic' },
        connectors: [],
        features: { [GIT_FEATURE_ID]: { worktreePerChat: true, worktreeCleanup } }
    });
    return p.id;
}

/** A merged PR of `chatId`, as the Pulls actor hands it to its merge hook. */
const mergedPr = (chatId: ChatId | undefined, number = 7): PullRequest => ({
    provider: 'github', repo: 'andtii/agentic', number, title: 'the work', url: `https://github.com/andtii/agentic/pull/${number}`, head: 'chat/x', base: 'main', state: 'merged',
    additions: 1, deletions: 0, files: 1, openedBy: 'me', openedAt: 0, mergedAt: 1, checks: [], review: { state: 'none', reviewers: [], threads: [] }, ...(chatId !== undefined ? { chatId } : {})
} as PullRequest);

const hop = { actor: (() => { throw new Error('not used'); }) as never };

describe('a merged pull request releases its chat (#675)', () => {
    it("removes a clean worktree and keeps a dirty one under on-merge, audited as 'merged'; the chat stays in the project", async () => {
        const projectId = await project(await onlineMachine());
        const { chatId: clean } = await workspace().createChat({ projectId });
        const { chatId: changed } = await workspace().createChat({ projectId });
        const then: string[] = [];
        const port = pullMergeRelease({ routing: () => Routing, then: { merged: async (_h, e) => void then.push(String(e.pr.number)) } });

        await port.merged(hop, { workspaceId: WS, projectId, pr: mergedPr(clean, 1) });
        await until(() => released().length === 1, 'the clean release');
        daemonFs = dirty;
        await port.merged(hop, { workspaceId: WS, projectId, pr: mergedPr(changed, 2) });
        await until(() => released().length === 2, 'the dirty release');

        const [removed, kept] = released().map((e) => e.data);
        expect(removed).toMatchObject({ chatId: clean, projectId, reason: 'merged', outcome: expect.stringMatching(/^removed /) });
        expect(kept).toMatchObject({ chatId: changed, projectId, reason: 'merged', error: expect.stringContaining('git worktree dirty') });
        expect(then).toEqual(['1', '2']);
        expect((await chat(clean).get()).projectId).toBe(projectId);
    });

    it('leaves alone a project on on-chat-leave, a PR with no chat, a chat that moved out and a deleted chat', async () => {
        const machineId = await onlineMachine();
        const leave = await project(machineId, 'on-chat-leave', 'Leave');
        const merge = await project(machineId, 'on-merge', 'Merge');
        const port = pullMergeRelease({ routing: () => Routing });
        const { chatId: onLeave } = await workspace().createChat({ projectId: leave });
        const { chatId: moved } = await workspace().createChat({ projectId: merge });
        const { chatId: gone } = await workspace().createChat({ projectId: merge });
        await chat(moved).setProject(null);
        await workspace().deleteChat(gone);
        // on-merge tidies a chat that leaves or is deleted too: wait for the delete's one-way release before starting over.
        await until(() => released().some((e) => e.data.reason === 'deleted'), 'the delete release');
        ops.length = 0;
        audit.events.length = 0;

        await port.merged(hop, { workspaceId: WS, projectId: leave, pr: mergedPr(onLeave) });
        await port.merged(hop, { workspaceId: WS, projectId: merge, pr: mergedPr(undefined) });
        await port.merged(hop, { workspaceId: WS, projectId: merge, pr: mergedPr(moved) });
        await port.merged(hop, { workspaceId: WS, projectId: merge, pr: mergedPr(gone) });
        // One-way: give the router its turns before looking.
        await app.as(owner).actor(Routing, routingKey(WS)).get();
        await new Promise((r) => setTimeout(r, 50));
        expect(ops).toEqual([]);
        expect(released()).toEqual([]);
    });

    it('a release that cannot be sent still runs the merge notices', async () => {
        const then: number[] = [];
        const port = pullMergeRelease({ routing: () => { throw new Error('no router'); }, then: { merged: async (_h, e) => void then.push(e.pr.number) } });
        await port.merged(hop, { workspaceId: WS, projectId: 'project_x' as ProjectId, pr: mergedPr('chat_x' as ChatId, 9) });
        expect(then).toEqual([9]);
    });
});
