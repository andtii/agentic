/**
 * A message arriving mid-turn steers into the running turn (#395; CHT-09,
 * COL-06, OPS-06). The same in-process host as `reuse.test.ts`: Routing +
 * Task + Agent + Session + Chat + Machine with an in-memory daemon (which
 * cannot steer), and a `mockAgent` (which can) as the `anthropic-api`
 * runtime. Offline and deterministic: the mock's first turn is held open
 * until the test releases it, the daemon's by an `ask_user` it answers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type OfflinePolicy, type Principal, type PromptPart, type RuntimeId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { Chat } from '../../src/chat/index';
import { mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
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
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

/** A fake socket layer bridged to `InMemoryDaemon` seats (the routing test's). */
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
    frames(key: string): Record<string, unknown>[] {
        return (this.sent.get(key) ?? []).map((t) => JSON.parse(t) as Record<string, unknown>);
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const text = (input: readonly PromptPart[]): string => input.map((p) => (p.type === 'text' ? p.text : '')).join('');

/** The gate the mock's FIRST turn waits behind before it answers: `release()` lets it play. */
let held: Promise<void>;
let release: () => void;

/**
 * The `anthropic-api` runtime: its first turn waits behind `held`, then plays two steps (a steer is taken up between
 * them, in the same turn); every later turn echoes at once. A steer answers with its own line.
 */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: async (input, turn) => {
            if (turn === 0) await held;
            return [{ text: `echo: ${text(input)}` }, { text: ' [done]' }];
        },
        steer: (input) => [{ text: `steered: ${text(input)}\n` }]
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
    held = new Promise<void>((r) => {
        release = r;
    });
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: localFactory(scriptedAgent()), commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Chat]);
    await app.start();
});

afterEach(async () => {
    release();
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));
/** The router as the agent working `taskId` in `sessionId` — what `task_report` reaches it as. */
const asAgentOf = (agentId: AgentId, sessionId: string, taskId: string) => app.as(mintAgentPrincipal({ workspaceId: WS, agentId, sessionId: sessionId as SessionId, taskId: taskId as TaskId })).actor(Routing, routingKey(WS));

async function agent(id: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; offlinePolicy?: OfflinePolicy }, name = id): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name, instructions: 'Be brief.', tools: [{ name: 'task_report' }, { name: 'ask_user' }], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

/** A chat with `members` in it (every one reads all history). */
async function room(...members: AgentId[]): Promise<ChatId> {
    const { chatId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({ title: 'Room' });
    for (const m of members) await chat(chatId).addAgent(m, 'all');
    return chatId;
}

/** What `runActivation` does in the browser: post the message, create the task it activates for `assignee`, hand it to the router. */
async function message(chatId: ChatId, assignee: AgentId, text: string, id: string, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    const { messageId } = await chat(chatId).post(text, [assignee]);
    const context: PromptPart[] = [{ type: 'text', text: `Chat so far:\nYou: ${text}` }];
    await task(id).create({ objective: text, origin: { kind: 'user', chatId, messageId: messageId as MessageId }, assignee, context, constraints: {}, ...extra }, { owner: assignee });
    return routing().run(id as TaskId);
}

/** Register + pair a machine in the workspace, and connect its daemon. */
async function pairMachine(name: string): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    return machineId;
}

/** The in-memory daemon: every turn asks `ask_user` first and holds until it is answered — the hold this path's tests use. */
function daemon(machineId: MachineId): InMemoryDaemon {
    const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000, tool: { name: 'ask_user', input: { question: 'Go on?' } } }) as InMemoryDaemon;
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
        throw new Error(`${(e as Error).message}\n${JSON.stringify({ task: { status: t.status, wait: t.wait, sessionId: t.sessionId }, routes: r.routes, session: t.sessionId ? await session(t.sessionId).get() : undefined }, null, 1)}`);
    }
};
const running = (sessionId: string) => until(async () => (await session(sessionId).get()).running !== undefined, `session ${sessionId} to run a turn`);
const routeOf = async (taskId: string) => (await routing().get()).routes.find((r) => r.taskId === taskId);
const transitions = async (taskId: string) => (await task(taskId).get()).transitions.map((t) => ({ to: t.to, why: t.why, ...(t.wait ? { wait: t.wait } : {}) }));
/** The open `ask_user` question on the session, once the daemon's turn has asked it. */
const question = async (sessionId: string): Promise<string> => {
    await until(async () => (await session(sessionId).requests({ openOnly: true })).length === 1, `session ${sessionId} to ask`);
    return (await session(sessionId).requests({ openOnly: true }))[0]!.request.requestId;
};
const frames = (machineId: MachineId, t: string) => sockets.frames(machineKey(WS, machineId)).filter((f) => f.t === t);
const sentPrompts = (machineId: MachineId, sessionId: string) => frames(machineId, 'session.command').filter((f) => f.sessionId === sessionId && (f.command as { type: string }).type === 'prompt');

