import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorKey, SESSION_EVENTS_TOPIC, type EnvironmentId, type FrozenAgentConfig, type MachineId, type MachinePolicy, type OpenSpec, type Principal, type SessionEvent, type SessionId, type WorkspaceId } from '@agentic/core';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { defineActor } from '@sigx/actors';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import { WIRE_PROTOCOL_VERSION, type WireCommand, type WireFrame } from '@sigx/ai-agent/wire';

import { AuditActor, auditKey } from '../../src/audit/index';
import { parseMachineToken, verifyMachineToken, workspaceKey } from '../../src/auth/index';
import { DEFAULT_ENV_TIMEOUT_MS, defineMachineActor, ENV_RESULT_TTL_MS, freeSlots, FS_RESULT_TTL_MS, MACHINE_OFFLINE_CODE, machineKey, machineWorkspaceSource, MAX_CHANGES_SNAPSHOTS, MAX_ENV_REQUESTS, MAX_FS_REQUESTS, parseMachineKey, SNAPSHOT_MAX_COMMITS, SNAPSHOT_MAX_FILES, ToolCallError, type FsAnswer, type MachineSocketPort, type ToolCallInput } from '../../src/machine/index';
import { initialMachineState, rememberChanges, snapshotOf } from '../../src/machine/state';
import { defineSessionActor, type CommandSink, type SessionOpenSpec } from '../../src/session/index';
import { PairingDirectory } from '../../src/pairing/index';
import { Workspace } from '../../src/workspace/index';
import { elevatedPrincipal, statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
/** The owner beside a live elevation (#355): what `revoke`, `setPolicy` and `browseMachine` take. */
const elevated = elevatedPrincipal('u1');
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
let toolHold: Promise<void> | undefined;
/** A turn-holding tool: the daemon's scripted `tool.call` waits on it until `release` (#394). */
const holdTurns = (): (() => void) => {
    let release!: () => void;
    toolHold = new Promise<void>((r) => (release = r));
    return () => {
        toolHold = undefined;
        release();
    };
};
let Machine: ReturnType<typeof defineMachineActor>;
let Session: ReturnType<typeof defineSessionActor>;
const daemons: InMemoryDaemon[] = [];

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sockets = new FakeSockets();
    scheduler = manualScheduler();
    toolCalls = [];
    toolFails = false;
    toolHold = undefined;
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink });
    Machine = defineMachineActor({
        socket: sockets,
        sessions: () => Session,
        tools: {
            async call(input, principal) {
                toolCalls.push({ input, principal });
                if (toolFails) throw new ToolCallError('denied', 'not allowed');
                // A held call keeps the daemon's turn running for as long as the test wants (#394).
                if (toolHold) await toolHold;
                return { echoed: input.input };
            }
        },
        heartbeatWindowMs: 90_000,
        commandTimeoutMs: 120_000
    });
    app = testActorApp([Machine, Session, Workspace, PairingDirectory, AuditActor], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
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
        // The owner too, without a live elevation (#355): 403 elevation-required.
        expect(await statusOf(machine(K1, owner).revoke())).toBe(403);
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
        await machine(key, elevated).revoke();
        expect(sockets.closed).toContainEqual({ key, code: 1008, reason: 'revoked' });
        expect(await verifyMachineToken(token, await machine(key).tokenRecord())).toEqual({ ok: false, reason: 'revoked' });
        expect(await machine(key).get()).toMatchObject({ revoked: true, online: false });
        expect(await statusOf(machine(key).pair(pairingCode))).toBe(403);
        await expect(seat.next()).rejects.toThrow();
        // A heartbeat as the revoked machine (#172): refused, `online` stays false, no liveness re-armed.
        const asMachineRevoked = machine(key, asMachine(machineId));
        expect(await statusOf(asMachineRevoked.heartbeat())).toBe(403);
        expect(await machine(key).get()).toMatchObject({ revoked: true, online: false });
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
        // The Session learned its capabilities from the synthesized wire hello — not its ref: `session.opened` carries a
        // placeholder, and the record keeps only a ref the daemon reported with `session.ref` (#389).
        const info = await session(S1).get();
        expect(info.mode).toBe('remote');
        expect(info.ref).toBeUndefined();
        expect(info.capabilities?.resume).toBe('local');
        // A `session.ref` for a session this machine does not host is ignored, not an error.
        expect(await machine(K1, asMachine(M1)).socketMessage(JSON.stringify({ v: 1, t: 'session.ref', sessionId: S2, ref: { agent: 'in-memory', v: 1, id: 'nobody' } }))).toMatchObject({ ok: true });
        expect((await session(S2).get()).ref).toBeUndefined();

        const pending = await session(S1).prompt('hello', 't1');
        expect(pending).toMatchObject({ kind: 'pending', commandId: 't1' });
        await until(async () => (await session(S1).get()).running?.turnId === 't1', 'the prompt ack');
        await until(async () => !(await session(S1).get()).running, 'the turn to end');
        // The runtime named the session with its first turn: the daemon's `session.ref` reached the record through the machine.
        expect((await session(S1).get()).ref).toEqual({ agent: 'in-memory', v: 1, id: `${S1}.run` });
        const events = await session(S1).events();
        expect(events.map((e) => e.type)).toEqual(['part-delta', 'part-delta', 'turn-end']);
        expect((await session(S1).get()).transcriptAt).toEqual({ epoch: 0, seq: 3 });
        const m = await machine(K1).get();
        expect(m.pending).toEqual([]);
        expect(m.activeSessions[0]?.cursor).toEqual({ epoch: 0, seq: 3 });
        // The reply is remembered: the same command answers with the ack it got.
        expect(await session(S1).prompt('hello', 't1')).toMatchObject({ kind: 'ack', commandId: 't1' });
    });

    it('a frame or a reply for a session the record refuses is dropped, and the socket stays (#393)', async () => {
        connect(K1, daemon(M1, undefined, { events: 3 }));
        await until(async () => (await machine(K1).get()).online, 'online');
        const asDaemon = machine(K1, asMachine(M1));
        // S2 was never opened on this machine: the Session record admits no machine for it (403). A daemon that still
        // runs it after a restart, or a stale one, must not take the whole socket down with that refusal.
        const event: WireFrame = { v: WIRE_PROTOCOL_VERSION, kind: 'event', epoch: 0, seq: 1, event: { type: 'part-delta', partId: 'p1', delta: 'x', turnId: 't1', sessionId: S2, epoch: 0, seq: 1 } };
        expect(await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.frame', sessionId: S2, frame: event }))).toMatchObject({ ok: true, t: 'session.frame' });
        expect(await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.reply', sessionId: S2, reply: { v: WIRE_PROTOCOL_VERSION, kind: 'ack', commandId: 'c1' } }))).toMatchObject({ ok: true, t: 'session.reply' });
        expect((await machine(K1).get()).online).toBe(true);
        expect((await session(S2).get()).opened).toBe(false);
        // The socket still carries a real session's turn after that.
        await session(S1).open(sessionSpec(M1));
        expect(await machine(K1).openSession(S1, E1, openSpec)).toBe('opened');
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'session.opened');
        await session(S1).prompt('hello', 't1');
        await until(async () => (await session(S1).get()).transcriptAt?.seq === 3, 'the turn to end');
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

    it('capacity counts running turns, not open sessions (#394): idle sessions open freely, a turn queues the next open, and the turn ending — not a close — dequeues it', async () => {
        const S3 = 'session_3' as SessionId;
        connect(K1, daemon(M1, [{ ...inMemoryEnvironment(M1, E1), concurrency: { max: 1, active: 0 } }], { tool: { name: 'hold', input: {} } }));
        await until(async () => (await machine(K1).get()).online, 'online');
        for (const id of [S1, S2, S3]) await session(id).open(sessionSpec(M1));
        // Two conversations in a concurrency-1 environment: both open, neither queued — nothing runs yet.
        expect(await machine(K1).openSession(S1, E1, openSpec)).toBe('opened');
        expect(await machine(K1).openSession(S2, E1, openSpec)).toBe('opened');
        await until(async () => (await machine(K1).get()).activeSessions.filter((h) => h.status === 'open').length === 2, 'both opened');
        expect(freeSlots(await machine(K1).get(), E1)).toBe(1);

        // A turn on S1 takes the one slot: the third open queues behind it, with a visible position.
        const release = holdTurns();
        await session(S1).prompt('go', 't1');
        await until(async () => (await machine(K1).get()).activeSessions.find((h) => h.sessionId === S1)?.running?.turnId === 't1', 'the ack to mark the turn running');
        expect(freeSlots(await machine(K1).get(), E1)).toBe(0);
        expect(await machine(K1).openSession(S3, E1, openSpec)).toBe('queued');
        expect(await machine(K1).openSession(S3, E1, openSpec)).toBe('queued');
        expect((await machine(K1).get()).queued.map((q) => q.sessionId)).toEqual([S3]);
        expect(sockets.frames(K1).filter((f) => f.t === 'session.open')).toHaveLength(2);

        // The turn ends; S1 stays open, and that alone opens the queued session.
        release();
        await until(async () => (await machine(K1).get()).activeSessions.find((h) => h.sessionId === S3)?.status === 'open', 'S3 dequeued and opened');
        const m = await machine(K1).get();
        expect(m.queued).toEqual([]);
        expect(m.closures).toEqual([]);
        expect(m.activeSessions.map((h) => h.sessionId).sort()).toEqual([S1, S2, S3]);
        expect(m.activeSessions.find((h) => h.sessionId === S1)?.running).toBeUndefined();
        expect(sockets.frames(K1).filter((f) => f.t === 'session.open')).toHaveLength(3);
        expect(freeSlots(m, E1)).toBe(1);

        // Closing a queued session just drops it.
        const S4 = 'session_4' as SessionId;
        await session(S4).open(sessionSpec(M1));
        const again = holdTurns();
        await session(S2).prompt('go', 't2');
        await until(async () => (await machine(K1).get()).activeSessions.find((h) => h.sessionId === S2)?.running !== undefined, 'S2 running');
        expect(await machine(K1).openSession(S4, E1, openSpec)).toBe('queued');
        await machine(K1).closeSession(S4);
        expect((await machine(K1).get()).queued).toEqual([]);
        again();
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

    it('doctor() returns the stored per-environment verdicts and is ok only when every environment is verified and clean (EXE-05/07)', async () => {
        const verdict = (id: EnvironmentId, ok: boolean, code: string) => ({ ok, findings: [{ level: ok ? ('info' as const) : ('error' as const), code, message: code, environmentIds: [id] }], checkedAt: 42 });
        const d = daemon(M1, [
            { ...inMemoryEnvironment(M1, E1), isolation: 'config-dir', doctor: verdict(E1, true, 'auth-ok') },
            { ...inMemoryEnvironment(M1, E2), name: 'second', account: { label: 'work', authStatus: 'missing' } }
        ]);
        connect(K1, d);
        await until(async () => (await machine(K1).get()).online, 'online');
        expect(await machine(K1).doctor()).toEqual({
            machineId: M1,
            online: true,
            lastSeen: expect.any(Number),
            ok: false,
            unverified: [E2],
            environments: [
                { environmentId: E1, name: 'in-memory', runtime: 'in-memory', account: { label: 'fake', authStatus: 'ok' }, isolation: 'config-dir', verdict: verdict(E1, true, 'auth-ok') },
                { environmentId: E2, name: 'second', runtime: 'in-memory', account: { label: 'work', authStatus: 'missing' }, isolation: 'none' }
            ]
        });
        // An `env` update replaces the verdicts; a clean set is ok.
        d.setEnvironments([{ ...inMemoryEnvironment(M1, E1), isolation: 'config-dir', doctor: verdict(E1, true, 'auth-ok') }, { ...inMemoryEnvironment(M1, E2), isolation: 'config-dir', doctor: verdict(E2, false, 'shared-config-dir') }]);
        await until(async () => (await machine(K1).doctor()).unverified.length === 0, 'env update');
        expect((await machine(K1).doctor()).ok).toBe(false);
        expect((await machine(K1).doctor(E2)).environments[0]?.verdict?.findings[0]?.code).toBe('shared-config-dir');
        expect(await statusOf(machine(K1).doctor('env_nope' as EnvironmentId))).toBe(404);
        // Readers of the workspace only.
        expect(await statusOf(app.as(userPrincipal('u2')).actor(Machine, K1).doctor())).toBe(403);
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

describe('Machine folder browsing (#189, EXE-06/08, OPS-03/04)', () => {
    const agentP: Principal = { kind: 'agent', workspaceId: WS, agentId: 'agent_1', sessionId: 'session_1' } as Principal;
    const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['machines', 'sessions'] };
    const list = (path: string) => ({ kind: 'list', path }) as const;
    const worktree = { kind: 'worktree', repo: '/work/app', branch: 'feat/x', path: '/work/app-worktrees/feat-x' } as const;
    const settled = (requestId: string, principal: Principal = owner) => until(async () => (await machine(K1, principal).fsResult(requestId)).status !== 'pending', `fs.response for ${requestId}`);

    /** A daemon this test speaks for by hand: its hello goes in, nothing answers unless the test sends `fs.response`. */
    async function rawDaemon() {
        sockets.connected.add(K1);
        const asDaemon = machine(K1, asMachine(M1));
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '1', os: 'linux', environments: [inMemoryEnvironment(M1, E1)], capabilities: [], resume: {} }));
        const respond = (requestId: string, body: object) => asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'fs.response', requestId, ...body }));
        return { asDaemon, respond };
    }

    const worktrees = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['workdir.worktree-created'] })).events;

    it('round-trips fs.request / fs.response over the daemon socket and stores the answer for fsResult', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');

        const { requestId } = await machine(K1).fsRequest(E1, list('/work/app'));
        expect(requestId).toMatch(/^fs_/);
        expect(sockets.frames(K1).find((f) => f.t === 'fs.request')).toEqual({ v: 1, t: 'fs.request', requestId, environmentId: E1, op: list('/work/app') });
        await settled(requestId);
        expect(await machine(K1).fsResult(requestId)).toEqual({
            requestId,
            environmentId: E1,
            op: list('/work/app'),
            status: 'done',
            requestedAt: expect.any(Number),
            finishedAt: expect.any(Number),
            result: { kind: 'list', path: '/work/app', parent: '/work', entries: [], truncated: false }
        });

        // A refusal the daemon names is stored as the error.
        const outside = await machine(K1).fsRequest(E1, list('/etc'));
        await settled(outside.requestId);
        expect(await machine(K1).fsResult(outside.requestId)).toMatchObject({ status: 'error', error: { code: 'outside-roots' } });
        const unsupported = await machine(K1).fsRequest(E1, worktree);
        await settled(unsupported.requestId);
        expect(await machine(K1).fsResult(unsupported.requestId)).toMatchObject({ status: 'error', error: { code: 'unsupported' } });

        // A session driver (an agent, an external client with `sessions`) lists and reads; a root has no parent.
        const byAgent = await machine(K1, agentP).fsRequest(E1, list('/work'));
        await settled(byAgent.requestId, agentP);
        const root = await machine(K1, agentP).fsResult(byAgent.requestId);
        expect(root.result).toEqual({ kind: 'list', path: '/work', entries: [], truncated: false });
        expect(await statusOf(machine(K1, external).fsRequest(E1, list('/work')))).toBeUndefined();
        expect(await statusOf(machine(K1, { ...external, scopes: ['machines'] }).fsRequest(E1, list('/work')))).toBe(403);
        // Not the machine itself, not another workspace.
        expect(await statusOf(machine(K1, asMachine(M1)).fsRequest(E1, list('/work')))).toBe(403);
        expect(await statusOf(machine(K1, asMachine(M1)).fsResult(requestId))).toBe(403);
        expect(await statusOf(machine(K1, userPrincipal('u2')).fsResult(requestId))).toBe(403);

        expect(await statusOf(machine(K1).fsResult('fs_nope'))).toBe(404);
        expect(await statusOf(machine(K1).fsRequest(E1, list('')))).toBe(400);
    });

    it('refuses an unknown environment (404), an offline machine (503) and a revoked one (403)', async () => {
        expect(await statusOf(machine(K1).fsRequest(E1, list('/work')))).toBe(404);
        const { seat } = connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        expect(await statusOf(machine(K1).fsRequest(E2, list('/work')))).toBe(404);
        seat.drop();
        await until(async () => !(await machine(K1).get()).online, 'offline');
        expect(await statusOf(machine(K1).fsRequest(E1, list('/work')))).toBe(503);
        expect(sockets.frames(K1).filter((f) => f.t === 'fs.request')).toEqual([]);
        await machine(K1, elevated).revoke();
        expect(await statusOf(machine(K1).fsRequest(E1, list('/work')))).toBe(403);
    });

    it('lets only the owner create a worktree: an agent or an external client is refused', async () => {
        await rawDaemon();
        expect(await statusOf(machine(K1, agentP).fsRequest(E1, worktree))).toBe(403);
        expect(await statusOf(machine(K1, external).fsRequest(E1, worktree))).toBe(403);
        expect(sockets.frames(K1).filter((f) => f.t === 'fs.request')).toEqual([]);
        expect(await statusOf(machine(K1).fsRequest(E1, worktree))).toBeUndefined();
    });

    it('records workdir.worktree-created once when a worktree is added — by the owner who asked (OPS-03)', async () => {
        const { respond } = await rawDaemon();
        const { requestId } = await machine(K1).fsRequest(E1, { ...worktree, base: 'main' });
        expect((await machine(K1).fsResult(requestId)).status).toBe('pending');
        expect(await respond(requestId, { result: { kind: 'worktree', path: worktree.path, branch: 'feat/x' } })).toEqual({ ok: true, t: 'fs.response' });
        expect(await machine(K1).fsResult(requestId)).toMatchObject({ status: 'done', result: { kind: 'worktree', path: worktree.path, branch: 'feat/x' } });
        await until(async () => (await worktrees()).length === 1, 'the audit record');
        expect((await worktrees())[0]).toMatchObject({
            key: `${K1}:worktree:${requestId}`,
            by: 'user:u1',
            data: { machineId: M1, environmentId: E1, repo: '/work/app', branch: 'feat/x', path: worktree.path, base: 'main' }
        });

        // A second answer, an answer for an unknown id and a refused worktree record nothing more.
        await respond(requestId, { error: { code: 'internal', message: 'late' } });
        expect((await machine(K1).fsResult(requestId)).status).toBe('done');
        expect(await respond('fs_unknown', { result: { kind: 'worktree', path: '/x', branch: 'y' } })).toEqual({ ok: true, t: 'fs.response' });
        const refused = await machine(K1).fsRequest(E1, worktree);
        await respond(refused.requestId, { error: { code: 'branch-exists', message: 'feat/x exists' } });
        expect(await machine(K1).fsResult(refused.requestId)).toMatchObject({ status: 'error', error: { code: 'branch-exists', message: 'feat/x exists' } });
        // A result of the wrong kind is the daemon's bug, not a worktree.
        const confused = await machine(K1).fsRequest(E1, worktree);
        await respond(confused.requestId, { result: { kind: 'list', path: '/work', entries: [], truncated: false } });
        expect(await machine(K1).fsResult(confused.requestId)).toMatchObject({ status: 'error', error: { code: 'internal' } });
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
        expect(await worktrees()).toHaveLength(1);
    });

    it('times out an unanswered request through the liveness reminder; a late answer still lands', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        sockets.seats.delete(K1); // frames stop reaching the daemon; nothing tells the actor
        const { requestId } = await machine(K1).fsRequest(E1, list('/work'));
        expect((await machine(K1).fsResult(requestId)).status).toBe('pending');
        await advance(TICK);
        expect(await machine(K1).fsResult(requestId)).toMatchObject({ status: 'error', error: { code: 'timeout', message: `no answer from machine ${M1} within 30000 ms` } });

        await machine(K1, asMachine(M1)).socketMessage(JSON.stringify({ v: 1, t: 'fs.response', requestId, result: { kind: 'list', path: '/work', entries: [], truncated: false } }));
        expect(await machine(K1).fsResult(requestId)).toMatchObject({ status: 'done', result: { path: '/work' } });
        expect((await machine(K1).fsResult(requestId)).error).toBeUndefined();
    });

    it('fails pending requests when the daemon disconnects', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        sockets.seats.delete(K1);
        const a = await machine(K1).fsRequest(E1, list('/work'));
        const b = await machine(K1).fsRequest(E1, list('/work/b'));
        await machine(K1, asMachine(M1)).socketClosed();
        for (const { requestId } of [a, b]) expect(await machine(K1).fsResult(requestId)).toMatchObject({ status: 'error', error: { code: 'timeout', message: 'machine went offline' }, finishedAt: expect.any(Number) });
    });

    it(`keeps at most ${MAX_FS_REQUESTS} entries, evicting the oldest, and prunes finished ones after ${FS_RESULT_TTL_MS / 1000} s`, async () => {
        const { respond } = await rawDaemon();
        const ids: string[] = [];
        for (let i = 0; i <= MAX_FS_REQUESTS; i++) {
            vi.setSystemTime(Date.now() + 1);
            ids.push((await machine(K1).fsRequest(E1, list(`/work/${i}`))).requestId);
        }
        expect(await statusOf(machine(K1).fsResult(ids[0]!))).toBe(404);
        for (const id of ids.slice(1)) expect((await machine(K1).fsResult(id)).status).toBe('pending');
        expect(sockets.frames(K1).filter((f) => f.t === 'fs.request')).toHaveLength(MAX_FS_REQUESTS + 1);
        // An evicted request's answer is an unknown id: ignored.
        expect(await respond(ids[0]!, { result: { kind: 'list', path: '/work/0', entries: [], truncated: false } })).toEqual({ ok: true, t: 'fs.response' });
        expect(await statusOf(machine(K1).fsResult(ids[0]!))).toBe(404);

        // Answer one; the reminder fails the rest at their deadline and prunes each finished entry once its TTL passes.
        await respond(ids[1]!, { result: { kind: 'list', path: '/work/1', entries: [], truncated: false } });
        await advance(TICK);
        expect(await machine(K1).fsResult(ids[2]!)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
        expect((await machine(K1).fsResult(ids[1]!)).status).toBe('done');
        await advance(TICK);
        expect(await statusOf(machine(K1).fsResult(ids[1]!))).toBe(404);
        expect((await machine(K1).fsResult(ids[2]!)).status).toBe('error'); // finished a tick later: not yet
    });

    it('evicts a finished entry before any pending one, so a request in flight keeps its answer (#562)', async () => {
        const { respond } = await rawDaemon();
        const ids: string[] = [];
        for (let i = 0; i < MAX_FS_REQUESTS; i++) {
            vi.setSystemTime(Date.now() + 1);
            ids.push((await machine(K1).fsRequest(E1, list(`/work/${i}`))).requestId);
        }
        // The newest answered, the oldest still in flight: room is made by dropping the answered one.
        await respond(ids.at(-1)!, { result: { kind: 'list', path: `/work/${MAX_FS_REQUESTS - 1}`, entries: [], truncated: false } });
        await machine(K1).fsRequest(E1, list('/work/next'));
        expect(await statusOf(machine(K1).fsResult(ids.at(-1)!))).toBe(404);
        for (const id of ids.slice(0, -1)) expect((await machine(K1).fsResult(id)).status).toBe('pending');
    });
});

