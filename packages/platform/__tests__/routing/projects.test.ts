/**
 * Projects end to end in the router (#332; AGT-05, EXE-02, EXE-12, COL-04,
 * PLG-01): a task's project gives each member's session the project's folder
 * on whichever environment the member runs in — the task's own folder still
 * wins, a delegated child inherits — merges the project's connectors into the
 * gate and the `OpenSpec`, and runs the enabled feature plugins' `beforeSession`
 * with an `fs` over the environment's daemon before the session opens: a
 * returned folder replaces the spec's (inside the roots, or the task fails),
 * instructions land in the prompt's `## Project` section, a throw parks the
 * task `waiting { project-feature }` and a later `run` tries again. A project
 * the Workspace no longer has fails the task `project-missing`. Same
 * in-process host as `workdir.test.ts`. The last block runs the real git
 * feature (#335, `@agentic/plugins-git`) through it: a worktree per chat on
 * every machine, reused by the next task, parked when the daemon cannot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAEMON_PROTOCOL_VERSION, actorKey, type AgentId, type ChatId, type DaemonFrame, type EnvironmentId, type FsError, type FsOp, type FsResult, type MachineId, type OfflinePolicy, type ProjectFeatureChatReleaseInput, type Principal, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFeatureSessionInput, type ProjectId, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mcpConnectorSetup } from '@agentic/mcp';
import { GIT_FEATURE_ID, gitBranchFor, gitFeatureManifest, gitFeaturePlugin } from '@agentic/plugins-git';
import { anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { capturingAuditPort } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage, defineChatActor } from '../../src/chat/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { createToolCallPort, defineRoutingActor, PROJECT_MISSING_CODE, routingKey, type RuntimeCatalogue } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
/** A second machine's environment (root `/home/b`), for the git feature's two-machine case. */
const E3 = 'env_3' as EnvironmentId;
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
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, `${WS}:session:${id}`);
const workspace = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const registry = () => app.as(owner).actor(Registry, registryKey(WS));
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

