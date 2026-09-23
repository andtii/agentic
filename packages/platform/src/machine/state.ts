/**
 * Machine actor state — `{ws}:machine:{id}` (architecture §4 Machine, §5b).
 *
 * Plain JSON, saved whole with `ctx.save()` at the end of every mutating
 * turn: on Cloudflare `onDeactivate` never runs. The token is never here —
 * only its hash (`machine-token.ts`); the daemon keeps the token.
 */

import type { CapabilityReport, Cursor, DaemonBuild, DaemonExit, DaemonFeature, DaemonLogError, EnvError, EnvironmentDescriptor, EnvironmentId, EnvOp, EnvResult, FsError, FsOp, FsResult, HarnessPhase, HarnessReport, HistoryError, HistoryRange, LifecycleError, LoginAction, LoginError, LoginPhase, MachineId, MachinePolicy, MachinePolicyError, MachinePolicyOp, MachinePolicyResult, MachineTelemetry, OpenSpec, QuotaSnapshot, ReleaseAsset, ReleaseChannel, RuntimeId, SessionId, TaskId, UpdatePhase, UpdatePolicy, UpdateSettings, WorkspaceId } from '@agentic/core';
import type { WireCommand } from '@sigx/ai-agent/wire';

export const MACHINE_STATE_VERSION = 1;

export type MachineOs = 'windows' | 'darwin' | 'linux';

/** A session this machine hosts: sent to the daemon (`opening`) or acknowledged by it (`open`). */
export interface HostedSession {
    readonly sessionId: SessionId;
    readonly environmentId: EnvironmentId;
    /** The agent the session runs as — the `tool.call` principal (§5b). */
    readonly agentId: string;
    readonly taskId?: TaskId;
    readonly spec: OpenSpec;
    status: 'opening' | 'open';
    readonly requestedAt: number;
    openedAt?: number;
    /** The last cursor this machine forwarded — `welcome.wanted` after a reconnect. */
    cursor?: Cursor;
    ref?: unknown;
    capabilities?: CapabilityReport;
    /**
     * The turn in flight (#394): set by a prompt's ack (`onSessionReply`) or by a `turn-start` the runtime began on
     * its own (#510, `onSessionFrame`), cleared by the turn's `turn-end`
     * (`onSessionFrame`) or the session's closure. What capacity counts — with the prompts still pending, see `runningIn`.
     */
    running?: { readonly turnId: string; readonly since: number };
}

/** An `openSession` waiting for capacity in its environment (EXE-09). */
export interface QueuedSession {
    readonly sessionId: SessionId;
    readonly environmentId: EnvironmentId;
    readonly agentId: string;
    readonly taskId?: TaskId;
    readonly spec: OpenSpec;
    readonly queuedAt: number;
}

/** A command sent through `sendCommand` whose reply is still out. */
export interface PendingCommand {
    readonly sessionId: SessionId;
    readonly command: WireCommand;
    readonly sentAt: number;
    /** After this the reply is synthesized as an error, so an eviction never leaks a promise. */
    readonly deadline: number;
}

/**
 * One `fsRequest` (#189): sent as `fs.request`, answered by the daemon's
 * `fs.response` in a later `socketMessage` turn — a stored result, never an
 * awaited promise. `fsResult(requestId)` reads it.
 */
export interface FsRequestRecord {
    readonly requestId: string;
    readonly environmentId: EnvironmentId;
    readonly op: FsOp;
    status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    /** After this the liveness reminder fails a pending request with `timeout`. */
    readonly deadline: number;
    /** Who asked (`principalLabel`) — the `by` of the `workdir.worktree-created` audit record. */
    readonly by: string;
    finishedAt?: number;
    result?: FsResult;
    error?: FsError;
}

/**
 * One `putEnvironment` / `removeEnvironment` (#237): sent as `env.request`,
 * answered by the daemon's `env.response` in a later `socketMessage` turn —
 * stored like an `fsRequest`, read with `envResult(requestId)`.
 */
