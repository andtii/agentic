/**
 * Capacity counts running turns, not open sessions (#394; EXE-03, EXE-09,
 * EXE-11). The same in-process host as `reuse.test.ts` — Routing + Task +
 * Agent + Session + Chat + Machine with an in-memory daemon — whose scripted
 * tool call is held by the test, so a turn runs for exactly as long as the
 * test wants and every "the other member's turn is in the way" case is
 * deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type Principal, type PromptPart, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import type { AgentEvent } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION } from '@sigx/ai-agent/wire';

import { AgentActor, agentKey } from '../../src/agent/index';
import { Chat } from '../../src/chat/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, freeSlots, isIdle, machineKey, parseMachineKey, runningIn, ToolCallError, type MachineSocketPort, type ToolCallPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type CommandSink } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

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

/** The daemon's one scripted tool, `hold`: its turn waits here until the test lets go. */
let hold: Promise<void> | undefined;
const holdTurns = (): (() => void) => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    return () => {
        hold = undefined;
        release();
    };
};
const tools: ToolCallPort = {
    async call(input) {
        if (input.tool !== 'hold') throw new ToolCallError('unsupported', `no tool ${input.tool}`);
        if (hold) await hold;
        return { held: true };
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let Session: ReturnType<typeof defineSessionActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const daemons: InMemoryDaemon[] = [];
beforeEach(async () => {
    hold = undefined;
    sockets = new FakeSockets();
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink });
    // Any implicit turn left empty is stale at once for the re-check (#605); nothing here fires the reminder on its own.
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, ghostTurnMs: 0 });
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

async function agent(id: string): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } }, 'create');
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

/** Register + pair a machine in the workspace, and connect its daemon: one environment, one turn at a time, its turns held by `hold`. */
async function pairMachine(name: string): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    const d = inMemoryHarness({ machineId, environments: [{ ...inMemoryEnvironment(machineId, E1), concurrency: { max: 1, active: 0 } }] }).start({ events: 3, heartbeatMs: 600_000, tool: { name: 'hold', input: {} } }) as InMemoryDaemon;
    daemons.push(d);
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
    })();
    await until(async () => (await machine(machineId).get()).online, `${machineId} online`);
    return machineId;
}

const settled = async (id: string) => {
    try {
        await until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
    } catch (e) {
        const t = await task(id).get();
        const r = await routing().get();
        throw new Error(`${(e as Error).message}\n${JSON.stringify({ task: { status: t.status, wait: t.wait, sessionId: t.sessionId, transitions: t.transitions }, routes: r.routes, machine: t.sessionId ? undefined : undefined }, null, 1)}`);
    }
};
const running = (id: string) => until(async () => (await routing().get()).routes.find((r) => r.taskId === id)?.status === 'running', `task ${id} running`);
const edges = (t: TaskView) => t.transitions.map((x) => `${x.from}>${x.to}`);
const frames = (machineId: MachineId, t: string) => sockets.frames(machineKey(WS, machineId)).filter((f) => f.t === t);
const closes = (machineId: MachineId) => frames(machineId, 'session.command').filter((f) => (f.command as { type: string }).type === 'close').length + frames(machineId, 'session.close').length;
const hosted = async (machineId: MachineId) => (await machine(machineId).get()).activeSessions;