describe('a message arriving mid-turn — a runtime that steers (anthropic-api)', () => {
    it('is acked with the running turn’s id; both tasks settle at that turn’s end, each with its own record', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const chatId = await room(atlas);
        const first = await message(chatId, atlas, 'first', 't1');
        const sid = first.sessionId!;
        await running(sid);
        expect(await routeOf('t1')).toMatchObject({ status: 'running', turnId: 't1:turn:1' });

        // The second message, while the first turn runs: sent into it, bound to it.
        const second = await message(chatId, atlas, 'second', 't2');
        expect(second.sessionId).toBe(sid);
        expect(second.status).toBe('active');
        expect(await routeOf('t2')).toMatchObject({ status: 'running', turnId: 't1:turn:1', joined: true });
        // The task record says so: it waited on the running turn and joined it.
        expect(await transitions('t2')).toEqual([
            { to: 'active', why: 'started' },
            { to: 'waiting', why: 'waiting: turn', wait: { kind: 'turn', sessionId: sid, turnId: 't1:turn:1' } },
            { to: 'active', why: 'joined running turn t1:turn:1' }
        ]);
        // Neither has settled: the turn is still held.
        expect((await task('t1').get()).status).toBe('active');

        release();
        await settled('t1');
        await settled('t2');
        // One turn in the log, carrying both messages; both tasks complete with what the turn said.
        const events = await session(sid).events();
        expect(events.filter((e) => e.type === 'turn-start')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'user-message')).toHaveLength(2);
        const t1 = await task('t1').get();
        const t2 = await task('t2').get();
        expect(t1).toMatchObject({ status: 'completed', sessionId: sid });
        expect(t2).toMatchObject({ status: 'completed', sessionId: sid });
        // The steer's line, then the turn's own answer: one turn's text, the second message taken up inside it.
        expect(t1.result?.text).toBe('steered: secondIn the chat since your last message:\nUser: first\n\necho: firstChat so far:\nYou: first\n [done]');
        expect(t2.result?.text).toBe(t1.result?.text);
        expect(t2.transitions.map((t) => t.to)).toEqual(['active', 'waiting', 'active', 'completed']);
        expect((await routing().get()).routes).toEqual([]);
        // The session lives on, idle.
        expect((await session(sid).get())).toMatchObject({ status: 'idle' });
        expect((await session(sid).get()).running).toBeUndefined();
    });

    it('a task_report during the shared turn is accepted from either task and is both tasks’ result', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const chatId = await room(atlas);
        const first = await message(chatId, atlas, 'first', 't1');
        const sid = first.sessionId!;
        await running(sid);
        await message(chatId, atlas, 'second', 't2');
        expect(await routeOf('t2')).toMatchObject({ joined: true });

        // The turn's task (`currentTaskId` stays the turn's) reports — on its own task, or on the one sharing the turn.
        await asAgentOf(atlas, sid, 't1').report('t1' as TaskId, { status: 'done', summary: 'both handled', output: { answer: 42 } });
        expect((await routing().get()).reports).toEqual({ t1: { status: 'done', summary: 'both handled', output: { answer: 42 } }, t2: { status: 'done', summary: 'both handled', output: { answer: 42 } } });
        expect(await statusOf(asAgentOf(atlas, sid, 't1').report('t2' as TaskId, { status: 'done', summary: 'for the second', output: { answer: 43 } }))).toBeUndefined();
        expect((await routing().get()).reports['t2']).toMatchObject({ output: { answer: 43 } });
        // A task that shares no turn is refused as before.
        expect(await statusOf(asAgentOf(atlas, sid, 't_other').report('t1' as TaskId, { status: 'done', summary: 'nope' }))).toBe(403);

        release();
        await settled('t1');
        await settled('t2');
        expect((await task('t1').get()).result?.output).toEqual({ answer: 43 });
        expect((await task('t2').get()).result?.output).toEqual({ answer: 43 });
    });

    it('cancelling the joined task does not cancel the turn it joined; the turn’s own task completes', async () => {
        const atlas = await agent('agent_atlas', { runtime: 'anthropic-api' }, 'Atlas');
        const chatId = await room(atlas);
        const first = await message(chatId, atlas, 'first', 't1');
        const sid = first.sessionId!;
        await running(sid);
        await message(chatId, atlas, 'second', 't2');
        expect(await routeOf('t2')).toMatchObject({ joined: true });

        const cancelled = task('t2').cancel('user:u1', { timeoutMs: 2_000 });
        release();
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(await cancelled).toMatchObject({ id: 't2', stopped: true, notStopped: [] });
        expect((await task('t2').get()).status).toBe('cancelled');
        // The session's turn was never cancelled: it ended on its own.
        const end = (await session(sid).events()).find((e) => e.type === 'turn-end');
        expect(end).toMatchObject({ stopReason: 'end_turn' });
        await until(async () => (await routing().get()).routes.length === 0, 'the routes to clear');
    });
});

