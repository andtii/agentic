/**
 * The "Runtimes on this machine" card's view model (#370; EXE-08, AGT-09,
 * PLG-02, PLG-09): pure adapters from what `Machine.get()` reports — the
 * daemon's harnesses, what the channel's release ships for the machine's
 * platform, its environments and sessions — to the rows the card draws, the
 * phases of a harness request, what an update on one runtime interrupts,
 * how a request ended, and the runtime plugin page's machine list. Nothing
 * here touches a hook or the DOM.
 */
import type { EnvironmentDescriptor, HarnessPhase, HarnessReport, SessionId, TaskId } from '@agentic/core';
import type { AvailableHarness, HarnessResultView } from '@agentic/platform';

/** How the card names the built-in harness runtimes; another runtime shows by its id. */
export const RUNTIME_NAMES: Readonly<Record<string, string>> = {
    'claude-code': 'Claude Code',
    'codex-cli': 'Codex',
    'copilot-cli': 'Copilot CLI'
};

export const runtimeName = (runtime: string): string => RUNTIME_NAMES[runtime] ?? runtime;

/** A running turn on the runtime: what an update interrupts and offers Resume for. */
export interface HarnessTurn {
    readonly sessionId: SessionId;
    readonly taskId?: TaskId;
    readonly agentId: string;
}

/** One runtime as the card lists it. */
export interface HarnessRow {
    readonly runtime: string;
    readonly name: string;
    readonly status: HarnessReport['status'];
    /** The installed version; absent → not installed. */
    readonly installed?: string;
    /** The version the release on the machine's channel ships; absent → it ships none. */
    readonly available?: string;
    /** The release has a build of it for the machine's platform: Install / Update can go out. */
    readonly installable: boolean;
    /** Installed, and the release ships a newer build for the platform. */
    readonly update: boolean;
    /** The environments that run on it, by name — Remove waits for them. */
    readonly environments: readonly string[];
    /** Turns running on it now, and how many sessions are live on it. */
    readonly running: readonly HarnessTurn[];
    readonly liveSessions: number;
}

/** What the rows are read from: `Machine.get()` (`MachineView`), or the mock's copy of it. */
export interface HarnessSource {
    readonly harnesses?: readonly HarnessReport[];
    readonly harnessesAvailable?: Readonly<Record<string, AvailableHarness>>;
    readonly environments: readonly Pick<EnvironmentDescriptor, 'id' | 'name' | 'runtime'>[];
    readonly activeSessions: readonly { readonly sessionId: SessionId; readonly environmentId: string; readonly agentId: string; readonly taskId?: TaskId; readonly running?: unknown }[];
    readonly pending: readonly { readonly sessionId: SessionId; readonly command: { readonly type: string } }[];
}

const core = (v: string): number[] => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);

const prerelease = (v: string): string[] | null => {
    const at = v.split('+')[0]!.indexOf('-');
    return at < 0 ? null : v.split('+')[0]!.slice(at + 1).split('.');
};

/**
 * Whether `a` is a newer version than `b`, in semver precedence: dotted numbers first, then a release beats its
 * prerelease, then prerelease identifiers left to right — numeric ones numerically and below alphanumeric ones.
 */
export function newerThan(a: string, b: string): boolean {
    const x = core(a);
    const y = core(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d) return d > 0;
    }
    const pa = prerelease(a);
    const pb = prerelease(b);
    if (!pa || !pb) return !pa && !!pb;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const p = pa[i];
        const q = pb[i];
        if (p === undefined || q === undefined) return q === undefined;
        if (p === q) continue;
        const np = /^\d+$/.test(p);
        const nq = /^\d+$/.test(q);
        if (np && nq) return Number(p) > Number(q);
        if (np !== nq) return nq;
        return p > q;
    }
    return false;
}

/** The runtimes the daemon reports, in the order it reports them, with what the release offers and who uses each. */
export function harnessRows(source: HarnessSource): HarnessRow[] {
    const prompted = new Set<string>();
    for (const p of source.pending) if (p.command.type === 'prompt') prompted.add(p.sessionId);
    return (source.harnesses ?? []).map((h) => {
        const offer = source.harnessesAvailable?.[h.runtime];
        const envs = source.environments.filter((e) => e.runtime === h.runtime);
        const ids = new Set(envs.map((e) => e.id as string));
        const sessions = source.activeSessions.filter((s) => ids.has(s.environmentId));
        const installed = h.installed?.version;
        const installable = !!offer?.asset;
        return {
            runtime: h.runtime,
            name: runtimeName(h.runtime),
            status: h.status,
            ...(installed !== undefined ? { installed } : {}),
            ...(offer ? { available: offer.version } : {}),
            installable,
            update: installable && installed !== undefined && newerThan(offer!.version, installed),
            environments: envs.map((e) => e.name),
            running: sessions.filter((s) => s.running !== undefined || prompted.has(s.sessionId)).map((s) => ({ sessionId: s.sessionId, ...(s.taskId ? { taskId: s.taskId } : {}), agentId: s.agentId })),
            liveSessions: sessions.length
        };
    });
}

