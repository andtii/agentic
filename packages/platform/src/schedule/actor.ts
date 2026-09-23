/**
 * Schedule actor — `{ws}:schedule:{id}` (architecture §4, AST-02/03/05/07).
 *
 * One actor per entry. Each occurrence is armed as a ONE-SHOT durable
 * reminder (`ctx.reminders.set('fire', {due})`) and re-armed from
 * `onReminder`, so the runtime's 60 s *period* floor is never asked for and
 * a Durable Object fires it from its own alarm with nothing else online.
 *
 * Persistence is `save` per turn: on Workers `onDeactivate` never runs, so
 * every mutation below ends in `ctx.save()` before the turn returns.
 *
 * Catch-up policy is `skip`: a reminder that runs late (host down, alarm
 * delayed) fires ONCE for the occurrence it was armed for, logs how many
 * later occurrences fell before "now", and re-arms from "now".
 */
import type { AgentId, EnvironmentId, MachineId, ProjectId, ScheduleId, WorkspaceId } from '@agentic/core';
import { workspaceOfKey } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { sameWorkspace } from '../auth/index.js';
import { NAME_RE } from '../registry/manifest.js';
import type { OfflinePolicy, ScheduleFired, ScheduleKind, ScheduleSource, TriggerHop, TriggerPort, TriggerResult } from './ports.js';
import { countOccurrences, nextOccurrence, validateRecurrence, type Recurrence } from './recur.js';

// ---------------------------------------------------------------------------
// State

export type ScheduleLogEntry =
    | { readonly kind: 'fired'; readonly at: number; readonly scheduledFor: number; readonly skipped: number }
    | { readonly kind: 'skipped'; readonly at: number; readonly from: number; readonly to: number; readonly count: number }
    | { readonly kind: 'retry'; readonly at: number; readonly scheduledFor: number; readonly attempt: number; readonly error: string }
    | { readonly kind: 'dropped'; readonly at: number; readonly scheduledFor: number; readonly error: string }
    | { readonly kind: 'exhausted'; readonly at: number }
    /** A firing asked to turn the entry off (#535). */
    | { readonly kind: 'paused'; readonly at: number; readonly reason: string };

export interface ScheduleState {
    /** `false` until `create` has run — every other method requires it. */
    created: boolean;
    workspaceId: WorkspaceId;
    id: ScheduleId;
    kind: ScheduleKind;
    title: string;
    recurrence: Recurrence;
    enabled: boolean;
    /** The instant the armed reminder is for; `null` when nothing is armed. */
    next: number | null;
    lastRun: number | null;
    /** Firings delivered so far. */
    runs: number;
    /** Delivery attempts for the CURRENT occurrence (reset after success or drop). */
    attempts: number;
    agentId?: AgentId;
    environmentId?: EnvironmentId;
    /** The folder a fired task runs in (#190); only with `environmentId`. */
    workdir?: string;
    /** The project a fired task belongs to (#332): the router picks its folder per environment. Never with `environmentId` or `workdir`. */
    projectId?: ProjectId;
    /** The machine a fired task runs on (#414): the router resolves the agent's account there. Never with `environmentId` or `workdir`. */
    machineId?: MachineId;
    prompt?: string;
    offlinePolicy: OfflinePolicy;
    /** What the entry watches (#535): handed to every firing. */
    source?: ScheduleSource;
    /** The trigger's progress, as the last firing that returned one left it (#535). */
    cursor?: string;
    /** Why a firing turned the entry off (#535); cleared when the owner switches it. */
    paused?: { readonly at: number; readonly reason: string };
    log: ScheduleLogEntry[];
    createdAt: number;
    updatedAt: number;
}