export interface EnvRequestRecord {
    readonly requestId: string;
    readonly op: EnvOp;
    status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    /** After this the liveness reminder fails a pending request with `timeout`. */
    readonly deadline: number;
    /** Who asked (`principalLabel`) — the `by` of the `environment.put` / `environment.removed` audit record. */
    readonly by: string;
    finishedAt?: number;
    result?: EnvResult;
    error?: EnvError;
}

/**
 * One `setPolicy` / `browseMachine` (#355, #480): sent as `policy.request`, answered by the daemon's `policy.response` in
 * a later `socketMessage` turn — stored like an `envRequest`, read with `policyResult(requestId)`. `auto` marks the
 * reconcile's own request (`by: system:setup`), whose answer updates `PolicyDesired.lastAuto`.
 */
export interface PolicyRequestRecord {
    readonly requestId: string;
    readonly op: MachinePolicyOp;
    status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    /** After this the liveness reminder fails a pending request with `timeout`. */
    readonly deadline: number;
    /** Who asked (`principalLabel`, or `system:setup` for the reconcile). */
    readonly by: string;
    readonly auto?: true;
    finishedAt?: number;
    result?: MachinePolicyResult;
    error?: MachinePolicyError;
}

/**
 * One `logTail` (#481): sent as `log.request`, answered by the daemon's `log.response` in a later `socketMessage` turn.
 * Like a history request, the record keeps the status only: the lines are held by the activation that received them
 * and handed out by `logResult`, never saved on this record.
 */
export interface LogRequestRecord {
    readonly requestId: string;
    readonly lines: number;
    status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    /** After this the liveness reminder fails a pending request with `timeout`. */
    readonly deadline: number;
    finishedAt?: number;
    error?: DaemonLogError;
}

/**
 * A sign-in relayed from the web (#355, #484), one per environment: the phase the daemon last reported and the action
 * the person must take — never the pasted text, which is forwarded inside the turn that receives it and stored nowhere.
 */
export interface LoginRecord {
    readonly requestId: string;
    readonly environmentId: EnvironmentId;
    phase: LoginPhase;
    readonly startedAt: number;
    /** After this, with no end from the daemon, the reminder fails it `timeout` (the daemon's own cap is ten minutes). */
    readonly deadline: number;
    readonly by: string;
    action?: LoginAction;
    error?: LoginError;
    finishedAt?: number;
}

/**
 * The folders the web may use on this machine, as the owner wants them (#355, #480): set on the page (`setPolicy`) or
 * preset on the Pair page and stored at `pair`. The daemon reports what it applied (`MachineState.policy`); the two are
 * compared with `policyConverged`, and `lastAuto` records the reconcile's last attempt so it never loops.
 */
export interface PolicyDesired {
    readonly allowedRoots: readonly string[];
    readonly setAt: number;
    /** Who set it (`principalLabel`). */
    readonly by: string;
    lastAuto?: { readonly at: number; readonly converged: boolean };
}

/**
 * One `historyRequest` (#397): sent as `history.request`, answered by the daemon's `history.response` in a later
 * `socketMessage` turn. The record keeps the request and its status — the events themselves (hundreds of KB) are held by
 * the activation that received them and handed out by the `historyAnswer` stream, never saved on this record.
 */
export interface HistoryRequestRecord {
    readonly requestId: string;
    readonly sessionId: SessionId;
    readonly range: HistoryRange;
    status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    /** After this the liveness reminder fails a pending request with `timeout`. */
    readonly deadline: number;
    finishedAt?: number;
    error?: HistoryError;
}

export interface SessionClosure {
    readonly sessionId: SessionId;
    readonly reason: string;
    readonly at: number;
}

/**
 * The machine takes no new turns (#365): an update is pending. With no `runtime` it covers every environment; a harness
 * drain (#370) names the runtime. Sessions still open — an open costs no slot (#394) — and prompts park on capacity.
 */