/** How many runtimes on a machine have a newer build waiting — the Machines list pill. */
export const harnessUpdates = (source: Pick<HarnessSource, 'harnesses' | 'harnessesAvailable'>): number =>
    (source.harnesses ?? []).filter((h) => {
        const offer = source.harnessesAvailable?.[h.runtime];
        return !!offer?.asset && h.installed !== undefined && newerThan(offer.version, h.installed.version);
    }).length;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Why Remove is off, or `null` when it may go out. */
export function removeBlocked(row: HarnessRow): string | null {
    if (row.environments.length) return `Used by ${row.environments.join(', ')}. Remove ${row.environments.length === 1 ? 'that environment' : 'those environments'} first.`;
    if (row.installed === undefined && row.status !== 'broken') return 'Not installed.';
    return null;
}

/** The status line of a row: "2.0.0 · 2.1.0 available", "not installed · 1.0.14 available", "broken". */
export function versionLine(row: HarnessRow): string {
    const have = row.installed ?? 'not installed';
    const offer = row.available && row.available !== row.installed ? ` · ${row.available} available${row.installable ? '' : ' (no build for this machine)'}` : '';
    return `${have}${offer}`;
}

/**
 * What an update on the runtime costs (re-scoped #370): `now` interrupts its running turns and offers them Resume;
 * `drain` waits for them first, for at most the daemon's drain window. Either way its live sessions restart.
 */
export function harnessImpactText(row: HarnessRow, mode: 'drain' | 'now'): string {
    const turns = row.running.length;
    const lead = !turns
        ? `No turn is running on ${row.name}, so nothing is interrupted.`
        : mode === 'now'
            ? `${plural(turns, 'running turn', 'running turns')} on ${row.name} will be interrupted and offered Resume.`
            : `It waits for ${plural(turns, 'running turn', 'running turns')} on ${row.name} to end, for at most 10 minutes; one still running then is interrupted and offered Resume.`;
    const live = row.liveSessions;
    const tail = live
        ? ` ${plural(live, 'live session restarts', 'live sessions restart')}: anything ${live === 1 ? 'it' : 'they'} started in the background stops; ${live === 1 ? 'its conversation continues' : 'their conversations continue'}. Other runtimes keep running.`
        : ' Other runtimes keep running.';
    return lead + tail;
}

/** The phases a harness request walks (`harness.status`): a removal only applies. */
export const HARNESS_PHASES: readonly Exclude<HarnessPhase, 'done' | 'failed'>[] = ['downloading', 'verifying', 'staged', 'draining', 'applying'];

export const HARNESS_PHASE_LABEL: Readonly<Record<Exclude<HarnessPhase, 'done' | 'failed'>, string>> = {
    downloading: 'Downloading',
    verifying: 'Verifying',
    staged: 'Staged',
    draining: 'Draining',
    applying: 'Applying'
};

export interface HarnessStep {
    readonly phase: Exclude<HarnessPhase, 'done' | 'failed'>;
    readonly label: string;
    readonly state: 'done' | 'current' | 'todo';
}

/** The phase list of a pending request: before the first `harness.status` every phase is still to do. */
export function harnessSteps(request: Pick<HarnessResultView, 'op' | 'phase'>): HarnessStep[] {
    const phases = request.op === 'remove' ? (['applying'] as const) : HARNESS_PHASES;
    const at = request.phase && request.phase !== 'done' && request.phase !== 'failed' ? phases.indexOf(request.phase as never) : -1;
    return phases.map((phase, i) => ({ phase, label: HARNESS_PHASE_LABEL[phase], state: i < at ? 'done' : i === at ? 'current' : 'todo' }));
}