describe('Machine session files (#562, EXE-08, AGT-09)', () => {
    const agentP: Principal = { kind: 'agent', workspaceId: WS, agentId: 'agent_1', sessionId: 'session_1' } as Principal;
    const ROOT = '/work/project';
    const source = (principal: Principal = owner) => machineWorkspaceSource(machine(K1, principal), E1, ROOT, { base: 'main' });
    const saved = async () => (await app.storage.load('machine', K1))!.state as { fs?: Record<string, { result?: unknown }>; changesSnapshots?: unknown[] };
    const answerOf = async (requestId: string): Promise<FsAnswer[]> => {
        const out: FsAnswer[] = [];
        for await (const a of machine(K1).fsAnswer(requestId)) out.push(a);
        return out;
    };

    it('answers tree, read and changes through machineWorkspaceSource, and keeps the answers off the saved record', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');

        const tree = await source().tree('');
        expect(tree.error).toBeUndefined();
        expect(tree.result).toMatchObject({ kind: 'tree', root: ROOT, path: '', ignoredHidden: true });
        expect(tree.result!.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['README.md', 'src']));
        expect(tree.result!.entries.map((e) => e.name)).not.toContain('dist');

        expect((await source().read('src/app.ts')).result).toMatchObject({ kind: 'read', rev: 'working', text: expect.stringContaining('answer = 42') });
        expect((await source().read('src/app.ts', 'head')).result).toMatchObject({ rev: 'head', text: expect.stringContaining('answer = 41') });
        const sent = sockets.frames(K1).filter((f) => f.t === 'fs.request') as unknown as { op: { kind: string; base?: string } }[];
        expect(sent.map((f) => f.op.kind)).toEqual(['tree', 'read', 'read']);

        const changes = await source().changes('uncommitted');
        expect(changes.result).toMatchObject({ kind: 'changes', scope: 'uncommitted', vcs: 'git', branch: 'feature/files' });
        expect((sockets.frames(K1).at(-1) as unknown as { op: unknown }).op).toEqual({ kind: 'changes', root: ROOT, scope: 'uncommitted', base: 'main' });

        // A session driver reads it too; the record never holds the answers, the live read does.
        expect((await source(agentP).tree('src')).result).toMatchObject({ path: 'src' });
        const records = Object.values((await saved()).fs ?? {});
        expect(records.length).toBeGreaterThan(0);
        for (const r of records) expect(r.result).toBeUndefined();
        const last = sent.length ? (sockets.frames(K1).at(-1) as unknown as { requestId: string }).requestId : '';
        expect(await machine(K1).fsResult(last)).toMatchObject({ status: 'done', result: { kind: 'tree' } });
    });

    it('answers the daemon\'s own refusals, and refuses at the Machine what it can: outside the roots, a daemon without files', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        expect((await machineWorkspaceSource(machine(K1), E1, '/work/plain').changes('uncommitted')).error).toMatchObject({ code: 'not-a-repo' });
        expect((await source().read('../plain/notes.txt')).error).toMatchObject({ code: 'outside-roots' });

        const before = sockets.frames(K1).filter((f) => f.t === 'fs.request').length;
        expect((await machineWorkspaceSource(machine(K1), E1, '/etc').tree('')).error).toMatchObject({ code: 'outside-roots' });
        expect(sockets.frames(K1).filter((f) => f.t === 'fs.request')).toHaveLength(before);

        // Only a session driver asks; the machine itself does not.
        expect(await statusOf(machine(K1, asMachine(M1)).fsRequest(E1, { kind: 'tree', root: ROOT, path: '' }))).toBe(403);
        // A picker id read through the files stream is an internal error, as is an unknown one.
        const picker = await machine(K1).fsRequest(E1, { kind: 'list', path: '/work' });
        expect(await answerOf(picker.requestId)).toEqual([{ error: expect.objectContaining({ code: 'internal' }) }]);
        expect(await answerOf('fs_nobody')).toEqual([{ error: expect.objectContaining({ code: 'internal' }) }]);
    });

    it('answers unsupported without a frame when the daemon lacks the files feature', async () => {
        sockets.connected.add(K1);
        await machine(K1, asMachine(M1)).socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '1', os: 'linux', environments: [inMemoryEnvironment(M1, E1)], capabilities: [], resume: {} }));
        expect((await source().tree('')).error).toMatchObject({ code: 'unsupported' });
        expect(sockets.frames(K1).filter((f) => f.t === 'fs.request')).toHaveLength(0);
    });

    it('times out through the liveness reminder, fails on a disconnect, and keeps the last changes snapshot across both', async () => {
        const { seat } = connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online');
        expect(await machine(K1).changesSnapshot(E1, ROOT, 'uncommitted')).toBeNull();
        await source().changes('uncommitted');
        const snap = await machine(K1).changesSnapshot(E1, ROOT, 'uncommitted');
        expect(snap).toMatchObject({ at: expect.any(Number), result: { kind: 'changes', branch: 'feature/files' } });
        expect(await machine(K1).changesSnapshot(E1, ROOT, 'branch')).toBeNull();
        expect(await statusOf(machine(K1, asMachine(M1)).changesSnapshot(E1, ROOT, 'uncommitted'))).toBe(403);

        sockets.seats.delete(K1); // frames stop reaching the daemon; nothing tells the actor
        const late = await machine(K1).fsRequest(E1, { kind: 'tree', root: ROOT, path: '' });
        const pending = answerOf(late.requestId);
        await advance(TICK);
        expect(await pending).toEqual([{ error: expect.objectContaining({ code: 'timeout' }) }]);

        const cut = await machine(K1).fsRequest(E1, { kind: 'read', root: ROOT, path: 'README.md' });
        seat.drop();
        await machine(K1, asMachine(M1)).socketClosed();
        expect(await answerOf(cut.requestId)).toEqual([{ error: expect.objectContaining({ code: 'timeout', message: 'machine went offline' }) }]);
        expect(await machine(K1).changesSnapshot(E1, ROOT, 'uncommitted')).toEqual(snap);
        expect((await saved()).changesSnapshots).toHaveLength(1);
    });

    it(`keeps at most ${MAX_CHANGES_SNAPSHOTS} snapshots, one per folder and scope, each within ${SNAPSHOT_MAX_FILES} files and ${SNAPSHOT_MAX_COMMITS} commits`, () => {
        const s = initialMachineState();
        const set = (n: number) => ({ kind: 'changes' as const, vcs: 'git', scope: 'uncommitted' as const, files: Array.from({ length: n }, (_, i) => ({ path: `f${i}`, status: 'modified' as const })), commits: [], truncated: false });
        for (let i = 0; i <= MAX_CHANGES_SNAPSHOTS; i++) rememberChanges(s, { environmentId: E1, root: `/work/${i}`, scope: 'uncommitted', at: i, result: set(1) });
        expect(s.changesSnapshots!.map((x) => x.root)).toEqual(Array.from({ length: MAX_CHANGES_SNAPSHOTS }, (_, i) => `/work/${i + 1}`));
        rememberChanges(s, { environmentId: E1, root: '/work/1', scope: 'uncommitted', at: 99, result: set(2) });
        expect(s.changesSnapshots).toHaveLength(MAX_CHANGES_SNAPSHOTS);
        expect(s.changesSnapshots!.at(-1)).toMatchObject({ root: '/work/1', at: 99 });

        expect(snapshotOf(set(3))).toEqual(set(3));
        const big = snapshotOf({ ...set(SNAPSHOT_MAX_FILES + 5), commits: Array.from({ length: SNAPSHOT_MAX_COMMITS + 1 }, (_, i) => ({ id: `${i}`, short: `${i}`, subject: 's', at: i, author: 'a' })) });
        expect(big.files).toHaveLength(SNAPSHOT_MAX_FILES);
        expect(big.commits).toHaveLength(SNAPSHOT_MAX_COMMITS);
        expect(big.truncated).toBe(true);
    });
});