export interface MachineDraining {
    readonly requestId: string;
    readonly since: number;
    readonly runtime?: RuntimeId;
}

/** An `update.request` in flight (#365), from `requestUpdate` to the `hello` that judges it, a `failed` phase or its deadline. */
export interface PendingUpdate {
    readonly requestId: string;
    /** The version asked for, `previous` (back to the build the daemon kept), or `restart` (the same build again, #481). */
    readonly target: string;
    readonly asset?: ReleaseAsset;
    readonly mode: 'drain' | 'now';
    /** The version the daemon ran when it was asked. */
    readonly from: string;
    readonly requestedAt: number;
    /** `drainTimeoutMs` + 10 min: after this the liveness reminder fails it as `timeout`. */
    readonly deadline: number;
    /** Who asked (`principalLabel`, or `system:updates` for a policy). */
    readonly by: string;
    phase?: UpdatePhase;
    progress?: { readonly bytes: number; readonly total: number };
    error?: LifecycleError;
}

/** How the last update ended. */
export interface UpdateOutcome {
    readonly requestId?: string;
    readonly from: string;
    readonly to: string;
    /** `restarted`: the daemon came back after `target: 'restart'` (#355) — no version to compare. */
    readonly outcome: 'applied' | 'failed' | 'rolled-back' | 'timeout' | 'cancelled' | 'restarted';
    readonly at: number;
    readonly error?: string;
}

/** A release newer than the build the daemon runs, on the machine's channel. */
export interface AvailableUpdate {
    readonly version: string;
    readonly notesUrl?: string;
    /** When the release directory last read the manifest. */
    readonly checkedAt?: number;
    /** The asset for the build's platform; absent when the release ships none for it. */
    readonly asset?: ReleaseAsset;
}

/** The machine's update record (#365). `channel` / `policy` are its own; absent, the Workspace's `settings.updates` apply (`defaults`, as last read). */
export interface MachineUpdateState {
    channel?: ReleaseChannel;
    policy?: UpdatePolicy;
    /** The Workspace's `settings.updates` as last read (on `hello` and the liveness tick). */
    defaults?: UpdateSettings;
    available?: AvailableUpdate;
    /** The last version an `update-available` Inbox row was sent for: once per version. */
    notified?: string;
    pending?: PendingUpdate;
    last?: UpdateOutcome;
    /** The `at` of the last `hello.lastUpdate` already acted on, so a reconnect does not report it twice. */
    reported?: number;
    /** When `available` was last compared against the release directory. */
    comparedAt?: number;
    /** When the release manifests it last compared against were read (#468): "Checked 3 min ago". */
    checkedAt?: number;
}

/** What a harness op asks for (#370): the frame's `op`. */
export type HarnessOp = 'install' | 'update' | 'remove';

/**
 * One `requestHarness` (#370): sent as `harness.request`, followed by the daemon's `harness.status` frames in later
 * `socketMessage` turns — stored like an `envRequest`, read with `harnessResult(requestId)`. While it is pending the
 * machine drains its runtime (`MachineState.draining` with `runtime`).
 */
export interface HarnessRequestRecord {
    readonly requestId: string;
    readonly op: HarnessOp;
    readonly runtime: RuntimeId;
    readonly mode: 'drain' | 'now';
    status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    /** After this the liveness reminder fails a pending request with `timeout`. */
    readonly deadline: number;
    /** Who asked (`principalLabel`) — the `by` of the `harness.changed` audit record. */
    readonly by: string;
    /** The version installed when it was asked; absent when none was. */
    readonly from?: string;
    /** The version asked for; absent for `remove`. */
    readonly to?: string;
    phase?: HarnessPhase;
    finishedAt?: number;
    error?: LifecycleError;
}