describe('capacity counts running turns, not open sessions (#394)', () => {
    it("two members of one chat hold live sessions in a concurrency-1 environment; the second's open queues behind the first's turn and is woken by that turn ending, not by a close", async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const dev = await agent('agent_dev');
        const chatId = await room(cc, dev);

        const release = holdTurns();
        const a = await message(chatId, cc, 'plan it', 't_cc');
        await running('t_cc');
        // The one slot is the running turn's: the second member's open queues, visibly, at position 1.
        const b = await message(chatId, dev, 'build it', 't_dev');
        expect(b.status).toBe('waiting');
        expect(b.wait).toEqual({ kind: 'capacity', environmentId: E1, position: 1 });
        expect((await routing().get()).routes.find((r) => r.taskId === 't_dev')).toMatchObject({ status: 'waiting-capacity', sessionId: b.sessionId });
        expect((await machine(m1).get()).queued.map((q) => q.sessionId)).toEqual([b.sessionId]);
        expect(a.sessionId).not.toBe(b.sessionId);

        // The first turn ends. Nothing closes; the queued open goes out, the session opens, the parked task runs.
        release();
        await settled('t_cc');
        await settled('t_dev');
        expect((await task('t_dev').get()).status).toBe('completed');
        const t2 = await task('t_dev').get();
        expect(edges(t2)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
        expect(t2.transitions[1]!.why).toMatch(/slot freed in environment env_1; session opened/);
        expect(closes(m1)).toBe(0);
        expect((await hosted(m1)).map((h) => h.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
        for (const sid of [a.sessionId!, b.sessionId!]) expect((await session(sid).get()).status).not.toBe('closed');
        expect((await machine(m1).get()).queued).toEqual([]);
        expect(frames(m1, 'session.open')).toHaveLength(2);
    });

    it("a prompt on a live session waits for the other member's turn to end — parked waiting-capacity, woken by slotFreed — and idle sessions never block a delegated child", async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const dev = await agent('agent_dev');
        const chatId = await room(cc, dev);
        const a = await message(chatId, cc, 'plan it', 't_cc');
        await settled('t_cc');
        const b = await message(chatId, dev, 'build it', 't_dev');
        await settled('t_dev');
        expect((await hosted(m1)).map((h) => h.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());

        // Both sessions live and idle. The coordinator's next message takes the slot; the member's reuses its session but must wait.
        const release = holdTurns();
        const c = await message(chatId, cc, 'again', 't_cc2');
        expect(c.sessionId).toBe(a.sessionId);
        await running('t_cc2');
        const d = await message(chatId, dev, 'me too', 't_dev2');
        expect(d.sessionId).toBe(b.sessionId);
        expect(d.status).toBe('waiting');
        expect(d.wait).toEqual({ kind: 'capacity', environmentId: E1, position: 1 });
        expect((await routing().get()).routes.find((r) => r.taskId === 't_dev2')?.status).toBe('waiting-capacity');
        // Nothing was queued on the machine (the session is open) and no prompt went out for it.
        expect((await machine(m1).get()).queued).toEqual([]);
        expect(frames(m1, 'session.command').filter((f) => f.sessionId === b.sessionId && (f.command as { type: string }).type === 'prompt')).toHaveLength(1);
        expect(frames(m1, 'session.open')).toHaveLength(2);

        // The turn in the way ends: the machine says so, and the parked route is prompted in its own live session.
        release();
        await settled('t_cc2');
        await settled('t_dev2');
        const t = await task('t_dev2').get();
        expect(t.status).toBe('completed');
        expect(edges(t)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(t.transitions[2]!.why).toMatch(/^turn t_cc2:turn:1 ended in session .*; a slot freed in environment env_1$/);
        expect(frames(m1, 'session.command').filter((f) => f.sessionId === b.sessionId && (f.command as { type: string }).type === 'prompt')).toHaveLength(2);
        expect(closes(m1)).toBe(0);

        // Work delegated from the chat opens its own session while both chat sessions are live — they hold no slot.
        await task('t_child').create({ objective: 'do the thing', origin: { kind: 'agent', taskId: 't_cc2' as TaskId, agentId: cc, sessionId: a.sessionId!, callId: 'call_1' }, assignee: dev, context: [], constraints: {} }, { owner: dev });
        const child = await routing().run('t_child' as TaskId);
        expect(child.status).toBe('active');
        await settled('t_child');
        expect((await task('t_child').get()).status).toBe('completed');
        expect(child.sessionId).not.toBe(a.sessionId);
        expect(child.sessionId).not.toBe(b.sessionId);
        await until(async () => (await session(child.sessionId!).get()).status === 'closed', 'the chatless session to close');
        expect((await hosted(m1)).map((h) => h.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
    });

    it("a second message to the member whose own turn is running waits on that turn (#395), never on capacity: the turn it would join already holds the environment's one slot", async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const chatId = await room(cc);

        const release = holdTurns();
        const a = await message(chatId, cc, 'plan it', 't_cc');
        await running('t_cc');
        // The in-memory runtime cannot steer: the route parks on the running turn, not on the environment (whose slot that turn holds).
        const again = await message(chatId, cc, 'and then', 't_cc2');
        expect(again.sessionId).toBe(a.sessionId);
        expect(again.status).toBe('waiting');
        expect(again.wait).toEqual({ kind: 'turn', sessionId: a.sessionId, turnId: 't_cc:turn:1' });
        expect((await routing().get()).routes.find((r) => r.taskId === 't_cc2')?.status).toBe('waiting-turn');

        // The turn ends: the parked message goes out in the same session, through the capacity check, which now finds the slot free.
        release();
        await settled('t_cc');
        await settled('t_cc2');
        const t = await task('t_cc2').get();
        expect(t.status).toBe('completed');
        expect(edges(t)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(t.transitions[2]!.why).toBe('turn t_cc:turn:1 ended');
        expect(frames(m1, 'session.command').filter((f) => f.sessionId === a.sessionId && (f.command as { type: string }).type === 'prompt')).toHaveLength(2);
        expect((await hosted(m1)).map((h) => h.sessionId)).toEqual([a.sessionId]);
    });

    it('an environment holding only idle chat sessions can be removed; while a turn runs there the refusal names it', async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const dev = await agent('agent_dev');
        const chatId = await room(cc, dev);
        const a = await message(chatId, cc, 'plan it', 't_cc');
        await settled('t_cc');
        const b = await message(chatId, dev, 'build it', 't_dev');
        await settled('t_dev');

        const release = holdTurns();
        await message(chatId, cc, 'again', 't_cc2');
        await running('t_cc2');
        const refused = await machine(m1)
            .removeEnvironment(E1)
            .then(() => null)
            .catch((e: unknown) => e as { status?: number; message?: string });
        expect(refused?.status).toBe(409);
        expect(refused?.message).toBe(`in-use: environment "env_1" on machine "${m1}" has work in it — running: session ${a.sessionId} (agent agent_cc, turn t_cc2:turn:1)`);
        release();
        await settled('t_cc2');

        // Idle now: the two live sessions are closed ahead of the request, and the daemon forgets the environment.
        const { requestId } = await machine(m1).removeEnvironment(E1);
        const kinds = sockets.frames(machineKey(WS, m1)).map((f) => f.t);
        expect(kinds.lastIndexOf('session.close')).toBeLessThan(kinds.indexOf('env.request'));
        expect(frames(m1, 'session.close').map((f) => f.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
        await until(async () => (await machine(m1).envResult(requestId)).status !== 'pending', 'env.response');
        expect(await machine(m1).envResult(requestId)).toMatchObject({ status: 'done', result: { environmentId: E1 } });
        await until(async () => (await machine(m1).get()).environments.length === 0, 'the environment gone');
        expect(await hosted(m1)).toEqual([]);
    });
});

describe('a turn the runtime starts itself holds the session and its slot (#510)', () => {
    /**
     * Claude Code starts a turn of its own when a background task it waited on finishes: a `turn-start` no prompt of
     * ours is out for. The in-memory daemon has no such turn, so the test plays it on the daemon's socket, stamped with
     * the daemon's own next seqs — and moves the fake's counter past them, as a real daemon's log would be.
     */
    async function implicitTurn(machineId: MachineId, sessionId: string, turnId = 'rt-1') {
        const daemon = machine(machineId, asMachine(machineId));
        const fake = (daemons.find((d) => d.machineId === machineId) as unknown as { sessions: Map<string, { seq: number; epoch: number }> }).sessions.get(sessionId)!;
        const send = async (event: Record<string, unknown>) => {
            fake.seq++;
            const at = { epoch: fake.epoch, seq: fake.seq };
            const frame = { v: WIRE_PROTOCOL_VERSION, kind: 'event', ...at, event: { ...event, turnId, sessionId, ...at } as AgentEvent };
            expect(await daemon.socketMessage(JSON.stringify({ v: 1, t: 'session.frame', sessionId, frame }))).toMatchObject({ ok: true });
        };
        return {
            start: () => send({ type: 'turn-start', input: [] }),
            /** A sign of work: a part, like a background task's result. */
            content: (text = 'working') => send({ type: 'part-delta', partId: `${turnId}:p`, delta: text }),
            end: async (text = 'done in the background') => {
                await send({ type: 'part-delta', partId: `${turnId}:p`, delta: text });
                await send({ type: 'turn-end', stopReason: 'end_turn' });
            },
            /** What the daemon plays once the turn is cancelled. */
            cancelled: () => send({ type: 'turn-end', stopReason: 'cancelled' })
        };
    }

    const cancels = (machineId: MachineId, sessionId: string) => frames(machineId, 'session.command').filter((f) => f.sessionId === sessionId && (f.command as { type: string }).type === 'cancel');

    it('one that stays empty is cancelled by the re-check, and the message waiting behind it runs (#605)', async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'what model are you', 't_1');
        await settled('t_1');
        const sid = first.sessionId!;

        // A runtime that answers a model switch with a turn it never ends (signalxjs/ai#193).
        const ghost = await implicitTurn(m1, sid);
        await ghost.start();
        await message(chatId, cc, '5 or 5.5', 't_2');
        await until(async () => (await routing().get()).routes.find((r) => r.taskId === 't_2')?.status === 'waiting-turn', 't_2 waiting-turn');
        expect(cancels(m1, sid)).toHaveLength(0);

        await routing().recheck();
        await until(() => cancels(m1, sid).length === 1, 'the ghost turn cancelled');
        await ghost.cancelled();
        await settled('t_2');
        expect((await task('t_2').get()).status).toBe('completed');
        expect(isIdle(await machine(m1).get())).toBe(true);
    });

    it("one that stays empty in another member's session is cancelled too: the slot it holds goes to the waiting member (#605)", async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const dev = await agent('agent_dev');
        const chatId = await room(cc, dev);
        const first = await message(chatId, cc, 'plan it', 't_cc');
        await settled('t_cc');

        const ghost = await implicitTurn(m1, first.sessionId!);
        await ghost.start();
        const b = await message(chatId, dev, 'build it', 't_dev');
        expect(b.wait).toEqual({ kind: 'capacity', environmentId: E1, position: 1 });

        await routing().recheck();
        await until(() => cancels(m1, first.sessionId!).length === 1, 'the ghost turn cancelled');
        await ghost.cancelled();
        await settled('t_dev');
        expect((await task('t_dev').get()).status).toBe('completed');
    });

    it('one that carries work is never cancelled by the re-check (#605)', async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'plan it', 't_1');
        await settled('t_1');
        const sid = first.sessionId!;

        const turn = await implicitTurn(m1, sid);
        await turn.start();
        await turn.content();
        expect((await session(sid).get()).running).toMatchObject({ turnId: 'rt-1', implicit: true, content: true });
        await message(chatId, cc, 'and now?', 't_2');
        await until(async () => (await routing().get()).routes.find((r) => r.taskId === 't_2')?.status === 'waiting-turn', 't_2 waiting-turn');

        await routing().recheck();
        expect(cancels(m1, sid)).toHaveLength(0);
        await turn.end('background work done');
        await settled('t_2');
        expect((await task('t_2').get()).status).toBe('completed');
    });

    it('the session runs it and the machine counts it: a message to the same member waits for it, then runs', async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const chatId = await room(cc);
        const first = await message(chatId, cc, 'plan it', 't_1');
        await settled('t_1');
        const sid = first.sessionId!;

        const turn = await implicitTurn(m1, sid);
        await turn.start();
        expect((await session(sid).get()).running).toMatchObject({ turnId: 'rt-1', implicit: true });
        expect((await session(sid).get()).running?.taskId).toBeUndefined();
        // The platform's count matches the daemon's: the slot is taken and the machine is not idle, so no update fires.
        const busy = await machine(m1).get();
        expect(runningIn(busy, E1).map((h) => h.sessionId)).toEqual([sid]);
        expect(freeSlots(busy, E1)).toBe(0);
        expect(isIdle(busy)).toBe(false);

        // A message meanwhile: the runtime cannot take it into the turn (no steer), so it waits for the turn to end.
        const next = await message(chatId, cc, 'and now?', 't_2');
        expect(next.sessionId).toBe(sid);
        await until(async () => (await routing().get()).routes.find((r) => r.taskId === 't_2')?.status === 'waiting-turn', 't_2 waiting-turn');
        expect(frames(m1, 'session.command').filter((f) => (f.command as { type: string }).type === 'prompt')).toHaveLength(1);

        await turn.end('background work done');
        await settled('t_2');
        expect((await task('t_2').get()).status).toBe('completed');
        expect(isIdle(await machine(m1).get())).toBe(true);
    });

    it("another member's message waits on the slot it holds and runs when it ends — no wait on an unrelated turn", async () => {
        const m1 = await pairMachine('laptop');
        const cc = await agent('agent_cc');
        const dev = await agent('agent_dev');
        const chatId = await room(cc, dev);
        const first = await message(chatId, cc, 'plan it', 't_cc');
        await settled('t_cc');

        const turn = await implicitTurn(m1, first.sessionId!);
        await turn.start();
        const b = await message(chatId, dev, 'build it', 't_dev');
        expect(b.status).toBe('waiting');
        expect(b.wait).toEqual({ kind: 'capacity', environmentId: E1, position: 1 });

        await turn.end('done in the background');
        await settled('t_dev');
        expect((await task('t_dev').get()).status).toBe('completed');
        expect((await task('t_dev').get()).transitions[1]!.why).toMatch(/slot freed in environment env_1/);
    });
});