/** A paired machine reporting E1 (roots `/work`, `/scratch`) and E2 (root `/other`) unless told otherwise; `connect` dials its daemon. */
async function pairMachine(reporting: Reporting = LAPTOP): Promise<{ machineId: MachineId; d: InMemoryDaemon; connect(): PlatformSeat }> {
    const { machineId, pairingCode } = await workspace().registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const environments = reporting.map((e) => ({ ...inMemoryEnvironment(machineId, e.id), cwdRoots: [...e.cwdRoots] }));
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
const chosenFor = (taskId: string) => audit.events.find((e) => e.kind === 'environment.chosen' && e.taskId === taskId && !e.key.endsWith(':fallback'));

/** The spec the daemon was sent for `taskId`'s session, and the Session record's cwd. */
async function openOf(machineId: MachineId, taskId: string): Promise<{ sent: { cwd?: string; system?: string; connectors?: { id: string }[] } | undefined; record: string | undefined }> {
    const sessionId = (await task(taskId).get()).sessionId as SessionId;
    return { sent: sockets.opens(machineKey(WS, machineId))[sessionId], record: (await session(sessionId).get()).spec?.cwd };
}

/** A project with a folder on both environments, the git feature on, and `connectors`. */
async function project(extra: { connectors?: { id: string }[]; features?: Record<string, Record<string, unknown> | null>; folders?: Partial<Record<EnvironmentId, string | null>> } = {}): Promise<ProjectId> {
    const p = await workspace().upsertProject({
        name: 'Agentic',
        folders: { [E1]: '/work/agentic', [E2]: '/other/agentic', ...extra.folders },
        connectors: extra.connectors ?? [],
        features: extra.features ?? { [GIT]: { baseBranch: 'develop' } }
    });
    return p.id;
}

describe('project folders (#332)', () => {
    it("two members on two environments in one chat each get the project's folder for their environment; the audit says so", async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1, defaultWorkdir: '/work/default' });
        const b = await agent('agent_b', { runtime: 'in-memory', defaultEnvironmentId: E2 });
        const projectId = await project({ features: {} });
        const { chatId } = await workspace().createChat({ title: 'agentic', projectId });
        await chat(chatId).addAgent(a);
        await chat(chatId).addAgent(b);
        expect((await chat(chatId).get()).project).toEqual({ id: projectId, name: 'Agentic' });
        // What the activation contract carries (#330): the chat's project on the task, no folder of its own.
        const origin = { kind: 'user', chatId, messageId: 'msg_1' } as const;
        await createTask('t1', a, { origin: { ...origin, messageId: 'msg_1' as never }, projectId });
        await createTask('t2', b, { origin: { ...origin, messageId: 'msg_2' as never }, projectId });
        await routing().run('t1' as TaskId);
        await routing().run('t2' as TaskId);
        await Promise.all([settled('t1'), settled('t2')]);
        expect((await task('t1').get()).status).toBe('completed');
        expect((await task('t2').get()).status).toBe('completed');
        expect((await openOf(m1, 't1')).sent?.cwd).toBe('/work/agentic');
        expect((await openOf(m1, 't1')).record).toBe('/work/agentic');
        expect((await openOf(m1, 't2')).sent?.cwd).toBe('/other/agentic');
        expect((await openOf(m1, 't2')).record).toBe('/other/agentic');
        expect(chosenFor('t1')).toMatchObject({ data: { environmentId: E1, cwd: '/work/agentic' } });
        expect(chosenFor('t1')!.summary).toMatch(/folder \/work\/agentic \(the project's folder\)/);
        expect(chosenFor('t2')!.summary).toMatch(/folder \/other\/agentic \(the project's folder\)/);
        // The prompt names the project (the chat section carries it) and, with no feature on, has no project section.
        expect((await openOf(m1, 't1')).sent?.system).not.toContain('## Project');
        const routes = (await routing().get()).routes;
        expect(routes).toEqual([]);
    });

    it("a member's own folder still wins; an environment the project has no folder on falls back to the chain", async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1, defaultWorkdir: '/work/default' });
        const projectId = await project({ features: {}, folders: { [E2]: null } });
        await createTask('t1', a, { projectId, environmentId: E1, workdir: '/scratch/own' });
        await createTask('t2', a, { projectId, environmentId: E2 });
        await routing().run('t1' as TaskId);
        await routing().run('t2' as TaskId);
        await Promise.all([settled('t1'), settled('t2')]);
        expect((await openOf(m1, 't1')).sent?.cwd).toBe('/scratch/own');
        expect(chosenFor('t1')!.summary).toMatch(/folder \/scratch\/own \(the task's own\)/);
        // No project folder on E2, and the agent's default is for E1 only: the environment's first root.
        expect((await openOf(m1, 't2')).sent?.cwd).toBe('/other');
        expect(chosenFor('t2')!.summary).toMatch(/folder \/other \(the environment's first root\)/);
    });

    it("a delegated child inherits the parent's project and gets the project's folder on ITS environment", async () => {
        const m1 = await onlineMachine();
        const lead = await agent('agent_lead', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const member = await agent('agent_member', { runtime: 'in-memory', defaultEnvironmentId: E2 });
        const projectId = await project({ features: {} });
        await createTask('p1', lead, { projectId });
        await task('p1').start('test', 'session_p1' as SessionId);
        const childId = await task('p1').delegate({ callId: 'call_1', objective: 'child', assignee: member, context: [], constraints: {} });
        expect((await task(childId).get()).projectId).toBe(projectId);
        await routing().run(childId);
        await settled(childId);
        expect((await openOf(m1, childId)).sent?.cwd).toBe('/other/agentic');
        expect(chosenFor(childId)!.summary).toMatch(/folder \/other\/agentic \(the project's folder\)/);
        // A child told its own project keeps that one.
        const other = await workspace().upsertProject({ name: 'Other', folders: { [E2]: '/other/other' } });
        const c2 = await task('p1').delegate({ callId: 'call_2', objective: 'child', assignee: member, context: [], constraints: {}, projectId: other.id });
        expect((await task(c2).get()).projectId).toBe(other.id);
        await routing().run(c2);
        await settled(c2);
        expect((await openOf(m1, c2)).sent?.cwd).toBe('/other/other');
    });

    it("the project's connectors reach the gate and the OpenSpec beside the agent's", async () => {
        for (const id of ['acme', 'other']) {
            const { manifest, connector } = mcpConnectorSetup({ id, name: id, transport: 'streamable-http', url: `https://${id}.test/mcp`, secret: `${id}.token` });
            await registry().register(manifest, { enabled: true, grant: 'declared' });
            await registry().putConnector(connector);
        }
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 }, [{ id: 'other' }]);
        const projectId = await project({ features: {}, connectors: [{ id: 'acme' }, { id: 'other' }] });
        await createTask('t1', a, { projectId });
        await routing().run('t1' as TaskId);
        await settled('t1');
        const { sent } = await openOf(m1, 't1');
        expect(sent?.connectors?.map((c) => c.id)).toEqual(['other', 'acme']);
        expect((await session((await task('t1').get()).sessionId!).get()).spec?.plugins?.connectors?.map((c) => c.id)).toEqual(['other', 'acme']);
    });

    it('an unknown project fails the task project-missing before any route or session exists', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        await createTask('t1', a, { projectId: 'project_gone' as ProjectId });
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: PROJECT_MISSING_CODE, recoverable: false });
        expect(t.error!.message).toMatch(/project_gone no longer exists/);
        expect(sockets.opens(machineKey(WS, m1))).toEqual({});
        expect((await routing().get()).routes).toEqual([]);
    });
});

describe('project feature plugins (#332)', () => {
    it('beforeSession sees the resolved folder and a daemon-backed fs, moves the session and adds instructions; instructions() joins the ## Project section', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project();
        const { chatId } = await workspace().createChat({ projectId });
        const probes: Record<string, unknown> = {};
        hook = async ({ fs, cwd, environmentId }) => {
            probes['worktree'] = await fs({ kind: 'worktree', repo: cwd, branch: 'feat/t1', path: `${cwd}/wt/t1` } satisfies FsOp);
            probes['list'] = await fs({ kind: 'list', path: cwd });
            return { cwd: `/work/agentic-worktrees/t1-${environmentId}`, instructions: 'Branch: feat/t1 (a worktree of /work/agentic).' };
        };
        await createTask('t1', a, { origin: { kind: 'user', chatId, messageId: 'msg_1' as never }, projectId });
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(hookCalls).toHaveLength(1);
        expect(hookCalls[0]).toMatchObject({ taskId: 't1', chatId, environmentId: E1, cwd: '/work/agentic', settings: { baseBranch: 'develop' }, project: { id: projectId, name: 'Agentic' } });
        // The in-memory daemon lists any folder inside the roots and creates no worktrees: both answered as the wire does.
        expect(probes['worktree']).toEqual({ error: { code: 'unsupported', message: expect.stringMatching(/worktree/) } });
        expect(probes['list']).toMatchObject({ result: { kind: 'list', path: '/work/agentic', entries: [] } });
        const { sent, record } = await openOf(m1, 't1');
        expect(sent?.cwd).toBe('/work/agentic-worktrees/t1-env_1');
        expect(record).toBe('/work/agentic-worktrees/t1-env_1');
        expect(sent?.system).toContain('## Project');
        expect(sent?.system).toContain('Branch: feat/t1 (a worktree of /work/agentic).');
        expect(sent?.system).toContain('Work on the Agentic repo; the base branch is develop.');
        const spec = (await session((await task('t1').get()).sessionId!).get()).spec!;
        expect(spec.projectInstructions).toBe('Branch: feat/t1 (a worktree of /work/agentic).\n\nWork on the Agentic repo; the base branch is develop.');
        // The route resolved the project's folder once; the plugin's replacement is what ran.
        expect(chosenFor('t1')).toMatchObject({ data: { cwd: '/work/agentic' } });
    });

    it('a throw parks the task waiting { project-feature } with the message, opens nothing, and a later run tries again', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project();
        hook = async () => {
            throw new Error('git worktree add failed:   disk full');
        };
        await createTask('t1', a, { projectId });
        const parked = await routing().run('t1' as TaskId);
        expect(parked.status).toBe('waiting');
        expect(parked.wait).toEqual({ kind: 'project-feature', pluginId: GIT, message: 'git worktree add failed: disk full' });
        expect(parked.sessionId).toBeUndefined();
        expect(sockets.opens(machineKey(WS, m1))).toEqual({});
        expect((await machine(m1).get()).activeSessions).toEqual([]);
        expect((await routing().get()).routes.map((r) => [r.taskId, r.status, r.cwd, r.projectId])).toEqual([['t1', 'opening', '/work/agentic', projectId]]);
        // Still failing: the same wait, no second transition.
        expect((await routing().run('t1' as TaskId)).wait).toEqual(parked.wait);
        expect(hookCalls).toHaveLength(2);
        // Fixed: the hooks run again on the same route and the session opens in the plugin's folder.
        hook = async () => ({ cwd: '/work/agentic/wt' });
        const again = await routing().run('t1' as TaskId);
        expect(again.status).not.toBe('waiting');
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect((await openOf(m1, 't1')).sent?.cwd).toBe('/work/agentic/wt');
    });

    it('a folder the plugin returns outside the roots fails the task workdir-outside-roots', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project();
        hook = async () => ({ cwd: '/tmp/elsewhere' });
        await createTask('t1', a, { projectId });
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'workdir-outside-roots', recoverable: false });
        expect(t.error!.message).toMatch(/\/tmp\/elsewhere \(from a project feature plugin\) is outside the roots of environment env_1/);
        expect(sockets.opens(machineKey(WS, m1))).toEqual({});
    });

    it('an enabled feature this build does not ship is skipped; on the API path only instructions apply and beforeSession is not called', async () => {
        const a = await agent('agent_api', { runtime: 'anthropic-api' });
        // No machine is paired: a project with no folders (a folder needs an environment a machine reports).
        const projectId = await project({ features: { [GIT]: {}, [OTHER]: {} }, folders: { [E1]: null, [E2]: null } });
        hook = async () => ({ cwd: '/nowhere', instructions: 'never' });
        await createTask('t1', a, { projectId });
        await routing().run('t1' as TaskId);
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect(hookCalls).toHaveLength(0);
        const spec = (await session(t.sessionId!).get()).spec!;
        expect(spec.cwd).toBeUndefined();
        expect(spec.projectInstructions).toBe('Work on the Agentic repo; the base branch is main.');
    });
});

