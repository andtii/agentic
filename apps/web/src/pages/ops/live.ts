/**
 * The live operations pages' view model (#145): pure adapters from what
 * the Schedule, Registry and Workspace actors return to the rows, cards
 * and drafts the mock pages already render, plus the specs and patches a
 * form submit persists. Nothing here touches a hook or the DOM, and
 * nothing of `@agentic/platform` is imported at runtime.
 */
import type { AgentId, EnvironmentId, MachineId, ProjectId, RuntimeId } from '@agentic/core';
import type { ConnectorRecord, Dependents, PluginView, ScheduleSpec, ScheduleView, SettingsPatch, WorkspaceOpRecord, WorkspaceSettings } from '@agentic/platform';
import type { OpsSchedule, ScheduleKind } from '../../mock/ops';

/** The Schedules table's column template (`docs/design/HANDOFF.md` → tables) — shared by the mock and the live page. */
export const SCHEDULES_COLS = '110px 1fr 140px 140px 310px 44px';

// ---------------------------------------------------------------------------
// Time zones

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/** The wall-clock fields of `instant` in `tz`, as a UTC timestamp of the same digits. */
function wallOf(instant: number, tz: string): number {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
}

/**
 * A wall time (`2026-09-18 15:00`, or with a `T`) read on the workspace's
 * wall clock → the instant, resolved through `Intl` like the Schedule
 * actor's own recurrence math (AST-07). A wall time inside a spring gap
 * lands after the gap; an ambiguous fall time takes its first occurrence.
 * `null` when the value is not a wall time.
 */
export function wallToInstant(value: string, tz: string): number | null {
    const m = WALL.exec(value.trim());
    if (!m) return null;
    const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
    // `Date.UTC` normalises overflow (month 13, day 40, hour 99); the dialog must not.
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    if (Number.isNaN(wanted) || new Date(wanted).getUTCMonth() !== month - 1) return null;
    try {
        const H = 3_600_000;
        const off1 = wallOf(wanted, tz) - wanted;
        const off2 = wallOf(wanted - off1, tz) - (wanted - off1);
        // The offsets around the guess, and one hour either side for a wall time that exists twice.
        const hits = [...new Set([wanted - off1, wanted - off2, wanted - off1 - H, wanted - off1 + H])].filter((c) => wallOf(c, tz) === wanted);
        if (hits.length) return Math.min(...hits);
        // Nothing maps to it — a spring gap: the first instant after it.
        return Math.max(wanted - off1, wanted - off2);
    } catch {
        return null;
    }
}

const dayStamp = (instant: number, tz: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const clockOf = (instant: number, tz: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(instant));

/** "today 15:00", "tomorrow 02:00", else "Thu 24 Sep 17:30" — in the workspace zone. */
export function nextRunLabel(instant: number, tz: string, now: number): string {
    try {
        const day = dayStamp(instant, tz);
        if (day === dayStamp(now, tz)) return `today ${clockOf(instant, tz)}`;
        if (day === dayStamp(now + 86_400_000, tz)) return `tomorrow ${clockOf(instant, tz)}`;
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(instant));
        const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
        return `${part('weekday')} ${part('day')} ${part('month')} ${clockOf(instant, tz)}`;
    } catch {
        return new Date(instant).toISOString();
    }
}

/** AST-07 as the footer states it, for the workspace's zone. */
export const dstRuleFor = (tz: string): string => `Times are ${tz}. Across daylight saving, 02:00 jobs run once: skipped hours run at 03:00, repeated hours run the first time only.`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "once", "daily 02:00", "weekdays 10:30", "Thu 17:30", else the cron text. */
export function whenLabel(view: Pick<ScheduleView, 'recurrence'>): string {
    const r = view.recurrence;
    if (r.kind === 'at') return 'once';
    const [min, hour, dom, mon, dow] = r.cron.trim().split(/\s+/);
    const clock = /^\d{1,2}$/.test(hour ?? '') && /^\d{1,2}$/.test(min ?? '') ? `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}` : null;
    if (!clock || dom !== '*' || mon !== '*') return r.cron;
    if (dow === '*') return `daily ${clock}`;
    if (dow === '1-5') return `weekdays ${clock}`;
    if (/^[0-6]$/.test(dow ?? '')) return `${WEEKDAYS[Number(dow)]} ${clock}`;
    return r.cron;
}

