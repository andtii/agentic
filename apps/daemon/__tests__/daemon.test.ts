// @vitest-environment node
import type { CapabilityReport, EnvironmentId, LocalEnvironment, SessionId } from '@agentic/core';
import { decodeDaemonFrame, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame, type DaemonFrameOf, type DaemonFrameType } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCapabilitiesOf, createDaemon, follows, withinRoots, type Daemon, type DaemonDriver } from '../src/daemon';
import { ndjsonEventLog } from '../src/event-log';
import { scriptedDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay } from './helpers/relay';

async function next(seat: PlatformSeat): Promise<DaemonFrame> {
    const decoded = decodeDaemonFrame((await seat.next()) as string);
    if (!decoded.ok) throw new Error(decoded.error.message);
    return decoded.frame;
}
async function expectFrame<T extends DaemonFrameType>(seat: PlatformSeat, t: T): Promise<DaemonFrameOf<T>> {
    for (;;) {
        const frame = await next(seat);
        if (frame.t === t) return frame as DaemonFrameOf<T>;
        if (frame.t !== 'heartbeat') throw new Error(`expected ${t}, got ${frame.t}`);
    }
}

describe('daemon', () => {
    let dir: string;
    let relay: Relay;
    let daemons: Daemon[];
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-daemon-'));
        relay = await startRelay();
        daemons = [];
    });
    afterEach(async () => {
        for (const d of daemons) await d.stop();
        await relay.close();
        await rm(dir, { recursive: true, force: true });
    });

    const env = (id: string, extra: Partial<LocalEnvironment> = {}): LocalEnvironment => ({ id: id as EnvironmentId, name: id, runtime: 'scripted', cwdRoots: [dir], concurrency: 1, ...extra });

    async function start(environments: LocalEnvironment[], drivers: DaemonDriver[] = [scriptedDriver({ events: 5, heartbeatMs: 1_000 })], toolTimeoutMs?: number) {
        const daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments,
            drivers,
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 1_000,
            ...(toolTimeoutMs ? { toolTimeoutMs } : {})
        });
        daemons.push(daemon);
        await daemon.start();
        const seat = await relay.nextSeat();
        const hello = await expectFrame(seat, 'hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });
        return { daemon, seat, hello };
    }

    const open = (seat: PlatformSeat, sessionId: string, environmentId: string, cwd = dir) =>
        seat.send({ v: V, t: 'session.open', sessionId: sessionId as SessionId, environmentId, spec: { agentId: 'agent_1', cwd, system: 's', tools: [] } });

    it('dials /_agentic/daemon/{machineId} with the token as a bearer header', async () => {
        await start([env('env_a')]);
        expect(relay.dialled).toEqual([`/_agentic/daemon/${TEST_MACHINE}`]);
        expect(relay.refused).toBe(0);
    });

    it('leaves out environments without a driver and reports an inspection failure as unknown auth', async () => {
        const failing: DaemonDriver = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), runtime: 'flaky', inspect: async () => Promise.reject(new Error('no claude binary')) };
        const { hello } = await start([env('env_a'), env('env_b', { runtime: 'nobody' }), env('env_c', { runtime: 'flaky' })], [scriptedDriver({ events: 1, heartbeatMs: 1_000 }), failing]);
        expect(hello.environments.map((e) => e.id)).toEqual(['env_a', 'env_c']);
        expect(hello.environments[1]!.account.authStatus).toBe('unknown');
        expect(hello.capabilities.find((c) => c.runtime === 'flaky')!.unsupported).toEqual([{ op: '*', reason: 'no claude binary' }]);
    });

    it('refuses unknown environments, a cwd outside cwdRoots and work beyond concurrency — with a reason', async () => {
        const { seat } = await start([env('env_a')]);
        open(seat, 'session_1', 'env_nope');
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/unknown environment/);
        open(seat, 'session_2', 'env_a', join(dir, '..'));
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/outside the environment's cwdRoots/);
        open(seat, 'session_3', 'env_a', join(dir, 'sub'));
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_3');
        open(seat, 'session_4', 'env_a');
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/at capacity/);
        // Opening the same session again is idempotent.
        open(seat, 'session_3', 'env_a');
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_3');
    });

    it('a command for a session it does not run is answered, not dropped', async () => {
        const { seat } = await start([env('env_a')]);
        seat.send({ v: V, t: 'session.command', sessionId: 'session_x' as SessionId, command: { v: 1, commandId: 'c1', type: 'cancel' } });
        expect((await expectFrame(seat, 'session.reply')).reply).toMatchObject({ kind: 'error', code: 'closed', commandId: 'c1' });
    });

    it('after a daemon restart, a wanted session is replayed from its log and reported closed', async () => {
        const first = await start([env('env_a')]);
        open(first.seat, 'session_1', 'env_a');
        const opened = await expectFrame(first.seat, 'session.opened');
        first.seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'go' }] } });
        let seen = 0;
        while (seen < 2) if ((await next(first.seat)).t === 'session.frame') seen++;
        await first.daemon.stop();
        daemons.length = 0;

        const second = await (async () => {
            const daemon = createDaemon({ credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token }, environments: [env('env_a')], drivers: [scriptedDriver({ events: 5, heartbeatMs: 1_000 })], eventLog: ndjsonEventLog(join(dir, 'sessions')), backoff: { initialMs: 5, maxMs: 20 } });
            daemons.push(daemon);
            await daemon.start();
            return { daemon, seat: await relay.nextSeat() };
        })();
        const hello = await expectFrame(second.seat, 'hello');
        expect(hello.resume).toEqual({});
        second.seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: { session_1: { epoch: opened.head.epoch, seq: 2 } } });
        const seqs: number[] = [];
        for (;;) {
            const frame = await next(second.seat);
            if (frame.t === 'session.frame' && frame.frame.kind === 'event') seqs.push(frame.frame.seq);
            if (frame.t === 'session.closed') {
                expect(frame.reason).toMatch(/daemon restarted/);
                break;
            }
        }
        expect(seqs).toEqual([3, 4, 5]);
    });

    it('bridges platform tools as tool.call; an unanswered call times out', async () => {
        const script = { events: 2, heartbeatMs: 1_000, tool: { name: 'memory_search', input: { q: 'x' } } };
        const { seat } = await start([env('env_a')], [scriptedDriver(script)], 50);
        open(seat, 'session_1', 'env_a');
        await expectFrame(seat, 'session.opened');
        seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'go' }] } });
        expect((await expectFrame(seat, 'session.reply')).reply.kind).toBe('ack');
        const call = await expectFrame(seat, 'tool.call');
        expect(call).toMatchObject({ sessionId: 'session_1', tool: 'memory_search', input: { q: 'x' } });
        // No answer: the scripted runtime swallows the timeout and finishes its turn.
        const frames: string[] = [];
        for (;;) {
            const frame = await next(seat);
            frames.push(frame.t);
            if (frame.t === 'session.frame' && frame.frame.kind === 'event' && frame.frame.event.type === 'turn-end') break;
        }
        expect(frames).toContain('session.frame');
    });
});

