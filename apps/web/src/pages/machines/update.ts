/**
 * The machine update card's view model (#367; EXE-08, OPS-03, OPS-04): pure
 * adapters from `Machine.updateState()` (#365) to what the card, the
 * Machines list badges, "Update all" and the Settings defaults print — the
 * build line, the phases of a pending update, what "Update now" interrupts,
 * how the last update ended, the restart warning, and the policy form's
 * draft. Nothing here touches a hook or the DOM.
 */
import type { DaemonBuild, HostOs, ReleaseChannel, UpdatePhase, UpdatePolicy } from '@agentic/core';
import type { MachineUpdateView } from '@agentic/platform';
import { dateTime } from '../agent/format';
import { whenLabel } from '../ops/live';

/** `0.2.0 · stable · abc1234` — the build a daemon reported, else its bare version (it predates builds, #359). */
export function buildLabel(build: DaemonBuild | undefined, daemonVersion: string | undefined): string {
    if (build) return `daemon ${build.version} · ${build.channel} · ${build.commit.slice(0, 7)}`;
    return `daemon ${daemonVersion ?? '—'}`;
}

/** "Running `0.2.0` (`stable`, built `abc1234`)"; a daemon without a build says only its version. */
export function runningLine(view: Pick<MachineUpdateView, 'build' | 'channel'>, daemonVersion?: string): string {
    const b = view.build;
    if (!b) return `Running ${daemonVersion ?? 'an unknown version'}`;
    return `Running ${b.version} (${view.channel}, built ${b.commit.slice(0, 7)})`;
}

/** Whether the daemon can update itself: it reports a build and answers `update` (#359). Otherwise it is reinstalled once. */
export const canSelfUpdate = (view: Pick<MachineUpdateView, 'build' | 'features'>): boolean => !!view.build && view.features.includes('update');

/** The phases a daemon update walks, in order (`update.status`, #359); `failed` ends any of them. */
export const UPDATE_PHASES: readonly Exclude<UpdatePhase, 'failed'>[] = ['downloading', 'verifying', 'staged', 'draining', 'restarting'];

export const PHASE_LABEL: Readonly<Record<Exclude<UpdatePhase, 'failed'>, string>> = {
    downloading: 'Downloading',
    verifying: 'Verifying',
    staged: 'Staged',
    draining: 'Draining',
    restarting: 'Restarting'
};

export interface PhaseStep {
    readonly phase: Exclude<UpdatePhase, 'failed'>;
    readonly label: string;
    readonly state: 'done' | 'current' | 'todo';
}

/** The phase list of a pending update: before the first `update.status` every phase is still to do. */
export function phaseSteps(pending: Pick<NonNullable<MachineUpdateView['pending']>, 'phase'>): PhaseStep[] {
    const at = pending.phase && pending.phase !== 'failed' ? UPDATE_PHASES.indexOf(pending.phase) : -1;
    return UPDATE_PHASES.map((phase, i) => ({ phase, label: PHASE_LABEL[phase], state: i < at ? 'done' : i === at ? 'current' : 'todo' }));
}

