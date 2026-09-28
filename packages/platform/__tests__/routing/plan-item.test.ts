/**
 * A task that carries a plan item (#1073; PRJ-11, COL-05): routing keeps the
 * contract's `planItem` on the route and hands it to the project's features'
 * `beforeSession`, so the git feature opens each item task in the item's own
 * worktree (`plan/<project>-<n>`) — two items started from one chat never share
 * a folder, and one placement does not end the other's session. Same
 * in-process host as `projects.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAEMON_PROTOCOL_VERSION, actorKey, type AgentId, type ChatId, type DaemonFrame, type EnvironmentId, projectFolderKey, type FsError, type FsOp, type FsResult, type MachineId, type OfflinePolicy, type Principal, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFeatureSessionInput, type ProjectId, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
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

const GIT = 'agentic.project.git';
/** A second feature the Registry lists but this build's router has no plugin for. */
const OTHER = 'agentic.project.other';
const git: ProjectFeatureManifest = {
    id: GIT,
    version: '1.0.0',
    kind: 'project-feature',
    name: 'Git',
    description: 'Worktrees per task',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object', properties: { baseBranch: { type: 'string', default: 'main' } } },
    permissions: [],
    compat: { platform: '*', core: '*' }
};
const other: ProjectFeatureManifest = { ...git, id: OTHER, name: 'Other', projectSettings: { type: 'object' } };

type WorktreeOp = Extract<FsOp, { kind: 'worktree' }>;

class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    connected = new Set<string>();
    /** How a daemon frame reaches the Machine actor of `key`, set by `connect()`. */
    readonly daemons = new Map<string, (frame: DaemonFrame) => Promise<void>>();
    /** Set per test: answers `fs.request` `worktree` in the daemon's place (the in-memory daemon fakes no worktrees). */
    worktree?: (environmentId: string, op: WorktreeOp) => { result: FsResult } | { error: FsError };
    readonly worktreeRequests: { key: string; environmentId: string; op: WorktreeOp }[] = [];
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
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
    /** The `session.open` frames the platform sent this machine, by session id. */
    opens(key: string): Record<string, { cwd?: string; system?: string; connectors?: { id: string }[] }> {
        const out: Record<string, { cwd?: string; system?: string; connectors?: { id: string }[] }> = {};
        for (const t of this.sent.get(key) ?? []) {
            const f = JSON.parse(t) as { t: string; sessionId?: string; spec?: { cwd?: string; system?: string; connectors?: { id: string }[] } };
            if (f.t === 'session.open') out[f.sessionId!] = f.spec ?? {};
        }
        return out;
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

/** The fake feature plugin: what `beforeSession` does is set per test. */
let hook: ((input: ProjectFeatureSessionInput) => Promise<{ cwd?: string; instructions?: string } | undefined>) | undefined;
let hookCalls: ProjectFeatureSessionInput[];
const feature: ProjectFeaturePlugin = {
    manifest: git,
    async beforeSession(input) {
        hookCalls.push(input);
        return hook?.(input);
    },
    instructions: ({ project, settings }) => `Work on the ${project.name} repo; the base branch is ${String(settings['baseBranch'])}.`
};

let app: TestActorApp;
let sockets: FakeSockets;
let audit: ReturnType<typeof capturingAuditPort>;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()), catalogue: [IN_MEMORY_PLUGIN, anthropicApiPlugin, git, other, gitFeatureManifest] });
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    hook = undefined;
    hookCalls = [];
    sockets = new FakeSockets();
    audit = capturingAuditPort();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes, audit, projectFeatures: { [GIT]: feature, [GIT_FEATURE_ID]: gitFeaturePlugin } });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    // The chat tells the router when it leaves a project (#623): the same `chat` type, with the router port.
    const RoutedChat = defineChatActor({ routing: () => Routing });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, RoutedChat, ChatPage, Registry, AuditActor]);
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

/** The spec the daemon was sent for `taskId`'s session, and the Session record's cwd. */
async function openOf(machineId: MachineId, taskId: string): Promise<{ sent: { cwd?: string; system?: string; connectors?: { id: string }[] } | undefined; record: string | undefined }> {
    const sessionId = (await task(taskId).get()).sessionId as SessionId;
    return { sent: sockets.opens(machineKey(WS, machineId))[sessionId], record: (await session(sessionId).get()).spec?.cwd };
}

/** A project with a folder on both environments, the git feature on, and `connectors`. */
async function project(extra: { connectors?: { id: string }[]; features?: Record<string, Record<string, unknown> | null>; folders?: Partial<Record<EnvironmentId, string | null>> } = {}): Promise<ProjectId> {
    const p = await workspace().upsertProject({
        name: 'Agentic',
        folders: onMachines({ [E1]: '/work/agentic', [E2]: '/other/agentic', ...extra.folders }),
        connectors: extra.connectors ?? [],
        features: extra.features ?? { [GIT]: { baseBranch: 'develop' } }
    });
    return p.id;
}