describe('daemon helpers', () => {
    it('follows: next seq in the epoch, or the first of a later one', () => {
        expect(follows({ epoch: 1, seq: 5 }, { epoch: 1, seq: 4 })).toBe(true);
        expect(follows({ epoch: 1, seq: 6 }, { epoch: 1, seq: 4 })).toBe(false);
        expect(follows({ epoch: 1, seq: 1 }, { epoch: 0, seq: 0 })).toBe(true);
        expect(follows({ epoch: 2, seq: 3 }, { epoch: 1, seq: 9 })).toBe(false);
    });
    it('withinRoots refuses escapes and is case-insensitive on Windows', () => {
        expect(withinRoots('/src/app', ['/src'], 'linux')).toBe(true);
        expect(withinRoots('/src/../etc', ['/src'], 'linux')).toBe(false);
        expect(withinRoots('/srcother', ['/src'], 'linux')).toBe(false);
        if (process.platform === 'win32') expect(withinRoots('C:\\SRC\\app', ['c:\\src'], 'win32')).toBe(true);
    });
    it('agentCapabilitiesOf maps the report onto what serveSession checks', () => {
        const report: CapabilityReport = { runtime: 'x', supported: ['prompt', 'configure', 'fork'], unsupported: [], resume: 'local', cancel: true, steer: true, permissions: 'every-call', tools: 'mcp' };
        expect(agentCapabilitiesOf(report)).toMatchObject({ resume: 'local', cancel: true, steer: true, config: true, fork: true, structuredOutput: false, permissions: 'every-call', tools: 'mcp' });
    });
});

describe('builtin drivers', () => {
    it('ship the Claude Code driver, disposable', async () => {
        const { builtinDrivers, isDisposable } = await import('../src/drivers');
        const drivers = builtinDrivers();
        expect(drivers.map((d) => d.runtime)).toEqual(['claude-code']);
        expect(drivers.every(isDisposable)).toBe(true);
    });
});
