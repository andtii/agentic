/**
 * A machine that goes away under running turns (#366; OPS-04, OPS-05, OPS-06, EXE-11, EXE-12, AC-15): the routes on it
 * wait `machine-offline` — distinct from `environment-offline` — and go on when it is back; past `MACHINE_LOST_MS` they
 * fail `machine-lost` (recoverable) and a chat member's session re-opens on the next message. `onInterrupt: 'auto'`
 * resumes an interrupted turn once on its own; a re-open the daemon refuses closes the record, so the member binds a
 * fresh session. Every interruption and resume is audited with its cause. The in-process host of `restart.test.ts`: the
 * in-memory daemon ignores `spec.resume` (#363), so the tests play the daemon's `session.closed` themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type Principal, type PromptPart, type RuntimeId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { drainingReply, isDrainingReply } from '@agentic/daemon-protocol';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';

import { AgentActor, agentKey } from '../../src/agent/index';
import { capturingAuditPort } from '../../src/audit/index';
import { Chat } from '../../src/chat/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort, type ToolCallPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRoutingActor, MACHINE_LOST_MS, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const TICK = 60_000;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

/**
 * A fake socket layer bridged to `InMemoryDaemon` seats; a `session.open` for a session in `swallow`, and a command whose
 * id is in `swallowCommands`, never reach the daemon.
 */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    readonly swallow = new Set<string>();
    readonly swallowCommands = new Set<string>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        const frame = JSON.parse(text) as { t: string; sessionId?: string; command?: { commandId: string } };
        const swallowed = (frame.t === 'session.open' && frame.sessionId !== undefined && this.swallow.has(frame.sessionId)) || (frame.t === 'session.command' && this.swallowCommands.has(frame.command!.commandId));
        if (!swallowed) this.seats.get(key)?.send(frame as never);
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

/** The daemon's `hold` tool: answered when the test releases it — the turn runs until then. */
let release: () => void = () => undefined;
let held: Promise<void> = new Promise(() => undefined);
const hold = (): void => {
    held = new Promise<void>((r) => (release = r));
};
const tools: ToolCallPort = {
    call: async () => {
        await held;
        return { released: true };
    }
};

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!(await check())) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let scheduler: ManualScheduler;
let audited: ReturnType<typeof capturingAuditPort>;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
/** With a manual scheduler and a fake `Date`, what keeps both — and the host's timers (the Session's change throttle, …) — moving at wall-clock pace. */
let pump: ReturnType<typeof setInterval> | undefined;

/** Build and start the host; `manual` puts the reminders (and every other timer of the host) on a manual scheduler. */
async function start(manual: boolean): Promise<void> {
    // Before the actors are built: each takes `Date.now` as its clock.
    if (manual) vi.useFakeTimers({ toFake: ['Date'] });
    sockets = new FakeSockets();
    audited = capturingAuditPort();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink, audit: audited });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, audit: audited });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools });
    const actors = [Routing, Session, Machine, TaskActor, AgentActor, Workspace, PairingDirectory, Chat];
    if (manual) {
        scheduler = manualScheduler();
        app = testActorApp(actors, { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
        pump = setInterval(() => {
            vi.setSystemTime(Date.now() + 5);
            scheduler.advance(5);
        }, 5);
    } else app = testActorApp(actors);
    await app.start();
}

beforeEach(async () => {
    hold();
    await start(false);
});

afterEach(async () => {
    release();
    for (const d of daemons.splice(0)) d.stop();
    if (pump) clearInterval(pump);
    pump = undefined;
    await app.stop();
    vi.useRealTimers();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));
const route = async (taskId: string) => (await routing().get()).routes.find((r) => r.taskId === taskId);

async function agent(id: string, runtime: RuntimeId, onInterrupt?: 'ask' | 'auto'): Promise<AgentId> {
    const agentId = id as AgentId;
    await app
        .as(owner)
        .actor(AgentActor, agentKey(WS, agentId))
        .update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { offlinePolicy: 'fail', runtime, defaultEnvironmentId: E1, ...(onInterrupt ? { onInterrupt } : {}) } }, 'create');
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