export interface ScheduleSpec {
    readonly kind: ScheduleKind;
    readonly title: string;
    readonly recurrence: Recurrence;
    readonly agentId?: AgentId;
    readonly environmentId?: EnvironmentId;
    /** The folder a fired task runs in (#190): absolute, within the roots of `environmentId` — which it requires. */
    readonly workdir?: string;
    /**
     * The project a fired task belongs to (#332): the router resolves the project's folder for whichever environment
     * the agent runs in. Exclusive with `environmentId` and `workdir` — a project says where the work lives.
     */
    readonly projectId?: ProjectId;
    /**
     * The machine a fired task runs on (#414): the router resolves the agent's account there — and the project's
     * folder, when the schedule names one. Exclusive with `environmentId` and `workdir`, which name a machine already.
     */
    readonly machineId?: MachineId;
    readonly prompt?: string;
    /** Default `'queue'`. */
    readonly offlinePolicy?: OfflinePolicy;
    /** Default `true`. */
    readonly enabled?: boolean;
    /** What the entry watches (#535): a connector trigger. Needs an `agentId` — the agent each new item wakes. */
    readonly source?: ScheduleSource;
}

/** `workdir: null` clears the folder; `projectId: null` / `environmentId: null` / `machineId: null` / `source: null` clear those. */
export type SchedulePatch = Partial<Omit<ScheduleSpec, 'kind' | 'workdir' | 'projectId' | 'environmentId' | 'machineId' | 'source'>> & { readonly workdir?: string | null; readonly projectId?: ProjectId | null; readonly environmentId?: EnvironmentId | null; readonly machineId?: MachineId | null; readonly source?: ScheduleSource | null };

/** The longest cursor an entry keeps (#535): a longer one is not stored, and the previous cursor stays. */
export const SCHEDULE_CURSOR_MAX = 32_768;
/** The longest `source.query` an entry keeps. */
export const SOURCE_QUERY_MAX = 1000;

/** A source names a connector plugin, carries a bounded filter, and wakes an agent (#535). */
function checkSource(source: ScheduleSource | undefined, agentId: AgentId | undefined): void {
    if (source === undefined) return;
    if (typeof source !== 'object' || source === null || source.kind !== 'connector') throw new ServerFnError(400, "[schedule] source.kind must be 'connector'");
    if (typeof source.connector !== 'string' || !NAME_RE.test(source.connector)) throw new ServerFnError(400, '[schedule] source.connector must be a plugin id');
    if (source.query !== undefined && (typeof source.query !== 'string' || source.query.length > SOURCE_QUERY_MAX)) throw new ServerFnError(400, `[schedule] source.query must be text of at most ${SOURCE_QUERY_MAX} characters`);
    if (agentId === undefined) throw new ServerFnError(400, '[schedule] a source needs an agentId (the agent each new item wakes)');
}

/** The stored copy: only the fields a source has. */
const sourceOf = (s: ScheduleSource): ScheduleSource => ({ kind: 'connector', connector: s.connector, ...(s.query !== undefined ? { query: s.query } : {}) });

/** A folder travels with its environment (#190): refuse one without it, or a blank one. */
function checkWorkdir(workdir: string | undefined, environmentId: EnvironmentId | undefined): void {
    if (workdir === undefined) return;
    if (typeof workdir !== 'string' || !workdir.trim()) throw new ServerFnError(400, '[schedule] workdir must be a path');
    if (environmentId === undefined) throw new ServerFnError(400, '[schedule] a workdir needs an environmentId');
}

/** A project names the folder itself (#332): refuse one beside an environment or a folder, or a blank one. */
function checkMachine(machineId: MachineId | undefined, environmentId: EnvironmentId | undefined, workdir: string | undefined): void {
    if (machineId === undefined) return;
    if (typeof machineId !== 'string' || !machineId.trim()) throw new ServerFnError(400, '[schedule] machineId must be an id');
    if (environmentId !== undefined || workdir !== undefined) throw new ServerFnError(400, '[schedule] a machineId is exclusive with environmentId and workdir (an environment names its machine)');
}

function checkProject(projectId: ProjectId | undefined, environmentId: EnvironmentId | undefined, workdir: string | undefined): void {
    if (projectId === undefined) return;
    if (typeof projectId !== 'string' || !projectId.trim()) throw new ServerFnError(400, '[schedule] projectId must be an id');
    if (environmentId !== undefined || workdir !== undefined) throw new ServerFnError(400, '[schedule] a projectId is exclusive with environmentId and workdir');
}

