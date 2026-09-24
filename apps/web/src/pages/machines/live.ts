/**
 * The live machine pages' view model (#144): pure adapters from what the
 * Machine, Workspace and Routing actors return — `Machine.get()`,
 * `Machine.doctor()`, `Workspace.listMachines()`, `Routing.get()` — to the
 * `OpsMachine` / `OpsSession` / `DoctorCheck` shapes the machine groups,
 * the sessions table and the doctor card already render from the mock
 * workspace. Nothing here touches a hook or the DOM.
 */
import { accountKeyFor, accountKeyOf, telemetryWarnings, type EnvironmentDescriptor, type MachineId, type MachineTelemetry, type ResourceSample, type TelemetryWarning } from '@agentic/core';
import { formatBytes, type AgentHue, type FieldOption } from '@agentic/ui';
import { activeIn, type MachineDoctorView, type MachineIndexEntry, type MachineOs, type MachineView, type RoutingView } from '@agentic/platform';
import type { DoctorCheck, OpsMachine, OpsSession } from '../../mock/ops';
import type { AgentIdentity } from '../chat/live';
import { dateTime, shortDate } from '../agent/format';
import { shellArg } from './manage';

/** An agent tile on an environment card's "Default for" line (`EnvironmentCard`'s own shape, not exported by the kit). */
export interface DefaultForAgent {
    readonly name: string;
    readonly hue?: AgentHue;
}

/** The daemon's `hello` OS as the machine caption prints it. */
export function osLabel(os: MachineOs | undefined): string {
    switch (os) {
        case 'windows':
            return 'Windows';
        case 'darwin':
            return 'macOS';
        case 'linux':
            return 'Linux';
        default:
            return 'unknown OS';
    }
}

