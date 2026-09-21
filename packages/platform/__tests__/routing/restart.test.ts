/**
 * A daemon restart mid-turn (#420; OPS-04, OPS-05, OPS-06, EXE-12, CHT-09): the restarted daemon answers the
 * platform's `wanted` with `session.closed`, the Machine tells the Session (`hostEnded`) before the router, and the
 * turn is interrupted — never stranded `running`. `Routing.resume` re-opens the same session on the same machine with
 * the recorded ref as `spec.resume`, and a new message to the member does the same. The in-process host of
 * `reuse.test.ts`: Routing + Task + Agent + Session + Chat + Machine with in-memory daemons. The in-memory daemon
 * ignores `spec.resume` (#363) and never answers `wanted` for a session it does not run, so the tests read the
 * `session.open` frames the Machine sent and play the daemon's `session.closed` themselves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type Principal, type PromptPart, type RuntimeId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { Chat } from '../../src/chat/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort, type ToolCallPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, isInterruptedTurnEnd, type CommandSink } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

/** A fake socket layer bridged to `InMemoryDaemon` seats; a `session.open` for a session in `swallow` never reaches the daemon. */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    readonly swallow = new Set<string>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        const frame = JSON.parse(text) as { t: string; sessionId?: string };
        if (!(frame.t === 'session.open' && frame.sessionId !== undefined && this.swallow.has(frame.sessionId))) this.seats.get(key)?.send(frame as never);
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

/** The tools the daemon's runtime calls: `hold` never answers — the turn stays running until the daemon goes away. */
const tools: ToolCallPort = { call: () => new Promise(() => undefined) };

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools });
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
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));

async function agent(id: string, runtime: RuntimeId): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { offlinePolicy: 'fail', runtime, defaultEnvironmentId: E1 } }, 'create');
    return agentId;
}

async function room(...members: AgentId[]): Promise<ChatId> {
    const { chatId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({ title: 'Room' });
    for (const m of members) await chat(chatId).addAgent(m, 'all');
    return chatId;
}

/** Post the message and run the task it activates for `assignee` — what the browser's `runActivation` does. */
async function message(chatId: ChatId, assignee: AgentId, text: string, id: string, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    const { messageId } = await chat(chatId).post(text, [assignee]);
    const context: PromptPart[] = [{ type: 'text', text: `Chat so far:\nYou: ${text}` }];
    await task(id).create({ objective: text, origin: { kind: 'user', chatId, messageId: messageId as MessageId }, assignee, context, constraints: {}, ...extra }, { owner: assignee });
    return routing().run(id as TaskId);
}

async function pairMachine(name: string): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    return machineId;
}

/** A daemon whose turns call `hold` first (`holding`), or run straight through. */
function daemon(machineId: MachineId, holding: boolean): InMemoryDaemon {
    const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000, ...(holding ? { tool: { name: 'hold', input: {} } } : {}) }) as InMemoryDaemon;
    daemons.push(d);
    return d;
}

