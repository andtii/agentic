/**
 * The machine owns a daemon session's history (#397): the record keeps the
 * newest `RETAINED_PAGES` pages, forgets the rest — the `SessionPage` record
 * deleted — and reads a forgotten range from the machine's own log through
 * `history.request` / `history.response`. A hole is never silent: a log that
 * no longer reaches back is `history-gap`, a machine that cannot be asked is
 * `history-unavailable`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorKey, type EnvironmentId, type FrozenAgentConfig, type MachineId, type OpenSpec, type Principal, type SessionId, type WorkspaceId } from '@agentic/core';
import { decodeDaemonFrame, type DaemonFrame } from '@agentic/daemon-protocol';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import type { AgentEvent } from '@sigx/ai-agent';

import { DEFAULT_HISTORY_TIMEOUT_MS, defineMachineActor, machineHistorySource, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { applySessionEntry, defineSessionActor, RETAINED_PAGES, SessionPage, sessionPageKey, type CommandSink, type SessionEntry, type SessionOpenSpec, type SessionState } from '../../src/session/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const M1 = 'machine_1' as MachineId;
const E1 = 'env_1' as EnvironmentId;
const K1 = machineKey(WS, M1);
const S1 = 'session_1' as SessionId;
const SESSION_KEY = actorKey(WS, 'session', S1);
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
const sessionSpec: SessionOpenSpec = { agentId: config.agentId, runtime: 'in-memory', environmentId: E1, machineId: M1, config };

/** A fake socket layer bridged to an `InMemoryDaemon` seat. */
class FakeSockets implements MachineSocketPort {
    readonly sent = new Map<string, string[]>();
    readonly seats = new Map<string, PlatformSeat>();
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

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!(await check())) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let sockets: FakeSockets;
let scheduler: ManualScheduler;
let Machine: ReturnType<typeof defineMachineActor>;
let Session: ReturnType<typeof defineSessionActor>;
const daemons: InMemoryDaemon[] = [];
/** Every event frame the daemon sent the platform, in order — what the session emitted. */
let streamed: AgentEvent[];

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sockets = new FakeSockets();
    scheduler = manualScheduler();
    streamed = [];
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({ factory: () => null, commands: sink, history: machineHistorySource(() => Machine) });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, heartbeatWindowMs: 90_000, commandTimeoutMs: 120_000 });
    app = testActorApp([Machine, Session, SessionPage], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
    vi.useRealTimers();
});

const machine = (principal: Principal | null = owner) => app.as(principal).actor(Machine, K1);
const session = () => app.as(owner).actor(Session, SESSION_KEY);

/** Connect a fake daemon to the machine: its frames go to `socketMessage`, the event frames are kept in `streamed`. */
function connect(daemon: InMemoryDaemon): PlatformSeat {
    const ids = parseMachineKey(K1)!;
    const seat = daemon.dial();
    sockets.seats.set(K1, seat);
    sockets.connected.add(K1);
    const asDaemon = machine(asMachine(ids.machineId));
    void (async () => {
        try {
            for (;;) {
                const text = (await seat.next()) as string;
                const decoded = decodeDaemonFrame(text);
                const frame = decoded.ok ? (decoded.frame as DaemonFrame) : undefined;
                if (frame?.t === 'session.frame' && frame.frame.kind === 'event') streamed.push(frame.frame.event);
                await asDaemon.socketMessage(text);
            }
        } catch {
            // dropped
        }
        if (sockets.seats.get(K1) === seat) {
            sockets.seats.delete(K1);
            sockets.connected.delete(K1);
            await asDaemon.socketClosed().catch(() => {});
        }
    })();
    return seat;
}

