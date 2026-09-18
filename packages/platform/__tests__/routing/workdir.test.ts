/**
 * The working folder end to end (#190; EXE-06, EXE-12, OPS-03): the router
 * resolves a task's cwd ONCE — the task's `workdir`, a delegating parent's
 * folder in the same environment, the agent's `defaultWorkdir` in its default
 * environment only, else the environment's first root — checks it against
 * the environment's `cwdRoots` before any session opens, and records it on
 * the route, the `environment.chosen` audit entry, the Session record and
 * `OpenSpec.cwd`. Same in-process host as `routing.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentId, type EnvironmentId, type MachineId, type OfflinePolicy, type Principal, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { capturingAuditPort } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
    /** The `session.open` frames the platform sent this machine: session id → `OpenSpec.cwd`. */
    opens(key: string): Record<string, string | undefined> {
        const out: Record<string, string | undefined> = {};
        for (const t of this.sent.get(key) ?? []) {
            const f = JSON.parse(t) as { t: string; sessionId?: string; spec?: { cwd?: string } };
            if (f.t === 'session.open') out[f.sessionId!] = f.spec?.cwd;
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

let app: TestActorApp;
let sockets: FakeSockets;
let audit: ReturnType<typeof capturingAuditPort>;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    audit = capturingAuditPort();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, audit });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory]);
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

async function agent(id: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; defaultWorkdir?: string; offlinePolicy?: OfflinePolicy }): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

async function createTask(id: string, assignee: AgentId, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    return task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
}

