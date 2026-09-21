/**
 * What this machine's sessions cost it (#400; EXE-06, EXE-08, EXE-09, OPS-04). Once per heartbeat the sampler
 * reads the OS process table in one call — `ps` on macOS and Linux, a CIM query on Windows — and charges each
 * runtime process and everything under it to the session it belongs to (a dev server the agent started is that
 * session's cost), rolls the sessions up per environment, and adds the daemon's own process and the machine's
 * totals. CPU is the cumulative CPU time of a tree between two samples over the wall time and the cores, so the
 * first sample has none. A session the daemon cannot attribute a process to reads `null`, never zero; a table it
 * cannot read is said as `not-reported` with the reason. Nothing here ends a session (#387).
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import type { EnvironmentId, MachineTelemetry, ResourceSample, SessionId, TelemetryAttribution } from '@agentic/core';
import type { Logger } from './logger.js';

/** One row of the process table: resident bytes and cumulative CPU seconds. */
export interface ProcessRow {
    readonly pid: number;
    readonly ppid: number;
    readonly rss: number;
    readonly cpuSeconds: number;
}

/** Runs a command and resolves to its stdout; `execFile` by default, a fake in tests. */
export type Exec = (command: string, args: readonly string[]) => Promise<string>;

/** The slice of `node:os` the sampler reads; a fake in tests. */
export interface OsReader {
    cpus(): ReadonlyArray<{ readonly times: { readonly user: number; readonly nice: number; readonly sys: number; readonly idle: number; readonly irq: number } }>;
    totalmem(): number;
    freemem(): number;
}

export interface TelemetryRoots {
    /** The daemon's own process. */
    readonly daemonPid: number;
    /** Every hosted session: `pid` as its runtime reports it, `attributable` when the runtime keeps a process per session at all. */
    readonly sessions: ReadonlyArray<{ readonly id: SessionId; readonly environmentId: EnvironmentId; readonly pid: number | undefined; readonly attributable: boolean }>;
    /** Every environment, with the processes its driver keeps for it as a whole (Codex's app-server). */
    readonly environments: ReadonlyArray<{ readonly id: EnvironmentId; readonly pids: readonly number[] }>;
}

export interface TelemetrySamplerOptions {
    readonly platform?: NodeJS.Platform;
    readonly exec?: Exec;
    readonly os?: OsReader;
    readonly now?: () => number;
    readonly logger?: Logger;
}

export interface TelemetrySampler {
    /** One snapshot; never throws — a table that could not be read is a `not-reported` snapshot with the reason. */
    sample(roots: TelemetryRoots): Promise<MachineTelemetry>;
}

const EXEC_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

const defaultExec: Exec = (command, args) =>
    new Promise((resolve, reject) => {
        execFile(command, [...args], { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    });

/** `[dd-][hh:]mm:ss[.cc]` — Linux prints days and hours, macOS hundredths — to seconds. */
export function parsePsTime(text: string): number | undefined {
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
    if (!m) return undefined;
    const [, days, hours, minutes, seconds] = m;
    return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** `ps -axo pid=,ppid=,rss=,time=`: one row per line, rss in KiB. Rows that do not parse are skipped. */
export function parsePsTable(stdout: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of stdout.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        const pid = Number(cols[0]);
        const ppid = Number(cols[1]);
        const rss = Number(cols[2]);
        const cpuSeconds = parsePsTime(cols[3]!);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rss) || cpuSeconds === undefined) continue;
        rows.push({ pid, ppid, rss: rss * 1024, cpuSeconds });
    }
    return rows;
}

const CIM_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';

/** The CIM query's JSON: an array, or one object when there is a single process; times in 100 ns units. */
export function parseCimTable(stdout: string): ProcessRow[] {
    const parsed: unknown = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rows: ProcessRow[] = [];
    for (const item of list) {
        const p = item as Record<string, unknown>;
        const pid = Number(p.ProcessId);
        const ppid = Number(p.ParentProcessId);
        const rss = Number(p.WorkingSetSize);
        const cpuSeconds = (Number(p.UserModeTime ?? 0) + Number(p.KernelModeTime ?? 0)) / 10_000_000;
        if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rss) || !Number.isFinite(cpuSeconds)) continue;
        rows.push({ pid, ppid, rss, cpuSeconds });
    }
    return rows;
}