/** A download's progress as a whole percent, or `null` when the daemon sent none. */
export function progressPercent(progress: { readonly bytes: number; readonly total: number } | undefined): number | null {
    if (!progress || !(progress.total > 0)) return null;
    return Math.max(0, Math.min(100, Math.round((progress.bytes / progress.total) * 100)));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What "Update now" costs, before it is confirmed (re-scoped #367): the running turns are interrupted and offered
 * Resume; every live session restarts, which stops what it started in the background while its conversation goes on.
 */
export function impactText(impact: MachineUpdateView['impact']): string {
    const turns = impact.runningTurns.length;
    const lead = turns
        ? `${plural(turns, 'running turn', 'running turns')} will be interrupted and offered Resume.`
        : 'No turn is running, so nothing is interrupted.';
    const live = impact.liveSessions;
    const tail = live
        ? ` ${plural(live, 'live session restarts', 'live sessions restart')}: anything ${live === 1 ? 'it' : 'they'} started in the background (dev servers, watchers) stops; ${live === 1 ? 'its conversation continues' : 'their conversations continue'}.`
        : '';
    return lead + tail;
}

/** While draining: "waiting for 2 running turns" — the links follow it. */
export function drainingText(impact: MachineUpdateView['impact']): string {
    const n = impact.runningTurns.length;
    return n ? `Waiting for ${plural(n, 'running turn', 'running turns')}:` : 'Waiting for running turns to end.';
}

/** How the last update ended, as the card's line — `null` when there was none. */
export function lastLine(last: MachineUpdateView['last'], zone?: string): string | null {
    if (!last) return null;
    const at = dateTime(last.at, zone);
    switch (last.outcome) {
        case 'applied':
            return `Updated to ${last.to} at ${at}.`;
        case 'rolled-back':
            return `The update to ${last.to} failed at ${at}${last.error ? `: ${last.error}` : ''}. The previous version was restored.`;
        case 'timeout':
            return `The update to ${last.to} timed out at ${at}${last.error ? `: ${last.error}` : ''}.`;
        case 'cancelled':
            return last.to === 'restart' ? `The restart was cancelled at ${at}.` : `The update to ${last.to} was cancelled at ${at}.`;
        case 'restarted':
            return `Restarted at ${at}.`;
        default:
            if (last.to === 'restart') return `The restart failed at ${at}${last.error ? `: ${last.error}` : ''}.`;
            return `The update to ${last.to} failed at ${at}${last.error ? `: ${last.error}` : ''}.`;
    }
}

/** The version "Roll back" returns to: the one the last applied update left (the daemon keeps it as `previous`). */
export function rollbackTarget(view: Pick<MachineUpdateView, 'last' | 'build'>): string | null {
    const last = view.last;
    if (!last || last.outcome !== 'applied' || !last.from || last.from === 'previous') return null;
    if (view.build && view.build.version === last.from) return null;
    return last.from;
}

/** A restart count that means trouble (#367): three or more, the last one inside the hour. */
export const RESTART_WARNING_COUNT = 3;
export const RESTART_WARNING_WINDOW_MS = 60 * 60_000;

/** The warning line under the card, or `null`: "Restarted 4 times — last exit: crashed (code 1) at 21 Sep 11:58". */
export function restartWarning(view: Pick<MachineUpdateView, 'restarts' | 'lastExit'>, now: number, zone?: string): string | null {
    const n = view.restarts ?? 0;
    const exit = view.lastExit;
    if (n < RESTART_WARNING_COUNT || !exit || now - exit.at > RESTART_WARNING_WINDOW_MS) return null;
    return `The daemon restarted ${n} times — last exit: ${exit.reason}${exit.code !== undefined ? ` (code ${exit.code})` : ''} at ${dateTime(exit.at, zone)}.`;
}

/** The Machines list pill for a machine's update, or `null`. */
export type UpdateBadge = 'outdated' | 'updating' | 'draining' | 'available';

export function updateBadge(view: Pick<MachineUpdateView, 'outdated' | 'pending' | 'draining' | 'available'> | null | undefined): UpdateBadge | null {
    if (!view) return null;
    if (view.pending) return view.pending.phase === 'draining' || (!view.pending.phase && view.draining) ? 'draining' : 'updating';
    if (view.outdated) return 'outdated';
    if (view.available) return 'available';
    return null;
}

export const BADGE_TEXT: Readonly<Record<UpdateBadge, { readonly label: string; readonly tone: 'failed' | 'working' | 'needs-you' | 'live' }>> = {
    outdated: { label: 'UPDATE REQUIRED', tone: 'failed' },
    updating: { label: 'UPDATING', tone: 'working' },
    draining: { label: 'DRAINING', tone: 'working' },
    available: { label: 'UPDATE AVAILABLE', tone: 'needs-you' }
};

/** Whether "Update all" asks this machine: online, able to update itself, a release available and nothing pending. */
export const updatable = (view: MachineUpdateView): boolean => view.online && canSelfUpdate(view) && !!view.available && !view.pending;

/* ------------------------------------------------------------ reinstall */

/**
 * The one-line installer without a pairing code (runbook §5.3): on a paired machine it upgrades in place — the
 * daemon's token and data stay. What a daemon that predates updates runs once.
 */
export function reinstallCommand(origin: string, os: HostOs | undefined): string {
    const base = origin || '<platform url>';
    if (os === 'windows') return `irm '${base}/install.ps1' | iex`;
    return `curl -fsSL '${base}/install.sh' | sh`;
}

/** A `requestUpdate` refusal that means "reinstall once" (409: no build, or no `update` feature). */
export function needsReinstall(e: unknown): boolean {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : String(e);
    return status === 409 && /reinstall/.test(message);
}

/* --------------------------------------------------------------- policy */

/** The channel and policy form's draft; `''` follows the workspace default (a machine) — Settings has no such option. */
export interface PolicyDraft {
    channel: ReleaseChannel | '';
    kind: UpdatePolicy['kind'] | '';
    cron: string;
    /** Hours the window stays open, as typed. */
    hours: string;
}

export const DEFAULT_WINDOW_CRON = '0 3 * * *';

export function draftOfPolicy(channel: ReleaseChannel | null, policy: UpdatePolicy | null): PolicyDraft {
    return {
        channel: channel ?? '',
        kind: policy?.kind ?? '',
        cron: policy?.kind === 'window' ? policy.cron : DEFAULT_WINDOW_CRON,
        hours: policy?.kind === 'window' ? String(Math.round((policy.durationMs / 3_600_000) * 100) / 100) : '2'
    };
}

export type PolicyErrors = Partial<Record<'cron' | 'hours', string>>;

/** The window fields checked the way the platform checks them (`checkUpdatePolicy`): five cron fields, one minute to seven days. */
export function validatePolicy(draft: PolicyDraft): PolicyErrors {
    if (draft.kind !== 'window') return {};
    const errors: PolicyErrors = {};
    if (draft.cron.trim().split(/\s+/).length !== 5) errors.cron = 'Five cron fields: minute hour day month weekday.';
    const hours = Number(draft.hours);
    if (!draft.hours.trim() || !Number.isFinite(hours) || hours * 60 < 1 || hours > 168) errors.hours = 'Between one minute and 168 hours.';
    return errors;
}

/** The draft's policy, `null` for "the workspace default", or `undefined` when it does not validate. */
export function policyOfDraft(draft: PolicyDraft, tz: string): UpdatePolicy | null | undefined {
    if (Object.keys(validatePolicy(draft)).length) return undefined;
    switch (draft.kind) {
        case '':
            return null;
        case 'window':
            return { kind: 'window', cron: draft.cron.trim(), tz, durationMs: Math.round(Number(draft.hours) * 3_600_000) };
        default:
            return { kind: draft.kind };
    }
}

/** Two policies say the same (a window compares field by field). */
export function samePolicy(a: UpdatePolicy | null | undefined, b: UpdatePolicy | null | undefined): boolean {
    if (!a || !b) return a === b || (!a && !b);
    if (a.kind !== b.kind) return false;
    if (a.kind === 'window' && b.kind === 'window') return a.cron === b.cron && a.tz === b.tz && a.durationMs === b.durationMs;
    return true;
}

/** "daily 03:00", "weekdays 22:30", "Sun 02:00", else the cron text — the Schedules page's reading (`whenLabel`). */
export const cronLabel = (cron: string): string => whenLabel({ recurrence: { kind: 'cron', cron, tz: 'UTC' } });

/** A policy in words: "manual", "when idle", "daily 03:00 for 2 h (Europe/Stockholm)". */
export function policyLabel(policy: UpdatePolicy): string {
    switch (policy.kind) {
        case 'manual':
            return 'only when asked';
        case 'auto-when-idle':
            return 'as soon as no turn runs';
        case 'window': {
            const hours = policy.durationMs / 3_600_000;
            const span = hours >= 1 ? `${Math.round(hours * 100) / 100} h` : `${Math.round(policy.durationMs / 60_000)} min`;
            return `${cronLabel(policy.cron)} for ${span} (${policy.tz})`;
        }
    }
}

export const POLICY_KIND_LABEL: Readonly<Record<UpdatePolicy['kind'], string>> = {
    manual: 'Manual — only when asked',
    'auto-when-idle': 'When idle — as soon as no turn runs',
    window: 'In a window — a recurring time'
};
