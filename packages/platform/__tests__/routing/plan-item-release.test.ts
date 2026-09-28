/**
 * A plan item done or dropped is released (#1081): the Plan actor, built with the production release port
 * (`routerPlanRelease`), tells the router `planItemReleased`, which runs the real git feature's `onPlanItemReleased` on
 * each online folder of the project (the item's worktree removed through the daemon), audits every call — an offline
 * machine too, not called — and closes the item's sessions, except one the chat's binding still names. A stray call for
 * an item that is not done changes nothing, and an agent may not make it. Same in-process host as `plan-item.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAEMON_PROTOCOL_VERSION, actorKey, type AgentId, type ChatId, type DaemonFrame, type EnvironmentId, projectFolderKey, type FsError, type FsOp, type FsResult, type MachineId, type OfflinePolicy, type Principal, type ProjectId, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { GIT_FEATURE_ID, gitFeatureManifest, gitFeaturePlugin } from '@agentic/plugins-git';
import { anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { capturingAuditPort } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage, defineChatActor } from '../../src/chat/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry } from '../../src/registry/index';
import { createToolCallPort, defineRoutingActor, routingKey, type RuntimeCatalogue } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { definePlanActor, planKey, routerPlanRelease } from '../../src/plan/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
/** The in-memory environment's runtime, as a runtime plugin the Registry lists — its sessions run on a machine. */
const IN_MEMORY_PLUGIN = { ...claudeCodePlugin, id: 'in-memory', name: 'In-memory' };
const runtimes: RuntimeCatalogue = { 'in-memory': { host: 'daemon' }, 'anthropic-api': { host: 'local', open: () => Promise.reject(new Error('not opened here')) } };

type WorktreeOp = Extract<FsOp, { kind: 'worktree' }>;
type RemoveOp = Extract<FsOp, { kind: 'worktree-remove' }>;

class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    connected = new Set<string>();
    /** How a daemon frame reaches the Machine actor of `key`, set by `connect()`. */
    readonly daemons = new Map<string, (frame: DaemonFrame) => Promise<void>>();
    /** Set per test: answers `fs.request` `worktree` in the daemon's place (the in-memory daemon fakes no worktrees). */
    worktree?: (environmentId: string, op: WorktreeOp) => { result: FsResult } | { error: FsError };
    readonly worktreeRequests: { key: string; environmentId: string; op: WorktreeOp }[] = [];
    /** Every `worktree-remove` the git feature sent, answered as removed. */
    readonly removeRequests: { key: string; environmentId: string; op: RemoveOp }[] = [];
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        const frame = JSON.parse(text) as { t: string; requestId: string; environmentId: string; op: FsOp };
        if (frame.t === 'fs.request' && frame.op.kind === 'worktree' && this.worktree) {
            this.worktreeRequests.push({ key, environmentId: frame.environmentId, op: frame.op });
            const answer = this.worktree(frame.environmentId, frame.op);
            void Promise.resolve().then(() => this.daemons.get(key)?.({ v: DAEMON_PROTOCOL_VERSION, t: 'fs.response', requestId: frame.requestId, ...answer }));
            return true;
        }
        if (frame.t === 'fs.request' && frame.op.kind === 'worktree-remove') {
            const op = frame.op;
            this.removeRequests.push({ key, environmentId: frame.environmentId, op });
            void Promise.resolve().then(() => this.daemons.get(key)?.({ v: DAEMON_PROTOCOL_VERSION, t: 'fs.response', requestId: frame.requestId, result: { kind: 'worktree-remove', path: op.path, removed: true, branchDeleted: false } }));
            return true;
        }
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

function localFactory(): SessionFactory {
    const agent = mockAgent({ respond: () => [{ text: 'done' }] });
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

let app: TestActorApp;
let sockets: FakeSockets;
let audit: ReturnType<typeof capturingAuditPort>;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let PlanStore: ReturnType<typeof definePlanActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()), catalogue: [IN_MEMORY_PLUGIN, anthropicApiPlugin, gitFeatureManifest] });
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    audit = capturingAuditPort();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes, audit, projectFeatures: { [GIT_FEATURE_ID]: gitFeaturePlugin } });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    // The chat tells the router when it leaves a project (#623): the same `chat` type, with the router port.
    const RoutedChat = defineChatActor({ routing: () => Routing });
    // The Plan as the host builds it (#1081): a done or dropped item reaches the router through the release port.
    PlanStore = definePlanActor({ release: routerPlanRelease({ routing: () => Routing }), wake: { wake: async () => true } });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, RoutedChat, ChatPage, Registry, AuditActor, PlanStore]);
    await app.start();
});

afterEach(async () => {
    reporter.clear();
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, `${WS}:session:${id}`);
const workspace = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));