describe('Machine environment management (#237, EXE-03/04, OPS-01/03)', () => {
    const agentP: Principal = { kind: 'agent', workspaceId: WS, agentId: 'agent_1', sessionId: 'session_1' } as Principal;
    const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['machines', 'sessions', 'tasks'] };
    /** The in-memory daemon's default policy: web-managed, inside `/work`. */
    const WORK_POLICY: MachinePolicy = { webManaged: true, allowedRoots: ['/work'] };
    const work = (name = 'Work', cwdRoots = ['/work/app'], extra: object = {}) => ({ name, runtime: 'in-memory', cwdRoots, ...extra });
    const settled = (requestId: string) => until(async () => (await machine(K1).envResult(requestId)).status !== 'pending', `env.response for ${requestId}`);
    const envAudit = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['environment.put', 'environment.removed'] })).events;
    const online = () => until(async () => (await machine(K1).get()).online, 'online');
    const envRequests = () => sockets.frames(K1).filter((f) => f.t === 'env.request');

    /** A daemon this test speaks for by hand: its hello goes in, nothing answers unless the test sends `env.response`. */
    async function rawDaemon(policy?: MachinePolicy) {
        sockets.connected.add(K1);
        const asDaemon = machine(K1, asMachine(M1));
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '1', os: 'linux', environments: [inMemoryEnvironment(M1, E1)], capabilities: [], resume: {}, ...(policy ? { policy } : {}) }));
        const respond = (requestId: string, body: object) => asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'env.response', requestId, ...body }));
        return { asDaemon, respond };
    }

    it('puts and removes an environment over env.request, stores the answer for envResult and records both (OPS-03)', async () => {
        connect(K1, daemon(M1));
        await online();
        expect((await machine(K1).get()).policy).toEqual(WORK_POLICY);

        const { requestId } = await machine(K1).putEnvironment(work());
        expect(requestId).toMatch(/^env_/);
        // Flat on the wire, like the frame schema: `op` beside `environment`.
        expect(envRequests()[0]).toEqual({ v: 1, t: 'env.request', requestId, op: 'put', environment: work() });
        await settled(requestId);
        const done = await machine(K1).envResult(requestId);
        expect(done).toEqual({ requestId, op: { op: 'put', environment: work() }, status: 'done', requestedAt: expect.any(Number), finishedAt: expect.any(Number), result: { environmentId: expect.any(String) } });
        const created = done.result!.environmentId;
        // The daemon's `env` frame went first: the list already has it.
        expect((await machine(K1).get()).environments.find((e) => e.id === created)).toMatchObject({ name: 'Work', cwdRoots: ['/work/app'] });

        // The same id again changes it in place.
        const changed = await machine(K1).putEnvironment(work('Work 2', ['/work/app', '/work/lib'], { id: created, concurrency: 2 }));
        await settled(changed.requestId);
        expect((await machine(K1).get()).environments.find((e) => e.id === created)).toMatchObject({ name: 'Work 2', cwdRoots: ['/work/app', '/work/lib'], concurrency: { max: 2 } });

        const removed = await machine(K1).removeEnvironment(created);
        await settled(removed.requestId);
        expect(await machine(K1).envResult(removed.requestId)).toMatchObject({ status: 'done', op: { op: 'remove', environmentId: created }, result: { environmentId: created } });
        expect((await machine(K1).get()).environments.map((e) => e.id)).toEqual([E1]);

        await until(async () => (await envAudit()).length === 3, 'three audit records');
        const events = await envAudit();
        expect(events.find((e) => e.key === `${K1}:env:${requestId}`)).toMatchObject({
            kind: 'environment.put',
            by: 'user:u1',
            data: { machineId: M1, environmentId: created, name: 'Work', runtime: 'in-memory', cwdRoots: ['/work/app'], outcome: 'ok' }
        });
        expect(events.find((e) => e.key === `${K1}:env:${removed.requestId}`)).toMatchObject({ kind: 'environment.removed', by: 'user:u1', data: { machineId: M1, environmentId: created, outcome: 'ok' } });
    });

    it("passes the daemon's refusal through unchanged, and records it with the roots that were asked for", async () => {
        connect(K1, daemon(M1));
        await online();
        const outside = await machine(K1).putEnvironment(work('Etc', ['/etc']));
        await settled(outside.requestId);
        expect(await machine(K1).envResult(outside.requestId)).toMatchObject({ status: 'error', error: { code: 'outside-allowed-roots' } });
        const runtime = await machine(K1).putEnvironment({ ...work(), runtime: 'claude-code' });
        await settled(runtime.requestId);
        expect(await machine(K1).envResult(runtime.requestId)).toMatchObject({ status: 'error', error: { code: 'unknown-runtime' } });
        expect((await machine(K1).get()).environments.map((e) => e.id)).toEqual([E1]);

        await until(async () => (await envAudit()).length === 2, 'the refusals on the audit log');
        expect((await envAudit()).find((e) => e.key === `${K1}:env:${outside.requestId}`)).toMatchObject({ kind: 'environment.put', data: { cwdRoots: ['/etc'], outcome: 'outside-allowed-roots' } });
    });

    it('follows the policy the machine reports: off at hello, turned on on the machine (env)', async () => {
        const d = inMemoryHarness({ machineId: M1, environments: [inMemoryEnvironment(M1, E1)], policy: { webManaged: false, allowedRoots: [] } }).start({ events: 3, heartbeatMs: 600_000 }) as InMemoryDaemon;
        daemons.push(d);
        connect(K1, d);
        await online();
        expect((await machine(K1).get()).policy).toEqual({ webManaged: false, allowedRoots: [] });
        const refused = await machine(K1).putEnvironment(work());
        await settled(refused.requestId);
        expect(await machine(K1).envResult(refused.requestId)).toMatchObject({ status: 'error', error: { code: 'policy-disabled' } });

        d.setPolicy(WORK_POLICY);
        await until(async () => (await machine(K1).get()).policy?.webManaged === true, 'the policy from env');
        const ok = await machine(K1).putEnvironment(work());
        await settled(ok.requestId);
        expect((await machine(K1).envResult(ok.requestId)).status).toBe('done');
    });

    it('keeps no policy for a daemon that reports none (it predates web-managed environments)', async () => {
        await rawDaemon(WORK_POLICY);
        expect((await machine(K1).get()).policy).toEqual(WORK_POLICY);
        // A reconnect by an older daemon: nothing stale is kept.
        await rawDaemon();
        expect((await machine(K1).get()).policy).toBeUndefined();
    });

    it('lets only the owner ask or read: agents, machines, external clients and other workspaces are refused (decisions 2026-09-19 (c))', async () => {
        connect(K1, daemon(M1));
        await online();
        const { requestId } = await machine(K1).putEnvironment(work());
        for (const p of [agentP, asMachine(M1), external, userPrincipal('u2')]) {
            expect(await statusOf(machine(K1, p).putEnvironment(work('Sneaky', ['/work'])))).toBe(403);
            expect(await statusOf(machine(K1, p).removeEnvironment(E1))).toBe(403);
            expect(await statusOf(machine(K1, p).envResult(requestId))).toBe(403);
        }
        expect(await statusOf(machine(K1, null).putEnvironment(work()))).toBe(401);
        expect(envRequests()).toHaveLength(1);
    });

    it('refuses a malformed input before anything is sent: a profile directory is never accepted over the wire', async () => {
        await rawDaemon(WORK_POLICY);
        expect(await statusOf(machine(K1).putEnvironment(work('Work', ['/work'], { profileDir: '/home/me/.claude' }) as never))).toBe(400);
        expect(await statusOf(machine(K1).putEnvironment(work('Work', [])))).toBe(400);
        expect(await statusOf(machine(K1).putEnvironment({ runtime: 'in-memory', cwdRoots: ['/work'] } as never))).toBe(400);
        expect(envRequests()).toEqual([]);
        expect(await statusOf(machine(K1).envResult('env_nope'))).toBe(404);
    });

    it('refuses offline (503 machine-offline), revoked (403), an unknown environment (404) and one in use (409)', async () => {
        const offline = await machine(K1)
            .putEnvironment(work())
            .then(() => null)
            .catch((e: unknown) => e as { status?: number; message?: string });
        expect(offline?.status).toBe(503);
        expect(offline?.message).toContain(MACHINE_OFFLINE_CODE);

        connect(K1, daemon(M1, undefined, { tool: { name: 'hold', input: {} } }));
        await online();
        expect(await statusOf(machine(K1).removeEnvironment(E2))).toBe(404);
        const s1 = app.as(owner).actor(Session, actorKey(WS, 'session', 'session_1'));
        await s1.open({ agentId: config.agentId, runtime: 'in-memory', environmentId: E1, machineId: M1, config });
        await machine(K1).openSession('session_1' as SessionId, E1, openSpec);
        await until(async () => (await machine(K1).get()).activeSessions[0]?.status === 'open', 'session.opened');
        // In use means a turn running there (#394) — and the refusal names it.
        const release = holdTurns();
        await s1.prompt('go', 't1');
        await until(async () => (await machine(K1).get()).activeSessions[0]?.running !== undefined, 'the turn running');
        const inUse = await machine(K1)
            .removeEnvironment(E1)
            .then(() => null)
            .catch((e: unknown) => e as { status?: number; message?: string });
        expect(inUse?.status).toBe(409);
        expect(inUse?.message).toMatch(/^in-use: environment "env_1" on machine "machine_1" has work in it — running: session session_1 \(agent agent_1, turn t1\)$/);
        expect(envRequests()).toEqual([]);
        release();

        await machine(K1, elevated).revoke();
        expect(await statusOf(machine(K1).putEnvironment(work()))).toBe(403);
        // Revoked wins over what the machine last reported: not 409 for the busy one, not 404 for an unknown one.
        expect(await statusOf(machine(K1).removeEnvironment(E1))).toBe(403);
        expect(await statusOf(machine(K1).removeEnvironment(E2))).toBe(403);
    });

    it('removes an environment whose sessions are all idle (#394): they are closed ahead of the request, a queued open still refuses', async () => {
        const S1 = 'session_1' as SessionId;
        const S2 = 'session_2' as SessionId;
        const S3 = 'session_3' as SessionId;
        const record = (id: SessionId, environmentId: EnvironmentId) => app.as(owner).actor(Session, actorKey(WS, 'session', id)).open({ agentId: config.agentId, runtime: 'in-memory', environmentId, machineId: M1, config });
        connect(K1, daemon(M1, [{ ...inMemoryEnvironment(M1, E1), concurrency: { max: 1, active: 0 } }, inMemoryEnvironment(M1, E2)], { tool: { name: 'hold', input: {} } }));
        await online();
        await record(S1, E1);
        await record(S2, E2);
        await record(S3, E1);
        await machine(K1).openSession(S1, E1, openSpec);
        await machine(K1).openSession(S2, E2, openSpec);
        await until(async () => (await machine(K1).get()).activeSessions.filter((h) => h.status === 'open').length === 2, 'both opened');

        // A session queued for the environment is work waiting to run there: refused, and named.
        const release = holdTurns();
        await app.as(owner).actor(Session, actorKey(WS, 'session', S1)).prompt('go', 't1');
        await until(async () => (await machine(K1).get()).activeSessions.find((h) => h.sessionId === S1)?.running !== undefined, 'S1 running');
        expect(await machine(K1).openSession(S3, E1, openSpec, { taskId: 'task_3' as never })).toBe('queued');
        const refused = await machine(K1)
            .removeEnvironment(E1)
            .then(() => null)
            .catch((e: unknown) => e as { status?: number; message?: string });
        expect(refused?.status).toBe(409);
        expect(refused?.message).toContain('running: session session_1 (agent agent_1, turn t1)');
        expect(refused?.message).toContain('queued: session session_3 (agent agent_1, task task_3)');
        await machine(K1).closeSession(S3);
        release();
        await until(async () => (await machine(K1).get()).activeSessions.find((h) => h.sessionId === S1)?.running === undefined, 'the turn to end');

        // Only idle sessions left in E1: removable. The idle one is closed on the same socket, ahead of the request; E2's is untouched.
        const { requestId } = await machine(K1).removeEnvironment(E1);
        const kinds = sockets.frames(K1).map((f) => f.t);
        expect(kinds.indexOf('session.close')).toBeLessThan(kinds.indexOf('env.request'));
        expect(sockets.frames(K1).filter((f) => f.t === 'session.close')).toEqual([expect.objectContaining({ sessionId: S1 })]);
        await settled(requestId);
        expect(await machine(K1).envResult(requestId)).toMatchObject({ status: 'done', result: { environmentId: E1 } });
        await until(async () => (await machine(K1).get()).environments.map((e) => e.id).join() === E2, 'E1 gone from the descriptors');
        const m = await machine(K1).get();
        expect(m.activeSessions.map((h) => h.sessionId)).toEqual([S2]);
        // The queued open dropped earlier, then the idle session the removal closed.
        expect(m.closures.map((c) => c.sessionId)).toEqual([S3, S1]);
    });

    it('checks removeEnvironment like fsRequest: revoked, then unknown environment, then offline', async () => {
        const { seat } = connect(K1, daemon(M1));
        await online();
        seat.drop();
        await until(async () => !(await machine(K1).get()).online, 'offline');
        expect(await statusOf(machine(K1).removeEnvironment(E2))).toBe(404);
        expect(await statusOf(machine(K1).removeEnvironment(E1))).toBe(503);
        expect(envRequests()).toEqual([]);
    });

    it('times out an unanswered request through the liveness reminder; a late answer still lands and is recorded once', async () => {
        const { respond } = await rawDaemon(WORK_POLICY);
        const { requestId } = await machine(K1).putEnvironment(work());
        expect((await machine(K1).envResult(requestId)).status).toBe('pending');
        await advance(TICK);
        expect(await machine(K1).envResult(requestId)).toMatchObject({ status: 'error', error: { code: 'timeout', message: `no answer from machine ${M1} within ${DEFAULT_ENV_TIMEOUT_MS} ms` } });

        await respond(requestId, { result: { environmentId: 'env_late' } });
        expect(await machine(K1).envResult(requestId)).toMatchObject({ status: 'done', result: { environmentId: 'env_late' } });
        expect((await machine(K1).envResult(requestId)).error).toBeUndefined();
        await until(async () => (await envAudit()).length === 1, 'the late answer on the audit log');
        // A second answer, and an answer for an unknown id, change nothing and record nothing.
        await respond(requestId, { error: { code: 'io', message: 'late' } });
        expect(await respond('env_unknown', { result: { environmentId: 'env_x' } })).toEqual({ ok: true, t: 'env.response' });
        expect((await machine(K1).envResult(requestId)).status).toBe('done');
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
        expect(await envAudit()).toHaveLength(1);
    });

    it('fails pending requests when the daemon disconnects', async () => {
        await rawDaemon(WORK_POLICY);
        const a = await machine(K1).putEnvironment(work());
        const b = await machine(K1).removeEnvironment(E1);
        await machine(K1, asMachine(M1)).socketClosed();
        for (const { requestId } of [a, b]) expect(await machine(K1).envResult(requestId)).toMatchObject({ status: 'error', error: { code: 'timeout', message: 'machine went offline' }, finishedAt: expect.any(Number) });
    });

    it(`keeps at most ${MAX_ENV_REQUESTS} requests, evicting the oldest, and prunes finished ones after ${ENV_RESULT_TTL_MS / 1000} s`, async () => {
        const { respond } = await rawDaemon(WORK_POLICY);
        const ids: string[] = [];
        for (let i = 0; i <= MAX_ENV_REQUESTS; i++) {
            vi.setSystemTime(Date.now() + 1);
            ids.push((await machine(K1).putEnvironment(work(`W${i}`))).requestId);
        }
        expect(await statusOf(machine(K1).envResult(ids[0]!))).toBe(404);
        for (const id of ids.slice(1)) expect((await machine(K1).envResult(id)).status).toBe('pending');
        await respond(ids[1]!, { result: { environmentId: 'env_w1' } });
        await advance(TICK);
        expect(await machine(K1).envResult(ids[2]!)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
        expect((await machine(K1).envResult(ids[1]!)).status).toBe('done');
        await advance(TICK);
        expect(await statusOf(machine(K1).envResult(ids[1]!))).toBe(404);
    });
});