/** Connect `d` as the machine's socket; `unnamed` drops its `session.ref` frames — a runtime that never names its session. */
function connect(machineId: MachineId, d: InMemoryDaemon, unnamed = false): PlatformSeat {
    const key = machineKey(WS, machineId);
    const ids = parseMachineKey(key)!;
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(ids.machineId, asMachine(ids.machineId));
    void (async () => {
        try {
            for (;;) {
                const text = (await seat.next()) as string;
                if (unnamed && (JSON.parse(text) as { t: string }).t === 'session.ref') continue;
                await asDaemon.socketMessage(text);
            }
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
const frames = (machineId: MachineId, t: string) => sockets.frames(machineKey(WS, machineId)).filter((f) => f.t === t);
const opens = (machineId: MachineId, sessionId: string) => frames(machineId, 'session.open').filter((f) => f.sessionId === sessionId) as { sessionId: string; spec: { resume?: unknown } }[];
const promptText = (input: readonly PromptPart[]): string => input.map((p) => (p.type === 'text' ? p.text : `<${p.type}>`)).join('\n');
const sentPrompts = (machineId: MachineId, sessionId: string): { turnId: string; text: string }[] =>
    frames(machineId, 'session.command')
        .filter((f) => f.sessionId === sessionId && (f.command as { type: string }).type === 'prompt')
        .map((f) => {
            const command = f.command as { turnId: string; input: PromptPart[] };
            return { turnId: command.turnId, text: promptText(command.input) };
        });
const statusRefs = async (chatId: ChatId) =>
    (await chat(chatId).history(null, 50)).entries
        .map((e) => e.entry)
        .filter((e) => e.t === 'status')
        .map((e) => `${(e as { kind: string }).kind}:${(e as { ref?: string }).ref ?? ''}`);

/**
 * A chat member's turn running on a daemon, then the daemon restarted under it: stopped, a fresh one connected, and
 * its word for the session the platform wanted — `session.closed`. Returns the ids and the ref the runtime named.
 */
async function restartedMidTurn(unnamed = false) {
    const m1 = await pairMachine('laptop');
    connect(m1, daemon(m1, true), unnamed);
    await online(m1);
    const cc = await agent('agent_cc', 'in-memory');
    const chatId = await room(cc);
    const first = await message(chatId, cc, 'one', 't1');
    const sid = first.sessionId!;
    await until(async () => {
        const info = await session(sid).get();
        return !!info.running && (unnamed || !!info.ref);
    }, 'the turn to run on the daemon');
    const ref = (await session(sid).get()).ref;

    daemons[0]!.stop();
    await online(m1, false);
    connect(m1, daemon(m1, false));
    await online(m1);
    expect(await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: sid, reason: 'no longer running on this machine (daemon restarted)' }))).toMatchObject({ ok: true });
    await until(async () => (await machine(m1).get()).activeSessions.length === 0, 'the machine to forget the session');
    return { m1, cc, chatId, sid, ref };
}

describe('a daemon restart mid-turn (#420)', () => {
    it('interrupts the turn — never strands it running: the task waits for resume, the route is interrupted, the session idle with its ref, the chat told', async () => {
        const { chatId, sid, ref } = await restartedMidTurn();
        const turnId = 't1:turn:1';
        await until(async () => (await task('t1').get()).status === 'waiting', 'the task to wait');
        expect((await task('t1').get()).wait).toEqual({ kind: 'input', requestId: `resume:${turnId}`, sessionId: sid });
        await until(async () => (await routing().get()).routes.some((r) => r.taskId === 't1' && r.status === 'interrupted'), 'the route to park interrupted');
        const info = await session(sid).get();
        expect(info).toMatchObject({ status: 'idle', opened: true, ref });
        expect(info.running).toBeUndefined();
        const end = (await session(sid).events()).at(-1)!;
        expect(isInterruptedTurnEnd(end)).toBe(true);
        expect(end).toMatchObject({ turnId, error: { message: 'interrupted: no longer running on this machine (daemon restarted)' } });
        await until(async () => (await statusRefs(chatId)).includes(`task:interrupted:${turnId}`), 'the chat to hear the interruption');
        // Still the member's session: nothing ended it.
        expect((await chat(chatId).get()).sessions['agent_cc']?.sessionId).toBe(sid);
        expect((await statusRefs(chatId)).some((s) => s.startsWith('session-ended'))).toBe(false);
    });

    it('Routing.resume re-opens the same session on the same machine with the recorded ref as spec.resume, prompts the cut turn and completes', async () => {
        const { m1, sid, ref } = await restartedMidTurn();
        await until(async () => (await routing().get()).routes.some((r) => r.taskId === 't1' && r.status === 'interrupted'), 'the route to park interrupted');
        expect(opens(m1, sid)).toHaveLength(1);

        await routing().resume('t1' as TaskId);
        await settled('t1');
        expect(await task('t1').get()).toMatchObject({ status: 'completed', sessionId: sid });
        const reopened = opens(m1, sid);
        expect(reopened).toHaveLength(2);
        expect(reopened[1]!.spec.resume).toEqual(ref);
        // The cut turn's input, once, as the resume turn.
        expect(sentPrompts(m1, sid)).toEqual([
            { turnId: 't1:turn:1', text: 'one\nChat so far:\nYou: one' },
            { turnId: 't1:turn:1:resume', text: 'one\nChat so far:\nYou: one' }
        ]);
        expect((await machine(m1).get()).activeSessions.map((h) => h.sessionId)).toEqual([sid]);
        expect((await routing().get()).routes).toEqual([]);
    });

    it('a new message to the member re-opens the session with resume and runs — never parked on the dead turn, never steered into it', async () => {
        const { m1, chatId, cc, sid, ref } = await restartedMidTurn();
        await until(async () => (await routing().get()).routes.some((r) => r.taskId === 't1' && r.status === 'interrupted'), 'the route to park interrupted');

        const second = await message(chatId, cc, 'two', 't2');
        expect(second.sessionId).toBe(sid);
        await settled('t2');
        expect(await task('t2').get()).toMatchObject({ status: 'completed', sessionId: sid });
        const reopened = opens(m1, sid);
        expect(reopened).toHaveLength(2);
        expect(reopened[1]!.spec.resume).toEqual(ref);
        expect(sentPrompts(m1, sid).map((p) => p.turnId)).toEqual(['t1:turn:1', 't2:turn:1']);
        // The interrupted task still waits for its person.
        expect((await task('t1').get()).wait).toMatchObject({ kind: 'input', requestId: 'resume:t1:turn:1' });
    });

    it('a re-open the daemon refuses sends the task to a fresh session on the same machine, resuming from the lost session’s ref', async () => {
        const { m1, chatId, sid, ref } = await restartedMidTurn();
        await until(async () => (await routing().get()).routes.some((r) => r.taskId === 't1' && r.status === 'interrupted'), 'the route to park interrupted');
        sockets.swallow.add(sid);
        await routing().resume('t1' as TaskId);
        expect((await routing().get()).routes.find((r) => r.taskId === 't1')).toMatchObject({ status: 'interrupted', rehosting: true, sessionId: sid });
        // A second resume while the re-open is out changes nothing.
        await routing().resume('t1' as TaskId);
        expect(opens(m1, sid)).toHaveLength(2);

        await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: sid, reason: 'cannot resume' }));
        await settled('t1');
        const done = await task('t1').get();
        expect(done.status).toBe('completed');
        expect(done.sessionId).not.toBe(sid);
        const fresh = opens(m1, done.sessionId!);
        expect(fresh).toHaveLength(1);
        expect(fresh[0]!.spec.resume).toEqual(ref);
        expect(sentPrompts(m1, done.sessionId!)).toEqual([{ turnId: 't1:turn:1', text: 'one\nChat so far:\nYou: one' }]);
        await until(async () => (await chat(chatId).get()).sessions['agent_cc']?.sessionId === done.sessionId, 'the chat to bind the fresh session');
    });

    it('a session its runtime never named ends closed; Resume and the next message each start a fresh session', async () => {
        const { m1, chatId, cc, sid } = await restartedMidTurn(true);
        await until(async () => (await routing().get()).routes.some((r) => r.taskId === 't1' && r.status === 'interrupted'), 'the route to park interrupted');
        expect((await session(sid).get()).status).toBe('closed');
        expect((await task('t1').get()).wait).toMatchObject({ kind: 'input', requestId: 'resume:t1:turn:1' });

        await routing().resume('t1' as TaskId);
        await settled('t1');
        const resumed = await task('t1').get();
        expect(resumed.status).toBe('completed');
        expect(resumed.sessionId).not.toBe(sid);
        expect(opens(m1, resumed.sessionId!)[0]!.spec.resume).toBeUndefined();

        const next = await message(chatId, cc, 'two', 't2');
        await settled('t2');
        expect(next.sessionId).not.toBe(sid);
        expect(opens(m1, sid)).toHaveLength(1);
    });
});