async function agent(id: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; defaultWorkdir?: string; offlinePolicy?: OfflinePolicy }, connectors: { id: string }[] = []): Promise<AgentId> {
    const agentId = id as AgentId;
    await workspace().createAgent({ name: id }); // indexed, so a project may list it as a member
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [], connectors, execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

async function createTask(id: string, assignee: AgentId, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    return task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
}

type Reporting = readonly { readonly id: EnvironmentId; readonly cwdRoots: readonly string[] }[];
const LAPTOP: Reporting = [
    { id: E1, cwdRoots: ['/work', '/scratch'] },
    { id: E2, cwdRoots: ['/other'] }
];

/** The first paired machine reporting each environment, for the project folders keyed by machine (#702). */
const reporter = new Map<EnvironmentId, MachineId>();
/** `folders` keyed by environment as the override on the first machine reporting it; a `null` for an environment no machine reports stays as is. */
const onMachines = (folders: Partial<Record<EnvironmentId, string | null>>): Record<string, string | null> =>
    Object.fromEntries(Object.entries(folders).map(([e, path]) => [reporter.has(e as EnvironmentId) ? projectFolderKey(reporter.get(e as EnvironmentId)!, e as EnvironmentId) : e, path!]));

/** A paired machine reporting E1 (roots `/work`, `/scratch`) and E2 (root `/other`) unless told otherwise; `connect` dials its daemon. */
async function pairMachine(reporting: Reporting = LAPTOP): Promise<{ machineId: MachineId; d: InMemoryDaemon; connect(): PlatformSeat }> {
    const { machineId, pairingCode } = await workspace().registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const environments = reporting.map((e) => ({ ...inMemoryEnvironment(machineId, e.id), cwdRoots: [...e.cwdRoots] }));
    for (const e of reporting) if (!reporter.has(e.id)) reporter.set(e.id, machineId);
    const d = inMemoryHarness({ machineId, environments }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const connect = (): PlatformSeat => {
        const key = machineKey(WS, machineId);
        const ids = parseMachineKey(key)!;
        const seat = d.dial();
        sockets.seats.set(key, seat);
        sockets.connected.add(key);
        const asDaemon = machine(ids.machineId, asMachine(ids.machineId));
        sockets.daemons.set(key, async (frame) => {
            await asDaemon.socketMessage(JSON.stringify(frame));
        });
        void (async () => {
            try {
                for (;;) await asDaemon.socketMessage((await seat.next()) as string);
            } catch {
                // dropped
            }
            if (sockets.seats.get(key) === seat) {
                sockets.seats.delete(key);
                sockets.connected.delete(key);
                await asDaemon.socketClosed().catch(() => {});
            }
        })();
        return seat;
    };
    return { machineId, d, connect };
}

async function onlineMachine(reporting?: Reporting): Promise<MachineId> {
    const m = await pairMachine(reporting);
    m.connect();
    await until(async () => (await machine(m.machineId).get()).online, 'the machine to come online');
    return m.machineId;
}

const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

/** A project with a folder on both environments (unless one is `null`), the git feature on with a worktree per chat. */
async function project(extra: { connectors?: { id: string }[]; features?: Record<string, Record<string, unknown> | null>; folders?: Partial<Record<EnvironmentId, string | null>> } = {}): Promise<ProjectId> {
    const p = await workspace().upsertProject({
        name: 'Agentic',
        folders: onMachines({ [E1]: '/work/agentic', [E2]: '/other/agentic', ...extra.folders }),
        connectors: extra.connectors ?? [],
        features: extra.features ?? { [GIT_FEATURE_ID]: { worktreePerChat: true } }
    });
    return p.id;
}

const plan = (projectId: ProjectId) => app.as(owner).actor(PlanStore, planKey(WS, projectId));
const itemReleased = () => audit.events.filter((e) => e.kind === 'project.item-released');
const chatOrigin = (chatId: ChatId, n: number) => ({ kind: 'user', chatId, messageId: `msg_${n}` as never }) as const;
const made = (_environmentId: string, op: WorktreeOp): { result: FsResult } => ({ result: { kind: 'worktree', path: op.path, branch: op.branch } });
const sessionOf = async (taskId: string): Promise<SessionId> => (await task(taskId).get()).sessionId as SessionId;

/** A plan of `count` items in project `projectId`. */
async function items(projectId: ProjectId, count: number): Promise<void> {
    await plan(projectId).create({ title: 'P', phases: [{ title: 'One', items: Array.from({ length: count }, (_, i) => ({ title: `item ${i + 1}` })) }] });
}

describe('a plan item done or dropped is released to the project features (#1081)', () => {
    it("done: the git feature removes the item's worktree on the online folder; the offline machine's folder is audited, not called", async () => {
        const m1 = await onlineMachine();
        // A second machine that reported its environment once, then went offline.
        const offline = await pairMachine([{ id: 'env_3' as EnvironmentId, cwdRoots: ['/far'] }]);
        offline.connect();
        await until(async () => (await machine(offline.machineId).get()).online, 'the second machine to come online');
        const p = await workspace().upsertProject({
            name: 'Agentic',
            folders: { [projectFolderKey(m1, E1)]: '/work/agentic', [projectFolderKey(offline.machineId, 'env_3' as EnvironmentId)]: '/far/agentic' },
            connectors: [],
            features: { [GIT_FEATURE_ID]: { worktreePerChat: true, worktreeCleanup: 'on-chat-leave' } }
        });
        sockets.close(machineKey(WS, offline.machineId));
        await machine(offline.machineId, asMachine(offline.machineId)).socketClosed();
        await until(async () => !(await machine(offline.machineId).get()).online, 'the second machine to go offline');
        await items(p.id, 7);
        await plan(p.id).update(7, { state: 'done' });

        await until(() => itemReleased().length === 2, 'both folders to be audited');
        expect(sockets.removeRequests.map((r) => ({ key: r.key, environmentId: r.environmentId, path: r.op.path, branch: r.op.branch }))).toEqual([
            { key: machineKey(WS, m1), environmentId: E1, path: '/work/agentic-worktrees/plan-agentic-7', branch: 'plan/agentic-7' }
        ]);
        const [online, away] = itemReleased().map((e) => e.data);
        expect(online).toEqual({ projectId: p.id, planItem: 7, pluginId: GIT_FEATURE_ID, environmentId: E1, reason: 'done', outcome: 'removed /work/agentic-worktrees/plan-agentic-7' });
        expect(away).toMatchObject({ projectId: p.id, planItem: 7, pluginId: GIT_FEATURE_ID, environmentId: 'env_3', reason: 'done', error: expect.stringContaining('offline') });
    });

    it('dropped: released as dropped', async () => {
        await onlineMachine();
        const projectId = await project({ features: { [GIT_FEATURE_ID]: { worktreePerChat: true, worktreeCleanup: 'on-merge' } }, folders: { [E2]: null } });
        await items(projectId, 2);
        await plan(projectId).update(2, { state: 'dropped', note: 'not needed' });
        await until(() => itemReleased().length === 1, 'the release');
        expect(itemReleased()[0]?.data).toMatchObject({ planItem: 2, reason: 'dropped', outcome: 'removed /work/agentic-worktrees/plan-agentic-2' });
    });

    it('a stray call for an item that is not done or dropped changes nothing; an agent may not make it', async () => {
        await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: { [GIT_FEATURE_ID]: { worktreePerChat: true, worktreeCleanup: 'on-merge' } }, folders: { [E2]: null } });
        await items(projectId, 1);
        await routing().planItemReleased(projectId, [{ n: 1, reason: 'done' }, { n: 9, reason: 'dropped' }]);
        expect(sockets.removeRequests).toEqual([]);
        expect(itemReleased()).toEqual([]);
        const asAgent: Principal = { kind: 'agent', agentId: a, workspaceId: WS, sessionId: 'sess_x' as SessionId };
        await expect(app.as(asAgent).actor(Routing, routingKey(WS)).planItemReleased(projectId, [{ n: 1, reason: 'done' }])).rejects.toMatchObject({ status: 403 });
    });
});