/** `4s ago`, `3m ago`, `3h ago`, `2d ago` — or `never` before the first heartbeat. */
export function seenLabel(lastSeen: number | undefined, now: number): string {
    if (lastSeen === undefined) return 'never';
    const s = Math.max(0, Math.round((now - lastSeen) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

/**
 * `Machine.get()` → the row the group and the hero render. The name is what
 * the daemon said at `pair` (its hostname unless `--name`), else the name
 * the index registered the machine under.
 */
export function machineOf(view: MachineView, indexName: string, now: number): OpsMachine {
    return {
        id: view.machineId,
        name: view.name || indexName || view.machineId,
        os: view.os ?? 'linux',
        osLabel: osLabel(view.os),
        daemonVersion: view.daemonVersion ?? '—',
        ...(view.build ? { build: view.build } : {}),
        ...(view.outdated ? { outdated: true } : {}),
        online: view.online && !view.revoked,
        lastSeenAt: view.lastSeen ?? 0,
        seen: seenLabel(view.lastSeen, now),
        pairedOn: view.pairedAt !== undefined ? shortDate(view.pairedAt) : '—'
    };
}

/** Environment name by id, for the sessions table and the queued line. */
export function environmentName(environments: readonly EnvironmentDescriptor[], id: string): string {
    return environments.find((e) => e.id === id)?.name ?? id;
}

/**
 * The machine's hosted sessions as the table's rows: `opening` reads AWAITING
 * (the daemon has not acknowledged `session.open` yet), `open` reads active.
 * `objectives` is what the Task reads resolved; a session without a task, or
 * one still loading, shows its task id.
 */
export function sessionsOf(view: MachineView, objectives: Readonly<Record<string, string>>, now: number): OpsSession[] {
    return view.activeSessions.map((h) => ({
        id: h.sessionId,
        task: (h.taskId && objectives[h.taskId]) || h.taskId || '—',
        agentId: h.agentId,
        environment: environmentName(view.environments, h.environmentId),
        machineId: view.machineId,
        status: h.status === 'open' ? 'active' : 'waiting',
        age: seenLabel(h.openedAt ?? h.requestedAt, now),
        ...(view.telemetry ? { load: sessionLoadOf(view.telemetry, h.sessionId) } : {})
    }));
}

/** A telemetry snapshot older than this is stale: three heartbeats missed, the machine is about to read offline anyway. */
export const TELEMETRY_STALE_MS = 90_000;

/** The machine's own load as the hero and the Machines list print it (#400). */
export interface MachineLoad {
    readonly cpu: number | null;
    readonly memoryUsed: number | null;
    readonly memoryTotal: number;
    readonly observedAt: number;
    readonly stale: boolean;
    readonly availability: MachineTelemetry['availability'];
    readonly reason?: string;
    /** The limits the snapshot crosses (core's `telemetryWarnings`: memory only). */
    readonly warnings: readonly TelemetryWarning[];
}

/** `Machine.get().telemetry` → the machine's load; `undefined` until the daemon has reported any. */
export function machineLoadOf(telemetry: MachineTelemetry | undefined, now: number): MachineLoad | undefined {
    if (!telemetry) return undefined;
    return {
        cpu: telemetry.machine.cpu,
        memoryUsed: telemetry.machine.memoryUsed,
        memoryTotal: telemetry.machine.memoryTotal,
        observedAt: telemetry.observedAt,
        stale: now - telemetry.observedAt > TELEMETRY_STALE_MS,
        availability: telemetry.availability,
        ...(telemetry.reason !== undefined ? { reason: telemetry.reason } : {}),
        warnings: telemetryWarnings(telemetry)
    };
}

/** A session's own sample: `null` when the daemon could not attribute it (the table says unknown), `undefined` when it is not in the snapshot. */
export function sessionLoadOf(telemetry: MachineTelemetry | undefined, sessionId: string): ResourceSample | null | undefined {
    return telemetry?.sessions[sessionId as never];
}

// A no-break space before the sign: a narrow cell never wraps `21` from its `%`.
const percent = (fraction: number | null): string => (fraction === null ? '—' : `${Math.round(fraction * 100)}\u00a0%`);

/** `CPU 34 % · 12.3 GB of 32 GB in use`; a `not-reported` snapshot reads `load not reported`. */
export function loadText(load: MachineLoad): string {
    if (load.availability === 'not-reported') return 'load not reported';
    const memory = load.memoryUsed === null ? `${formatBytes(load.memoryTotal)} memory` : `${formatBytes(load.memoryUsed)} of ${formatBytes(load.memoryTotal)} in use`;
    return `CPU ${percent(load.cpu)} · ${memory}`;
}

/** The tone the load prints in: a warning while a limit is crossed, `dim` when stale, nothing otherwise. */
export function loadTone(load: MachineLoad): 'warning' | 'dim' | undefined {
    if (load.warnings.length) return 'warning';
    return load.stale ? 'dim' : undefined;
}

/** One sentence per crossed limit for the alert under the hero, naming the session's agent when it is known. */
export function warningText(w: TelemetryWarning, sessions: readonly OpsSession[], agentName: (id: string) => string): string {
    if (w.kind === 'machine-memory') return `This machine is at ${Math.round(w.value * 100)} % memory (the warning level is ${Math.round(w.limit * 100)} %). Nothing is stopped: see which sessions hold it below.`;
    const session = sessions.find((s) => s.id === w.sessionId);
    const who = session ? `${agentName(session.agentId)}'s session ${w.sessionId}` : `Session ${w.sessionId}`;
    return `${who} and what it started hold ${formatBytes(w.value)} (the warning level is ${formatBytes(w.limit)}). Nothing is stopped: check what it is running.`;
}

/** A session row's CPU cell. */
export function sessionCpuText(load: ResourceSample | null | undefined): string {
    if (load === undefined) return '—';
    if (load === null) return 'unknown';
    return percent(load.cpu);
}

/** A session row's memory cell. */
export function sessionMemoryText(load: ResourceSample | null | undefined): string {
    if (load === undefined) return '—';
    if (load === null) return 'unknown';
    return formatBytes(load.rss);
}

/**
 * The EXE-07 checklist from `Machine.doctor()`: isolation across the
 * environments, then per environment its sign-in and the daemon's verdict
 * with every finding — an environment the daemon sent no verdict for is a
 * failed "not checked" row, never a silent pass.
 */
export function doctorChecksOf(doctor: MachineDoctorView): DoctorCheck[] {
    const envs = doctor.environments;
    const checks: DoctorCheck[] = [];
    if (envs.length === 0) return [{ text: 'The daemon has reported no environment', ok: false, note: doctor.online ? 'environments.json is empty' : 'not connected yet' }];
    const isolated = envs.filter((e) => e.isolation !== 'none').length;
    checks.push({ text: 'Each environment has its own profile directory', ok: isolated === envs.length, note: `${isolated} of ${envs.length}` });
    for (const e of envs) {
        checks.push({ text: `${e.name} can authenticate`, ok: e.account.authStatus === 'ok', note: e.account.authStatus === 'ok' ? 'ok' : e.account.authStatus === 'expired' ? 'token expired' : e.account.authStatus === 'missing' ? 'not signed in' : 'unknown' });
        if (!e.verdict) {
            checks.push({ text: `${e.name} passed the daemon's doctor`, ok: false, note: 'not checked' });
            continue;
        }
        checks.push({ text: `${e.name} passed the daemon's doctor`, ok: e.verdict.ok, note: `checked ${dateTime(e.verdict.checkedAt)}` });
        for (const f of e.verdict.findings) checks.push({ text: f.message, ok: f.level !== 'error', note: f.code });
    }
    return checks;
}

/**
 * The environments with the turns running in each counted from the Machine's own sessions (#652, `activeIn`) — the
 * daemon's `concurrency.active` is only what it said at its last `hello` / `env`, so a card read from it goes stale.
 */
export function liveCapacity(view: Pick<MachineView, 'environments' | 'activeSessions' | 'pending' | 'draining'>): EnvironmentDescriptor[] {
    return view.environments.map((e) => ({ ...e, concurrency: { ...e.concurrency, active: activeIn(view, e.id) } }));
}

/** The doctor card's footnote on the platform: the verdicts are the daemon's, re-run there. */
export const LIVE_DOCTOR_FOOTNOTE = 'What the daemon reported at its last hello. Run `agentic-daemon doctor` on the machine to check again.';

/**
 * EXE-09/12: tasks parked on this machine's environments, by environment — because it is offline (`waiting-offline`
 * routes under the agent's `queue` policy) or because every slot is taken (`waiting-capacity`, #652).
 */
export function queuedByEnvironment(routing: RoutingView | undefined, machineId: MachineId | string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of routing?.routes ?? []) {
        if ((r.status !== 'waiting-offline' && r.status !== 'waiting-capacity') || !r.environmentId) continue;
        if (r.machineId !== undefined && r.machineId !== machineId) continue;
        out[r.environmentId] = (out[r.environmentId] ?? 0) + 1;
    }
    return out;
}

/**
 * Which agents default to which environment, from the directory's identities:
 * a daemon runtime's `environment.machine` is its `defaultEnvironmentId`
 * (`identityOf`), the platform runtime's is `platform`. An account-bound
 * agent (#414) lands under every one of `environments` whose login is its
 * account — where a chat naming this machine would run it.
 */
export function defaultForByEnvironment(agents: readonly AgentIdentity[], environments: readonly EnvironmentDescriptor[] = []): Record<string, DefaultForAgent[]> {
    const out: Record<string, DefaultForAgent[]> = {};
    for (const a of agents) {
        if (a.environment.runtime === 'anthropic-api') continue;
        if (a.account) {
            const key = accountKeyFor(a.environment.runtime, a.account);
            for (const e of environments) if (accountKeyOf(e) === key) (out[e.id] ??= []).push({ name: a.name, hue: a.hue });
            continue;
        }
        const id = a.environment.machine;
        if (!id || id === 'unassigned' || id === '—') continue;
        (out[id] ??= []).push({ name: a.name, hue: a.hue });
    }
    return out;
}

/** The agents on the `platform` row: every `anthropic-api` agent. */
export function platformAgents(agents: readonly AgentIdentity[]): DefaultForAgent[] {
    return agents.filter((a) => a.environment.runtime === 'anthropic-api').map((a) => ({ name: a.name, hue: a.hue }));
}

/** The `platform` row on the platform: the deployment's key serves every workspace (runbook §10), so the pill says it is not checked here. */
export const LIVE_PLATFORM_ROW = { caption: 'anthropic-api · the deployment’s key · runs without any machine online', key: 'unknown', keyLabel: 'KEY NOT CHECKED' } as const;

/**
 * The environment picker's options (`execution.defaultEnvironmentId`): every
 * environment of every paired machine as `machine / runtime / account`, the
 * machine's name first so the line matches `EnvironmentLine`.
 */
export function environmentOptions(machines: readonly { readonly name: string; readonly environments: readonly EnvironmentDescriptor[] }[]): FieldOption[] {
    const out: FieldOption[] = [];
    for (const m of machines) for (const e of m.environments) out.push({ value: e.id, label: `${m.name} / ${e.runtime} / ${e.account.label}` });
    return out;
}

/* ------------------------------------------------------------------ pairing */

/** One line to paste on the machine: the one-line installer for that OS (#343) — downloads the daemon, pairs, runs it in the background. */
export interface InstallLine {
    /** What the well is labelled: `Windows`, `macOS / Linux`. */
    readonly os: string;
    readonly command: string;
}

/** What the Pair page shows: the one-line installer per OS (runbook §5) and the by-hand pair command. */
export interface PairCommands {
    readonly install: readonly InstallLine[];
    readonly pair: string;
}

/** A PowerShell single-quoted literal: only `'` needs care. */
const psArg = (value: string): string => `'${value.replace(/'/g, "''")}'`;
/** A POSIX single-quoted literal. */
const shArg = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * `allowRoot` is the folder the machine lets this page manage environments in
 * (#239): `pair --allow-root` turns web management on at pairing (#238). Left
 * empty, the machine keeps it off and its environments are edited there.
 */
/**
 * `allowRoots` (#482): the folders the Pair page presets. Only full paths ride the by-hand command as `--allow-root`
 * (a headless install with no web round trip yet); a `~` form is the platform's to expand on the first hello — the
 * daemon's `pair` takes absolute paths only.
 */
export function pairCommands(origin: string, code: string, name: string, allowRoots: string | readonly string[] = []): PairCommands {
    // Every value quoted when it needs it: a machine name may hold a space, and so does the placeholder URL.
    const base = origin || '<platform url>';
    const url = shellArg(base);
    const machine = shellArg(name);
    const roots = (typeof allowRoots === 'string' ? [allowRoots] : allowRoots).map((r) => r.trim()).filter((r) => r && !r.startsWith('~'));
    return {
        install: [
            { os: 'Windows', command: `$env:AGENTIC_URL=${psArg(base)}; $env:AGENTIC_CODE=${psArg(code)}; $env:AGENTIC_NAME=${psArg(name)}; irm ${psArg(`${base}/install.ps1`)} | iex` },
            { os: 'macOS / Linux', command: `curl -fsSL ${shArg(`${base}/install.sh`)} | AGENTIC_URL=${shArg(base)} AGENTIC_CODE=${shArg(code)} AGENTIC_NAME=${shArg(name)} sh` }
        ],
        pair: `agentic-daemon pair ${code} --url ${url} --name ${machine}${roots.map((r) => ` --allow-root ${shellArg(r)}`).join('')}`
    };
}

/** Whole seconds left on a code; never negative. */
export function secondsLeft(expiresAt: number, now: number): number {
    return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** `machine-3` for a workspace with two machines registered — the name the daemon pairs under unless the user changes it. */
export function defaultMachineName(index: readonly MachineIndexEntry[]): string {
    return `machine-${index.length + 1}`;
}
