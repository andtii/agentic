/**
 * MCP session files (#566): the port bound to the real actors — Session, Machine over an in-memory daemon that serves
 * its default session folders — reads a session's folder through `machineWorkspaceSource`: the Session under the
 * CLIENT's principal (a `sessions` client may read it without `machines`), then `tree` / `read` / `changes` with `root` =
 * the Session record's `spec.cwd`, the project git feature's `base` when the session's task is in a project, and a clear
 * refusal for a session with no folder on a machine.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectFolderKey, type AgentId, type EnvironmentId, type MachineId, type Principal, type ProjectId, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { IN_MEMORY_PLAIN_ROOT, IN_MEMORY_PROJECT_ROOT, inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import type { ExternalPrincipal } from '@agentic/mcp';
import {
    AgentActor,
    Chat,
    Memory,
    PairingDirectory,
    TaskActor,
    Workspace,
    agentKey,
    defineMachineActor,
    defineRegistry,
    defineRoutingActor,
    defineScheduleActor,
    defineSessionActor,
    generateWorkspaceKek,
    importWorkspaceKek,
    machineKey,
    registryKey,
    taskKey,
    workspaceKey,
    type CommandSink,
    type MachineSocketPort
} from '@agentic/platform';
import { GIT_FEATURE_ID, gitFeatureManifest } from '@agentic/plugins-git';
import type { AnyActorDefinition } from '@sigx/actors';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { createActorPlatformPort } from '../src/auth/oauth-server/port';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
const client: ExternalPrincipal = { kind: 'external', workspaceId: WS, clientId: 'cc', scopes: ['sessions'] };

/** Sockets bridged to in-memory daemon seats; records every frame the platform sends. */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    send(key: string, text: string): boolean {
        const seat = this.seats.get(key);
        if (!seat) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        seat.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
    }
    fsOps(key: string): Record<string, unknown>[] {
        return (this.sent.get(key) ?? []).map((t) => JSON.parse(t) as { t: string; op?: Record<string, unknown> }).flatMap((f) => (f.t === 'fs.request' && f.op ? [f.op] : []));
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
let actors: readonly AnyActorDefinition[];
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()), catalogue: [gitFeatureManifest] });
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink });
    const Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing });
    const Schedule = defineScheduleActor({ trigger: { fired: async () => {} } });
    actors = [Workspace, AgentActor, Chat, TaskActor, Session, Machine, Routing, Schedule, Memory, PairingDirectory, Registry];
    app = testActorApp(actors);
    await app.start();
});
afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const workspace = () => app.as(owner).actor(Workspace, workspaceKey(WS));

/** A paired machine whose daemon reports `E1` over `/work` (the fake's default session folders live there), online. */
async function onlineMachine(): Promise<MachineId> {
    const { machineId, pairingCode } = await workspace().registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const d = inMemoryHarness({ machineId, environments: [{ ...inMemoryEnvironment(machineId, E1), cwdRoots: ['/work'] }] }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const seat = d.dial();
    sockets.seats.set(key, seat);
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

const AGENT = 'agent_cc' as AgentId;

/** A session record as the router leaves it: opened on the machine in `cwd`, for a task (in `projectId`, when given). */
async function sessionIn(machineId: MachineId | undefined, cwd: string | undefined, projectId?: ProjectId): Promise<SessionId> {
    const taskId = `task_${crypto.randomUUID().slice(0, 8)}` as TaskId;
    await app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective: 'x', origin: { kind: 'external', clientId: 'cc' }, assignee: AGENT, context: [], constraints: {}, ...(projectId ? { projectId } : {}) }, { owner: AGENT });
    const sessionId = `sess_${crypto.randomUUID().slice(0, 8)}` as SessionId;
    const config = (await app.as(owner).actor(AgentActor, agentKey(WS, AGENT)).get()).config;
    await app
        .as(owner)
        .actor(Session, `${WS}:session:${sessionId}`)
        .open({ agentId: AGENT, runtime: machineId ? 'in-memory' : 'anthropic-api', taskId, config: config as never, ...(machineId ? { machineId, environmentId: E1 } : {}), ...(cwd ? { cwd } : {}) });
    return sessionId;
}

beforeEach(async () => {
    await app.as(owner).actor(AgentActor, agentKey(WS, AGENT)).update({ name: 'cc', instructions: 'Be brief.', tools: [], execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } }, 'create');
});