describe('Machine quota (#268, OPS-07)', () => {
    const win = (id: string, utilization: number, status = 'ok') => ({ id, label: id, period: 'week', utilization, unit: 'percent', status });
    const snapshot = (environmentId: EnvironmentId, windows: object[], extra: object = {}) => ({ sourceId: 'agentic.quota.claude-code', runtime: 'claude-code', environmentId, availability: 'reported', windows, observedAt: Date.now(), via: 'probe', ...extra });
    const hello = (environments = [inMemoryEnvironment(M1, E1), inMemoryEnvironment(M1, E2)]) => JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '1', os: 'linux', environments, capabilities: [], resume: {} });

    /** A daemon this test speaks for by hand. */
    async function rawDaemon() {
        sockets.connected.add(K1);
        const asDaemon = machine(K1, asMachine(M1));
        await asDaemon.socketMessage(hello());
        const quota = (environmentId: EnvironmentId, windows: object[], extra: object = {}) => asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'quota', environmentId, snapshot: snapshot(environmentId, windows, extra) }));
        return { asDaemon, quota };
    }

    it('stores a probe snapshot, merges a stream update into it, and saves in the turn', async () => {
        const { quota } = await rawDaemon();
        expect((await machine().get()).quota).toBeUndefined();
        expect(await quota(E1, [win('five_hour', 0.19), win('seven_day', 0.76)], { plan: 'max' })).toMatchObject({ ok: true, t: 'quota' });
        await quota(E1, [win('five_hour', 0.9, 'warning')], { availability: 'partial', via: 'stream' });
        const stored = (await machine().get()).quota![E1]!;
        expect(stored.windows.map((w) => [w.id, w.utilization, w.status])).toEqual([
            ['five_hour', 0.9, 'warning'],
            ['seven_day', 0.76, 'ok']
        ]);
        expect(stored).toMatchObject({ plan: 'max', availability: 'reported', via: 'stream' });
        const saved = (await app.storage.load('machine', K1))!.state as { quota?: Record<string, unknown> };
        expect(saved.quota?.[E1]).toEqual(stored);
    });

    it('quota() lists every environment, null until reported; one environment on request, 404 for an unknown one', async () => {
        const { quota } = await rawDaemon();
        await quota(E2, [], { availability: 'not-reported', reason: 'API-key login' });
        const view = await machine().quota();
        expect(view).toMatchObject({ machineId: M1, online: true });
        expect(view.environments.map((e) => [e.environmentId, e.snapshot?.availability ?? null])).toEqual([
            [E1, null],
            [E2, 'not-reported']
        ]);
        expect((await machine().quota(E2)).environments).toHaveLength(1);
        expect(await statusOf(machine().quota('env_nope' as EnvironmentId))).toBe(404);
    });

    it('ignores a snapshot for an environment the machine does not report, and prunes one whose environment is dropped', async () => {
        const { asDaemon, quota } = await rawDaemon();
        await quota('env_nope' as EnvironmentId, [win('five_hour', 0.5)]);
        expect((await machine().get()).quota).toBeUndefined();
        await quota(E1, [win('five_hour', 0.5)]);
        await quota(E2, [win('five_hour', 0.6)]);
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'env', environments: [inMemoryEnvironment(M1, E1)] }));
        expect(Object.keys((await machine().get()).quota!)).toEqual([E1]);
        await asDaemon.socketMessage(hello([inMemoryEnvironment(M1, E2)]));
        expect((await machine().get()).quota).toBeUndefined();
        expect(((await app.storage.load('machine', K1))!.state as { quota?: unknown }).quota).toBeUndefined();
    });

    it('keeps the last snapshot while the machine is offline', async () => {
        const { asDaemon, quota } = await rawDaemon();
        await quota(E1, [win('seven_day', 0.76)]);
        await asDaemon.socketClosed();
        const view = await machine().quota(E1);
        expect(view.online).toBe(false);
        expect(view.environments[0]!.snapshot?.windows[0]?.utilization).toBe(0.76);
    });

    it('is read under the machines reader rule: an external client needs the machines scope', async () => {
        await rawDaemon();
        const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['usage'] };
        expect(await statusOf(app.as(external).actor(Machine, K1).quota())).toBe(403);
        expect(await statusOf(app.as({ ...external, scopes: ['machines'] }).actor(Machine, K1).quota())).toBeUndefined();
        expect(await statusOf(app.as(userPrincipal('u2')).actor(Machine, K1).quota())).toBe(403);
    });

    it('a real daemon reports its limits once welcomed', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine().get()).quota?.[E1] !== undefined, 'the in-memory daemon quota frame');
        expect((await machine().get()).quota![E1]).toMatchObject({ availability: 'not-reported', via: 'probe' });
    });
});

