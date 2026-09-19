/**
 * The live machine pages' view model (#144): pure adapters from what the
 * Machine, Workspace and Routing actors return — `Machine.get()`,
 * `Machine.doctor()`, `Workspace.listMachines()`, `Routing.get()` — to the
 * `OpsMachine` / `OpsSession` / `DoctorCheck` shapes the machine groups,
 * the sessions table and the doctor card already render from the mock
 * workspace. Nothing here touches a hook or the DOM.
 */
import type { EnvironmentDescriptor, MachineId } from '@agentic/core';
import type { AgentHue, FieldOption } from '@agentic/ui';
import type { MachineDoctorView, MachineIndexEntry, MachineOs, MachineView, RoutingView } from '@agentic/platform';
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
        age: seenLabel(h.openedAt ?? h.requestedAt, now)
    }));
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

/** The doctor card's footnote on the platform: the verdicts are the daemon's, re-run there. */
export const LIVE_DOCTOR_FOOTNOTE = 'What the daemon reported at its last hello. Run `agentic-daemon doctor` on the machine to check again.';

/**
 * EXE-12: tasks parked on this machine's environments because it is offline
 * (`waiting-offline` routes under the agent's `queue` policy), by environment.
 */
export function queuedByEnvironment(routing: RoutingView | undefined, machineId: MachineId | string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of routing?.routes ?? []) {
        if (r.status !== 'waiting-offline' || !r.environmentId) continue;
        if (r.machineId !== undefined && r.machineId !== machineId) continue;
        out[r.environmentId] = (out[r.environmentId] ?? 0) + 1;
    }
    return out;
}

/**
 * Which agents default to which environment, from the directory's identities:
 * a daemon runtime's `environment.machine` is its `defaultEnvironmentId`
 * (`identityOf`), the platform runtime's is `platform`.
 */
export function defaultForByEnvironment(agents: readonly AgentIdentity[]): Record<string, DefaultForAgent[]> {
    const out: Record<string, DefaultForAgent[]> = {};
    for (const a of agents) {
        if (a.environment.runtime === 'anthropic-api') continue;
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

/** What the Pair page shows: the runbook's install line (§5.3, pairs too) and the by-hand pair command. */
export interface PairCommands {
    readonly install: string;
    readonly pair: string;
}

/**
 * `allowRoot` is the folder the machine lets this page manage environments in
 * (#239): `pair --allow-root` turns web management on at pairing (#238). Left
 * empty, the machine keeps it off and its environments are edited there.
 */
export function pairCommands(origin: string, code: string, name: string, allowRoot = ''): PairCommands {
    // Every value quoted when it needs it: a machine name may hold a space, and so does the placeholder URL.
    const url = shellArg(origin || '<platform url>');
    const machine = shellArg(name);
    const root = allowRoot.trim();
    return {
        install: `powershell -ExecutionPolicy Bypass -File install.ps1 -Url ${url} -Code ${code} -Name ${machine}`,
        pair: `agentic-daemon pair ${code} --url ${url} --name ${machine}${root ? ` --allow-root ${shellArg(root)}` : ''}`
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