/** What `get()` returns: the state minus the bookkeeping flag. */
export type ScheduleView = Readonly<Omit<ScheduleState, 'created'>>;

// ---------------------------------------------------------------------------
// Options

export interface ScheduleActorOptions {
    /** Where firings go (Task creation / Inbox in integration). */
    readonly trigger: TriggerPort;
    /** Clock; default `Date.now`. Tests inject a virtual one. */
    readonly now?: () => number;
    /** Override the policy chain. Default: the package's `sameWorkspace` (src/auth). */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
    /** Waive the identity gate (tests, in-process hosts without a codec). */
    readonly allowAnonymous?: true;
    /** Delivery attempts per occurrence before it is dropped. Default 3. */
    readonly maxAttempts?: number;
    /** Retry delay after a failed delivery, ms. Default and floor: 60 s. */
    readonly retryDelayMs?: number;
    /** Log entries kept in state. Default 50. */
    readonly logLimit?: number;
    /** Observe every log entry as it is written (metrics, console). Default: none. */
    readonly onLog?: (key: string, entry: ScheduleLogEntry) => void;
}

/** The reminder name every occurrence is armed under. */
export const FIRE = 'fire';
/** The platform's reminder resolution: retries are never armed tighter than this. */
export const REMINDER_FLOOR_MS = 60_000;

const DEFAULTS = { maxAttempts: 3, retryDelayMs: REMINDER_FLOOR_MS, logLimit: 50 } as const;

// ---------------------------------------------------------------------------
// Definition

/** `{ws}:schedule:{id}` → its parts, or `null` for any other shape. */
function parseKey(key: string): { workspaceId: WorkspaceId; id: ScheduleId } | null {
    const ws = workspaceOfKey(key);
    const marker = ':schedule:';
    const i = key.indexOf(marker);
    if (ws === null || i < 0 || i + marker.length >= key.length) return null;
    return { workspaceId: ws, id: key.slice(i + marker.length) as ScheduleId };
}