/** `Schedule.get()` → the row the table renders. */
export function scheduleRow(view: ScheduleView, tz: string, now: number): OpsSchedule {
    return {
        id: view.id,
        kind: view.kind,
        what: view.title,
        when: whenLabel(view),
        nextRun: view.enabled && view.next !== null ? nextRunLabel(view.next, tz, now) : view.enabled ? 'done' : 'paused',
        runsOn: { ...(view.environmentId ? { environmentId: view.environmentId } : {}), ...(view.agentId ? { agentId: view.agentId } : {}) },
        enabled: view.enabled
    };
}

/** What the "New schedule" dialog asks for. */
export interface NewScheduleInput {
    readonly kind: ScheduleKind;
    readonly title: string;
    /** `reminder`: `YYYY-MM-DD HH:mm` on the workspace clock. */
    readonly at: string;
    /** `recurring` / `agent-task`: a 5-field cron on the workspace clock. */
    readonly cron: string;
    readonly agentId: string;
    readonly environmentId: string;
    /** `agent-task`: the folder the task runs in, inside `environmentId` (#193); `''` = the environment's default. Optional for callers that predate it. */
    readonly workdir?: string;
    /** `agent-task`: the project the task belongs to (#333) — the router picks its folder per environment; exclusive with `environmentId` / `workdir`. `''` = none. */
    readonly projectId?: string;
    /** `agent-task`: the machine each run runs on (#414) — the router resolves the agent's account there; exclusive with `environmentId` / `workdir`. `''` = none. */
    readonly machineId?: string;
    readonly prompt: string;
}

export type NewScheduleErrors = Partial<Record<'title' | 'at' | 'cron' | 'agentId', string>>;

export function validateNewSchedule(input: NewScheduleInput, tz: string): NewScheduleErrors {
    const errors: NewScheduleErrors = {};
    if (!input.title.trim()) errors.title = 'A title is required.';
    if (input.kind === 'reminder') {
        if (wallToInstant(input.at, tz) === null) errors.at = 'Pick a date and time.';
    } else if (input.cron.trim().split(/\s+/).length !== 5) errors.cron = 'Five cron fields: minute hour day month weekday.';
    if (input.kind === 'agent-task' && !input.agentId) errors.agentId = 'Pick the agent that runs it.';
    return errors;
}

/** The dialog's input as the spec `Schedule.create` takes, on the workspace zone; `null` while it does not validate. */
export function newScheduleSpec(input: NewScheduleInput, tz: string): ScheduleSpec | null {
    if (Object.keys(validateNewSchedule(input, tz)).length) return null;
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    const recurrence: ScheduleSpec['recurrence'] = input.kind === 'reminder' ? { kind: 'at', at: wallToInstant(input.at, tz)! } : { kind: 'cron', cron: input.cron.trim(), tz };
    return {
        kind: input.kind,
        title,
        recurrence,
        ...(prompt ? { prompt } : {}),
        ...(input.kind === 'agent-task'
            ? {
                  agentId: input.agentId as AgentId,
                  // A project says where the work lives (#333), a machine where it runs (#414): either way no environment or folder of its own.
                  ...(input.projectId ? { projectId: input.projectId as ProjectId } : {}),
                  ...(input.machineId ? { machineId: input.machineId as MachineId } : {}),
                  ...(input.projectId || input.machineId
                      ? {}
                      : {
                            ...(input.environmentId ? { environmentId: input.environmentId as EnvironmentId } : {}),
                            // A folder only means something in its environment.
                            ...(input.environmentId && input.workdir?.trim() ? { workdir: input.workdir.trim() } : {})
                        }),
                  offlinePolicy: 'queue' as const
              }
            : {})
    };
}

// ---------------------------------------------------------------------------
// Plugins

/** A dependent by name, for the dialog and the status line: "Ada — connector, tool", "nightly triage — schedule via Bob". */
export function dependentNames(deps: Dependents, agentName: (id: string) => string = (id) => id): string[] {
    return [
        ...deps.agents.map((a) => `${a.name || a.id} — ${a.via.join(', ')}`),
        ...deps.schedules.map((s) => `${s.title} — schedule via ${agentName(s.agentId)}`)
    ];
}

export const dependentCount = (deps: Dependents): number => deps.agents.length + deps.schedules.length;

/** "Disable github" — nothing running is stopped (AC-13: only NEW use is refused), so the button says exactly that. */
export const disableLabel = (plugin: PluginView): string => `Disable ${plugin.manifest.name}`;