/** Connect `d` as the machine's socket, until the seat drops — then `socketClosed`, as the host does. */
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
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
const opens = (machineId: MachineId, sessionId: string) => sockets.frames(machineKey(WS, machineId)).filter((f) => f.t === 'session.open' && f.sessionId === sessionId) as { sessionId: string; spec: { resume?: unknown } }[];
const statusRefs = async (chatId: ChatId) =>
    (await chat(chatId).history(null, 50)).entries
        .map((e) => e.entry)
        .filter((e) => e.t === 'status')
        .map((e) => `${(e as { kind: string }).kind}:${(e as { ref?: string }).ref ?? ''}`);
const ofKind = (kind: string) => audited.events.filter((e) => e.kind === kind);

/** Move the clock on by `ms`, then one reminder tick: the host's other timers see a minute, not a day. */
const advance = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    scheduler.advance(TICK);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A chat member's turn running on a daemon that holds it: the ids, the daemon and its seat. */
async function running(onInterrupt?: 'ask' | 'auto') {
    const m1 = await pairMachine('laptop');
    const d = daemon(m1, true);
    const seat = connect(m1, d);
    await online(m1);
    const cc = await agent('agent_cc', 'in-memory', onInterrupt);
    const chatId = await room(cc);
    const first = await message(chatId, cc, 'one', 't1');
    const sid = first.sessionId!;
    await until(async () => {
        const info = await session(sid).get();
        return !!info.running && !!info.ref;
    }, 'the turn to run on the daemon');
    return { m1, d, seat, cc, chatId, sid, ref: (await session(sid).get()).ref };
}

/** The daemon restarted under the turn: stopped, a fresh one (`holding` or not) connected, and its `session.closed {code}` for the session it lost. */
async function restart(m1: MachineId, sid: string, holding: boolean): Promise<void> {
    daemons.at(-1)!.stop();
    await online(m1, false);
    connect(m1, daemon(m1, holding));
    await online(m1);
    await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: sid, reason: 'no longer running on this machine (daemon restarted)', code: 'restart' }));
}

describe('a machine offline under a running turn (#366)', () => {
    it('parks the task machine-offline — not environment-offline — and the turn goes on when the machine is back', async () => {
        const { m1, d, seat, sid } = await running();
        seat.drop();
        await online(m1, false);
        await until(async () => (await task('t1').get()).status === 'waiting', 'the task to wait on the machine');
        const t = await task('t1').get();
        expect(t.wait).toMatchObject({ kind: 'machine-offline', machineId: m1 });
        expect(typeof (t.wait as { since?: unknown }).since).toBe('number');
        expect(await route('t1')).toMatchObject({ status: 'running', offlineSince: (t.wait as { since: number }).since });

        // The same daemon dials again: its session still runs, the wanted replay goes on.
        connect(m1, d);
        await online(m1);
        await until(async () => (await task('t1').get()).status === 'active', 'the task to go on');
        expect((await route('t1'))?.offlineSince).toBeUndefined();
        release();
        await settled('t1');
        expect(await task('t1').get()).toMatchObject({ status: 'completed', sessionId: sid });
        expect(ofKind('session.interrupted')).toEqual([]);
        expect(ofKind('task.machine-lost')).toEqual([]);
    });

    it('past MACHINE_LOST_MS the task fails machine-lost (recoverable), audited, the chat told — and the member’s session re-opens on the next message', async () => {
        await app.stop();
        await start(true);
        const { m1, cc, chatId, seat, sid, ref } = await running();
        seat.drop();
        await online(m1, false);
        await until(async () => (await task('t1').get()).wait?.kind === 'machine-offline', 'the task to wait on the machine');
        const since = (await route('t1'))!.offlineSince!;

        await advance(MACHINE_LOST_MS - TICK);
        expect((await task('t1').get()).status).toBe('waiting');
        await advance(2 * TICK);
        await settled('t1');
        expect((await task('t1').get()).error).toMatchObject({ code: 'machine-lost', recoverable: true });
        expect(await route('t1')).toBeUndefined();
        expect(ofKind('task.machine-lost')).toEqual([expect.objectContaining({ taskId: 't1', by: 'system:routing', data: { taskId: 't1', machineId: m1, since } })]);
        await until(async () => (await statusRefs(chatId)).includes('task-failed:t1'), 'the chat to hear the failure');
        // The machine let go of the session: the record's turn was interrupted, and it waits idle with its ref.
        await until(async () => (await session(sid).get()).status === 'idle', 'the record to wait idle');
        expect(await session(sid).get()).toMatchObject({ status: 'idle', ref });
        expect((await machine(m1).get()).activeSessions).toEqual([]);
        expect((await chat(chatId).get()).sessions['agent_cc']?.sessionId).toBe(sid);

        // The machine is back (a fresh daemon): the next message re-opens the same session with its ref.
        daemons[0]!.stop();
        connect(m1, daemon(m1, false));
        await online(m1);
        const next = await message(chatId, cc, 'two', 't2');
        expect(next.sessionId).toBe(sid);
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        expect(opens(m1, sid).at(-1)!.spec.resume).toEqual(ref);
    }, 20_000);
});

