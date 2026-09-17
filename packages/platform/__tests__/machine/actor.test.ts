import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorKey, type EnvironmentId, type FrozenAgentConfig, type MachineId, type OpenSpec, type Principal, type SessionId, type WorkspaceId } from '@agentic/core';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import type { WireCommand } from '@sigx/ai-agent/wire';

import { parseMachineToken, verifyMachineToken, workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, parseMachineKey, ToolCallError, type MachineSocketPort, type ToolCallInput } from '../../src/machine/index';
import { defineSessionActor, type CommandSink, type SessionOpenSpec } from '../../src/session/index';
import { PairingDirectory } from '../../src/pairing/index';
import { Workspace } from '../../src/workspace/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const M1 = 'machine_1' as MachineId;
const M2 = 'machine_2' as MachineId;
const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
const K1 = machineKey(WS, M1);
const K2 = machineKey(WS, M2);
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });
const TICK = 60_000;

const config: FrozenAgentConfig = {
    agentId: 'agent_1' as FrozenAgentConfig['agentId'],
    configVersion: 1,
    name: 'Ada',
    description: '',
    role: 'assistant',
    instructions: 'Be brief.',
    skills: [],
    tools: [],
    connectors: [],
    approvalPolicy: [],
    memoryPolicy: { shared: [], autoLearn: 'off' },
    execution: { runtime: 'in-memory', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};
const openSpec: OpenSpec = { agentId: 'agent_1', cwd: '/work', system: 'Be brief.', tools: [] };

/** A fake socket layer: outbound text per key, optionally bridged to an `InMemoryDaemon` seat. */
class FakeSockets implements MachineSocketPort {
    readonly sent = new Map<string, string[]>();
    readonly seats = new Map<string, PlatformSeat>();
    readonly closed: { key: string; code: number; reason: string }[] = [];
    connected = new Set<string>();

    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string, code: number, reason: string): void {
        this.closed.push({ key, code, reason });
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
    frames(key: string): { t: string }[] {
        return (this.sent.get(key) ?? []).map((t) => JSON.parse(t) as { t: string });
    }
}

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 3_000): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!(await check())) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let scheduler: ManualScheduler;
let toolCalls: { input: ToolCallInput; principal: Principal }[];
let toolFails = false;
let Machine: ReturnType<typeof defineMachineActor>;
let Session: ReturnType<typeof defineSessionActor>;
const daemons: InMemoryDaemon[] = [];

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sockets = new FakeSockets();
    scheduler = manualScheduler();
    toolCalls = [];
    toolFails = false;
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink });
    Machine = defineMachineActor({
        socket: sockets,
        sessions: () => Session,
        tools: {
            async call(input, principal) {
                toolCalls.push({ input, principal });
                if (toolFails) throw new ToolCallError('denied', 'not allowed');
                return { echoed: input.input };
            }
        },
        heartbeatWindowMs: 90_000,
        commandTimeoutMs: 120_000
    });
    app = testActorApp([Machine, Session, Workspace, PairingDirectory], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
    vi.useRealTimers();
});

const machine = (key = K1, principal: Principal | null = owner) => app.as(principal).actor(Machine, key);

