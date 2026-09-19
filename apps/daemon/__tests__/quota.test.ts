// @vitest-environment node
import type { EnvironmentId, LocalEnvironment, QuotaSnapshot, QuotaSource, SessionId } from '@agentic/core';
import { decodeDaemonFrame, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame, type DaemonFrameOf } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mockAgent } from '@sigx/ai-agent/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quotaFlags } from '../src/cli';
import { createDaemon, type Daemon } from '../src/daemon';
import { ndjsonEventLog } from '../src/event-log';
import { silentLogger } from '../src/logger';
import { createQuotaMonitor, quotaSignalOf, type QuotaMonitorOptions } from '../src/quota';
import { agentDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay } from './helpers/relay';

const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
const envOf = (id: EnvironmentId, runtime = 'mock'): LocalEnvironment => ({ id, name: id, runtime, cwdRoots: ['/work'], concurrency: 1 });
const win = (id: string, utilization: number) => ({ id, label: id, period: 'week', utilization, unit: 'percent', status: 'ok' }) as const;
const snap = (environmentId: EnvironmentId, windows: QuotaSnapshot['windows'], extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
    sourceId: 'test.quota',
    runtime: 'mock',
    environmentId,
    availability: 'reported',
    windows,
    observedAt: Date.now(),
    via: 'probe',
    ...extra
});

/** A source for runtime `mock`: probes answer `probeAnswer`, `ext test/limit` carries `{ id, utilization }`. */
function testSource(probeAnswer: (env: LocalEnvironment) => QuotaSnapshot | null = (env) => snap(env.id, [win('five_hour', 0.1), win('seven_day', 0.5)])): QuotaSource & { probes: EnvironmentId[] } {
    const probes: EnvironmentId[] = [];
    return {
        id: 'test.quota',
        version: '0',
        runtime: 'mock',
        probes,
        async probe(env) {
            probes.push(env.id);
            return probeAnswer(env);
        },
        fromSignal(signal, env) {
            if (signal.ns !== 'test' || signal.name !== 'limit') return null;
            const d = signal.data as { id: string; utilization: number };
            return snap(env.id, [win(d.id, d.utilization)], { availability: 'partial', via: 'stream' });
        }
    };
}

describe('quotaSignalOf', () => {
    it('reads ext as ns/name and error as ns error / its code; anything else carries nothing', () => {
        expect(quotaSignalOf({ type: 'ext', ns: 'claude-code', name: 'rate-limit', data: 1 } as never)).toEqual({ ns: 'claude-code', name: 'rate-limit', data: 1 });
        expect(quotaSignalOf({ type: 'error', code: 'rate_limited', message: 'x', recoverable: true, data: 2 } as never)).toEqual({ ns: 'error', name: 'rate_limited', data: 2 });
        expect(quotaSignalOf({ type: 'part-delta' })).toBeUndefined();
    });
});