/** A paired machine reporting E1 (roots `/work`, `/scratch`) and E2 (root `/other`); `connect` dials its daemon. */
async function pairMachine(): Promise<{ machineId: MachineId; d: InMemoryDaemon; connect(): PlatformSeat }> {
    const { machineId, pairingCode } = await workspace().registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const environments = [
        { ...inMemoryEnvironment(machineId, E1), cwdRoots: ['/work', '/scratch'] },
        { ...inMemoryEnvironment(machineId, E2), cwdRoots: ['/other'] }
    ];
    const d = inMemoryHarness({ machineId, environments }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const connect = (): PlatformSeat => {
        const key = machineKey(WS, machineId);
        const ids = parseMachineKey(key)!;
        const seat = d.dial();
        sockets.seats.set(key, seat);
        sockets.connected.add(key);
        const asDaemon = machine(ids.machineId, asMachine(ids.machineId));
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

async function onlineMachine(): Promise<MachineId> {
    const m = await pairMachine();
    m.connect();
    await until(async () => (await machine(m.machineId).get()).online, 'the machine to come online');
    return m.machineId;
}

const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
const chosenFor = (taskId: string) => audit.events.find((e) => e.kind === 'environment.chosen' && e.taskId === taskId && !e.key.endsWith(':fallback'));

/** The cwd the daemon was sent for `taskId`'s session, and the Session record's. */
async function cwdOf(machineId: MachineId, taskId: string): Promise<{ sent: string | undefined; record: string | undefined }> {
    const sessionId = (await task(taskId).get()).sessionId as SessionId;
    return { sent: sockets.opens(machineKey(WS, machineId))[sessionId], record: (await session(sessionId).get()).spec?.cwd };
}

describe('working folder resolution (#190)', () => {
    it("the task's own workdir: OpenSpec.cwd, the Session record, the route and the audit entry carry it, and the workspace notes it", async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, defaultWorkdir: '/work/default' });
        await createTask('t1', a, { environmentId: E1, workdir: '/scratch/app' });
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(await cwdOf(m1, 't1')).toEqual({ sent: '/scratch/app', record: '/scratch/app' });
        expect(chosenFor('t1')).toMatchObject({ data: { environmentId: E1, cwd: '/scratch/app' } });
        expect(chosenFor('t1')!.summary).toMatch(/folder \/scratch\/app \(the task's own\)/);
        await until(async () => (await workspace().recentWorkdirs()).length === 1, 'the workspace to note the folder');
        expect(await workspace().recentWorkdirs()).toEqual([{ environmentId: E1, path: '/scratch/app', at: expect.any(Number) }]);
    });

    it("the agent's defaultWorkdir applies in its default environment only; elsewhere the first root", async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, defaultWorkdir: '/work/default' });
        await createTask('t1', a);
        await createTask('t2', a, { environmentId: E2 });
        await routing().run('t1' as TaskId);
        await routing().run('t2' as TaskId);
        await Promise.all([settled('t1'), settled('t2')]);
        expect(await cwdOf(m1, 't1')).toEqual({ sent: '/work/default', record: '/work/default' });
        expect(await cwdOf(m1, 't2')).toEqual({ sent: '/other', record: '/other' });
        expect(chosenFor('t1')!.summary).toMatch(/folder \/work\/default \(the agent's default\)/);
        expect(chosenFor('t2')).toMatchObject({ data: { environmentId: E2, cwd: '/other' } });
        expect(chosenFor('t2')!.summary).toMatch(/folder \/other \(the environment's first root\)/);
        // Neither was the task's own choice: nothing joins the recents.
        expect(await workspace().recentWorkdirs()).toEqual([]);
    });

    it('with nothing chosen, the first root', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        await createTask('t1', a);
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect(await cwdOf(m1, 't1')).toEqual({ sent: '/work', record: '/work' });
        expect(chosenFor('t1')).toMatchObject({ data: { cwd: '/work' } });
    });

    it('a folder outside the roots fails the task workdir-outside-roots before any session exists — a sibling prefix included', async () => {
        const m1 = await onlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        await createTask('t1', a, { environmentId: E1, workdir: '/work2/app' });
        await createTask('t2', a, { environmentId: E1, workdir: '/work/../etc' });
        await createTask('t3', a, { environmentId: E1, workdir: 'work/app' });
        for (const id of ['t1', 't2', 't3']) {
            const t = await routing().run(id as TaskId);
            expect(t.status).toBe('failed');
            expect(t.error).toMatchObject({ code: 'workdir-outside-roots', recoverable: false });
            expect(t.sessionId).toBeUndefined();
        }
        expect((await task('t1').get()).error!.message).toMatch(/\/work2\/app is outside the roots of environment env_1 .*\(\/work, \/scratch\)/);
        // No Machine.openSession: the daemon was never asked, and no slot or queue entry was taken.
        expect(sockets.opens(machineKey(WS, m1))).toEqual({});
        expect((await machine(m1).get()).activeSessions).toEqual([]);
        expect((await machine(m1).get()).queued).toEqual([]);
        expect((await routing().get()).routes).toEqual([]);
        // An agent default outside the roots fails the same way.
        const b = await agent('agent_bad', { runtime: 'in-memory', defaultEnvironmentId: E1, defaultWorkdir: '/nowhere' });
        await createTask('t4', b);
        expect((await routing().run('t4' as TaskId)).error).toMatchObject({ code: 'workdir-outside-roots' });
        expect(sockets.opens(machineKey(WS, m1))).toEqual({});
    });

    it("a delegated task inherits its parent's folder in the parent's environment only — resolved once, while the machine is offline", async () => {
        const m = await pairMachine();
        const seat = m.connect();
        await until(async () => (await machine(m.machineId).get()).online, 'online');
        seat.drop();
        await until(async () => !(await machine(m.machineId).get()).online, 'offline');

        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'queue' });
        await createTask('p1', a, { environmentId: E1, workdir: '/scratch/app' });
        expect((await routing().run('p1' as TaskId)).status).toBe('waiting');
        const origin = { kind: 'agent', agentId: a, taskId: 'p1' as TaskId, sessionId: 'session_p1' as SessionId, callId: 'call_1' } as const;
        await task('c1').create({ objective: 'child', origin, assignee: a, context: [], constraints: {} }, { owner: a, depth: 1, parentId: 'p1' as TaskId });
        await task('c2').create({ objective: 'child elsewhere', origin: { ...origin, callId: 'call_2' }, assignee: a, context: [], constraints: {}, environmentId: E2 }, { owner: a, depth: 1, parentId: 'p1' as TaskId });
        await task('c3').create({ objective: 'child with its own', origin: { ...origin, callId: 'call_3' }, assignee: a, context: [], constraints: {}, environmentId: E1, workdir: '/work/own' }, { owner: a, depth: 1, parentId: 'p1' as TaskId });
        for (const id of ['c1', 'c2', 'c3']) await routing().run(id as TaskId);
        const routes = Object.fromEntries((await routing().get()).routes.map((r) => [r.taskId, r.cwd]));
        expect(routes).toEqual({ p1: '/scratch/app', c1: '/scratch/app', c2: '/other', c3: '/work/own' });
        expect(chosenFor('c1')!.summary).toMatch(/folder \/scratch\/app \(the delegating task's\)/);

        // The machine comes back: every session opens in the folder chosen at `run`.
        m.connect();
        await Promise.all(['p1', 'c1', 'c2', 'c3'].map(settled));
        for (const [id, cwd] of Object.entries(routes)) expect(await cwdOf(m.machineId, id)).toEqual({ sent: cwd, record: cwd });
    });

    it('anthropic-api ignores a workdir and says so in the record', async () => {
        const a = await agent('agent_api', { runtime: 'anthropic-api' });
        await createTask('t1', a, { environmentId: E1, workdir: '/work/app' });
        await routing().run('t1' as TaskId);
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect((await session(t.sessionId!).get()).spec?.cwd).toBeUndefined();
        expect(chosenFor('t1')).toMatchObject({ data: { runtime: 'anthropic-api', ignoredWorkdir: '/work/app' } });
        expect(chosenFor('t1')!.data).not.toHaveProperty('cwd');
        expect(chosenFor('t1')!.summary).toMatch(/folder \/work\/app ignored/);
    });

    it('Task.create refuses a workdir without an environment (400)', async () => {
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        expect(await statusOf(createTask('t1', a, { workdir: '/work/app' }))).toBe(400);
        expect(await statusOf(createTask('t2', a, { environmentId: E1, workdir: '  ' }))).toBe(400);
        expect((await createTask('t3', a, { environmentId: E1, workdir: '/work/app' })).workdir).toBe('/work/app');
    });
});