describe("a released item's sessions close (#1081)", () => {
    it("with item worktrees, the item's session is closed once the item is done; a follow-up opens a fresh one", async () => {
        await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: { [GIT_FEATURE_ID]: { worktreePerChat: true } }, folders: { [E2]: null } });
        const { chatId } = await workspace().createChat({ projectId });
        await chat(chatId).addAgent(a, 'all');
        sockets.worktree = made;
        await items(projectId, 3);
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId, planItem: 3 });
        await routing().run('t1' as TaskId);
        await settled('t1');
        const item = await sessionOf('t1');
        // A task with no item since: the chat binds another session, the item's lives on.
        await createTask('t2', a, { origin: chatOrigin(chatId, 2), projectId });
        await routing().run('t2' as TaskId);
        await settled('t2');
        const own = await sessionOf('t2');
        expect(own).not.toBe(item);
        await until(async () => (await chat(chatId).get()).sessions[a]?.sessionId === own, "the chat's binding to move on");
        expect((await session(item).get()).status).not.toBe('closed');

        await plan(projectId).update(3, { state: 'done' });
        await until(async () => (await session(item).get()).status === 'closed', "the item's session to close");
        expect((await session(own).get()).status).not.toBe('closed');

        await createTask('t3', a, { origin: chatOrigin(chatId, 3), projectId, planItem: 3 });
        await routing().run('t3' as TaskId);
        await settled('t3');
        expect(await sessionOf('t3')).not.toBe(item);
    });

    it("without item worktrees, the item's session is the chat's own: it stays open, and a task with no item goes on in it", async () => {
        await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: {}, folders: { [E2]: null } });
        const { chatId } = await workspace().createChat({ projectId });
        await chat(chatId).addAgent(a, 'all');
        await items(projectId, 4);
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId, planItem: 4 });
        await routing().run('t1' as TaskId);
        await settled('t1');
        const shared = await sessionOf('t1');
        await until(async () => (await chat(chatId).get()).sessions[a]?.sessionId === shared, "the chat's binding");

        await plan(projectId).update(4, { state: 'done' });
        // One-way: give the router its turn before looking.
        await routing().get();
        await new Promise((r) => setTimeout(r, 50));
        expect((await session(shared).get()).status).not.toBe('closed');

        await createTask('t2', a, { origin: chatOrigin(chatId, 2), projectId });
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        expect(await sessionOf('t2')).toBe(shared);
    });
});