describe('MCP session files through the actor port (#566)', () => {
    it('lists, reads and diffs the session folder on its machine for a client holding only "sessions", rooted at spec.cwd', async () => {
        const machineId = await onlineMachine();
        const sessionId = await sessionIn(machineId, IN_MEMORY_PROJECT_ROOT);
        const port = createActorPlatformPort(client, { actors });

        const tree = await port.sessions.tree(sessionId, '');
        expect(tree.error).toBeUndefined();
        expect(tree.result!.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['src', 'README.md']));
        expect(tree.result!.entries.map((e) => e.name)).not.toContain('dist');

        const working = await port.sessions.read(sessionId, 'src/app.ts');
        const head = await port.sessions.read(sessionId, 'src/app.ts', 'head');
        expect(working.result?.text).toContain('answer = 42');
        expect(head.result?.text).toContain('answer = 41');

        const changes = await port.sessions.changes(sessionId, 'uncommitted');
        expect(changes.result).toMatchObject({ kind: 'changes', vcs: 'git', branch: 'feature/files' });
        expect(changes.result!.files.map((f) => f.path)).toContain('src/app.ts');

        const ops = sockets.fsOps(machineKey(WS, machineId));
        expect(ops.map((o) => o['kind'])).toEqual(['tree', 'read', 'read', 'changes']);
        for (const op of ops) expect(op['root']).toBe(IN_MEMORY_PROJECT_ROOT);
        // No project: the daemon picks the base.
        expect(ops.some((o) => 'base' in o)).toBe(false);
    });

    it("the machine's refusals come back as the answer's error: a path outside the folder, a folder without version control", async () => {
        const machineId = await onlineMachine();
        const port = createActorPlatformPort(client, { actors });
        const repo = await sessionIn(machineId, IN_MEMORY_PROJECT_ROOT);
        expect((await port.sessions.read(repo, '../plain/notes.txt')).error?.code).toBe('outside-roots');
        const plain = await sessionIn(machineId, IN_MEMORY_PLAIN_ROOT);
        expect((await port.sessions.changes(plain, 'uncommitted')).error?.code).toBe('not-a-repo');
        expect((await port.sessions.tree(plain, '')).result?.entries.map((e) => e.name)).toEqual(['notes.txt']);
    });

    it("compares a branch with the project git feature's base when the session's task is in a project", async () => {
        const machineId = await onlineMachine();
        await app.as(owner).actor(Registry, registryKey(WS)).enable(GIT_FEATURE_ID);
        const project = await workspace().upsertProject({ name: 'Agentic', folders: { [projectFolderKey(machineId)]: IN_MEMORY_PROJECT_ROOT }, features: { [GIT_FEATURE_ID]: { base: 'develop' } } });
        const sessionId = await sessionIn(machineId, IN_MEMORY_PROJECT_ROOT, project.id);
        const port = createActorPlatformPort(client, { actors });
        await port.sessions.changes(sessionId, 'branch');
        await port.sessions.read(sessionId, 'src/app.ts', 'base');
        await port.sessions.read(sessionId, 'src/app.ts', 'head');
        const ops = sockets.fsOps(machineKey(WS, machineId));
        expect(ops.map((o) => [o['kind'], o['base']])).toEqual([
            ['changes', 'develop'],
            ['read', 'develop'],
            ['read', undefined]
        ]);
    });

    it('a session with no folder on a machine is a 400 before any machine is asked; a client without "sessions" is refused by the Session', async () => {
        const machineId = await onlineMachine();
        const port = createActorPlatformPort(client, { actors });
        const api = await sessionIn(undefined, undefined);
        expect(await statusOf(port.sessions.tree(api, ''))).toBe(400);
        await expect(port.sessions.changes(api, 'uncommitted')).rejects.toThrow(/has no folder on a machine \(runtime anthropic-api\)/);
        expect(sockets.fsOps(machineKey(WS, machineId))).toEqual([]);

        const repo = await sessionIn(machineId, IN_MEMORY_PROJECT_ROOT);
        const narrow = createActorPlatformPort({ ...client, scopes: ['machines'] }, { actors });
        expect(await statusOf(narrow.sessions.tree(repo, ''))).toBe(403);
        expect(sockets.fsOps(machineKey(WS, machineId))).toEqual([]);
    });
});