function daemon(script: { events: number; deltaChars?: number }): InMemoryDaemon {
    const d = inMemoryHarness({ machineId: M1, environments: [inMemoryEnvironment(M1, E1)], ...(script.deltaChars ? { deltaChars: script.deltaChars } : {}) }).start({ events: script.events, heartbeatMs: 600_000 }) as InMemoryDaemon;
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

/** The record as storage holds it, folded the way a load folds it. */
async function storedState(): Promise<SessionState> {
    const record = await app.storage.load('session', SESSION_KEY);
    const state = structuredClone(record!.state) as SessionState;
    for (const entry of record!.log ?? []) applySessionEntry(state, entry as SessionEntry);
    return state;
}

const historyRequests = () => sockets.frames(K1).filter((f) => f.t === 'history.request').length;

/** A hosted session that streamed two turns of 8 KB deltas — about 5.6 MB, past `RETAINED_PAGES` pages behind the window. */
async function paged(): Promise<{ state: SessionState; forgotten: number[] }> {
    connect(daemon({ events: 350, deltaChars: 8192 }));
    await until(async () => (await machine().get()).online, 'online');
    await session().open(sessionSpec);
    expect(await machine().openSession(S1, E1, openSpec)).toBe('opened');
    await until(async () => (await machine().get()).activeSessions[0]?.status === 'open', 'session.opened');
    for (const turnId of ['t1', 't2']) {
        await session().prompt('go', turnId);
        await until(async () => (await session().get()).running?.turnId === turnId, `the ${turnId} ack`);
        await until(async () => !(await session().get()).running, `${turnId} to end`, 60_000);
    }
    const state = await storedState();
    const kept = new Set((state.pages ?? []).map((p) => p.page));
    const forgotten = Array.from({ length: Math.max(...kept) + 1 }, (_, n) => n).filter((n) => !kept.has(n));
    return { state, forgotten };
}

describe('the machine owns a daemon session’s history (#397)', { timeout: 120_000 }, () => {
    it('keeps RETAINED_PAGES pages, deletes the older page records, and still answers events() for the forgotten range from the machine — the same events the session emitted', async () => {
        const { state, forgotten } = await paged();
        expect(streamed.length).toBe(700);
        expect(state.pages).toHaveLength(RETAINED_PAGES);
        expect(forgotten.length).toBeGreaterThan(0);
        expect(forgotten).toEqual(Array.from({ length: forgotten.length }, (_, n) => n));
        // The frontier: the last cursor of the newest forgotten page; the count still says everything.
        const info = await session().get();
        expect(info.archivedTo).toBeDefined();
        expect(info.eventCount).toBe(streamed.length);
        // Forgetting a page deleted its record; the kept ones are there.
        for (const n of forgotten) expect(await app.storage.load('session-page', sessionPageKey(SESSION_KEY, n)), `page ${n}`).toBeNull();
        for (const p of state.pages!) expect(await app.storage.load('session-page', sessionPageKey(SESSION_KEY, p.page)), `page ${p.page}`).not.toBeNull();

        // Everything, from the start: the forgotten range came from the machine, in more than one answer.
        const before = historyRequests();
        const all = await session().events();
        expect(historyRequests()).toBeGreaterThan(before + 1);
        expect(all).toEqual(streamed);
        // From inside the forgotten range: exactly what follows the cursor.
        const mid = streamed[100]!;
        expect(await session().events({ epoch: mid.epoch, seq: mid.seq })).toEqual(streamed.slice(101));
        // From the frontier on: the platform's own pages and window, no round trip.
        const own = historyRequests();
        const since = await session().events(info.archivedTo);
        expect(historyRequests()).toBe(own);
        expect(since).toEqual(streamed.filter((e) => e.epoch > info.archivedTo!.epoch || (e.epoch === info.archivedTo!.epoch && e.seq > info.archivedTo!.seq)));
        // A late joiner's tail from the start folds the same log.
        const tailed: AgentEvent[] = [];
        for await (const ev of session().tail({ epoch: 0, seq: 0 })) {
            tailed.push(ev);
            if (ev.epoch === info.head.epoch && ev.seq === info.head.seq) break;
        }
        expect(tailed).toEqual(streamed);
    });

    it('a machine whose log was truncated past the cursor answers a named gap, and a machine that cannot be asked a named unavailability — never a silent hole', async () => {
        const { state } = await paged();
        const cut = { epoch: 0, seq: 300 };
        daemons[0]!.truncateLog(S1, cut);
        await expect(session().events()).rejects.toThrow(/history-gap: machine machine_1 no longer holds the events of session "session_1" before \(0, 300\)/);
        await expect(session().events({ epoch: 0, seq: 10 })).rejects.toThrow(/history-gap/);
        // What the log still holds is answered; so is what the platform holds itself.
        expect(await session().events(cut)).toEqual(streamed.slice(300));
        expect(await session().events(state.archivedTo)).toEqual(streamed.filter((e) => e.seq > state.archivedTo!.seq));
        // The daemon goes away: the platform cannot ask, and says so.
        sockets.seats.get(K1)!.drop();
        await until(async () => !(await machine().get()).online, 'offline');
        await expect(session().events()).rejects.toThrow(/history-unavailable: session ".*" holds no events before .*machine machine_1 could not be asked: machine-offline/);
        expect(await session().events(state.archivedTo)).toEqual(streamed.filter((e) => e.seq > state.archivedTo!.seq));
    });

    it('historyRequest / historyAnswer: an unanswered request times out through the liveness reminder, a disconnect fails a pending one, a stray response is ignored', async () => {
        connect(daemon({ events: 3 }));
        await until(async () => (await machine().get()).online, 'online');
        // The daemon's seat is gone but the socket still "sends": nobody answers.
        sockets.seats.delete(K1);
        const { requestId } = await machine().historyRequest(S1, { from: { epoch: 0, seq: 0 } });
        expect(await machine().historyResult(requestId)).toMatchObject({ requestId, sessionId: S1, status: 'pending', range: { from: { epoch: 0, seq: 0 } } });
        await advance(DEFAULT_HISTORY_TIMEOUT_MS + TICK);
        expect(await machine().historyResult(requestId)).toMatchObject({ status: 'error', error: { code: 'internal', message: expect.stringContaining('no answer') } });
        const answers = [];
        for await (const a of machine().historyAnswer(requestId)) answers.push(a);
        expect(answers).toEqual([{ error: { code: 'internal', message: expect.stringContaining('no answer') } }]);
        // A response for an id this machine never asked is ignored, and the socket stays.
        expect(await machine(asMachine(M1)).socketMessage(JSON.stringify({ v: 1, t: 'history.response', requestId: 'history_nobody', result: { events: [] } }))).toEqual({ ok: true, t: 'history.response' });
        for await (const a of machine().historyAnswer('history_nobody')) expect(a).toEqual({ error: { code: 'internal', message: expect.stringContaining('no history request') } });
        // A pending request when the daemon disconnects fails at once.
        const pending = await machine().historyRequest(S1, { from: { epoch: 0, seq: 0 } });
        await machine(asMachine(M1)).socketClosed();
        expect(await machine().historyResult(pending.requestId)).toMatchObject({ status: 'error', error: { code: 'internal', message: 'machine went offline' } });
        await expect(machine().historyRequest(S1, { from: { epoch: 0, seq: 0 } })).rejects.toThrow(/machine-offline/);
        await expect(machine().historyResult('history_nobody')).rejects.toThrow(/no history request/);
    });
});