/**
 * Bytes in use as macOS counts them (`vm_stat`: wired + compressed + anonymous pages — Activity Monitor's "Memory Used").
 * `os.freemem()` there is free pages only, with the file cache counted as used, so a Mac would always read near full.
 */
export function parseVmStat(stdout: string): number | null {
    const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? NaN);
    const pages = (label: string): number | undefined => {
        const m = new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(stdout);
        return m ? Number(m[1]) : undefined;
    };
    const wired = pages('Pages wired down');
    const compressed = pages('Pages occupied by compressor');
    const anonymous = pages('Anonymous pages');
    if (!Number.isFinite(pageSize) || wired === undefined || compressed === undefined || anonymous === undefined) return null;
    return (wired + compressed + anonymous) * pageSize;
}

async function readMemoryUsed(platform: NodeJS.Platform, exec: Exec, reader: OsReader): Promise<number | null> {
    if (platform !== 'darwin') return Math.max(0, reader.totalmem() - reader.freemem());
    try {
        return parseVmStat(await exec('vm_stat', []));
    } catch {
        return null;
    }
}

async function readProcessTable(platform: NodeJS.Platform, exec: Exec): Promise<ProcessRow[]> {
    if (platform === 'win32') return parseCimTable(await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', CIM_QUERY]));
    return parsePsTable(await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=']));
}

/** Every pid under `root`, `root` included, by parent links; a cycle or a missing row ends the walk. */
function subtree(root: number, children: ReadonlyMap<number, readonly number[]>): number[] {
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length) {
        const pid = stack.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        for (const child of children.get(pid) ?? []) stack.push(child);
    }
    return [...seen];
}

const sum = (samples: readonly ResourceSample[]): ResourceSample => ({
    cpu: samples.every((s) => s.cpu === null) ? null : samples.reduce((n, s) => n + (s.cpu ?? 0), 0),
    rss: samples.reduce((n, s) => n + s.rss, 0),
    processes: samples.reduce((n, s) => n + s.processes, 0)
});

export function createTelemetrySampler(options: TelemetrySamplerOptions = {}): TelemetrySampler {
    const platform = options.platform ?? process.platform;
    const exec = options.exec ?? defaultExec;
    const reader: OsReader = options.os ?? os;
    const now = options.now ?? Date.now;
    let previous: { readonly at: number; readonly rows: ReadonlyMap<number, ProcessRow>; readonly cpu: { readonly idle: number; readonly total: number } } | undefined;

    const cpuTimes = () => {
        let idle = 0;
        let total = 0;
        for (const { times } of reader.cpus()) {
            idle += times.idle;
            total += times.user + times.nice + times.sys + times.idle + times.irq;
        }
        return { idle, total };
    };

    return {
        async sample(roots) {
            const at = now();
            const cpus = reader.cpus().length;
            const memoryTotal = reader.totalmem();
            const memoryUsed = await readMemoryUsed(platform, exec, reader);
            const cpu = cpuTimes();
            const intervalMs = previous ? at - previous.at : 0;
            const machineCpu = previous && cpu.total > previous.cpu.total ? Math.min(1, Math.max(0, 1 - (cpu.idle - previous.cpu.idle) / (cpu.total - previous.cpu.total))) : null;

            let table: ProcessRow[];
            try {
                table = await readProcessTable(platform, exec);
            } catch (e) {
                const reason = `the process table could not be read: ${e instanceof Error ? e.message : String(e)}`;
                options.logger?.warn('telemetry: not sampled', { reason });
                previous = undefined;
                return {
                    observedAt: at,
                    intervalMs,
                    cpus,
                    machine: { cpu: machineCpu, memoryUsed, memoryTotal },
                    daemon: { cpu: null, rss: 0, processes: 0 },
                    environments: {},
                    sessions: {},
                    availability: 'not-reported',
                    reason
                };
            }
            const rows = new Map(table.map((r) => [r.pid, r]));
            const children = new Map<number, number[]>();
            for (const r of table) {
                if (r.ppid === r.pid) continue;
                const list = children.get(r.ppid);
                if (list) list.push(r.pid);
                else children.set(r.ppid, [r.pid]);
            }
            const before = previous;
            const wallSeconds = before ? (at - before.at) / 1000 : 0;
            // The tree under `root` (or `root` alone), or `null` when the root is not in the table (it exited, or was never there).
            const tree = (root: number, alone = false): ResourceSample | null => {
                if (!rows.has(root)) return null;
                const pids = alone ? [root] : subtree(root, children);
                let rss = 0;
                let cpuDelta = 0;
                let measured = false;
                for (const pid of pids) {
                    const row = rows.get(pid)!;
                    rss += row.rss;
                    const prior = before?.rows.get(pid);
                    // A pid seen before with less CPU time is a new process wearing an old number: no delta to trust.
                    if (prior && row.cpuSeconds >= prior.cpuSeconds) {
                        cpuDelta += row.cpuSeconds - prior.cpuSeconds;
                        measured = true;
                    }
                }
                const cpuFraction = measured && wallSeconds > 0 && cpus > 0 ? Math.min(1, cpuDelta / wallSeconds / cpus) : null;
                return { cpu: cpuFraction, rss, processes: pids.length };
            };

            const sessions: Record<SessionId, ResourceSample | null> = {};
            const byEnvironment = new Map<EnvironmentId, { samples: ResourceSample[]; unknown: number; attributable: boolean }>();
            for (const s of roots.sessions) {
                const sample = s.attributable && s.pid !== undefined ? tree(s.pid) : null;
                sessions[s.id] = sample;
                const env = byEnvironment.get(s.environmentId) ?? { samples: [], unknown: 0, attributable: false };
                if (sample) env.samples.push(sample);
                else env.unknown += 1;
                env.attributable ||= s.attributable;
                byEnvironment.set(s.environmentId, env);
            }
            const environments: Record<EnvironmentId, { sample: ResourceSample | null; attribution: TelemetryAttribution }> = {};
            let partial = Object.values(sessions).some((s) => s === null);
            for (const e of roots.environments) {
                const own = e.pids.map((pid) => tree(pid)).filter((s): s is ResourceSample => s !== null);
                const hosted = byEnvironment.get(e.id);
                if (own.length) {
                    environments[e.id] = { sample: sum(own), attribution: 'environment' };
                } else if (hosted?.attributable) {
                    environments[e.id] = { sample: hosted.samples.length ? sum(hosted.samples) : null, attribution: 'session' };
                } else if (hosted) {
                    environments[e.id] = { sample: null, attribution: 'none' };
                } else {
                    continue;
                }
                if (environments[e.id]!.sample === null) partial = true;
            }
            // The daemon's own process: every runtime runs under it, and is charged to its session or environment instead.
            const daemon = tree(roots.daemonPid, true) ?? { cpu: null, rss: 0, processes: 0 };
            previous = { at, rows, cpu };
            return {
                observedAt: at,
                intervalMs,
                cpus,
                machine: { cpu: machineCpu, memoryUsed, memoryTotal },
                daemon,
                environments,
                sessions,
                availability: partial ? 'partial' : 'reported'
            };
        }
    };
}

/** What a daemon sends while telemetry is off (`--telemetry off`): the machine is known, nothing is sampled. */
export function telemetryOff(at: number): MachineTelemetry {
    return {
        observedAt: at,
        intervalMs: 0,
        cpus: os.cpus().length,
        machine: { cpu: null, memoryUsed: null, memoryTotal: os.totalmem() },
        daemon: { cpu: null, rss: 0, processes: 0 },
        environments: {},
        sessions: {},
        availability: 'not-reported',
        reason: 'telemetry is off on this machine (agentic-daemon run --telemetry off)'
    };
}