/** One line per connector: transport and where it is. A conduit connector runs on the platform itself (#530, #533). */
export function connectorWhere(c: ConnectorRecord): string {
    if (c.transport === 'streamable-http') return c.url ?? 'http';
    if (c.transport === 'conduit') return `${c.connector ?? 'conduit'} on the platform${c.account === undefined ? ' · not connected' : ''}`;
    return `${c.command ?? 'stdio'}${c.args?.length ? ` ${c.args.join(' ')}` : ''}${c.machine ? ` on ${c.machine}` : ''}`;
}

// ---------------------------------------------------------------------------
// Settings

/** What the settings form edits; strings so the fields bind straight to it. */
export interface SettingsDraft {
    timeZone: string;
    environmentId: string;
    inbox: boolean;
    push: boolean;
    sessionLogDays: string;
    artifactDays: string;
}

export type SettingsDraftErrors = Partial<Record<'timeZone' | 'sessionLogDays' | 'artifactDays', string>>;

export function toDraft(settings: WorkspaceSettings): SettingsDraft {
    return {
        timeZone: settings.timeZone,
        environmentId: settings.defaults.environmentId ?? '',
        inbox: settings.notifications.inbox,
        push: settings.notifications.push,
        sessionLogDays: String(settings.retention.sessionLogDays),
        artifactDays: String(settings.retention.artifactDays)
    };
}

const days = (value: string): number | null => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : null);

export function validateDraft(draft: SettingsDraft, zones: readonly string[]): SettingsDraftErrors {
    const errors: SettingsDraftErrors = {};
    const tz = draft.timeZone.trim();
    if (!tz) errors.timeZone = 'Choose a time zone.';
    else if (zones.length && tz !== 'UTC' && !zones.includes(tz)) errors.timeZone = `Unknown time zone "${tz}".`;
    if (days(draft.sessionLogDays) === null) errors.sessionLogDays = 'Whole days.';
    if (days(draft.artifactDays) === null) errors.artifactDays = 'Whole days.';
    return errors;
}

/**
 * The draft as the one-level patch `Workspace.updateSettings` takes; `null` while it does not validate.
 * `runtimeOf` names the runtime a machine environment runs (Claude Code, Copilot CLI, Codex, …); an
 * environment it does not know yet keeps `claude-code`, the first daemon runtime.
 */
export function settingsPatch(draft: SettingsDraft, zones: readonly string[], runtimeOf: (environmentId: EnvironmentId) => RuntimeId | undefined = () => undefined): SettingsPatch | null {
    if (Object.keys(validateDraft(draft, zones)).length) return null;
    const environmentId = draft.environmentId.trim();
    return {
        timeZone: draft.timeZone.trim(),
        notifications: { inbox: draft.inbox, push: draft.push },
        // The platform runtime for no environment; a machine environment runs its own.
        defaults: environmentId ? { runtime: runtimeOf(environmentId as EnvironmentId) ?? 'claude-code', environmentId: environmentId as EnvironmentId } : { runtime: 'anthropic-api', environmentId: undefined },
        retention: { sessionLogDays: days(draft.sessionLogDays)!, artifactDays: days(draft.artifactDays)! }
    };
}

/**
 * The IANA zones this runtime knows, the workspace's own first. Without
 * `Intl.supportedValuesOf` the list is the current zone plus UTC.
 */
export function timeZoneOptions(current: string): readonly string[] {
    const intl = Intl as { supportedValuesOf?: (key: 'timeZone') => string[] };
    let zones: string[] = [];
    try {
        zones = intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
    } catch {
        zones = [];
    }
    return [...new Set([current, ...zones, 'UTC'])];
}

/** What an OPS-10 task's record reads as: running, done (with what it did), or failed. */
export function opStatus(op: WorkspaceOpRecord | undefined, kind: 'export' | 'delete'): { readonly state: 'idle' | 'running' | 'done' | 'failed'; readonly text: string } {
    if (!op) return { state: 'idle', text: '' };
    if (op.finishedAt === undefined) return { state: 'running', text: kind === 'export' ? 'Exporting…' : 'Deleting…' };
    if (op.error) return { state: 'failed', text: `${kind === 'export' ? 'Export' : 'Delete'} failed: ${op.error}` };
    return kind === 'export'
        ? { state: 'done', text: `Exported ${op.count ?? 0} ${op.count === 1 ? 'file' : 'files'} under ${op.prefix ?? 'the export bucket'} (manifest.json lists them).` }
        : { state: 'done', text: `Deleted ${op.count ?? 0} records.` };
}