/** A harness build the release on the machine's channel ships (#370), for the machine's `<os>-<arch>`. */
export interface AvailableHarness {
    readonly version: string;
    /** Absent when the release ships no build of it for the machine's platform. */
    readonly asset?: ReleaseAsset;
}

export interface MachineState {
    v: number;
    name: string;
    os?: MachineOs;
    /** SHA-256 (base64url) of the machine token; absent until paired. */
    tokenHash?: string;
    pairedAt?: number;
    revokedAt?: number | null;
    online: boolean;
    lastSeen?: number;
    connectedAt?: number;
    daemonVersion?: string;
    capabilities: CapabilityReport[];
    environments: EnvironmentDescriptor[];
    activeSessions: Record<string, HostedSession>;
    queued: QueuedSession[];
    /** Keyed `${sessionId}:${commandId}` — a `commandId` is unique per Session, not per machine. */
    pending: Record<string, PendingCommand>;
    /** `fsRequest` entries by request id, at most `MAX_FS_REQUESTS`; absent on a record saved before #189. */
    fs?: Record<string, FsRequestRecord>;
    /** `putEnvironment` / `removeEnvironment` entries by request id, at most `MAX_ENV_REQUESTS`; absent on a record saved before #237. */
    envRequests?: Record<string, EnvRequestRecord>;
    /** `setPolicy` / `browseMachine` entries by request id, at most `MAX_POLICY_REQUESTS`; absent on a record saved before #480. */
    policyRequests?: Record<string, PolicyRequestRecord>;
    /** `logTail` entries by request id, at most `MAX_LOG_REQUESTS` (#481): the status only — the lines live in the activation. */
    logRequests?: Record<string, LogRequestRecord>;
    /** The sign-ins relayed from the web (#484), by environment id: one running or lately ended per environment. */
    logins?: Record<string, LoginRecord>;
    /** The folders the web may use, as the owner wants them (#480); absent until set or preset. */
    policyDesired?: PolicyDesired;
    /** The `elevatedUntil` of the last elevation audited (`auth.elevated`, #355): one row per elevation window, by its first change. */
    elevationAudited?: number;
    /** `historyRequest` entries by request id (#397), at most `MAX_HISTORY_REQUESTS` — statuses only, never the events. */
    history?: Record<string, HistoryRequestRecord>;
    /** The machine-local policy the daemon last reported (`hello` / `env`); absent when it reports none (it predates web-managed environments). */
    policy?: MachinePolicy;
    /**
     * Each environment's provider limits as the daemon last reported them (`quota` frames, #261), merged with `mergeQuota`;
     * kept while the machine is offline (readers judge staleness from `observedAt`), dropped with the environment.
     * Absent on a record saved before #268.
     */
    quota?: Record<string, QuotaSnapshot>;
    /**
     * What the machine's sessions cost it, as the daemon last reported (`telemetry` frames, #400): a full snapshot each
     * time, its sessions and environments pruned with the hosted ones; kept while the machine is offline (readers judge
     * staleness from `observedAt`). Absent until the daemon reports one.
     */
    telemetry?: MachineTelemetry;
    /** The resource warnings told to the Inbox (#400), by `telemetryWarningKey` → when: one re-arms once its value clears (`telemetryWarningCleared`). */
    telemetryWarned?: Record<string, number>;
    /** The most recent closures, newest last (capped). */
    closures: SessionClosure[];
    /** Daemon messages refused by the protocol codec since pairing. */
    rejected: number;
    /** What the daemon last reported on `hello` (#359): its build, the frame families it answers, restarts, its last exit, its harnesses. */
    build?: DaemonBuild;
    features?: DaemonFeature[];
    restarts?: number;
    lastExit?: DaemonExit;
    harnesses?: HarnessReport[];
    /** The build is older than `MIN_DAEMON_VERSION`. */
    outdated?: boolean;
    /** Daemon restarts seen from `hello.restarts` deltas in the last `CRASH_LOOP_WINDOW_MS`, and when a crash loop was last reported. */
    restartLog?: { at: number; count: number }[];
    crashLoopAt?: number;
    update?: MachineUpdateState;
    draining?: MachineDraining;
    /** `requestHarness` entries by request id (#370), at most `MAX_HARNESS_REQUESTS`. */
    harnessRequests?: Record<string, HarnessRequestRecord>;
    /** The harness builds the channel's release ships, by runtime, as last compared (#370). */
    harnessesAvailable?: Record<string, AvailableHarness>;
    /** The version a `harness-update-available` Inbox row last went out for, by runtime: once per runtime and version. */
    harnessesNotified?: Record<string, string>;
}