describe('the git feature (#335)', () => {
    const chatOrigin = (chatId: ChatId, n: number) => ({ kind: 'user', chatId, messageId: `msg_${n}` as never }) as const;
    const slugOf = (branch: string) => branch.replace('/', '-');
    const made = (_environmentId: string, op: WorktreeOp): { result: FsResult } => ({ result: { kind: 'worktree', path: op.path, branch: op.branch } });

    it('two members on two machines in one chat each get a worktree beside their own checkout with one branch name; the spec opens there and the prompt names the branch', async () => {
        const m1 = await onlineMachine();
        const m2 = await onlineMachine([{ id: E3, cwdRoots: ['/home/b'] }]);
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const b = await agent('agent_b', { runtime: 'in-memory', defaultEnvironmentId: E3 });
        const projectId = await project({ folders: { [E3]: '/home/b/agentic' }, features: { [GIT_FEATURE_ID]: { worktreePerChat: true, base: 'develop', instructions: 'Branch first; never work on main.' } } });
        const { chatId } = await workspace().createChat({ projectId });
        const branch = gitBranchFor(chatId);
        expect(branch).toMatch(/^chat\/[a-z0-9_-]{8}$/);
        sockets.worktree = made;
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId });
        await createTask('t2', b, { origin: chatOrigin(chatId, 2), projectId });
        await routing().run('t1' as TaskId);
        await routing().run('t2' as TaskId);
        await Promise.all([settled('t1'), settled('t2')]);
        expect((await task('t1').get()).status).toBe('completed');
        expect((await task('t2').get()).status).toBe('completed');
        // One `worktree` op per environment, each to its own machine's daemon, the same branch from the project's base.
        expect(sockets.worktreeRequests).toEqual([
            { key: machineKey(WS, m1), environmentId: E1, op: { kind: 'worktree', repo: '/work/agentic', branch, base: 'develop', path: `/work/agentic-worktrees/${slugOf(branch)}` } },
            { key: machineKey(WS, m2), environmentId: E3, op: { kind: 'worktree', repo: '/home/b/agentic', branch, base: 'develop', path: `/home/b/agentic-worktrees/${slugOf(branch)}` } }
        ]);
        for (const [machineId, taskId, cwd] of [
            [m1, 't1', `/work/agentic-worktrees/${slugOf(branch)}`],
            [m2, 't2', `/home/b/agentic-worktrees/${slugOf(branch)}`]
        ] as const) {
            const { sent, record } = await openOf(machineId, taskId);
            expect(sent?.cwd).toBe(cwd);
            expect(record).toBe(cwd);
            expect(sent?.system).toContain('## Project');
            expect(sent?.system).toContain(`isolated git worktree \`${cwd}\` on branch \`${branch}\``);
            expect(sent?.system).toContain('Branch first; never work on main.');
        }
        // The route still records the project's folder; the worktree is the plugin's replacement.
        expect(chosenFor('t1')).toMatchObject({ data: { environmentId: E1, cwd: '/work/agentic' } });
        expect(chosenFor('t2')).toMatchObject({ data: { environmentId: E3, cwd: '/home/b/agentic' } });
    });

    it('a second task in the same chat keeps the worktree: the daemon answers reused (#618), the same folder is the same placement, and the member’s live session is reused (#393)', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: { [GIT_FEATURE_ID]: { worktreePerChat: true } } });
        const { chatId } = await workspace().createChat({ projectId });
        await app.as(owner).actor(Chat, actorKey(WS, 'chat', chatId)).addAgent(a, 'all');
        const branch = gitBranchFor(chatId);
        const cwd = `/work/agentic-worktrees/${slugOf(branch)}`;
        const branches = new Set<string>();
        sockets.worktree = (environmentId, op) => {
            if (branches.has(op.branch)) return { result: { kind: 'worktree', path: op.path, branch: op.branch, reused: true } };
            branches.add(op.branch);
            return made(environmentId, op);
        };
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId });
        expect((await routing().run('t1' as TaskId)).status).not.toBe('waiting');
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        await createTask('t2', a, { origin: chatOrigin(chatId, 2), projectId });
        const second = await routing().run('t2' as TaskId);
        expect(second.status).not.toBe('waiting');
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        // The hook ran for each placement — idempotent: the worktree is reused, the folder is the same — so the placement is unchanged.
        expect(sockets.worktreeRequests.map((r) => r.op)).toEqual([
            { kind: 'worktree', repo: '/work/agentic', branch, path: cwd },
            { kind: 'worktree', repo: '/work/agentic', branch, path: cwd }
        ]);
        // One session for the member: opened once on the daemon in the worktree, re-opened for the second task with the same folder and the branch named.
        expect(second.sessionId).toBe((await task('t1').get()).sessionId);
        const opened = await openOf(m1, 't1');
        expect(opened.sent?.cwd).toBe(cwd);
        expect(Object.keys(sockets.opens(machineKey(WS, m1)))).toEqual([second.sessionId]);
        const record = (await session(second.sessionId!).get()).spec;
        expect(record).toMatchObject({ taskId: 't2', cwd });
        expect(record?.system).toContain(`isolated git worktree \`${cwd}\` on branch \`${branch}\``);
    });

    it("a daemon that cannot make the worktree parks the task waiting { project-feature } with the daemon's message; a task from no chat opens in the project's folder", async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ features: { [GIT_FEATURE_ID]: { worktreePerChat: true, instructions: 'Branch first.' } } });
        const { chatId } = await workspace().createChat({ projectId });
        // The in-memory daemon answers `worktree` as unsupported: the plugin throws with that message.
        await createTask('t1', a, { origin: chatOrigin(chatId, 1), projectId });
        const parked = await routing().run('t1' as TaskId);
        expect(parked.status).toBe('waiting');
        expect(parked.wait).toEqual({ kind: 'project-feature', pluginId: GIT_FEATURE_ID, message: 'git worktree unsupported: the in-memory daemon does not answer worktree' });
        expect(parked.sessionId).toBeUndefined();
        expect(sockets.opens(machineKey(WS, m1))).toEqual({});
        // No chat: nothing to name a branch after, so no worktree and no daemon round trip; the instructions still apply.
        await createTask('t2', a, { projectId });
        await routing().run('t2' as TaskId);
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        expect(sockets.worktreeRequests).toEqual([]);
        const { sent } = await openOf(m1, 't2');
        expect(sent?.cwd).toBe('/work/agentic');
        expect(sent?.system).toContain('## Project');
        expect(sent?.system).toContain('Branch first.');
        expect(sent?.system).not.toContain('isolated git worktree');
    });
});

