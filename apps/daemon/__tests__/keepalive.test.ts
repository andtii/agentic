// @vitest-environment node
/** Liveness on the `{"p":1}` keepalive (#984): heartbeats only on change, legacy platforms still heartbeated, silence redials, telemetry only when news. */
import type { EnvironmentId, LocalEnvironment, SessionId } from '@agentic/core';
import { decodeDaemonFrame, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame } from '@agentic/daemon-protocol';
import { mockAgent } from '@sigx/ai-agent/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, type Daemon, type DaemonOptions } from '../src/daemon';
import { ndjsonEventLog } from '../src/event-log';
import type { Exec } from '../src/telemetry';
import { agentDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay, type RelaySeat } from './helpers/relay';

const E1 = 'env_1' as EnvironmentId;
const S1 = 's1' as SessionId;
const GiB = 2 ** 30;

describe('daemon keepalive (#984)', () => {
    let dir: string;
    let relay: Relay | undefined;
    let daemon: Daemon | undefined;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-keepalive-'));
    });
    afterEach(async () => {
        await daemon?.stop();
        await relay?.close();
        daemon = undefined;
        relay = undefined;
        await rm(dir, { recursive: true, force: true });
    });

    const env = (): LocalEnvironment => ({ id: E1, name: 'work', runtime: 'mock', cwdRoots: [dir], concurrency: 1 });

    async function start(autoResponse: boolean, extra: Partial<DaemonOptions> = {}): Promise<RelaySeat> {
        relay = await startRelay({ autoResponse });
        daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments: [env()],
            drivers: [agentDriver('mock', mockAgent({ respond: () => [{ text: 'ok' }] }))],
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 40,
            keepalive: { pingMs: 40, idleMs: 10_000 },
            platform: 'linux',
            quota: { sources: [], pollMs: 0 },
            telemetry: { enabled: false },
            ...extra
        });
        await daemon.start();
        const seat = await relay.nextSeat();
        expect((await next(seat)).t).toBe('hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });
        return seat;
    }

    async function next(seat: RelaySeat): Promise<DaemonFrame> {
        const decoded = decodeDaemonFrame((await seat.next()) as string);
        if (!decoded.ok) throw new Error(decoded.error.message);
        return decoded.frame;
    }

    /** Every frame the daemon sends within `ms`. */
    async function during(seat: RelaySeat, ms: number): Promise<DaemonFrame[]> {
        const frames: DaemonFrame[] = [];
        const deadline = Date.now() + ms;
        for (;;) {
            const left = deadline - Date.now();
            if (left <= 0) return frames;
            const pending = next(seat);
            // Left waiting past the window, it rejects when the seat closes: nobody reads it.
            pending.catch(() => undefined);
            const frame = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), left))]);
            if (frame === null) return frames;
            frames.push(frame);
        }
    }

    async function until(seat: RelaySeat, match: (f: DaemonFrame) => boolean): Promise<DaemonFrame> {
        for (;;) {
            const frame = await next(seat);
            if (match(frame)) return frame;
        }
    }

    const heartbeats = (frames: DaemonFrame[]) => frames.filter((f) => f.t === 'heartbeat');
    const openFrame = { v: V, t: 'session.open', sessionId: S1, environmentId: E1, spec: { agentId: 'agent_1', cwd: '', system: 's', tools: [] } } as const;

    it('against a platform that answers the ping: heartbeat on welcome and when the sessions change, never on a timer', async () => {
        const seat = await start(true);
        const idle = await during(seat, 400);
        expect(heartbeats(idle)).toEqual([expect.objectContaining({ t: 'heartbeat', active: [] })]);
        expect(seat.pings).toBeGreaterThanOrEqual(3);

        seat.send({ ...openFrame, spec: { ...openFrame.spec, cwd: dir } });
        expect(await until(seat, (f) => f.t === 'heartbeat')).toMatchObject({ active: [S1] });
        seat.send({ v: V, t: 'session.close', sessionId: S1 });
        expect(await until(seat, (f) => f.t === 'heartbeat')).toMatchObject({ active: [] });
        expect(heartbeats(await during(seat, 300))).toEqual([]);
    });

    it('against a platform from before the keepalive: one unanswered ping, then heartbeats on every tick as before', async () => {
        const seat = await start(false);
        const frames = await during(seat, 400);
        expect(heartbeats(frames).length).toBeGreaterThanOrEqual(4);
        expect(seat.pings).toBe(1);
    });

    it('redials when a platform that answered the ping goes quiet', async () => {
        const seat = await start(true, { keepalive: { pingMs: 50, idleMs: 300 } });
        while (seat.pings < 2) await new Promise((r) => setTimeout(r, 10));
        seat.answer = false;
        const again = await relay!.nextSeat(3_000);
        expect((await next(again)).t).toBe('hello');
    });

    it('sends telemetry only when it is news: after welcome, a session opened, a limit crossed and cleared', async () => {
        let rss = 100 * 1024; // KiB
        const exec: Exec = async () => `${process.pid} 1 51200 0:01.00\n4242 ${process.pid} ${rss} 0:02.00\n`;
        const base = agentDriver('mock', mockAgent({ respond: () => [{ text: 'ok' }] }));
        const driver = { ...base, open: async (...args: Parameters<typeof base.open>) => ({ ...(await base.open(...args)), pid: () => 4242 }) };
        const seat = await start(true, { drivers: [driver], telemetry: { exec } });
        const telemetry = (frames: DaemonFrame[]) => frames.filter((f) => f.t === 'telemetry');

        expect(telemetry(await during(seat, 400))).toHaveLength(1);

        seat.send({ ...openFrame, spec: { ...openFrame.spec, cwd: dir } });
        await until(seat, (f) => f.t === 'telemetry' && S1 in f.snapshot.sessions);
        expect(telemetry(await during(seat, 300))).toEqual([]);

        rss = 3 * 1024 * 1024; // 3 GiB in KiB: over the session limit
        const crossed = await until(seat, (f) => f.t === 'telemetry');
        expect(crossed.t === 'telemetry' && crossed.snapshot.sessions[S1]?.rss).toBeGreaterThanOrEqual(2 * GiB);
        expect(telemetry(await during(seat, 300))).toEqual([]);

        rss = 100 * 1024;
        const cleared = await until(seat, (f) => f.t === 'telemetry');
        expect(cleared.t === 'telemetry' && cleared.snapshot.sessions[S1]?.rss).toBeLessThan(GiB);
    });
});