export const MAX_CLOSURES = 32;
/** At most this many `fsRequest` entries are kept; the oldest is evicted first. */
export const MAX_FS_REQUESTS = 16;
/** A finished `fsRequest` entry is pruned this long after it finished. */
export const FS_RESULT_TTL_MS = 120_000;
/** At most this many environment requests are kept; the oldest is evicted first. */
export const MAX_ENV_REQUESTS = 16;
/** At most this many policy requests are kept (#480). */
export const MAX_POLICY_REQUESTS = 16;
/** A finished policy request is kept this long. */
export const POLICY_RESULT_TTL_MS = 120_000;
/** At most this many log requests are kept (#481). */
export const MAX_LOG_REQUESTS = 16;
/** A finished log request is kept this long; the activation drops the lines it holds for it at the same time. */
export const LOG_RESULT_TTL_MS = 60_000;
/** A relayed sign-in with no end from the daemon is failed `timeout` after this (#484): past the daemon's own ten-minute cap. */
export const LOGIN_TIMEOUT_MS = 11 * 60_000;
/** An ended sign-in is kept this long, so the page reads how it ended. */
export const LOGIN_RESULT_TTL_MS = 60_000;

/** Whether a login record is still running. */
export const loginRunning = (r: LoginRecord): boolean => r.phase !== 'done' && r.phase !== 'failed';
/** A finished environment request is pruned this long after it finished. */
export const ENV_RESULT_TTL_MS = 120_000;
/** At most this many history requests are kept (#397); the oldest is evicted first. */
export const MAX_HISTORY_REQUESTS = 16;
/** A finished history request is pruned this long after it finished — its reader takes the answer at once. */
export const HISTORY_RESULT_TTL_MS = 60_000;
/** At most this many harness requests are kept (#370); the oldest is evicted first. */
export const MAX_HARNESS_REQUESTS = 16;
/** A finished harness request is pruned this long after it finished. */
export const HARNESS_RESULT_TTL_MS = 120_000;

export function initialMachineState(): MachineState {
    return {
        v: MACHINE_STATE_VERSION,
        name: '',
        online: false,
        capabilities: [],
        environments: [],
        activeSessions: {},
        queued: [],
        pending: {},
        fs: {},
        envRequests: {},
        closures: [],
        rejected: 0
    };
}

/** The key of a machine's actor: `{ws}:machine:{id}`. */
export function machineKey(workspaceId: WorkspaceId | string, machineId: MachineId | string): string {
    return `${workspaceId}:machine:${machineId}`;
}

/** The ids a `{ws}:machine:{id}` key names, or `null` for any other shape. */
export function parseMachineKey(key: string): { workspaceId: WorkspaceId; machineId: MachineId } | null {
    const parts = key.split(':');
    if (parts.length !== 3 || parts[1] !== 'machine' || !parts[0] || !parts[2]) return null;
    return { workspaceId: parts[0] as WorkspaceId, machineId: parts[2] as MachineId };
}

/** What capacity is judged on (#394): the state, or a `MachineView` (the same fields as arrays). */
export interface CapacityView {
    readonly environments: readonly EnvironmentDescriptor[];
    readonly activeSessions: Readonly<Record<string, HostedSession>> | readonly HostedSession[];
    readonly pending: Readonly<Record<string, PendingCommand>> | readonly PendingCommand[];
    /** While an update is pending (#365) no new turn starts where the drain covers. */
    readonly draining?: MachineDraining;
}