describe('Machine telemetry (#400)', () => {
    const GiB = 2 ** 30;
    const sample = (rss: number, cpu: number | null = 0.1) => ({ cpu, rss, processes: 2 });
    const snapshot = (sessions: Record<string, unknown>, environments: Record<string, unknown> = {}, extra: object = {}) => ({
        observedAt: Date.now(),
        intervalMs: 30_000,
        cpus: 8,
        machine: { cpu: 0.3, memoryUsed: 8 * GiB, memoryTotal: 32 * GiB },
        daemon: sample(80_000_000, 0.01),
        environments,
        sessions,
        availability: 'reported',
        ...extra
    });
    const hello = (environments = [inMemoryEnvironment(M1, E1), inMemoryEnvironment(M1, E2)]) => JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '1', os: 'linux', environments, capabilities: [], resume: {} });
    const spec: OpenSpec = { agentId: 'agent_1', cwd: '/work', system: '', tools: [] };

    /** A daemon this test speaks for by hand, hosting `s1` in E1 (asked for, not yet acknowledged) and `s2` in E2. */
    async function rawDaemon() {
        sockets.connected.add(K1);
        const asDaemon = machine(K1, asMachine(M1));
        await asDaemon.socketMessage(hello());
        expect(await machine().openSession('s1' as SessionId, E1, spec)).toBe('opened');
        expect(await machine().openSession('s2' as SessionId, E2, spec)).toBe('opened');
        const telemetry = (sessions: Record<string, unknown>, environments: Record<string, unknown> = {}, extra: object = {}) => asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'telemetry', snapshot: snapshot(sessions, environments, extra) }));
        return { asDaemon, telemetry };
    }

    it('stores the snapshot as a whole, unknowns as null, and saves in the turn', async () => {
        const { telemetry } = await rawDaemon();
        expect((await machine().get()).telemetry).toBeUndefined();
        expect(await telemetry({ s1: sample(GiB), s2: null }, { [E1]: { sample: sample(GiB), attribution: 'session' }, [E2]: { sample: null, attribution: 'none' } }, { availability: 'partial' })).toMatchObject({ ok: true, t: 'telemetry' });
        const stored = (await machine().get()).telemetry!;
        expect(stored).toMatchObject({ availability: 'partial', cpus: 8, sessions: { s1: { rss: GiB }, s2: null }, environments: { [E2]: { sample: null, attribution: 'none' } } });
        expect(stored.machine).toEqual({ cpu: 0.3, memoryUsed: 8 * GiB, memoryTotal: 32 * GiB });
        const saved = (await app.storage.load('machine', K1))!.state as { telemetry?: unknown };
        expect(saved.telemetry).toEqual(stored);
        // The next snapshot replaces, never merges.
        await telemetry({ s1: sample(2 * GiB) }, {});
        expect((await machine().get()).telemetry!.sessions).toEqual({ s1: sample(2 * GiB) });
    });

    it('prunes sessions the machine no longer hosts and environments it no longer reports', async () => {
        const { asDaemon, telemetry } = await rawDaemon();
        // `toString` is a session id off the wire like any other: only hosted ids are kept, never a prototype's.
        await telemetry({ s1: sample(GiB), s2: sample(GiB), s_nope: sample(GiB), toString: sample(GiB) }, { [E1]: { sample: sample(GiB), attribution: 'session' }, [E2]: { sample: sample(GiB), attribution: 'environment' }, env_nope: { sample: null, attribution: 'none' } });
        let stored = (await machine().get()).telemetry!;
        expect(Object.keys(stored.sessions).sort()).toEqual(['s1', 's2']);
        expect(Object.keys(stored.environments).sort()).toEqual([E1, E2]);
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: 's2', reason: 'done' }));
        stored = (await machine().get()).telemetry!;
        expect(Object.keys(stored.sessions)).toEqual(['s1']);
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'env', environments: [inMemoryEnvironment(M1, E1)] }));
        stored = (await machine().get()).telemetry!;
        expect(Object.keys(stored.environments)).toEqual([E1]);
        expect(stored.machine.memoryTotal).toBe(32 * GiB);
    });

    it('keeps the last snapshot while the machine is offline, and get() carries it', async () => {
        const { asDaemon, telemetry } = await rawDaemon();
        await telemetry({ s1: sample(GiB), s2: null });
        await asDaemon.socketClosed();
        const view = await machine().get();
        expect(view.online).toBe(false);
        expect(view.telemetry?.sessions).toEqual({ s1: sample(GiB), s2: null });
    });

    it('a real daemon reports its load once welcomed', async () => {
        connect(K1, daemon(M1));
        await until(async () => (await machine().get()).telemetry !== undefined, 'the in-memory daemon telemetry frame');
        expect((await machine().get()).telemetry).toMatchObject({ availability: 'not-reported', reason: expect.stringContaining('in-memory') });
    });
});