describe('a chat leaving its project (#623)', () => {
    /** What `onChatReleased` did, set per test; every call recorded. */
    let released: ProjectFeatureChatReleaseInput[];
    beforeEach(() => {
        released = [];
        feature.onChatReleased = async (input) => {
            released.push(input);
            if (input.environmentId === E1) return `tidied ${input.cwd}`;
            throw new Error('the daemon said no');
        };
    });
    afterEach(() => {
        delete (feature as { onChatReleased?: unknown }).onChatReleased;
    });

    it("tells the project's plugins once per environment with a folder, audits what each said, and a throw never undoes the move", async () => {
        await onlineMachine();
        const projectId = await project();
        const { chatId } = await workspace().createChat({ projectId });
        await chat(chatId).setProject(null);
        await until(() => released.length > 0 && audit.events.filter((e) => e.kind === 'project.chat-released').length >= 2, 'the release to be heard and audited');
        expect((await chat(chatId).get()).projectId).toBeUndefined();
        // The machine reports both environments: the hook ran on each with the project's folder there.
        expect(released.map((r) => [r.environmentId, r.cwd, r.chatId, r.reason, r.project.id])).toEqual([
            [E1, '/work/agentic', chatId, 'project-changed', projectId],
            [E2, '/other/agentic', chatId, 'project-changed', projectId]
        ]);
        const records = audit.events.filter((e) => e.kind === 'project.chat-released');
        expect(records.map((e) => e.data)).toEqual([
            { chatId, projectId, pluginId: GIT, environmentId: E1, reason: 'project-changed', outcome: 'tidied /work/agentic' },
            { chatId, projectId, pluginId: GIT, environmentId: E2, reason: 'project-changed', error: 'the daemon said no' }
        ]);
    });

    it('a member agent moving the chat still reaches the daemon as the workspace owner: owner-only ops are not refused', async () => {
        await onlineMachine();
        const a = await agent('agent_a', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const projectId = await project({ folders: { [E2]: null } });
        const { chatId } = await workspace().createChat({ projectId });
        await chat(chatId).addAgent(a, 'all');
        const answers: (FsError | undefined)[] = [];
        feature.onChatReleased = async (input) => {
            released.push(input);
            answers.push((await input.fs({ kind: 'worktree-remove', repo: input.cwd, path: `${input.cwd}-worktrees/x` })).error);
            return 'asked';
        };
        const asAgent = mintAgentPrincipal({ workspaceId: WS, agentId: a, sessionId: 'sess_a' as SessionId });
        await app.as(asAgent).actor(Chat, actorKey(WS, 'chat', chatId)).setProject(null);
        await until(() => answers.length > 0, 'the plugin to ask the daemon');
        // The in-memory daemon cannot remove worktrees; what matters is that the Machine let the request through (no 403).
        expect(answers[0]?.message ?? '').not.toMatch(/only the owner/);
    });

    it('an environment whose machine is offline is audited as unreachable, and the hook is not run there', async () => {
        const machineId = await onlineMachine();
        const projectId = await project({ folders: { [E2]: null } });
        const { chatId } = await workspace().createChat({ projectId });
        sockets.close(machineKey(WS, machineId));
        await machine(machineId, asMachine(machineId)).socketClosed();
        await until(async () => !(await machine(machineId).get()).online, 'the machine to go offline');
        await chat(chatId).setProject(null);
        await until(() => audit.events.some((e) => e.kind === 'project.chat-released'), 'the unreachable release to be audited');
        expect(released).toEqual([]);
        expect(audit.events.find((e) => e.kind === 'project.chat-released')?.data).toMatchObject({ environmentId: E1, error: expect.stringContaining('offline') });
    });

    it('a throwing plugin is audited with its message; a chat still in the project, or a call for nothing, changes nothing', async () => {
        await onlineMachine();
        const projectId = await project({ folders: { [E2]: null } });
        feature.onChatReleased = async (input) => {
            released.push(input);
            throw new Error('the daemon said no');
        };
        const { chatId } = await workspace().createChat({ projectId });
        // A stray call while the chat is still in the project: nothing runs.
        await routing().chatReleased(chatId, projectId, 'project-changed');
        expect(released).toEqual([]);
        const other = await workspace().upsertProject({ name: 'Other', folders: {}, connectors: [], features: {} });
        await chat(chatId).setProject(other.id);
        await until(() => audit.events.some((e) => e.kind === 'project.chat-released'), 'the failed release to be audited');
        expect((await chat(chatId).get()).projectId).toBe(other.id);
        expect(audit.events.find((e) => e.kind === 'project.chat-released')?.data).toEqual({ chatId, projectId, pluginId: GIT, environmentId: E1, reason: 'project-changed', error: 'the daemon said no' });
    });
});