/**
 * The hosted sessions in `environmentId` that hold a slot (#394): running a turn, or with a `prompt` whose reply is
 * still out — the slot is taken when the prompt leaves, not when its ack lands, so two prompts sent back to back never
 * share one. An open, idle session holds none.
 */
export function runningIn(view: CapacityView, environmentId: EnvironmentId | string): HostedSession[] {
    const prompted = new Set<string>();
    for (const p of Object.values(view.pending)) if (p.command.type === 'prompt') prompted.add(p.sessionId);
    return Object.values(view.activeSessions).filter((s) => s.environmentId === environmentId && (s.running !== undefined || prompted.has(s.sessionId)));
}

/** Sessions hosted in `environmentId`, opening or open — whatever they run. */
export function hostedIn(view: Pick<CapacityView, 'activeSessions'>, environmentId: EnvironmentId | string): HostedSession[] {
    return Object.values(view.activeSessions).filter((s) => s.environmentId === environmentId);
}

/** How many slots `environmentId` has taken: sessions running a turn (`runningIn`), never sessions merely open (#394). */
export function activeIn(view: CapacityView, environmentId: EnvironmentId | string): number {
    return runningIn(view, environmentId).length;
}

/**
 * Free slots in an environment as the daemon last described it — `concurrency.max` minus the turns running; `0` for an
 * unknown environment, and `0` while a drain covers it (#365): a prompt parks on capacity until the drain ends.
 */
export function freeSlots(view: CapacityView, environmentId: EnvironmentId | string): number {
    const env = view.environments.find((e) => e.id === environmentId);
    if (!env) return 0;
    if (view.draining && (view.draining.runtime === undefined || view.draining.runtime === env.runtime)) return 0;
    return Math.max(0, env.concurrency.max - activeIn(view, environmentId));
}

/** Whether no turn runs anywhere on the machine (#365) — a live session with no turn does not count. What an update policy waits for. */
export function isIdle(view: CapacityView): boolean {
    // One pass: a session holds a slot with a turn running or a prompt out (`runningIn`'s rule).
    const prompted = new Set<string>();
    for (const p of Object.values(view.pending)) if (p.command.type === 'prompt') prompted.add(p.sessionId);
    return Object.values(view.activeSessions).every((s) => s.running === undefined && !prompted.has(s.sessionId));
}

/** `true` when `at` is strictly after `cursor` (or there is no cursor). */
export function advances(cursor: Cursor | undefined, at: Cursor): boolean {
    if (!cursor) return true;
    return at.epoch > cursor.epoch || (at.epoch === cursor.epoch && at.seq > cursor.seq);
}

/**
 * Make room for one more `fsRequest` entry: drop finished entries older than
 * `FS_RESULT_TTL_MS`, then evict the oldest (by `requestedAt`) until fewer
 * than `MAX_FS_REQUESTS` remain. `room: false` only prunes.
 */
export function pruneFs(fs: Record<string, FsRequestRecord>, at: number, room = true): void {
    prune(fs, at, room, FS_RESULT_TTL_MS, MAX_FS_REQUESTS);
}

/** Drop the telemetry of sessions the machine no longer hosts and of environments it no longer reports, and the warnings told for them. */
export function pruneTelemetry(s: MachineState): void {
    const t = s.telemetry;
    if (t) {
        // Own keys only: a session id off the wire is any bounded string, `toString` included.
        const sessions = Object.fromEntries(Object.entries(t.sessions).filter(([id]) => Object.hasOwn(s.activeSessions, id)));
        const environments = Object.fromEntries(Object.entries(t.environments).filter(([id]) => s.environments.some((e) => e.id === id)));
        s.telemetry = { ...t, sessions, environments };
    }
    if (s.telemetryWarned) {
        for (const key of Object.keys(s.telemetryWarned)) if (key.startsWith('session:') && !Object.hasOwn(s.activeSessions, key.slice('session:'.length))) delete s.telemetryWarned[key];
        if (Object.keys(s.telemetryWarned).length === 0) delete s.telemetryWarned;
    }
}