describe('QuotaMonitor', () => {
    let sent: { environmentId: EnvironmentId; snapshot: QuotaSnapshot }[];
    let connected: boolean;
    let busy: Set<EnvironmentId>;
    let environments: LocalEnvironment[];

    beforeEach(() => {
        vi.useFakeTimers();
        sent = [];
        connected = true;
        busy = new Set();
        environments = [envOf(E1), envOf(E2)];
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const monitor = (source: QuotaSource, extra: Partial<QuotaMonitorOptions> = {}) =>
        createQuotaMonitor({
            sources: [source],
            send: (environmentId, snapshot) => {
                if (!connected) return false;
                sent.push({ environmentId, snapshot });
                return true;
            },
            environments: () => environments,
            busy: (id) => busy.has(id),
            logger: silentLogger,
            ...extra
        });
    const flush = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it('probes every environment once welcomed, one at a time, and sends each snapshot', async () => {
        const source = testSource();
        const m = monitor(source);
        m.welcomed();
        await flush();
        expect(source.probes).toEqual([E1, E2]);
        expect(sent.map((s) => [s.environmentId, s.snapshot.windows.length])).toEqual([
            [E1, 2],
            [E2, 2]
        ]);
    });

    it('drops an unchanged snapshot, sends it again after refreshMs, and sends a changed one at once', async () => {
        let u = 0.5;
        const source = testSource((env) => snap(env.id, [win('seven_day', u)]));
        const m = monitor(source, { refreshMs: 60_000 });
        await m.probe(E1);
        await m.probe(E1);
        expect(sent).toHaveLength(1);
        u = 0.6;
        await m.probe(E1);
        expect(sent.map((s) => s.snapshot.windows[0]!.utilization)).toEqual([0.5, 0.6]);
        vi.advanceTimersByTime(60_000);
        await m.probe(E1);
        expect(sent).toHaveLength(3);
    });

    it('polls idle environments every pollMs and leaves busy ones alone', async () => {
        const source = testSource();
        const m = monitor(source, { pollMs: 1_000 });
        m.start();
        busy.add(E2);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(source.probes).toEqual([E1]);
        busy.clear();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(source.probes).toEqual([E1, E1, E2]);
        m.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(source.probes).toHaveLength(3);
    });

    it('probes once, debounced, after turns end', async () => {
        const source = testSource();
        const m = monitor(source, { turnEndDebounceMs: 500 });
        m.observe(E1, { type: 'turn-end' });
        await vi.advanceTimersByTimeAsync(400);
        m.observe(E1, { type: 'turn-end' });
        await vi.advanceTimersByTimeAsync(400);
        expect(source.probes).toEqual([]);
        await vi.advanceTimersByTimeAsync(100);
        expect(source.probes).toEqual([E1]);
    });

    it('merges a stream signal into the probe snapshot and sends the whole', async () => {
        const m = monitor(testSource());
        await m.probe(E1);
        m.observe(E1, { type: 'ext', ns: 'test', name: 'limit', data: { id: 'five_hour', utilization: 0.9 } } as never);
        const last = sent.at(-1)!.snapshot;
        expect(last.windows.map((w) => [w.id, w.utilization])).toEqual([
            ['five_hour', 0.9],
            ['seven_day', 0.5]
        ]);
        expect(last).toMatchObject({ availability: 'reported', via: 'stream' });
        // Unrelated events, and an environment of a runtime with no source, send nothing.
        m.observe(E1, { type: 'part-delta' });
        environments = [envOf(E1, 'other'), envOf(E2)];
        m.observe(E1, { type: 'ext', ns: 'test', name: 'limit', data: { id: 'five_hour', utilization: 0.1 } } as never);
        expect(sent).toHaveLength(2);
    });

    it('with probe off it never probes — not when welcomed, not on the poll, not after a turn — and still follows the stream', async () => {
        const source = testSource();
        const m = monitor(source, { probe: false, pollMs: 1_000, turnEndDebounceMs: 10 });
        m.start();
        m.welcomed();
        m.observe(E1, { type: 'turn-end' });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(source.probes).toEqual([]);
        m.observe(E1, { type: 'ext', ns: 'test', name: 'limit', data: { id: 'five_hour', utilization: 0.3 } } as never);
        expect(sent.map((s) => s.snapshot.via)).toEqual(['stream']);
    });

    it('without a source that can probe it schedules nothing', async () => {
        const m = createQuotaMonitor({ sources: [], send: () => true, environments: () => environments, busy: () => false, logger: silentLogger, pollMs: 1_000, turnEndDebounceMs: 10 });
        m.start();
        m.observe(E1, { type: 'turn-end' });
        expect(vi.getTimerCount()).toBe(0);
        m.stop();
    });

    it('a probe that answers null keeps what the stream said; one that throws is logged, not fatal', async () => {
        let answer: () => QuotaSnapshot | null = () => null;
        const source = testSource(() => answer());
        const m = monitor(source);
        m.observe(E1, { type: 'ext', ns: 'test', name: 'limit', data: { id: 'five_hour', utilization: 0.3 } } as never);
        await m.probe(E1);
        expect(sent).toHaveLength(1);
        answer = () => {
            throw new Error('boom');
        };
        await expect(m.probe(E1)).resolves.toBeUndefined();
    });

    it('keeps an undelivered snapshot and sends it once welcomed', async () => {
        const source = testSource();
        const m = monitor(source, { probe: false });
        connected = false;
        m.observe(E1, { type: 'ext', ns: 'test', name: 'limit', data: { id: 'five_hour', utilization: 0.3 } } as never);
        expect(sent).toEqual([]);
        connected = true;
        m.welcomed();
        expect(sent.map((s) => s.environmentId)).toEqual([E1]);
    });

    it('forgets a removed environment and probes a new one', async () => {
        const source = testSource();
        const m = monitor(source);
        m.welcomed();
        await flush();
        environments = [envOf(E1), envOf('env_3' as EnvironmentId)];
        m.environmentsChanged();
        await flush();
        expect(source.probes).toEqual([E1, E2, 'env_3']);
    });
});

describe('quotaFlags', () => {
    it('reads --quota-probe on|off and --quota-poll-ms; refuses anything else', () => {
        expect(quotaFlags({})).toEqual({});
        expect(quotaFlags({ 'quota-probe': 'off', 'quota-poll-ms': '60000' })).toEqual({ probe: false, pollMs: 60_000 });
        expect(quotaFlags({ 'quota-probe': 'on' })).toEqual({ probe: true });
        expect(quotaFlags({ 'quota-probe': true })).toMatch(/on or off/);
        expect(quotaFlags({ 'quota-poll-ms': 'soon' })).toMatch(/milliseconds/);
    });
});

describe('daemon quota frames (#271)', () => {
    let dir: string;
    let relay: Relay;
    let daemon: Daemon | undefined;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-quota-'));
        relay = await startRelay();
    });
    afterEach(async () => {
        await daemon?.stop();
        await relay.close();
        await rm(dir, { recursive: true, force: true });
    });

    async function next(seat: PlatformSeat): Promise<DaemonFrame> {
        const decoded = decodeDaemonFrame((await seat.next()) as string);
        if (!decoded.ok) throw new Error(decoded.error.message);
        return decoded.frame;
    }
    async function nextQuota(seat: PlatformSeat): Promise<DaemonFrameOf<'quota'>> {
        for (;;) {
            const frame = await next(seat);
            if (frame.t === 'quota') return frame;
        }
    }

    it('probes after welcome, then turns a rate-limit event in a live session into a merged quota frame', async () => {
        const agent = mockAgent({ respond: () => [{ ext: { ns: 'test', name: 'limit', data: { id: 'five_hour', utilization: 0.8 } } }, { text: 'done' }] });
        const source = testSource();
        const env: LocalEnvironment = { ...envOf(E1), cwdRoots: [dir] };
        daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments: [env],
            drivers: [agentDriver('mock', agent)],
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 60_000,
            quota: { sources: [source], pollMs: 0 }
        });
        await daemon.start();
        const seat = await relay.nextSeat();
        expect((await next(seat)).t).toBe('hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });

        const probed = await nextQuota(seat);
        expect(probed).toMatchObject({ environmentId: E1, snapshot: { via: 'probe', availability: 'reported' } });

        seat.send({ v: V, t: 'session.open', sessionId: 's1' as SessionId, environmentId: E1, spec: { agentId: 'agent_1', cwd: dir, system: 's', tools: [] } });
        for (let frame = await next(seat); frame.t !== 'session.opened'; frame = await next(seat));
        seat.send({ v: V, t: 'session.command', sessionId: 's1' as SessionId, command: { v: 1, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'hi' }] } });
        const streamed = await nextQuota(seat);
        expect(streamed.snapshot.via).toBe('stream');
        expect(streamed.snapshot.windows.map((w) => [w.id, w.utilization])).toEqual([
            ['five_hour', 0.8],
            ['seven_day', 0.5]
        ]);
    });
});