describe('onInterrupt (#366)', () => {
    it('auto: an interrupted turn is resumed once on its own on the machine that is back; a second interruption of the same turn waits for a person', async () => {
        const { m1, sid } = await running('auto');
        await restart(m1, sid, true);
        // Resumed without anyone asking: re-opened on the machine, the cut turn prompted again.
        await until(async () => (await route('t1'))?.turnId === 't1:turn:1:resume' && (await route('t1'))?.status === 'running', 'the turn to resume on its own');
        expect(ofKind('session.interrupted')).toEqual([expect.objectContaining({ sessionId: sid, taskId: 't1', data: { sessionId: sid, taskId: 't1', turnId: 't1:turn:1', host: 'restart' } })]);
        await until(() => ofKind('session.resumed').length === 1, 'the resume to be audited');
        expect(ofKind('session.resumed')[0]).toMatchObject({ by: 'system:routing', data: { sessionId: sid, taskId: 't1', how: 're-host', by: 'system:routing' } });

        // Interrupted again, the same turn: this time it waits for a person.
        await until(async () => !!(await session(sid).get()).running, 'the resumed turn to run');
        await restart(m1, sid, false);
        await until(async () => (await route('t1'))?.status === 'interrupted', 'the route to park interrupted');
        await until(() => ofKind('session.interrupted').length === 2, 'the second interruption to be audited');
        expect(ofKind('session.interrupted')[1]).toMatchObject({ data: { turnId: 't1:turn:1:resume', host: 'restart' } });
        expect((await task('t1').get()).wait).toMatchObject({ kind: 'input', requestId: 'resume:t1:turn:1:resume' });
        await new Promise((r) => setTimeout(r, 50));
        expect(await route('t1')).toMatchObject({ status: 'interrupted', autoResumed: 't1:turn:1' });
        expect(ofKind('session.resumed')).toHaveLength(1);

        // A person's Resume still works, and says who asked.
        await routing().resume('t1' as TaskId);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(ofKind('session.resumed')[1]).toMatchObject({ by: 'user:u1', data: { how: 're-host', by: 'user:u1' } });
    });

    it('ask (the default): the interrupted turn waits for a person', async () => {
        const { m1, sid } = await running();
        await restart(m1, sid, false);
        await until(async () => (await route('t1'))?.status === 'interrupted', 'the route to park interrupted');
        await new Promise((r) => setTimeout(r, 50));
        expect(await route('t1')).toMatchObject({ status: 'interrupted' });
        expect((await task('t1').get()).wait).toMatchObject({ kind: 'input', requestId: 'resume:t1:turn:1' });
        expect(ofKind('session.resumed')).toEqual([]);
    });
});