/** Drop the quota snapshots of environments the machine no longer reports. */
export function pruneQuota(s: MachineState): void {
    if (!s.quota) return;
    for (const id of Object.keys(s.quota)) if (!s.environments.some((e) => e.id === id)) delete s.quota[id];
    // Absent until something is reported, and again once nothing is left.
    if (Object.keys(s.quota).length === 0) delete s.quota;
}

/** `pruneFs` for environment requests: the same TTL-then-oldest rule over `ENV_RESULT_TTL_MS` / `MAX_ENV_REQUESTS`. */
export function pruneEnvRequests(requests: Record<string, EnvRequestRecord>, at: number, room = true): void {
    prune(requests, at, room, ENV_RESULT_TTL_MS, MAX_ENV_REQUESTS);
}

/** `pruneFs` for policy requests (#480): the same rule over `POLICY_RESULT_TTL_MS` / `MAX_POLICY_REQUESTS`. */
export function prunePolicyRequests(requests: Record<string, PolicyRequestRecord>, at: number, room = true): void {
    prune(requests, at, room, POLICY_RESULT_TTL_MS, MAX_POLICY_REQUESTS);
}

/** `pruneFs` for log requests (#481): the same rule over `LOG_RESULT_TTL_MS` / `MAX_LOG_REQUESTS`. */
export function pruneLogRequests(requests: Record<string, LogRequestRecord>, at: number, room = true): void {
    prune(requests, at, room, LOG_RESULT_TTL_MS, MAX_LOG_REQUESTS);
}

/** Drop the ended sign-ins older than `LOGIN_RESULT_TTL_MS` (#484), and an ended one of an environment the machine no longer reports; a running one is left to end (`timeout`, a disconnect, a revoke). */
export function pruneLogins(s: MachineState, at: number): void {
    if (!s.logins) return;
    for (const [id, r] of Object.entries(s.logins)) {
        if (!loginRunning(r) && (r.finishedAt ?? r.startedAt) + LOGIN_RESULT_TTL_MS <= at) delete s.logins[id];
        else if (!s.environments.some((e) => e.id === id) && !loginRunning(r)) delete s.logins[id];
    }
    if (Object.keys(s.logins).length === 0) delete s.logins;
}

/** `pruneFs` for history requests (#397): the same rule over `HISTORY_RESULT_TTL_MS` / `MAX_HISTORY_REQUESTS`. */
export function pruneHistory(requests: Record<string, HistoryRequestRecord>, at: number, room = true): void {
    prune(requests, at, room, HISTORY_RESULT_TTL_MS, MAX_HISTORY_REQUESTS);
}

/** `pruneFs` for harness requests (#370): the same rule over `HARNESS_RESULT_TTL_MS` / `MAX_HARNESS_REQUESTS`. */
export function pruneHarnessRequests(requests: Record<string, HarnessRequestRecord>, at: number, room = true): void {
    prune(requests, at, room, HARNESS_RESULT_TTL_MS, MAX_HARNESS_REQUESTS);
}

function prune(entries: Record<string, { readonly requestId: string; readonly status: string; readonly requestedAt: number; readonly finishedAt?: number }>, at: number, room: boolean, ttlMs: number, max: number): void {
    for (const [id, r] of Object.entries(entries)) if (r.status !== 'pending' && (r.finishedAt ?? r.requestedAt) + ttlMs <= at) delete entries[id];
    if (!room) return;
    const byAge = Object.values(entries).sort((a, b) => a.requestedAt - b.requestedAt);
    while (byAge.length >= max) delete entries[byAge.shift()!.requestId];
}