/** Connect a fake daemon to `key`: its hello goes in, the actor's frames go back, until the seat drops. */
function connect(key: string, daemon: InMemoryDaemon): { seat: PlatformSeat; done: Promise<void> } {
    const ids = parseMachineKey(key)!;
    const seat = daemon.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(key, asMachine(ids.machineId));
    const done = (async () => {
        try {
            for (;;) {
                const text = (await seat.next()) as string;
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
    return { seat, done };
}

function daemon(machineId: MachineId, environments = [inMemoryEnvironment(machineId, E1)], script: { events?: number; tool?: { name: string; input: unknown }; heartbeatMs?: number } = {}): InMemoryDaemon {
    const d = inMemoryHarness({ machineId, environments }).start({ events: script.events ?? 3, heartbeatMs: script.heartbeatMs ?? 600_000, ...(script.tool ? { tool: script.tool } : {}) }) as InMemoryDaemon;
    daemons.push(d);
    return d;
}

const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
        const step = Math.min(left, TICK);
        vi.setSystemTime(Date.now() + step);
        scheduler.advance(TICK);
        await new Promise((r) => setTimeout(r, 0));
        left -= step;
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Machine authorization', () => {
    it('admits the workspace only, and the socket entry points only to the machine itself', async () => {
        expect(await statusOf(app.as(userPrincipal('u2')).actor(Machine, K1).get())).toBe(403);
        expect(await statusOf(app.as(null).actor(Machine, K1).get())).toBe(401);
        expect(await statusOf(machine(K1, owner).socketMessage('{}'))).toBe(403);
        expect(await statusOf(machine(K1, asMachine(M2)).socketMessage('{}'))).toBe(403);
        expect(await statusOf(machine(K1, asMachine(M2)).socketClosed())).toBe(403);
        expect(await statusOf(machine(K1, asMachine(M1)).socketClosed())).toBeUndefined();
        expect(await statusOf(machine(K1, asMachine(M1)).revoke())).toBe(403);
        expect(await statusOf(machine(K1, asMachine(M1)).openSession('s' as SessionId, E1, openSpec))).toBe(403);
        const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['tasks'] };
        expect(await statusOf(app.as(external).actor(Machine, K1).get())).toBe(403);
        expect(await statusOf(app.as({ ...external, scopes: ['machines'] }).actor(Machine, K1).get())).toBeUndefined();
    });
});

describe('Machine pairing (USR-04)', () => {
    it('redeems a pairing code through the Workspace, keeps only the hash, and refuses a second pairing', async () => {
        const ws = app.as(owner).actor(Workspace, workspaceKey(WS));
        const { machineId, pairingCode } = await ws.registerMachinePending({ name: 'laptop' });
        const key = machineKey(WS, machineId);
        const paired = await machine(key).pair(pairingCode, { name: 'laptop', os: 'windows' });
        expect(parseMachineToken(paired.token)).toEqual({ workspaceId: WS, machineId });
        const record = await machine(key).tokenRecord();
        expect(record?.revokedAt).toBeNull();
        expect(await verifyMachineToken(paired.token, record)).toMatchObject({ ok: true, principal: { kind: 'machine', machineId } });
        expect(await machine(key).get()).toMatchObject({ paired: true, name: 'laptop', os: 'windows', revoked: false, online: false });
        expect((await ws.listMachines()).find((m) => m.id === machineId)?.status).toBe('paired');

        expect(await statusOf(machine(key).pair(pairingCode))).toBe(409);
        // A used code refuses a different machine too.
        expect(await statusOf(machine(K2).pair(pairingCode))).toBe(401);
        expect(await machine(K2).tokenRecord()).toBeNull();
    });

    it('a code issued for another machine is refused', async () => {
        const ws = app.as(owner).actor(Workspace, workspaceKey(WS));
        const { pairingCode } = await ws.registerMachinePending({ name: 'other' });
        expect(await statusOf(machine(K1).pair(pairingCode))).toBe(401);
    });

    it('revoke refuses the token from then on and drops the socket', async () => {
        const ws = app.as(owner).actor(Workspace, workspaceKey(WS));
        const { machineId, pairingCode } = await ws.registerMachinePending({ name: 'laptop' });
        const key = machineKey(WS, machineId);
        const { token } = await machine(key).pair(pairingCode);
        const { seat } = connect(key, daemon(machineId));
        await until(async () => (await machine(key).get()).online, 'online');
        await machine(key).revoke();
        expect(sockets.closed).toContainEqual({ key, code: 1008, reason: 'revoked' });
        expect(await verifyMachineToken(token, await machine(key).tokenRecord())).toEqual({ ok: false, reason: 'revoked' });
        expect(await machine(key).get()).toMatchObject({ revoked: true, online: false });
        expect(await statusOf(machine(key).pair(pairingCode))).toBe(403);
        await expect(seat.next()).rejects.toThrow();
    });
});

describe('Machine daemons (AC-01, EXE-02/03/06/08)', () => {
    it('two daemons appear with independent environments and availability', async () => {
        const d1 = daemon(M1, [inMemoryEnvironment(M1, E1)]);
        const d2 = daemon(M2, [inMemoryEnvironment(M2, E2), { ...inMemoryEnvironment(M2, 'env_3' as EnvironmentId), name: 'second', account: { label: 'work', authStatus: 'missing' } }]);
        connect(K1, d1);
        connect(K2, d2);
        await until(async () => (await machine(K1).get()).online && (await machine(K2).get()).online, 'both online');

        const m1 = await machine(K1).get();
        const m2 = await machine(K2).get();
        expect(m1.environments.map((e) => e.id)).toEqual([E1]);
        expect(m2.environments.map((e) => e.id)).toEqual([E2, 'env_3']);
        expect(m2.environments[1]?.account).toEqual({ label: 'work', authStatus: 'missing' });
        expect(m1).toMatchObject({ os: 'linux', daemonVersion: '0.0.0-fake', capabilities: [IN_MEMORY_CAPABILITIES] });
        expect(sockets.frames(K1)[0]).toMatchObject({ t: 'welcome', wanted: {} });

        // An `env` update on one machine leaves the other alone.
        d2.setEnvironments([inMemoryEnvironment(M2, E2)]);
        await until(async () => (await machine(K2).get()).environments.length === 1, 'env update');
        expect((await machine(K1).get()).environments.map((e) => e.id)).toEqual([E1]);

        // Dropping one leaves the other online.
        d2.stop();
        await until(async () => !(await machine(K2).get()).online, 'm2 offline');
        expect((await machine(K1).get()).online).toBe(true);
    });

    it('a socket drop marks the machine offline at once; a silent daemon within the heartbeat window', async () => {
        const { seat } = connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        seat.drop();
        await until(async () => !(await machine(K1).get()).online, 'offline on close');

        // Silent drop: no close event. The liveness reminder notices within the window.
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online again');
        const before = (await machine(K1).get()).lastSeen!;
        sockets.seats.delete(K1); // frames stop flowing both ways; nothing tells the actor
        await advance(TICK);
        expect((await machine(K1).get()).online).toBe(true);
        await advance(TICK);
        expect((await machine(K1).get()).online).toBe(false);
        expect((await machine(K1).get()).lastSeen).toBe(before);
    });

    it('a heartbeat keeps the machine online across the window', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        await advance(TICK);
        await machine(K1, asMachine(M1)).heartbeat();
        await advance(TICK);
        expect((await machine(K1).get()).online).toBe(true);
    });

    it('drops malformed messages and keeps the socket; refuses a hello for another machine', async () => {
        const asDaemon = machine(K1, asMachine(M1));
        sockets.connected.add(K1);
        expect(await asDaemon.socketMessage('not json')).toMatchObject({ ok: false, code: 'not-json' });
        expect(await asDaemon.socketMessage(JSON.stringify({ v: 2, t: 'hello' }))).toMatchObject({ ok: false, code: 'unsupported-version' });
        expect((await machine(K1).get()).rejected).toBe(2);
        expect(sockets.closed).toEqual([]);

        const hello = { v: 1, t: 'hello', machineId: M2, daemonVersion: '1', os: 'linux', environments: [], capabilities: [], resume: {} };
        expect(await asDaemon.socketMessage(JSON.stringify(hello))).toMatchObject({ ok: true, t: 'hello' });
        expect(sockets.closed[0]).toMatchObject({ key: K1, code: 1008 });
        expect((await machine(K1).get()).online).toBe(false);
    });
});