/** "Updating Claude Code to 2.1.0 (when its turns end)". */
export function pendingLine(request: Pick<HarnessResultView, 'op' | 'runtime' | 'to' | 'mode' | 'phase'>): string {
    const name = runtimeName(request.runtime);
    const to = request.to ?? 'the release version';
    const what = request.op === 'remove' ? `Removing ${name}` : request.op === 'install' ? `Installing ${name} ${to}` : `Updating ${name} to ${to}`;
    const when = request.op === 'remove' ? '' : request.mode === 'now' ? ' (now)' : ' (when its turns end)';
    return `${what}${when}.${request.phase ? '' : ' Asked — waiting for the daemon to report.'}`;
}

/** How a finished request ended, as the row's line; `null` while it is pending. */
export function outcomeLine(request: Pick<HarnessResultView, 'op' | 'runtime' | 'status' | 'to' | 'error'>): string | null {
    if (request.status === 'pending') return null;
    const name = runtimeName(request.runtime);
    if (request.status === 'done') {
        if (request.op === 'remove') return `${name} was removed.`;
        if (request.op === 'install') return `${request.to ? `${name} ${request.to}` : name} is installed.`;
        return `${name} was updated${request.to ? ` to ${request.to}` : ''}.`;
    }
    return `${request.op === 'remove' ? `Removing ${name}` : `The ${request.op} of ${name}`} did not go through: ${harnessErrorText(request.error)}`;
}

/** A daemon's (or the platform's) named failure in words. */
export function harnessErrorText(error: HarnessResultView['error']): string {
    if (!error) return 'the daemon did not say why.';
    switch (error.code) {
        case 'timeout':
            return 'the daemon did not finish in time.';
        case 'interrupted':
            return 'the daemon restarted before it finished. Check the version it reports, then try again.';
        case 'checksum':
            return 'the download did not match the release. Nothing was changed.';
        case 'download-failed':
            return `the download failed (${error.message}). Nothing was changed.`;
        case 'in-use':
            return error.message;
        default:
            return error.message || error.code;
    }
}

/** A `requestHarness` refusal as the card says it: the `in-use` / `not-installed` reason, the offline or reinstall line, else the message. */
export function refusalText(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number } | null)?.status;
    if (status === 503) return 'The machine is offline. Its runtimes can be changed while its daemon is connected.';
    return message.replace(/^(in-use|not-installed): /, '');
}

/** A `requestHarness` refusal that means "reinstall once" (409: the daemon does not answer `harness`). */
export function harnessNeedsReinstall(e: unknown): boolean {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : String(e);
    return status === 409 && /reinstall/.test(message);
}

/* --------------------------------------------------- runtime plugin page */

/** One machine as the runtime plugin page lists it: it has the harness (at a version), it lacks it, or it is broken. */
export interface RuntimeMachine {
    readonly machineId: string;
    readonly name: string;
    readonly online: boolean;
    readonly state: 'has' | 'lacks' | 'broken' | 'unknown';
    readonly version?: string;
    /** A newer build is waiting for it. */
    readonly update?: string;
}

/** Where `runtime` stands on one machine, from what its daemon reported; `unknown` when it reports no harnesses (it predates them). */
export function runtimeOnMachine(runtime: string, machine: { readonly machineId: string; readonly name: string; readonly online: boolean } & Pick<HarnessSource, 'harnesses' | 'harnessesAvailable'>): RuntimeMachine {
    const base = { machineId: machine.machineId, name: machine.name, online: machine.online };
    const h = machine.harnesses?.find((x) => x.runtime === runtime);
    if (!machine.harnesses) return { ...base, state: 'unknown' };
    if (!h) return { ...base, state: 'lacks' };
    const offer = machine.harnessesAvailable?.[runtime];
    const version = h.installed?.version;
    const update = offer?.asset && version !== undefined && newerThan(offer.version, version) ? offer.version : undefined;
    if (h.status === 'broken') return { ...base, state: 'broken', ...(version ? { version } : {}) };
    if (h.status === 'missing' || version === undefined) return { ...base, state: 'lacks' };
    return { ...base, state: 'has', version, ...(update ? { update } : {}) };
}

/** "2.0.0 · 2.1.0 available · offline" — what follows the machine's pill. */
export const runtimeMachineLine = (m: RuntimeMachine): string => [m.version, m.update ? `${m.update} available` : undefined, m.online ? undefined : 'offline'].filter((x): x is string => !!x).join(' · ');

export const RUNTIME_MACHINE_TEXT: Readonly<Record<RuntimeMachine['state'], string>> = {
    has: 'installed',
    lacks: 'not installed',
    broken: 'broken',
    unknown: 'daemon predates harnesses'
};