describe('Machine offline and closed sessions (#366)', () => {
    const S1 = 'session_1' as SessionId;
    const sessionSpec: SessionOpenSpec = { agentId: config.agentId, runtime: 'in-memory', environmentId: E1, machineId: M1, config };
    const session = () => app.as(owner).actor(Session, actorKey(WS, 'session', S1));
    /** What the router heard, in order. */
    let heard: string[];

    beforeEach(async () => {
        await app.stop();
        heard = [];
        const Routing = defineActor({
            type: 'routing',
            state: () => ({}),
            methods: () => ({
                machineOnline: (id: MachineId) => void heard.push(`online:${id}`),
                machineOffline: (id: MachineId) => void heard.push(`offline:${id}`),
                sessionOpened: () => undefined,
                sessionClosed: (id: SessionId, reason: string) => void heard.push(`closed:${id}:${reason}`),
                slotFreed: () => undefined,
                promptRefused: () => undefined
            })
        });
        const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
        Session = defineSessionActor({ factory: () => null, commands: sink });
        Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, heartbeatWindowMs: 90_000, commandTimeoutMs: 120_000 });
        heardByChat = [];
        const ChatStub = defineActor({
            type: 'chat-stub',
            allowAnonymous: true,
            state: () => ({}),
            methods: () => ({}),
            subscriptions: { [SESSION_EVENTS_TOPIC]: (_ctx, event) => void heardByChat.push(event.payload as SessionEvent) }
        });
        app = testActorApp([Machine, Session, Workspace, PairingDirectory, AuditActor, Routing, ChatStub], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
        await app.start();
    });
    /** What the sessions told their chats. */
    let heardByChat: SessionEvent[];

    /** A daemon the test speaks for itself: its hello, then whatever frames the test sends. */
    async function rawDaemon() {
        sockets.connected.add(K1);
        const asDaemon = machine(K1, asMachine(M1));
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '1', os: 'linux', environments: [inMemoryEnvironment(M1, E1)], capabilities: [], resume: {} }));
        return asDaemon;
    }

    /** `S1` opened on the raw daemon and named `real` by its runtime. */
    async function opened(asDaemon: Awaited<ReturnType<typeof rawDaemon>>, spec: SessionOpenSpec = sessionSpec) {
        await session().open(spec);
        await machine(K1).openSession(S1, E1, openSpec);
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.opened', sessionId: S1, ref: { agent: 'in-memory', v: 1, id: S1 }, capabilities: IN_MEMORY_CAPABILITIES, head: { epoch: 0, seq: 0 } }));
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.ref', sessionId: S1, ref: { agent: 'in-memory', v: 1, id: 'real' } }));
    }

    it("hands the runtime's title for a hosted session to its record, which tells the chat (#460); one for a session it does not host is ignored", async () => {
        const asDaemon = await rawDaemon();
        await opened(asDaemon, { ...sessionSpec, chatId: 'chat_1' as never });
        expect(await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.title', sessionId: S1, title: 'Chat list titles' }))).toMatchObject({ ok: true });
        await until(() => heardByChat.some((e) => e.kind === 'title'), 'the chat to hear the title');
        expect(heardByChat.at(-1)).toMatchObject({ kind: 'title', sessionId: S1, title: 'Chat list titles' });
        const count = heardByChat.length;
        expect(await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.title', sessionId: 'session_9', title: 'Nobody' }))).toMatchObject({ ok: true });
        expect(heardByChat).toHaveLength(count);
    });

    it('tells the router it went offline: at once when the socket closes, and past the heartbeat window when the daemon falls silent', async () => {
        const { seat } = connect(K1, daemon(M1));
        await until(() => heard.includes(`online:${M1}`), 'the router to hear the hello');
        seat.drop();
        await until(() => heard.includes(`offline:${M1}`), 'the router to hear the close');
        // Once per going away: a second close says nothing new.
        await machine(K1, asMachine(M1)).socketClosed();

        connect(K1, daemon(M1));
        await until(async () => (await machine(K1).get()).online, 'online again');
        sockets.seats.delete(K1); // frames stop flowing both ways; nothing tells the actor
        await advance(TICK);
        expect(heard.filter((h) => h === `offline:${M1}`)).toHaveLength(1);
        await advance(TICK);
        await until(() => heard.filter((h) => h === `offline:${M1}`).length === 2, 'the router to hear the silence');
    });

    it('carries the daemon’s close code to the record: the running turn is interrupted with it', async () => {
        const asDaemon = await rawDaemon();
        await opened(asDaemon);
        await session().prompt('hello', 't1');
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.reply', sessionId: S1, reply: { v: WIRE_PROTOCOL_VERSION, kind: 'ack', commandId: 't1', turnId: 't1' } }));
        expect((await session().get()).running?.turnId).toBe('t1');

        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: S1, reason: 'updating', code: 'update' }));
        expect(await session().get()).toMatchObject({ status: 'idle', ref: { id: 'real' } });
        expect((await session().events()).find((e) => e.type === 'error')).toMatchObject({ message: 'interrupted: updating', data: { interrupted: true, host: 'update' } });
        await until(() => heard.includes(`closed:${S1}:updating`), 'the router to hear the close');
    });

    it('a re-open the daemon refuses closes the record, ref and all — with resume-failed, or any close while a resume is opening', async () => {
        const asDaemon = await rawDaemon();
        await session().open(sessionSpec);
        await app.as(asMachine(M1)).actor(Session, actorKey(WS, 'session', S1)).noteRef({ agent: 'in-memory', v: 1, id: 'real' });
        // Re-opened from its ref (#393): the entry is `opening` until the daemon answers.
        await machine(K1).openSession(S1, E1, { ...openSpec, resume: { agent: 'in-memory', v: 1, id: 'real' } });
        expect((await machine(K1).get()).activeSessions[0]?.status).toBe('opening');
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: S1, reason: 'cannot resume real' }));
        expect(await session().get()).toMatchObject({ status: 'closed', ref: { id: 'real' } });
        expect((await machine(K1).get()).activeSessions).toEqual([]);

        // A first open refused for another reason leaves the record as it was: nothing had opened.
        const S2 = 'session_2' as SessionId;
        const second = app.as(owner).actor(Session, actorKey(WS, 'session', S2));
        await second.open(sessionSpec);
        await machine(K1).openSession(S2, E1, openSpec);
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: S2, reason: 'no room', code: 'draining' }));
        expect((await second.get()).status).toBe('idle');

        // `resume-failed` closes one opened without a ref too.
        const S3 = 'session_3' as SessionId;
        const third = app.as(owner).actor(Session, actorKey(WS, 'session', S3));
        await third.open(sessionSpec);
        await machine(K1).openSession(S3, E1, openSpec);
        await asDaemon.socketMessage(JSON.stringify({ v: 1, t: 'session.closed', sessionId: S3, reason: 'cannot resume', code: 'resume-failed' }));
        expect((await third.get()).status).toBe('closed');
    });

    it('closing a session while the daemon is offline lets it go: the record is told its host ended', async () => {
        const asDaemon = await rawDaemon();
        await opened(asDaemon);
        sockets.connected.delete(K1);
        await asDaemon.socketClosed();
        await machine(K1).closeSession(S1);
        expect((await machine(K1).get()).activeSessions).toEqual([]);
        expect(await session().get()).toMatchObject({ status: 'idle', ref: { id: 'real' } });
        await until(() => heard.some((h) => h.startsWith(`closed:${S1}:`)), 'the router to hear the close');
    });
});