describe('a plan item task (#1073)', () => {
    const chatOrigin = (chatId: ChatId, n: number) => ({ kind: 'user', chatId, messageId: `msg_${n}` as never }) as const;
    const made = (_environmentId: string, op: WorktreeOp): { result: FsResult } => ({ result: { kind: 'worktree', path: op.path, branch: op.branch } });

    it("hands the contract's planItem to beforeSession, and the git feature opens the task in plan/<project>-<n>'s worktree", async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: { [GIT]: { baseBranch: 'develop' }, [GIT_FEATURE_ID]: { worktreePerChat: true } } });
        const { chatId } = await workspace().createChat({ projectId });
        sockets.worktree = made;
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId, planItem: 7 });
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(hookCalls).toHaveLength(1);
        expect(hookCalls[0]).toMatchObject({ taskId: 't1', chatId, planItem: 7, environmentId: E1, cwd: '/work/agentic' });
        expect(sockets.worktreeRequests.map((r) => r.op)).toEqual([{ kind: 'worktree', repo: '/work/agentic', branch: 'plan/agentic-7', path: '/work/agentic-worktrees/plan-agentic-7' }]);
        const { sent, record } = await openOf(m1, 't1');
        expect(sent?.cwd).toBe('/work/agentic-worktrees/plan-agentic-7');
        expect(record).toBe('/work/agentic-worktrees/plan-agentic-7');
        expect(sent?.system).toContain('on branch `plan/agentic-7`');
    });

    it('a task with no plan item gets none: beforeSession sees no planItem', async () => {
        await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project();
        const { chatId } = await workspace().createChat({ projectId });
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId });
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect(hookCalls).toHaveLength(1);
        expect(hookCalls[0]).not.toHaveProperty('planItem');
    });

    it("with worktreePerChat on, two item tasks of one member from one chat open in two worktrees, and neither placement ends the other's session", async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: { [GIT_FEATURE_ID]: { worktreePerChat: true } } });
        const { chatId } = await workspace().createChat({ projectId });
        await chat(chatId).addAgent(a, 'all');
        sockets.worktree = made;
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId, planItem: 1 });
        await createTask('t2', a, { origin: chatOrigin(chatId, 2), projectId, planItem: 2 });
        await Promise.all([routing().run('t1' as TaskId), routing().run('t2' as TaskId)]);
        await Promise.all([settled('t1'), settled('t2')]);
        expect((await task('t1').get()).status).toBe('completed');
        expect((await task('t2').get()).status).toBe('completed');
        expect(sockets.worktreeRequests.map((r) => r.op.branch).sort()).toEqual(['plan/agentic-1', 'plan/agentic-2']);
        const one = await openOf(m1, 't1');
        const two = await openOf(m1, 't2');
        expect(one.sent?.cwd).toBe('/work/agentic-worktrees/plan-agentic-1');
        expect(two.sent?.cwd).toBe('/work/agentic-worktrees/plan-agentic-2');
        expect((await task('t1').get()).sessionId).not.toBe((await task('t2').get()).sessionId);
    });
});

describe("an item task's session is the item's, not the chat's (#1078)", () => {
    const chatOrigin = (chatId: ChatId, n: number) => ({ kind: 'user', chatId, messageId: `msg_${n}` as never }) as const;
    const made = (_environmentId: string, op: WorktreeOp): { result: FsResult } => ({ result: { kind: 'worktree', path: op.path, branch: op.branch } });
    const sessionOf = async (taskId: string): Promise<SessionId> => (await task(taskId).get()).sessionId as SessionId;

    async function itemChat(): Promise<{ a: AgentId; projectId: ProjectId; chatId: ChatId }> {
        await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: { [GIT_FEATURE_ID]: { worktreePerChat: true } } });
        const { chatId } = await workspace().createChat({ projectId });
        await chat(chatId).addAgent(a, 'all');
        sockets.worktree = made;
        return { a, projectId, chatId };
    }

    it('an item task finishes, then a task with no item runs in the same chat: the item session is not closed', async () => {
        const { a, projectId, chatId } = await itemChat();
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId, planItem: 3 });
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        const item = await sessionOf('t1');
        await until(async () => (await chat(chatId).get()).sessions[a]?.sessionId === item, "the item session to be the chat's binding");

        await createTask('t2', a, { origin: chatOrigin(chatId, 2), projectId });
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        expect(await sessionOf('t2')).not.toBe(item);
        expect((await session(item).get()).status).not.toBe('closed');

        // A follow-up on the item goes back to the item's session, though the chat now binds the other one.
        await createTask('t3', a, { origin: chatOrigin(chatId, 3), projectId, planItem: 3 });
        await routing().run('t3' as TaskId);
        await settled('t3');
        expect((await task('t3').get()).status).toBe('completed');
        expect(await sessionOf('t3')).toBe(item);
    });

    it("tasks with no item still reuse the chat's session", async () => {
        const { a, projectId, chatId } = await itemChat();
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId });
        await routing().run('t1' as TaskId);
        await settled('t1');
        const first = await sessionOf('t1');
        await until(async () => (await chat(chatId).get()).sessions[a]?.sessionId === first, "the chat's binding");
        await createTask('t2', a, { origin: chatOrigin(chatId, 2), projectId });
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        expect(await sessionOf('t2')).toBe(first);
        expect((await session(first).get()).status).not.toBe('closed');
    });
});

describe('an item task in the chat\'s own folder (#1078)', () => {
    const chatOrigin = (chatId: ChatId, n: number) => ({ kind: 'user', chatId, messageId: `msg_${n}` as never }) as const;

    it("without an item worktree, item and non-item tasks share the chat's session and none closes it", async () => {
        await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project();
        const { chatId } = await workspace().createChat({ projectId });
        await chat(chatId).addAgent(a, 'all');
        const ids: SessionId[] = [];
        for (const [i, planItem] of [[1, undefined], [2, 4], [3, undefined]] as const) {
            await createTask(`t${i}`, a, { origin: chatOrigin(chatId, i), projectId, ...(planItem !== undefined ? { planItem } : {}) });
            await routing().run(`t${i}` as TaskId);
            await settled(`t${i}`);
            expect((await task(`t${i}`).get()).status).toBe('completed');
            ids.push((await task(`t${i}`).get()).sessionId as SessionId);
            await until(async () => (await chat(chatId).get()).sessions[a]?.sessionId === ids[0], "the chat's binding");
        }
        expect(new Set(ids).size).toBe(1);
        expect((await session(ids[0]!).get()).status).not.toBe('closed');
    });
});