describe('Machine sessions (§5b routing, EXE-09)', () => {
    const S1 = 'session_1' as SessionId;
    const S2 = 'session_2' as SessionId;
    const sessionSpec = (machineId: MachineId): SessionOpenSpec => ({ agentId: config.agentId, runtime: 'in-memory', environmentId: E1, machineId, config });
    const session = (id: SessionId) => app.as(owner).actor(Session, actorKey(WS, 'session', id));

    it('opens a session on the daemon, routes frames and replies to the Session, and runs a turn', async () => {
        connect(K1, daemon(M1, undefined, { events: 3 }));
        await until(async () => (await machine(K1).get()).online, 'online');
        await session(S1).open(sessionSpec(M1));

        expect(await machine(K1).openSession(S1, E1, openSpec)).toBe('opened');
        expect(await machine(K1).openSession(S1, E1, openSpec)).toBe('opened'); // idempotent
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'session.opened');
        // The Session learned its ref and capabilities from the synthesized wire hello.
        const info = await session(S1).get();
        expect(info.mode).toBe('remote');
        expect(info.ref).toEqual({ agent: 'in-memory', v: 1, id: S1 });
        expect(info.capabilities?.resume).toBe('local');

        const pending = await session(S1).prompt('hello', 't1');
        expect(pending).toMatchObject({ kind: 'pending', commandId: 't1' });
        await until(async () => (await session(S1).get()).running?.turnId === 't1', 'the prompt ack');
        await until(async () => !(await session(S1).get()).running, 'the turn to end');
        const events = await session(S1).events();
        expect(events.map((e) => e.type)).toEqual(['part-delta', 'part-delta', 'turn-end']);
        expect((await session(S1).get()).transcriptAt).toEqual({ epoch: 0, seq: 3 });
        const m = await machine(K1).get();
        expect(m.pending).toEqual([]);
        expect(m.activeSessions[0]?.cursor).toEqual({ epoch: 0, seq: 3 });
        // The reply is remembered: the same command answers with the ack it got.
        expect(await session(S1).prompt('hello', 't1')).toMatchObject({ kind: 'ack', commandId: 't1' });
    });

    it('a tool.call runs on the ToolCallPort under the agent principal and answers tool.result', async () => {
        connect(K1, daemon(M1, undefined, { events: 2, tool: { name: 'memory_search', input: { q: 'tea' } } }));
        await until(async () => (await machine(K1).get()).online, 'online');
        await session(S1).open(sessionSpec(M1));
        await machine(K1).openSession(S1, E1, openSpec, { taskId: 'task_1' as never });
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'session.opened');
        await session(S1).prompt('go', 't1');
        await until(async () => !(await session(S1).get()).running && (await session(S1).get()).eventCount === 2, 'the turn');
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]!.input).toMatchObject({ sessionId: S1, tool: 'memory_search', input: { q: 'tea' } });
        expect(toolCalls[0]!.principal).toEqual({ kind: 'agent', workspaceId: WS, agentId: 'agent_1', sessionId: S1, taskId: 'task_1' });
        const results = sockets.frames(K1).filter((f) => f.t === 'tool.result');
        expect(results[0]).toMatchObject({ output: { echoed: { q: 'tea' } } });
    });

    it('a failing tool answers tool.result.error with the port error code', async () => {
        toolFails = true;
        connect(K1, daemon(M1, undefined, { events: 1, tool: { name: 'delegate', input: {} } }));
        await until(async () => (await machine(K1).get()).online, 'online');
        await session(S1).open(sessionSpec(M1));
        await machine(K1).openSession(S1, E1, openSpec);
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'session.opened');
        await session(S1).prompt('go', 't1');
        await until(() => sockets.frames(K1).some((f) => f.t === 'tool.result'), 'tool.result');
        expect(sockets.frames(K1).find((f) => f.t === 'tool.result')).toMatchObject({ error: { code: 'denied', message: 'not allowed' } });
    });

    it('queues beyond an environment capacity and opens the next when a session closes', async () => {
        connect(K1, daemon(M1, [{ ...inMemoryEnvironment(M1, E1), concurrency: { max: 1, active: 0 } }]));
        await until(async () => (await machine(K1).get()).online, 'online');
        await session(S1).open(sessionSpec(M1));
        await session(S2).open(sessionSpec(M1));
        expect(await machine(K1).openSession(S1, E1, openSpec)).toBe('opened');
        expect(await machine(K1).openSession(S2, E1, openSpec)).toBe('queued');
        expect(await machine(K1).openSession(S2, E1, openSpec)).toBe('queued');
        expect((await machine(K1).get()).queued.map((q) => q.sessionId)).toEqual([S2]);
        expect(sockets.frames(K1).filter((f) => f.t === 'session.open')).toHaveLength(1);

        await machine(K1).closeSession(S1);
        await until(async () => (await machine(K1).get()).activeSessions.map((s) => s.sessionId).join() === S2, 'S2 dequeued');
        const m = await machine(K1).get();
        expect(m.queued).toEqual([]);
        expect(m.closures[0]).toMatchObject({ sessionId: S1, reason: 'closed' });
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'S2 opened');
        expect(sockets.frames(K1).filter((f) => f.t === 'session.open')).toHaveLength(2);

        // Closing a queued session just drops it.
        await machine(K1).openSession(S1, E1, openSpec);
        expect((await machine(K1).get()).queued.map((q) => q.sessionId)).toEqual([S1]);
        await machine(K1).closeSession(S1);
        expect((await machine(K1).get()).queued).toEqual([]);
    });

    it('refuses an unknown environment and an offline machine', async () => {
        expect(await statusOf(machine(K1).openSession(S1, E1, openSpec))).toBe(404);
        const { seat } = connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        seat.drop();
        await until(async () => !(await machine(K1).get()).online, 'offline');
        expect(await statusOf(machine(K1).openSession(S1, E1, openSpec))).toBe(503);
    });

    it('a command for a session this machine does not host is answered closed', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        await session(S1).open(sessionSpec(M1));
        const result = await session(S1).prompt('hello', 't1');
        expect(result).toMatchObject({ kind: 'pending' });
        await until(async () => (await session(S1).prompt('hello', 't1')).kind === 'error', 'the closed reply');
        expect(await session(S1).prompt('hello', 't1')).toMatchObject({ kind: 'error', code: 'closed' });
    });

    it('holds a command while offline, re-sends it after the next hello, and times out through the reminder', async () => {
        const d = daemon(M1);
        const { seat } = connect(K1, d);
        await until(async () => (await machine(K1).get()).online, 'online');
        await session(S1).open(sessionSpec(M1));
        await machine(K1).openSession(S1, E1, openSpec);
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'session.opened');
        seat.drop();
        await until(async () => !(await machine(K1).get()).online, 'offline');

        const command: WireCommand = { v: 1, commandId: 'c1', type: 'cancel' };
        await machine(K1).sendCommand(S1, command);
        expect((await machine(K1).get()).pending).toHaveLength(1);
        expect(sockets.frames(K1).filter((f) => f.t === 'session.command')).toHaveLength(0);

        // Redial: the hello resumes the session; welcome asks from the last cursor; the pending command goes out again.
        connect(K1, d);
        await until(async () => (await machine(K1).get()).online, 'online again');
        const welcome = sockets.frames(K1).filter((f) => f.t === 'welcome')[1] as unknown as { wanted: Record<string, unknown> };
        expect(welcome.wanted).toEqual({ [S1]: { epoch: 0, seq: 0 } });
        await until(async () => (await machine(K1).get()).pending.length === 0, 'the cancel reply');

        // A command the daemon never answers times out into the Session.
        sockets.seats.delete(K1);
        const prompt = await session(S1).prompt('late', 't9');
        expect(prompt).toMatchObject({ kind: 'pending' });
        expect((await machine(K1).get()).pending.map((p) => p.command.commandId)).toEqual(['t9']);
        await advance(3 * TICK);
        expect((await machine(K1).get()).pending).toEqual([]);
        expect(await session(S1).prompt('late', 't9')).toMatchObject({ kind: 'error', code: 'internal' });
    });

    it('a session closed by the daemon frees its slot and answers its open commands', async () => {
        const d = daemon(M1, [{ ...inMemoryEnvironment(M1, E1), concurrency: { max: 1, active: 0 } }]);
        connect(K1, d);
        await until(async () => (await machine(K1).get()).online, 'online');
        await session(S1).open(sessionSpec(M1));
        await machine(K1).openSession(S1, E1, openSpec);
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'session.opened');
        const closed = await session(S1).close('close_1');
        expect(closed).toMatchObject({ kind: 'pending' });
        await until(async () => (await session(S1).get()).status === 'closed', 'the session record to close');
        await until(async () => (await machine(K1).get()).activeSessions.length === 0, 'the slot to free');
        expect((await machine(K1).get()).closures.at(-1)).toMatchObject({ sessionId: S1 });
    });
});
