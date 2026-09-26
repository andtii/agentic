/**
 * A chat moving out of a project asks the project's feature plugins FIRST (#936): `Chat.setProject` awaits
 * `Routing.chatReleased(…, { before: true })` before it writes the move, so a plugin's `onChatReleased` sees the chat
 * still in the project; a throw — or a release that does not finish in time — refuses the move with the reason, and
 * `{ force: true }` moves anyway. A fake feature plugin through the real router, one online in-memory machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, projectFolderKey, type ChatId, type EnvironmentId, type MachineId, type Principal, type ProjectFeatureChatReleaseInput, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';

import { AgentActor } from '../../src/agent/index';
import { AuditActor, capturingAuditPort } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage, defineChatActor } from '../../src/chat/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry } from '../../src/registry/index';
import { defineRoutingActor, type RuntimeCatalogue } from '../../src/routing/index';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { TaskActor } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
const runtimes: RuntimeCatalogue = { 'anthropic-api': { host: 'local', open: () => Promise.reject(new Error('not opened here')) } };

const FEATURE = 'agentic.project.fake';
const manifest: ProjectFeatureManifest = {
    id: FEATURE,
    version: '1.0.0',
    kind: 'project-feature',
    name: 'Fake',
    description: 'Tidies up after a chat',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object' },
    permissions: [],
    compat: { platform: '*', core: '*' }
};

/** What `onChatReleased` does, set per test. */
let release: (input: ProjectFeatureChatReleaseInput) => Promise<string | undefined>;
const feature: ProjectFeaturePlugin = { manifest, onChatReleased: (input) => release(input) };

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

const RELEASE_TIMEOUT_MS = 150;
let app: TestActorApp;
let sockets: FakeSockets;
let Machine: ReturnType<typeof defineMachineActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    release = async () => 'tidied';
    sockets = new FakeSockets();
    const audit = capturingAuditPort();
    const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()), catalogue: [manifest] });
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    const Session = defineSessionActor({ factory: async () => null, commands: sink });
    const Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes, audit, projectFeatures: { [FEATURE]: feature } });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing });
    const RoutedChat = defineChatActor({ routing: () => Routing, releaseTimeoutMs: RELEASE_TIMEOUT_MS });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, RoutedChat, ChatPage, Registry, AuditActor]);
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const workspace = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));

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

/** A project with a folder on the machine's E1 and the fake feature on. */
async function project(machineId: MachineId, name = 'Agentic'): Promise<ProjectId> {
    const p = await workspace().upsertProject({ name, folders: { [projectFolderKey(machineId, E1)]: '/work/agentic' }, connectors: [], features: { [FEATURE]: {} } });
    return p.id;
}

/** The project notes the thread holds, in order. */
async function projectNotes(chatId: ChatId): Promise<(string | null)[]> {
    const page = await chat(chatId).history(null, 50);
    return page.entries.flatMap(({ entry: e }) => (e.t === 'msg' && e.project ? [e.project.id] : []));
}

describe('a chat moving project releases it first (#936)', () => {
    it('runs the hook while the chat is still in the project, then moves', async () => {
        const machineId = await onlineMachine();
        const projectId = await project(machineId);
        const { chatId } = await workspace().createChat({ projectId });
        const seen: (ProjectId | undefined)[] = [];
        release = async (input) => {
            // Chat.get is reentrant: it answers while setProject waits on this release.
            seen.push((await chat(input.chatId).get()).projectId);
            return 'parked';
        };
        await chat(chatId).setProject(null);
        expect(seen).toEqual([projectId]);
        expect((await chat(chatId).get()).projectId).toBeUndefined();
        expect(await projectNotes(chatId)).toEqual([projectId, null]);
    });

    it('a throwing hook refuses the move with its message and writes nothing; force moves anyway', async () => {
        const machineId = await onlineMachine();
        const projectId = await project(machineId);
        const other = await project(machineId, 'Other');
        const { chatId } = await workspace().createChat({ projectId });
        let calls = 0;
        release = async () => {
            calls++;
            throw new Error('git worktree dirty: /work/agentic-worktrees/x has uncommitted changes');
        };
        await expect(chat(chatId).setProject(other)).rejects.toThrow(/uncommitted changes.*force/);
        expect((await chat(chatId).get()).projectId).toBe(projectId);
        expect(await projectNotes(chatId)).toEqual([projectId]);
        await chat(chatId).setProject(other, { force: true });
        expect(calls).toBe(2);
        expect((await chat(chatId).get()).projectId).toBe(other);
    });

    it('a release that does not finish in time refuses the move', async () => {
        const machineId = await onlineMachine();
        const projectId = await project(machineId);
        const { chatId } = await workspace().createChat({ projectId });
        release = () => new Promise((resolve) => setTimeout(() => resolve('late'), RELEASE_TIMEOUT_MS * 4));
        await expect(chat(chatId).setProject(null)).rejects.toThrow(/did not finish/);
        expect((await chat(chatId).get()).projectId).toBe(projectId);
    });

    it('a chat coming from no project has nothing to release', async () => {
        const machineId = await onlineMachine();
        const projectId = await project(machineId);
        const { chatId } = await workspace().createChat({});
        let calls = 0;
        release = async () => {
            calls++;
            throw new Error('never asked');
        };
        await chat(chatId).setProject(projectId);
        expect(calls).toBe(0);
        expect((await chat(chatId).get()).projectId).toBe(projectId);
    });
});
