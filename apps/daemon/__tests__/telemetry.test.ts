// @vitest-environment node
import type { EnvironmentId, LocalEnvironment, SessionId } from '@agentic/core';
import { decodeDaemonFrame, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame, type DaemonFrameOf } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mockAgent } from '@sigx/ai-agent/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { telemetryFlags } from '../src/cli';
import { createDaemon, type Daemon } from '../src/daemon';
import { ndjsonEventLog } from '../src/event-log';
import { createTelemetrySampler, parseCimTable, parsePsTable, parsePsTime, parseVmStat, telemetryOff, type Exec, type OsReader, type ProcessRow, type TelemetryRoots } from '../src/telemetry';
import { agentDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay } from './helpers/relay';

const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
const E3 = 'env_3' as EnvironmentId;
const S1 = 's1' as SessionId;
const S2 = 's2' as SessionId;
const S3 = 's3' as SessionId;
const KiB = 1024;
const MiB = 1024 * KiB;

describe('process table parsing (#400)', () => {
    it('reads ps time on Linux and macOS', () => {
        expect(parsePsTime('0:00.12')).toBeCloseTo(0.12);
        expect(parsePsTime('1:02:03.45')).toBeCloseTo(3723.45);
        expect(parsePsTime('00:00:07')).toBe(7);
        expect(parsePsTime('2-03:04:05')).toBe(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
        expect(parsePsTime('garbage')).toBeUndefined();
    });

    it('reads a ps table, rss in KiB, skipping what does not parse', () => {
        const out = '    1     0  1200 0:01.00\n  400     1 20480 0:10.50\n  401   400   512 1:00.00\nPID PPID RSS TIME\n';
        expect(parsePsTable(out)).toEqual([
            { pid: 1, ppid: 0, rss: 1200 * KiB, cpuSeconds: 1 },
            { pid: 400, ppid: 1, rss: 20480 * KiB, cpuSeconds: 10.5 },
            { pid: 401, ppid: 400, rss: 512 * KiB, cpuSeconds: 60 }
        ]);
    });

    it('reads vm_stat as wired + compressed + anonymous pages, or nothing when a line is missing', () => {
        const out = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      141777.\nPages active:     588402.\nPages wired down:   238264.\nAnonymous pages:    564681.\nPages occupied by compressor:   493793.\n';
        expect(parseVmStat(out)).toBe((238264 + 493793 + 564681) * 16384);
        expect(parseVmStat(out.replace('Anonymous pages', 'Anon'))).toBeNull();
        expect(parseVmStat('')).toBeNull();
    });

    it('reads the CIM query as an array or a single object, times in 100 ns', () => {
        const row = { ProcessId: 400, ParentProcessId: 1, WorkingSetSize: 5 * MiB, UserModeTime: 15_000_000, KernelModeTime: 5_000_000 };
        expect(parseCimTable(JSON.stringify([row]))).toEqual([{ pid: 400, ppid: 1, rss: 5 * MiB, cpuSeconds: 2 }]);
        expect(parseCimTable(JSON.stringify(row))).toEqual([{ pid: 400, ppid: 1, rss: 5 * MiB, cpuSeconds: 2 }]);
        expect(parseCimTable(JSON.stringify([{ ProcessId: 'x' }]))).toEqual([]);
    });
});

describe('telemetry sampler (#400)', () => {
    const psLine = (r: ProcessRow) => `${r.pid} ${r.ppid} ${Math.round(r.rss / KiB)} 0:${r.cpuSeconds.toFixed(2).padStart(5, '0')}`;
    const VM_STAT = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages wired down:   1000.\nAnonymous pages:    2000.\nPages occupied by compressor:   500.\n';
    /** A fake `ps` (and `vm_stat`) answering from a mutable table, with each call recorded. */
    function fakeExec(rows: () => readonly ProcessRow[]): Exec & { calls: string[][] } {
        const calls: string[][] = [];
        const exec: Exec = async (command, args) => {
            calls.push([command, ...args]);
            if (command === 'vm_stat') return VM_STAT;
            return rows()
                .map(psLine)
                .join('\n');
        };
        return Object.assign(exec, { calls });
    }
    /** A fake `os` whose core times advance by `busy` busy and `idle` idle ticks between samples. */
    function fakeOs(cores: number, total: number, free: () => number): OsReader & { advance(busy: number, idle: number): void } {
        let user = 0;
        let idle = 0;
        return {
            cpus: () => Array.from({ length: cores }, () => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } })),
            totalmem: () => total,
            freemem: free,
            advance(b, i) {
                user += b;
                idle += i;
            }
        };
    }
    const daemonPid = 100;
    const row = (pid: number, ppid: number, rss: number, cpuSeconds = 0): ProcessRow => ({ pid, ppid, rss, cpuSeconds });
    const roots = (over: Partial<TelemetryRoots> = {}): TelemetryRoots => ({
        daemonPid,
        sessions: [
            { id: S1, environmentId: E1, pid: 200, attributable: true },
            { id: S2, environmentId: E1, pid: undefined, attributable: true },
            { id: S3, environmentId: E2, pid: undefined, attributable: false }
        ],
        environments: [
            { id: E1, pids: [] },
            { id: E2, pids: [300] },
            { id: E3, pids: [] }
        ],
        ...over
    });

    it('charges a process and everything under it to its session, an app-server to its environment, and says what it cannot see', async () => {
        let now = 1_000;
        const table: ProcessRow[] = [row(daemonPid, 1, 50 * MiB), row(200, daemonPid, 300 * MiB), row(201, 200, 120 * MiB), row(202, 201, 80 * MiB), row(300, daemonPid, 400 * MiB), row(999, 1, 1 * MiB)];
        const exec = fakeExec(() => table);
        const os = fakeOs(4, 16_000 * MiB, () => 6_000 * MiB);
        const sampler = createTelemetrySampler({ platform: 'darwin', exec, os, now: () => now });

        const first = await sampler.sample(roots());
        expect(exec.calls).toEqual([
            ['vm_stat'],
            ['ps', '-axo', 'pid=,ppid=,rss=,time=']
        ]);
        expect(first.availability).toBe('partial');
        expect(first.cpus).toBe(4);
        // On a Mac what is in use comes from vm_stat, not from free pages.
        expect(first.machine).toEqual({ cpu: null, memoryUsed: 3500 * 4096, memoryTotal: 16_000 * MiB });
        expect(first.daemon).toEqual({ cpu: null, rss: 50 * MiB, processes: 1 });
        // s1's tree: the CLI, its shell, the dev server under it. s2 has no process yet; s3's runtime keeps none per session.
        expect(first.sessions).toEqual({ s1: { cpu: null, rss: 500 * MiB, processes: 3 }, s2: null, s3: null });
        expect(first.environments).toEqual({
            env_1: { sample: { cpu: null, rss: 500 * MiB, processes: 3 }, attribution: 'session' },
            env_2: { sample: { cpu: null, rss: 400 * MiB, processes: 1 }, attribution: 'environment' }
        });
        expect(first.environments).not.toHaveProperty('env_3');

        // Ten seconds on: s1's tree burnt 8 CPU seconds of a possible 40 (4 cores), the machine was half busy.
        now += 10_000;
        table[1] = row(200, daemonPid, 300 * MiB, 2);
        table[2] = row(201, 200, 120 * MiB, 6);
        table[4] = row(300, daemonPid, 400 * MiB, 1);
        os.advance(50, 50);
        const second = await sampler.sample(roots());
        expect(second.intervalMs).toBe(10_000);
        expect(second.machine.cpu).toBeCloseTo(0.5);
        expect(second.sessions[S1]).toEqual({ cpu: 0.2, rss: 500 * MiB, processes: 3 });
        expect(second.environments[E2]!.sample!.cpu).toBeCloseTo(1 / 40);
        expect(second.daemon.cpu).toBe(0);
    });

    it('a session whose process is gone reads unknown, never zero — and a reused pid gets no delta', async () => {
        let now = 1_000;
        let table: ProcessRow[] = [row(daemonPid, 1, 50 * MiB), row(200, daemonPid, 300 * MiB, 5)];
        const sampler = createTelemetrySampler({ platform: 'linux', exec: fakeExec(() => table), os: fakeOs(2, 1_000 * MiB, () => 500 * MiB), now: () => now });
        await sampler.sample(roots({ sessions: [{ id: S1, environmentId: E1, pid: 200, attributable: true }], environments: [{ id: E1, pids: [] }] }));
        now += 5_000;
        table = [row(daemonPid, 1, 50 * MiB)];
        const gone = await sampler.sample(roots({ sessions: [{ id: S1, environmentId: E1, pid: 200, attributable: true }], environments: [{ id: E1, pids: [] }] }));
        expect(gone.sessions).toEqual({ s1: null });
        expect(gone.environments[E1]).toEqual({ sample: null, attribution: 'session' });
        expect(gone.availability).toBe('partial');
        // Back with less CPU time than before: a new process wearing the old number.
        now += 5_000;
        table = [row(daemonPid, 1, 50 * MiB), row(200, daemonPid, 10 * MiB, 1)];
        await sampler.sample(roots({ sessions: [{ id: S1, environmentId: E1, pid: 200, attributable: true }], environments: [{ id: E1, pids: [] }] }));
        now += 5_000;
        table = [row(daemonPid, 1, 50 * MiB), row(200, daemonPid, 10 * MiB, 0.5)];
        const reused = await sampler.sample(roots({ sessions: [{ id: S1, environmentId: E1, pid: 200, attributable: true }], environments: [{ id: E1, pids: [] }] }));
        expect(reused.sessions[S1]).toEqual({ cpu: null, rss: 10 * MiB, processes: 1 });
    });

    it('everything attributed is reported, an environment without sessions is left out', async () => {
        const table = [row(daemonPid, 1, 50 * MiB), row(200, daemonPid, 300 * MiB)];
        const sampler = createTelemetrySampler({ platform: 'linux', exec: fakeExec(() => table), os: fakeOs(2, 1_000 * MiB, () => 500 * MiB), now: () => 1 });
        const t = await sampler.sample(roots({ sessions: [{ id: S1, environmentId: E1, pid: 200, attributable: true }], environments: [{ id: E1, pids: [] }, { id: E3, pids: [] }] }));
        expect(t.availability).toBe('reported');
        expect(Object.keys(t.environments)).toEqual(['env_1']);
    });

    it('a table it cannot read is a not-reported snapshot with the reason, and the next good sample starts over', async () => {
        let fail = true;
        const table = [row(daemonPid, 1, 50 * MiB)];
        const exec: Exec = async () => {
            if (fail) throw new Error('spawn ps ENOENT');
            return table.map(psLine).join('\n');
        };
        let now = 1_000;
        const sampler = createTelemetrySampler({ platform: 'linux', exec, os: fakeOs(2, 1_000 * MiB, () => 500 * MiB), now: () => now });
        const bad = await sampler.sample(roots({ sessions: [], environments: [] }));
        expect(bad).toMatchObject({ availability: 'not-reported', reason: 'the process table could not be read: spawn ps ENOENT', sessions: {}, environments: {} });
        expect(bad.machine.memoryTotal).toBe(1_000 * MiB);
        fail = false;
        now += 1_000;
        const good = await sampler.sample(roots({ sessions: [], environments: [] }));
        expect(good.availability).toBe('reported');
        expect(good.machine.memoryUsed).toBe(500 * MiB);
        expect(good.daemon.cpu).toBeNull();
    });

    it('asks Windows through PowerShell', async () => {
        const calls: string[][] = [];
        const exec: Exec = async (command, args) => {
            calls.push([command, ...args]);
            return JSON.stringify([{ ProcessId: daemonPid, ParentProcessId: 1, WorkingSetSize: 50 * MiB, UserModeTime: 0, KernelModeTime: 0 }]);
        };
        const sampler = createTelemetrySampler({ platform: 'win32', exec, os: fakeOs(2, 1_000 * MiB, () => 500 * MiB), now: () => 1 });
        const t = await sampler.sample(roots({ sessions: [], environments: [] }));
        expect(calls[0]!.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command']);
        expect(calls[0]![4]).toContain('Win32_Process');
        expect(t.daemon).toEqual({ cpu: null, rss: 50 * MiB, processes: 1 });
    });

    it('telemetry off is a not-reported snapshot that names the flag', () => {
        expect(telemetryOff(5)).toMatchObject({ observedAt: 5, availability: 'not-reported', reason: expect.stringContaining('--telemetry off'), sessions: {}, environments: {} });
    });

    it('telemetryFlags reads --telemetry on|off', () => {
        expect(telemetryFlags({})).toEqual({});
        expect(telemetryFlags({ telemetry: 'off' })).toEqual({ enabled: false });
        expect(telemetryFlags({ telemetry: 'on' })).toEqual({ enabled: true });
        expect(telemetryFlags({ telemetry: 'maybe' })).toBe('--telemetry takes on or off');
        expect(telemetryFlags({ telemetry: true })).toBe('--telemetry takes on or off');
    });
});