describe('a re-open the daemon refuses (#366, carried over from #420)', () => {
    it('from a message: the record is closed (resume-failed), that task fails, and the member’s next message binds a fresh session', async () => {
        const { m1, cc, chatId, sid } = await running();
        await restart(m1, sid, false);
        await until(async () => (await route('t1'))?.status === 'interrupted', 'the route to park interrupted');

        sockets.swallow.add(sid);
        const second = await message(chatId, cc, 'two', 't2');
        expect(second.sessionId).toBe(sid);
        expect(opens(m1, sid)).toHaveLength(2);
        await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: sid, reason: 'cannot resume', code: 'resume-failed' }));
        await settled('t2');
        expect((await task('t2').get()).error).toMatchObject({ code: 'session-refused', recoverable: true });
        expect((await session(sid).get()).status).toBe('closed');
        await until(async () => (await chat(chatId).get()).sessions['agent_cc'] === undefined, 'the chat to drop the refused session');

        const third = await message(chatId, cc, 'three', 't3');
        expect(third.sessionId).not.toBe(sid);
        await settled('t3');
        expect((await task('t3').get()).status).toBe('completed');
        await until(async () => (await chat(chatId).get()).sessions['agent_cc']?.sessionId === third.sessionId, 'the chat to bind the fresh session');
        expect(opens(m1, sid)).toHaveLength(2);
    });

    it('from Resume: the record is closed, the task goes on in a fresh session the chat binds, audited fresh', async () => {
        const { m1, chatId, sid, ref } = await running();
        await restart(m1, sid, false);
        await until(async () => (await route('t1'))?.status === 'interrupted', 'the route to park interrupted');
        sockets.swallow.add(sid);
        await routing().resume('t1' as TaskId);
        // Any close while the re-open is out: the ref it was re-opened from is refused.
        await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: sid, reason: 'cannot resume' }));
        await settled('t1');
        const done = await task('t1').get();
        expect(done.status).toBe('completed');
        expect(done.sessionId).not.toBe(sid);
        expect(opens(m1, done.sessionId!)[0]!.spec.resume).toEqual(ref);
        expect((await session(sid).get()).status).toBe('closed');
        await until(async () => (await chat(chatId).get()).sessions['agent_cc']?.sessionId === done.sessionId, 'the chat to bind the fresh session');
        expect(ofKind('session.resumed')).toEqual([expect.objectContaining({ by: 'user:u1', data: { sessionId: done.sessionId, taskId: 't1', how: 'fresh', by: 'user:u1' } })]);
    });
});

describe('a daemon draining (#366, #360)', () => {
    it('a prompt the draining daemon refuses parks the route as busy does — never fails the task — and goes out again when a slot frees', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1, false));
        await online(m1);
        const cc = await agent('agent_cc', 'in-memory');
        const chatId = await room(cc);
        await message(chatId, cc, 'one', 't1');
        await settled('t1');

        // The daemon drains: the prompt never runs, its reply is the refusal.
        sockets.swallowCommands.add('t2:turn:1');
        const second = await message(chatId, cc, 'two', 't2');
        const sid = second.sessionId!;
        await until(async () => (await route('t2'))?.status === 'running', 'the prompt to go out');
        sockets.swallowCommands.clear();
        // The daemon's refusal while it drains before an update (#360): the wire's `busy`, with a `draining:` message.
        const refusal = drainingReply('t2:turn:1');
        expect(isDrainingReply(refusal)).toBe(true);
        await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.reply', sessionId: sid, reply: refusal }));
        await until(async () => (await route('t2'))?.status === 'waiting-capacity', 'the route to park');
        expect(await route('t2')).toMatchObject({ status: 'waiting-capacity', attempt: 1 });
        const t = await task('t2').get();
        expect(t.status).toBe('waiting');
        expect(t.wait).toMatchObject({ kind: 'capacity', environmentId: E1 });

        // A slot frees there (a turn ended): the prompt goes out again under a fresh command id and the turn runs.
        await app.as(asMachine(m1)).actor(Routing, routingKey(WS)).slotFreed(m1, E1, 'a turn ended');
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
        const prompts = sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'session.command' && f.sessionId === sid && (f.command as { type: string }).type === 'prompt');
        expect(prompts.map((f) => (f.command as { commandId: string }).commandId)).toEqual(['t1:turn:1', 't2:turn:1', 't2:turn:1#1']);
    });
});