describe('a message arriving mid-turn — a runtime that cannot steer (the in-memory daemon)', () => {
    it('parks the route waiting-turn with nothing sent, and runs it in its own turn when the running one ends', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'one', 't1');
        const sid = first.sessionId!;
        const q1 = await question(sid);
        expect((await session(sid).get()).running).toMatchObject({ turnId: 't1:turn:1' });

        // The second message while the daemon's turn runs: parked, not sent, not failed.
        const second = await message(chatId, cc, 'two', 't2');
        expect(second.sessionId).toBe(sid);
        expect(second).toMatchObject({ status: 'waiting', wait: { kind: 'turn', sessionId: sid, turnId: 't1:turn:1' } });
        expect(await routeOf('t2')).toMatchObject({ status: 'waiting-turn' });
        expect(sentPrompts(m1, sid)).toHaveLength(1);
        expect(frames(m1, 'session.open')).toHaveLength(1);

        // The first turn ends: the parked message goes out in a turn of its own, and both tasks keep their own record.
        await session(sid).respond(q1, { type: 'input', answers: 'yes' });
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        await until(async () => sentPrompts(m1, sid).length === 2, 'the parked prompt to go out');
        expect(await routeOf('t2')).toMatchObject({ status: 'running', turnId: 't2:turn:1' });
        expect((await routeOf('t2'))?.joined).toBeFalsy();
        const q2 = await question(sid);
        await session(sid).respond(q2, { type: 'input', answers: 'yes' });
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        expect(await transitions('t2')).toEqual([
            { to: 'active', why: 'started' },
            { to: 'waiting', why: 'waiting: turn', wait: { kind: 'turn', sessionId: sid, turnId: 't1:turn:1' } },
            { to: 'active', why: 'turn t1:turn:1 ended' },
            { to: 'waiting', why: 'waiting: input', wait: { kind: 'input', requestId: q2, sessionId: sid } },
            { to: 'active', why: `request ${q2}: input` },
            { to: 'completed', why: 'completed' }
        ]);
        expect((await session(sid).events()).filter((e) => e.type === 'turn-end')).toHaveLength(2);
        expect((await routing().get()).routes).toEqual([]);
    });

    it('a session the daemon closes while a message waits for its turn fails that task with the reason', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1));
        await online(m1);
        const cc = await agent('agent_cc', { runtime: 'in-memory', defaultEnvironmentId: E1 });
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'one', 't1');
        const sid = first.sessionId!;
        await question(sid);
        await message(chatId, cc, 'two', 't2');
        expect(await routeOf('t2')).toMatchObject({ status: 'waiting-turn' });

        expect(await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: sid, reason: 'restarted' }))).toMatchObject({ ok: true });
        await settled('t2');
        expect((await task('t2').get())).toMatchObject({ status: 'failed', error: { code: 'session-refused', message: `machine ${m1} closed the session while this task waited for its running turn to end: restarted`, recoverable: true } });
        expect(await routeOf('t2')).toBeUndefined();
    });
});
