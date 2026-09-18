/**
 * Execution routing end to end (architecture §7; EXE-09, EXE-11, EXE-12,
 * AC-07) against a real in-process host: Routing + Task + Agent + Session +
 * Machine with an in-memory daemon, and a `mockAgent` as the `anthropic-api`
 * runtime. Offline and deterministic: a machine goes offline by dropping its
 * socket, never through the heartbeat window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type EnvironmentId, type MachineId, type MessageId, type OfflinePolicy, type Principal, type RuntimeId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { Chat } from '../../src/chat/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { createEnvironmentProbe, createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

/** A fake socket layer bridged to `InMemoryDaemon` seats (the Machine test's). */
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
    frames(key: string): { t: string }[] {
        return (this.sent.get(key) ?? []).map((t) => JSON.parse(t) as { t: string });
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** The `anthropic-api` runtime: echoes the prompt. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => [{ text: `echo: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }]
    });
}

function localFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

let app: TestActorApp;
let sockets: FakeSockets;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(scriptedAgent()), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Chat]);
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));

/** An agent configured for `runtime`, with an environment and an offline policy. */
async function agent(id: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; offlinePolicy?: OfflinePolicy }): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }, { name: 'memory_search' }], approvalPolicy: [{ id: 'ask-destructive', match: { categories: ['destructive'] }, outcome: 'ask' }], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

async function createTask(id: string, assignee: AgentId, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    return task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
}

/** Register + pair a machine in the workspace (so the router can find its environments), and connect its daemon. */
async function pairMachine(name: string): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    return machineId;
}

function daemon(machineId: MachineId, environments = [inMemoryEnvironment(machineId, E1)], script: { events?: number; tool?: { name: string; input: unknown } } = {}): InMemoryDaemon {
    const d = inMemoryHarness({ machineId, environments }).start({ events: script.events ?? 3, heartbeatMs: 600_000, ...(script.tool ? { tool: script.tool } : {}) }) as InMemoryDaemon;
    daemons.push(d);
    return d;
}

function connect(machineId: MachineId, d: InMemoryDaemon): PlatformSeat {
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
}

const online = (id: MachineId, is = true) => until(async () => (await machine(id).get()).online === is, `${id} ${is ? 'online' : 'offline'}`);
const settled = async (id: string) => {
    try {
        await until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
    } catch (e) {
        const t = await task(id).get();
        const r = await routing().get();
        const details = { task: { status: t.status, wait: t.wait, sessionId: t.sessionId, transitions: t.transitions }, routes: r.routes, session: t.sessionId ? await session(t.sessionId).get() : undefined };
        throw new Error(`${(e as Error).message}
${JSON.stringify(details, null, 1)}`);
    }
};
const edges = (t: TaskView) => t.transitions.map((x) => `${x.from}>${x.to}`);

describe('Routing authorization', () => {
    it('admits task drivers of the workspace; the machine entry points only machines', async () => {
        expect(await statusOf(app.as(userPrincipal('u2')).actor(Routing, routingKey(WS)).get())).toBe(403);
        expect(await statusOf(app.as(asMachine('m' as MachineId)).actor(Routing, routingKey(WS)).run('t' as TaskId))).toBe(403);
        expect(await statusOf(routing().machineOnline('m' as MachineId))).toBe(403);
        expect(await statusOf(app.as(asMachine('m' as MachineId)).actor(Routing, routingKey(WS)).machineOnline('m' as MachineId))).toBeUndefined();
        const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['chats'] };
        expect(await statusOf(app.as(external).actor(Routing, routingKey(WS)).run('t' as TaskId))).toBe(403);
    });
});

describe('anthropic-api (local)', () => {
    it('opens a local session, prompts the objective and completes the task with the final text', async () => {
        const a = await agent('agent_api', { runtime: 'anthropic-api' });
        await createTask('t1', a);
        const started = await routing().run('t1' as TaskId);
        expect(started.status).toBe('active');
        expect(started.sessionId).toBeDefined();
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect(t.result).toEqual({ text: 'echo: do the thing', artifacts: [], verified: false });
        expect(edges(t)).toEqual(['queued>active', 'active>completed']);
        expect(t.transitions[1]).toMatchObject({ by: 'system:routing' });
        const info = await session(t.sessionId!).get();
        expect(info.spec).toMatchObject({ runtime: 'anthropic-api', taskId: 't1', tools: ['task_report', 'memory_search'] });
        await until(async () => (await session(t.sessionId!).get()).status === 'closed', 'the session to close');
        expect((await routing().get()).routes).toEqual([]);
        // A settled task is not re-run: its route is gone and `run` only starts a queued task.
        expect(await statusOf(routing().run('t1' as TaskId))).toBe(409);
    });

    it('refuses to run a task that is not queued', async () => {
        const a = await agent('agent_api', { runtime: 'anthropic-api' });
        await createTask('t2', a);
        await task('t2').start('user:u1');
        expect(await statusOf(routing().run('t2' as TaskId))).toBe(409);
    });
});

describe('daemon runtime (EXE-09)', () => {
    it('opens the session on the environment machine, prompts on session.opened, bridges task_report and completes with its output', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1, undefined, { tool: { name: 'task_report', input: { status: 'done', summary: 'did it', output: { answer: 42 } } } }));
        await online(m1);
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        await createTask('t1', a);
        const started = await routing().run('t1' as TaskId);
        expect(started.status).toBe('active');
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect(t.result).toEqual({ text: 'did it', output: { answer: 42 }, artifacts: [], verified: false });
        expect(edges(t)).toEqual(['queued>active', 'active>completed']);
        const info = await session(t.sessionId!).get();
        expect(info.spec).toMatchObject({ runtime: 'in-memory', environmentId: E1, machineId: m1 });
        expect(info.mode).toBe('remote');
        expect(sockets.frames(machineKey(WS, m1)).find((f) => f.t === 'tool.result')).toMatchObject({ output: { ok: true, status: 'done' } });
        // The daemon compiles the session policy from what travels in session.open (#121): the agent's rules and its grants, in config order.
        expect(sockets.frames(machineKey(WS, m1)).find((f) => f.t === 'session.open')).toMatchObject({ spec: { policy: { rules: [{ id: 'ask-destructive', match: { categories: ['destructive'] }, outcome: 'ask' }], grants: [{ name: 'task_report' }, { name: 'memory_search' }] } } });
        // The session is closed at the end, freeing the environment slot.
        await until(async () => (await machine(m1).get()).activeSessions.length === 0, 'the slot to free');
    });

    it('a chat task tells the agent who is in the chat (CHT-07): the roster on the spec and the full prompt on the daemon', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const forge = await agent('agent_forge', { runtime: 'anthropic-api' });
        await app.as(owner).actor(AgentActor, agentKey(WS, forge)).update({ role: 'Builds and ships' }, 'role');
        const { chatId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({ title: 'Release' });
        const room = app.as(owner).actor(Chat, actorKey(WS, 'chat', chatId));
        await room.addAgent(cc, 'all');
        await room.addAgent(forge, 'all');
        await room.setCoordinator(cc);
        const { messageId } = await room.post('talk to everyone', []);
        await createTask('t1', cc, { objective: 'talk to everyone', origin: { kind: 'user', chatId, messageId: messageId as MessageId } });
        await routing().run('t1' as TaskId);
        await settled('t1');

        const info = await session((await task('t1').get()).sessionId!).get();
        expect(info.spec?.roster).toEqual({
            chatId,
            title: 'Release',
            self: cc,
            coordinator: cc,
            members: [
                { agentId: cc, name: 'agent_cc' },
                { agentId: forge, name: 'agent_forge', role: 'Builds and ships' }
            ]
        });
        // The daemon runs the platform's whole prompt — identity, instructions, the chat, the tools — not the bare instructions.
        const system = (sockets.frames(machineKey(WS, m1)).find((f) => f.t === "session.open") as unknown as { spec: { system: string } }).spec.system;
        expect(system).toContain('# agent_cc');
        expect(system).toContain('Be brief.');
        expect(system).toContain('## This chat');
        expect(system).toContain('- agent_forge (agent_forge): Builds and ships');
        expect(system).toContain('You are the coordinator');
        expect(system).toContain('## Tools');
    });

    it('a task that came from no chat carries no roster', async () => {
        const a = await agent('agent_api', { runtime: 'anthropic-api' });
        await createTask('t1', a);
        await routing().run('t1' as TaskId);
        await settled('t1');
        expect((await session((await task('t1').get()).sessionId!).get()).spec?.roster).toBeUndefined();
    });

    it('a task with its own environmentId runs there, not on the agent default', async () => {
        const m1 = await pairMachine('laptop');
        const E2 = 'env_2' as EnvironmentId;
        connect(m1, daemon(m1, [inMemoryEnvironment(m1, E1), inMemoryEnvironment(m1, E2)]));
        await online(m1);
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        await createTask('t1', a, { environmentId: E2 });
        await routing().run('t1' as TaskId);
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect((await session(t.sessionId!).get()).spec).toMatchObject({ environmentId: E2, machineId: m1 });
    });

    it('queues beyond capacity with a visible position and dequeues when the slot frees', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1, [{ ...inMemoryEnvironment(m1, E1), concurrency: { max: 1, active: 0 } }], { events: 2 }));
        await online(m1);
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        await createTask('t1', a);
        await createTask('t2', a);
        // Hold the first slot: the daemon needs the platform's prompt before its session ends, and t1 runs a full turn.
        await routing().run('t1' as TaskId);
        const second = await routing().run('t2' as TaskId);
        if (second.status === 'waiting') {
            expect(second.wait).toEqual({ kind: 'capacity', environmentId: E1, position: 1 });
            expect(second.sessionId).toBeDefined();
            expect(edges(second)).toEqual(['queued>waiting']);
        }
        await settled('t1');
        await settled('t2');
        const t2 = await task('t2').get();
        expect(t2.status).toBe('completed');
        if (second.status === 'waiting') {
            expect(edges(t2)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
            expect(t2.transitions[1]!.why).toMatch(/slot freed in environment env_1/);
        }
        expect((await machine(m1).get()).queued).toEqual([]);
    });

    it('an environment no machine reports is offline under the policy: fail fails, queue waits for the machine that reports it', async () => {
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: 'env_nowhere' as EnvironmentId, offlinePolicy: 'fail' });
        await createTask('t1', a);
        const t1 = await routing().run('t1' as TaskId);
        expect(t1.status).toBe('failed');
        expect(t1.error).toMatchObject({ code: 'environment-offline' });
        expect(t1.error!.message).toMatch(/no machine of the workspace reports it/);
        expect(edges(t1)).toEqual(['queued>waiting', 'waiting>failed']);

        const b = await agent('agent_q', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'queue' });
        await createTask('t2', b);
        const t2 = await routing().run('t2' as TaskId);
        expect(t2.status).toBe('waiting');
        expect(t2.wait).toEqual({ kind: 'environment-offline', environmentId: E1, policy: 'queue' });
        expect((await routing().get()).routes[0]).toMatchObject({ taskId: 't2', status: 'waiting-offline' });
        expect((await routing().get()).routes[0]!.machineId).toBeUndefined();
        // The first machine to report the environment gets the task — and keeps it.
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        await settled('t2');
        const done = await task('t2').get();
        expect(done.status).toBe('completed');
        expect((await session(done.sessionId!).get()).spec).toMatchObject({ environmentId: E1, machineId: m1 });
    });

    it('fails a task whose agent names no environment, or whose environment runs another runtime', async () => {
        const b = await agent('agent_none', { runtime: 'in-memory' });
        await createTask('t2', b);
        const t2 = await routing().run('t2' as TaskId);
        expect(t2.error).toMatchObject({ code: 'no-environment' });
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const c = await agent('agent_other', { runtime: 'claude-code', defaultEnvironmentId: E1 });
        await createTask('t3', c);
        const t3 = await routing().run('t3' as TaskId);
        expect(t3.status).toBe('failed');
        expect(t3.error).toMatchObject({ code: 'runtime-mismatch' });
        expect((await routing().get()).routes).toEqual([]);
    });
});

describe('AC-07: the selected machine is offline (EXE-11, EXE-12)', () => {
    /** A paired machine that reported `E1` and then dropped its socket. */
    async function offlineMachine(name = 'laptop'): Promise<{ machineId: MachineId; d: InMemoryDaemon }> {
        const machineId = await pairMachine(name);
        const d = daemon(machineId);
        const seat = connect(machineId, d);
        await online(machineId);
        seat.drop();
        await online(machineId, false);
        return { machineId, d };
    }

    it('policy queue: waits {environment-offline}, ignores another machine with the same environment id, and resumes on the next hello of ITS machine', async () => {
        const { machineId: m1, d } = await offlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'queue' });
        await createTask('t1', a);
        const waiting = await routing().run('t1' as TaskId);
        expect(waiting.status).toBe('waiting');
        expect(waiting.wait).toEqual({ kind: 'environment-offline', environmentId: E1, policy: 'queue' });
        expect(waiting.sessionId).toBeUndefined();
        expect((await routing().get()).routes[0]).toMatchObject({ taskId: 't1', status: 'waiting-offline', environmentId: E1, machineId: m1 });

        // Another machine reporting an environment with the same id changes nothing: the task is bound to m1 (EXE-12).
        const m2 = await pairMachine('other');
        connect(m2, daemon(m2, [inMemoryEnvironment(m2, E1)]));
        await online(m2);
        await new Promise((r) => setTimeout(r, 50));
        expect((await task('t1').get()).status).toBe('waiting');
        expect((await machine(m2).get()).activeSessions).toEqual([]);

        // m1 redials: the route retries there.
        connect(m1, d);
        await online(m1);
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect(edges(t)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
        expect(t.transitions[1]!.why).toMatch(/environment env_1 on machine .* is online/);
        expect((await session(t.sessionId!).get()).spec).toMatchObject({ environmentId: E1, machineId: m1 });
        expect((await machine(m2).get()).activeSessions).toEqual([]);
    });

    it('policy fail: waits {environment-offline} then fails with a clear error', async () => {
        await offlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' });
        await createTask('t1', a);
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'environment-offline', recoverable: true });
        expect(t.error!.message).toMatch(/env_1 .* is offline; the agent's offline policy is "fail"/);
        expect(edges(t)).toEqual(['queued>waiting', 'waiting>failed']);
        expect(t.transitions[0]!.wait).toEqual({ kind: 'environment-offline', environmentId: E1, policy: 'fail' });
        expect((await routing().get()).routes).toEqual([]);
    });

    it('policy fallback-api, when the config says so: runs on anthropic-api through a transition that says why', async () => {
        await offlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fallback-api' });
        await createTask('t1', a, { environmentId: E1 });
        const started = await routing().run('t1' as TaskId);
        expect(started.status).toBe('active');
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect(t.result?.text).toBe('echo: do the thing');
        expect(edges(t)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
        expect(t.transitions[0]!.wait).toEqual({ kind: 'environment-offline', environmentId: E1, policy: 'fallback-api' });
        expect(t.transitions[1]!.why).toMatch(/^fallback-api: environment env_1 on machine .* is offline; running on anthropic-api/);
        // The task's own environment is untouched; only the session ran elsewhere, and the record says so.
        expect(t.environmentId).toBe(E1);
        const info = await session(t.sessionId!).get();
        expect(info.spec).toMatchObject({ runtime: 'anthropic-api' });
        expect(info.spec?.machineId).toBeUndefined();
    });

    it('adopts a task the schedule trigger parked waiting {environment-offline} and resumes it on the hello (AST-05)', async () => {
        const { machineId: m1, d } = await offlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'queue' });
        await createTask('t1', a, { origin: { kind: 'schedule', scheduleId: 'sch_1' } });
        await task('t1').reportWaiting({ kind: 'environment-offline', environmentId: E1, policy: 'queue' }, 'schedule:sch_1');
        const probe = createEnvironmentProbe({ machines: () => Machine });
        expect(await probe.isOnline(WS, E1)).toBe(false);
        expect(await probe.isOnline(WS, 'env_nowhere' as EnvironmentId)).toBe(false);

        const adopted = await routing().run('t1' as TaskId);
        expect(adopted.status).toBe('waiting');
        expect(edges(adopted)).toEqual(['queued>waiting']); // no second waiting transition for the same reason
        expect((await routing().get()).routes[0]).toMatchObject({ taskId: 't1', status: 'waiting-offline', machineId: m1 });

        connect(m1, d);
        await online(m1);
        expect(await probe.isOnline(WS, E1)).toBe(true);
        await settled('t1');
        const t = await task('t1').get();
        expect(t.status).toBe('completed');
        expect(edges(t)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
    });

    it('never falls back when the policy does not say so, even though the API runtime is available', async () => {
        await offlineMachine();
        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'queue' });
        await createTask('t1', a);
        await routing().run('t1' as TaskId);
        await new Promise((r) => setTimeout(r, 50));
        const t = await task('t1').get();
        expect(t.status).toBe('waiting');
        expect(t.sessionId).toBeUndefined();
        expect(edges(t)).toEqual(['queued>waiting']);
    });
});

describe('multi-account environments on one machine (EXE-04/05/07, AC-02)', () => {
    const E2 = 'env_2' as EnvironmentId;
    const E3 = 'env_3' as EnvironmentId;
    /** One account per environment, isolated by its own config dir, with the daemon's doctor verdict as `hello` carries it. */
    const profile = (m: MachineId, id: EnvironmentId, label: string, identity: string, verdict: { ok: boolean; code: string; level: 'error' | 'info' } = { ok: true, code: 'auth-ok', level: 'info' }) => ({
        ...inMemoryEnvironment(m, id),
        name: label,
        account: { label, authStatus: 'ok' as const, identity },
        isolation: 'config-dir' as const,
        doctor: { ok: verdict.ok, findings: [{ level: verdict.level, code: verdict.code, message: `${label}: ${verdict.code}`, environmentIds: [id] }], checkedAt: 1 }
    });
    const picks: [string, EnvironmentId][] = [
        ['t1', E1],
        ['t2', E2],
        ['t3', E3]
    ];

    it('three accounts are each selectable, every session opens on the environment its task chose, and no run changes another account', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1, [profile(m1, E1, 'work', 'me@work.example'), profile(m1, E2, 'personal', 'me@home.example'), profile(m1, E3, 'client', 'me@client.example')]));
        await online(m1);
        const before = (await machine(m1).get()).environments;
        expect(before.map((e) => e.account.identity)).toEqual(['me@work.example', 'me@home.example', 'me@client.example']);

        const a = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        // One first, then two at once on the same machine (#106): each run must leave the others' accounts untouched.
        for (const [id, environmentId] of picks) await createTask(id, a, { environmentId });
        await routing().run('t1' as TaskId);
        await settled('t1');
        await routing().run('t2' as TaskId);
        await routing().run('t3' as TaskId);
        await Promise.all([settled('t2'), settled('t3')]);

        const opens = sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'session.open') as unknown as { sessionId: string; environmentId: string }[];
        expect(opens).toHaveLength(3);
        for (const [id, environmentId] of picks) {
            const t = await task(id).get();
            expect(t.status).toBe('completed');
            expect((await session(t.sessionId!).get()).spec).toMatchObject({ environmentId, machineId: m1 });
            // The daemon was told exactly that environment for this session — the account is chosen by the task, never switched (EXE-12).
            expect(opens.filter((o) => o.sessionId === t.sessionId).map((o) => o.environmentId)).toEqual([environmentId]);
        }

        // Execution changed no environment's account or verdict: what the machine reports is what it reported before (EXE-05).
        const after = (await machine(m1).get()).environments;
        expect(after.map((e) => ({ id: e.id, account: e.account, isolation: e.isolation, doctor: e.doctor }))).toEqual(before.map((e) => ({ id: e.id, account: e.account, isolation: e.isolation, doctor: e.doctor })));

        const verdicts = await machine(m1).doctor();
        expect(verdicts).toMatchObject({ machineId: m1, online: true, ok: true, unverified: [] });
        expect(verdicts.environments.map((e) => [e.environmentId, e.account.identity, e.isolation, e.verdict?.ok])).toEqual([
            [E1, 'me@work.example', 'config-dir', true],
            [E2, 'me@home.example', 'config-dir', true],
            [E3, 'me@client.example', 'config-dir', true]
        ]);
        expect((await machine(m1).doctor(E2)).environments.map((e) => e.environmentId)).toEqual([E2]);
        expect(await statusOf(machine(m1).doctor('env_nope' as EnvironmentId))).toBe(404);
    });

    it('two accounts on one config dir are reported by the machine, never tolerated as ok', async () => {
        const m1 = await pairMachine('laptop');
        const shared = { ok: false, code: 'shared-config-dir', level: 'error' as const };
        const { doctor: _none, ...unverified } = profile(m1, E3, 'client', 'me@client.example');
        connect(m1, daemon(m1, [profile(m1, E1, 'work', 'me@work.example', shared), profile(m1, E2, 'work-again', 'me@work.example', shared), unverified]));
        await online(m1);
        const verdicts = await machine(m1).doctor();
        expect(verdicts.ok).toBe(false);
        expect(verdicts.unverified).toEqual([E3]);
        expect(verdicts.environments.map((e) => [e.environmentId, e.verdict?.ok, e.verdict?.findings[0]?.code])).toEqual([
            [E1, false, 'shared-config-dir'],
            [E2, false, 'shared-config-dir'],
            [E3, undefined, undefined]
        ]);
    });
});