describe('a message parked on a live session across a daemon restart or update (#433)', () => {
    const closed = (m1: MachineId, sessionId: string, code: string, reason = 'the daemon is going away') => machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId, reason, code }));

    it('waiting-capacity across code update: re-opened in the same session with its ref once the daemon is back, and delivered', async () => {
        const m1 = await pairMachine('laptop');
        connect(m1, daemon(m1, false));
        await online(m1);
        const cc = await agent('agent_cc', 'in-memory');
        const chatId = await room(cc);
        // The machine drains for an update: the member's session opens, its prompt is refused and the message parks.
        sockets.swallowCommands.add('t1:turn:1');
        const sid = (await message(chatId, cc, 'one', 't1')).sessionId!;
        await until(async () => (await route('t1'))?.status === 'running', 'the prompt to go out');
        sockets.swallowCommands.clear();
        await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.reply', sessionId: sid, reply: drainingReply('t1:turn:1') }));
        await until(async () => (await route('t1'))?.status === 'waiting-capacity', 'the message to park on capacity');
        // The runtime had named the session (the in-memory daemon names one only with a turn, #363).
        const ref = { agent: 'in-memory', v: 1, id: `${sid}.run` };
        await machine(m1, asMachine(m1)).socketMessage(JSON.stringify({ v: 1, t: 'session.ref', sessionId: sid, ref }));
        await until(async () => (await session(sid).get()).ref?.id === ref.id, 'the record to hold the ref');

        // The update: the daemon closes the session with code update and stops; a new one says hello.
        await closed(m1, sid, 'update');
        await until(async () => (await route('t1'))?.reopen === true, 'the router to keep the message for the re-open');
        expect(await route('t1')).toMatchObject({ status: 'waiting-capacity', reopen: true, sessionId: sid });
        expect((await task('t1').get()).status).toBe('waiting');
        expect(opens(m1, sid)).toHaveLength(1);
        daemons.at(-1)!.stop();
        await online(m1, false);
        connect(m1, daemon(m1, false));
        await online(m1);

        await settled('t1');
        expect(await task('t1').get()).toMatchObject({ status: 'completed', sessionId: sid });
        expect(opens(m1, sid)).toHaveLength(2);
        expect(opens(m1, sid)[1]!.spec.resume).toEqual(ref);
        expect((await chat(chatId).get()).sessions['agent_cc']?.sessionId).toBe(sid);
    });

    it('waiting-turn across code restart: re-opened in the same session with its ref, and delivered', async () => {
        const { m1, cc, chatId, sid, ref } = await running();
        await message(chatId, cc, 'two', 't2');
        await until(async () => (await route('t2'))?.status === 'waiting-turn', 'the message to wait for the running turn');

        await restart(m1, sid, false);
        await settled('t2');
        expect(await task('t2').get()).toMatchObject({ status: 'completed', sessionId: sid });
        expect(opens(m1, sid)).toHaveLength(2);
        expect(opens(m1, sid)[1]!.spec.resume).toEqual(ref);
        // The turn the restart cut waits for a person, as before.
        await until(async () => (await route('t1'))?.status === 'interrupted', 'the cut turn to park interrupted');
    });

    it('resume-failed still fails the parked route, recoverable', async () => {
        const { m1, cc, chatId, sid } = await running();
        await message(chatId, cc, 'two', 't2');
        await until(async () => (await route('t2'))?.status === 'waiting-turn', 'the message to wait for the running turn');
        await closed(m1, sid, 'resume-failed', 'cannot resume');
        await settled('t2');
        expect((await task('t2').get()).error).toMatchObject({ code: 'session-refused', recoverable: true });
        expect((await session(sid).get()).status).toBe('closed');
    });
});