export function defineScheduleActor(options: ScheduleActorOptions) {
    const now = options.now ?? Date.now;
    const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    const retryDelayMs = Math.max(REMINDER_FLOOR_MS, options.retryDelayMs ?? DEFAULTS.retryDelayMs);
    const logLimit = options.logLimit ?? DEFAULTS.logLimit;
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? sameWorkspace;

    type Ctx = ActorContext<ScheduleState>;

    const log = (ctx: Ctx, entry: ScheduleLogEntry): void => {
        ctx.state.log.push(entry);
        if (ctx.state.log.length > logLimit) ctx.state.log.splice(0, ctx.state.log.length - logLimit);
        options.onLog?.(ctx.key, entry);
    };

    /** Arm the reminder for `state.next` (or clear it). Never sets a `period`. */
    const arm = async (ctx: Ctx): Promise<void> => {
        const s = ctx.state;
        if (!s.enabled || s.next === null) {
            await ctx.reminders.clear(FIRE);
            return;
        }
        await ctx.reminders.set(FIRE, { due: Math.max(0, s.next - now()) });
    };

    /** Recompute `next` from `after` and (re)arm. */
    const reschedule = async (ctx: Ctx, after: number): Promise<void> => {
        const s = ctx.state;
        s.next = s.enabled ? nextOccurrence(s.recurrence, after) : null;
        if (s.enabled && s.next === null) log(ctx, { kind: 'exhausted', at: now() });
        s.updatedAt = now();
        await ctx.save();
        await arm(ctx);
    };

    const requireCreated = (ctx: Ctx): void => {
        if (!ctx.state.created) throw new Error(`[schedule] ${ctx.key} does not exist`);
    };

    const view = (s: ScheduleState): ScheduleView => {
        const { created: _created, ...rest } = s;
        void _created;
        return { ...rest, log: [...rest.log] };
    };

    return defineActor({
        type: 'Schedule',
        authorize,
        ...(options.allowAnonymous ? { allowAnonymous: true as const } : {}),
        state: (key): ScheduleState => {
            // A malformed key is rejected by `create`, not here: a throwing
            // state factory would surface as an opaque activation failure.
            const parsed = parseKey(key);
            return {
                created: false,
                workspaceId: parsed?.workspaceId ?? ('' as WorkspaceId),
                id: parsed?.id ?? ('' as ScheduleId),
                kind: 'reminder',
                title: '',
                recurrence: { kind: 'at', at: 0 },
                enabled: false,
                next: null,
                lastRun: null,
                runs: 0,
                attempts: 0,
                offlinePolicy: 'queue',
                log: [],
                createdAt: 0,
                updatedAt: 0
            };
        },
        methods: (ctx) => ({
            async create(spec: ScheduleSpec): Promise<ScheduleView> {
                if (ctx.state.created) throw new Error(`[schedule] ${ctx.key} already exists`);
                if (parseKey(ctx.key) === null) throw new Error(`[schedule] key must be "{ws}:schedule:{id}", got "${ctx.key}"`);
                validateRecurrence(spec.recurrence);
                checkWorkdir(spec.workdir, spec.environmentId);
                checkProject(spec.projectId, spec.environmentId, spec.workdir);
                checkMachine(spec.machineId, spec.environmentId, spec.workdir);
                checkSource(spec.source, spec.agentId);
                const at = now();
                const s = ctx.state;
                s.created = true;
                s.kind = spec.kind;
                s.title = spec.title;
                s.recurrence = spec.recurrence;
                s.enabled = spec.enabled ?? true;
                if (spec.agentId !== undefined) s.agentId = spec.agentId;
                if (spec.environmentId !== undefined) s.environmentId = spec.environmentId;
                if (spec.workdir !== undefined) s.workdir = spec.workdir.trim();
                if (spec.projectId !== undefined) s.projectId = spec.projectId;
                if (spec.machineId !== undefined) s.machineId = spec.machineId;
                if (spec.prompt !== undefined) s.prompt = spec.prompt;
                s.offlinePolicy = spec.offlinePolicy ?? 'queue';
                if (spec.source !== undefined) s.source = sourceOf(spec.source);
                s.createdAt = at;
                await reschedule(ctx, at);
                return view(s);
            },

            async update(patch: SchedulePatch): Promise<ScheduleView> {
                requireCreated(ctx);
                const s = ctx.state;
                if (patch.recurrence) validateRecurrence(patch.recurrence);
                const workdir = patch.workdir === null ? undefined : (patch.workdir ?? s.workdir);
                const environmentId = patch.environmentId === null ? undefined : (patch.environmentId ?? s.environmentId);
                const projectId = patch.projectId === null ? undefined : (patch.projectId ?? s.projectId);
                const machineId = patch.machineId === null ? undefined : (patch.machineId ?? s.machineId);
                checkWorkdir(workdir, environmentId);
                checkProject(projectId, environmentId, workdir);
                checkMachine(machineId, environmentId, workdir);
                const source = patch.source === null ? undefined : (patch.source ?? s.source);
                checkSource(source, patch.agentId ?? s.agentId);
                if (patch.title !== undefined) s.title = patch.title;
                if (patch.recurrence !== undefined) s.recurrence = patch.recurrence;
                if (patch.agentId !== undefined) s.agentId = patch.agentId;
                if (environmentId === undefined) delete s.environmentId;
                else s.environmentId = environmentId;
                if (workdir === undefined) delete s.workdir;
                else s.workdir = workdir.trim();
                if (projectId === undefined) delete s.projectId;
                else s.projectId = projectId;
                if (machineId === undefined) delete s.machineId;
                else s.machineId = machineId;
                if (patch.prompt !== undefined) s.prompt = patch.prompt;
                if (patch.offlinePolicy !== undefined) s.offlinePolicy = patch.offlinePolicy;
                // The cursor is the progress through ONE connector's items: another connector (or none) starts over.
                if (source?.connector !== s.source?.connector) delete s.cursor;
                if (source === undefined) delete s.source;
                else s.source = sourceOf(source);
                if (patch.enabled !== undefined) {
                    s.enabled = patch.enabled;
                    delete s.paused;
                }
                s.attempts = 0;
                await reschedule(ctx, now());
                return view(s);
            },

            async enable(): Promise<ScheduleView> {
                requireCreated(ctx);
                ctx.state.enabled = true;
                ctx.state.attempts = 0;
                delete ctx.state.paused;
                await reschedule(ctx, now());
                return view(ctx.state);
            },

            async disable(): Promise<ScheduleView> {
                requireCreated(ctx);
                ctx.state.enabled = false;
                ctx.state.attempts = 0;
                delete ctx.state.paused;
                await reschedule(ctx, now());
                return view(ctx.state);
            },

            async get(): Promise<ScheduleView> {
                requireCreated(ctx);
                return view(ctx.state);
            }
        }),

        onReminder: async (ctx, name) => {
            if (name !== FIRE) return;
            const s = ctx.state;
            if (!s.created || !s.enabled || s.next === null) {
                await ctx.reminders.clear(FIRE);
                return;
            }
            const at = now();
            const scheduledFor = s.next;
            // Alarms are "at or after due"; a reminder that somehow runs
            // early is re-armed for the same instant rather than fired.
            if (at < scheduledFor) {
                await arm(ctx);
                return;
            }
            const skipped = countOccurrences(s.recurrence, scheduledFor, at);
            const event: ScheduleFired = {
                type: 'ScheduleFired',
                workspaceId: s.workspaceId,
                scheduleId: s.id,
                key: ctx.key,
                kind: s.kind,
                title: s.title,
                scheduledFor,
                firedAt: at,
                occurrence: s.runs + 1,
                skipped,
                ...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
                ...(s.environmentId !== undefined ? { environmentId: s.environmentId } : {}),
                ...(s.workdir !== undefined ? { workdir: s.workdir } : {}),
                ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
                ...(s.machineId !== undefined ? { machineId: s.machineId } : {}),
                ...(s.prompt !== undefined ? { prompt: s.prompt } : {}),
                offlinePolicy: s.offlinePolicy,
                ...(s.source !== undefined ? { source: s.source } : {}),
                ...(s.cursor !== undefined ? { cursor: s.cursor } : {})
            };
            // The port hops through THIS actor's context: trusted actor-to-actor
            // calls, so the Inbox and Task policies are not re-run against the
            // reminder's empty principal.
            const hop: TriggerHop = { actor: (def, key) => ctx.actor(def, key) };
            let result: void | TriggerResult;
            try {
                result = await options.trigger.fired(event, hop);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                s.attempts++;
                if (s.attempts < maxAttempts) {
                    // Same occurrence, one floor later; `next` is unchanged so
                    // the retry still reports the original `scheduledFor`.
                    log(ctx, { kind: 'retry', at, scheduledFor, attempt: s.attempts, error: message });
                    s.updatedAt = at;
                    await ctx.save();
                    await ctx.reminders.set(FIRE, { due: retryDelayMs });
                    return;
                }
                log(ctx, { kind: 'dropped', at, scheduledFor, error: message });
                s.attempts = 0;
                await reschedule(ctx, at);
                return;
            }
            s.runs++;
            s.lastRun = at;
            s.attempts = 0;
            log(ctx, { kind: 'fired', at, scheduledFor, skipped });
            if (skipped > 0) {
                log(ctx, { kind: 'skipped', at, from: scheduledFor, to: at, count: skipped });
            }
            // A trigger's progress and its word to stop (#535), saved with the rest of this turn by `reschedule`.
            if (result && typeof result.cursor === 'string' && result.cursor.length <= SCHEDULE_CURSOR_MAX) s.cursor = result.cursor;
            if (result && typeof result.pause === 'string') {
                const reason = result.pause.slice(0, 500);
                s.enabled = false;
                s.paused = { at, reason };
                log(ctx, { kind: 'paused', at, reason });
            }
            // `at` is the search origin: everything missed before now stays skipped.
            await reschedule(ctx, at);
        }
    });
}

export type ScheduleActor = ReturnType<typeof defineScheduleActor>;