describe('daemon telemetry frames (#400)', () => {
    let dir: string;
    let relay: Relay;
    let daemon: Daemon | undefined;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-telemetry-'));
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
    async function nextTelemetry(seat: PlatformSeat): Promise<DaemonFrameOf<'telemetry'>> {
        for (;;) {
            const frame = await next(seat);
            if (frame.t === 'telemetry') return frame;
        }
    }

    it('follows each heartbeat with a telemetry frame charging the session its driver names a pid for', async () => {
        const env: LocalEnvironment = { id: E1, name: 'work', runtime: 'mock', cwdRoots: [dir], concurrency: 1 };
        const base = agentDriver('mock', mockAgent({ respond: () => [{ text: 'ok' }] }));
        let pid: number | undefined;
        const driver = { ...base, open: async (...args: Parameters<typeof base.open>) => ({ ...(await base.open(...args)), pid: () => pid }) };
        const exec: Exec = async () => `${process.pid} 1 51200 0:01.00\n4242 ${process.pid} 204800 0:02.00\n4243 4242 10240 0:00.50\n`;
        daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments: [env],
            drivers: [driver],
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 200,
            platform: 'linux',
            quota: { sources: [], pollMs: 0 },
            telemetry: { exec }
        });
        await daemon.start();
        const seat = await relay.nextSeat();
        expect((await next(seat)).t).toBe('hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });

        seat.send({ v: V, t: 'session.open', sessionId: S1, environmentId: E1, spec: { agentId: 'agent_1', cwd: dir, system: 's', tools: [] } });
        for (let frame = await next(seat); frame.t !== 'session.opened'; frame = await next(seat));
        const unknown = await nextTelemetry(seat);
        expect(unknown.snapshot.sessions).toEqual({ s1: null });
        expect(unknown.snapshot.availability).toBe('partial');
        expect(unknown.snapshot.daemon.processes).toBe(1);

        pid = 4242;
        let known = await nextTelemetry(seat);
        // The frame in flight may predate the pid; the next one after it does not.
        if (known.snapshot.sessions[S1] === null) known = await nextTelemetry(seat);
        expect(known.snapshot.sessions[S1]).toMatchObject({ rss: 215_040 * KiB, processes: 2 });
        expect(known.snapshot.environments).toEqual({ env_1: { sample: known.snapshot.sessions[S1], attribution: 'session' } });
        expect(known.snapshot.availability).toBe('reported');
    });

    it('sends a not-reported snapshot when telemetry is off', async () => {
        daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments: [],
            drivers: [],
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 100,
            quota: { sources: [], pollMs: 0 },
            telemetry: { enabled: false }
        });
        await daemon.start();
        const seat = await relay.nextSeat();
        expect((await next(seat)).t).toBe('hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });
        const off = await nextTelemetry(seat);
        expect(off.snapshot).toMatchObject({ availability: 'not-reported', reason: expect.stringContaining('--telemetry off') });
    });
});
