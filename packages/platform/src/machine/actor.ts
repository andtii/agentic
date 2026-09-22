/**
 * The Machine actor — `{ws}:machine:{id}` (architecture §4 Machine, §5b).
 *
 * One paired daemon, one record: its token hash, what it reported
 * (`hello` / `env` / `heartbeat`), the sessions it hosts and those waiting
 * for capacity, the commands whose replies are still out, and the folder
 * requests (`fsRequest`) and environment requests (`putEnvironment` /
 * `removeEnvironment`) waiting on, or answered by, the daemon. The host
 * accepts the daemon's hibernatable WebSocket and hands every message to
 * `socketMessage`; the actor answers through the `MachineSocketPort`.
 *
 * Routing (§5b): `session.frame` → `Session.forwardFrames`, `session.reply`
 * → `Session.commandReplied`, `tool.call` → the `ToolCallPort` under the
 * agent principal. Every mutation ends in `ctx.save()` inside the turn.
 */

import { actorKey, DEFAULT_UPDATE_SETTINGS, hasScope, mergeQuota, telemetryWarningCleared, telemetryWarningKey, telemetryWarnings, type AgentId, type CapabilityReport, type DaemonBuild, type DaemonExit, type DaemonFeature, type HarnessPhase, type HarnessReport, type LifecycleError, type PlatformInfo, type ReleaseAsset, type ReleaseChannel, type ReleaseManifest, type UpdatePolicy, type EnvError, type EnvOp, type EnvResult, type EnvironmentDescriptor, type EnvironmentId, type EnvironmentInput, type EnvironmentVerdict, type FsError, type FsOp, type FsResult, type HistoryError, type HistoryRange, type IsolationMechanism, type MachineId, type MachinePolicy, type MachineTelemetry, type OpenSpec, type Principal, type QuotaSnapshot, type RuntimeId, type SessionClosedCode, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { compareVersions, DAEMON_PROTOCOL_VERSION, decodeDaemonFrame, encodeFrame, environmentInput as environmentInputSchema, fsOp as fsOpSchema, type DaemonFrame, type DaemonFrameOf, type PlatformFrame } from '@agentic/daemon-protocol';
import { actor, defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { capabilities as agentCapabilities, type AgentCapabilities, type AgentEvent, type SessionRef } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { ServerFnError } from '@sigx/server';

import { principalLabel } from '../agent/index.js';
import { recordAudit } from '../audit/port.js';
import { asPrincipal, issueMachineToken, machinePrincipal, mintAgentPrincipal, sameWorkspace, workspaceKey, type MachineTokenRecord } from '../auth/index.js';
import { inboxKey } from '../notify/inbox.js';
import type { NotificationInput } from '../notify/types.js';
import { MIN_DAEMON_VERSION, platformVersion, RELEASE_DIRECTORY_KEY, type ReleasesView } from '../releases/directory.js';
import { routingKey } from '../routing/key.js';
import { Workspace } from '../workspace/index.js';
import type { MachinePorts } from './ports.js';
import { ToolCallError } from './ports.js';
import type { HistoryAnswer } from '../session/ports.js';
import { advances, freeSlots, hostedIn, initialMachineState, MAX_CLOSURES, parseMachineKey, pruneEnvRequests, pruneFs, pruneHarnessRequests, pruneHistory, pruneQuota, pruneTelemetry, runningIn, type AvailableHarness, type AvailableUpdate, type EnvRequestRecord, type FsRequestRecord, type HarnessOp, type HarnessRequestRecord, type HistoryRequestRecord, type HostedSession, type MachineDraining, type MachineOs, type MachineState, type PendingCommand, type PendingUpdate, type QueuedSession, type SessionClosure, type UpdateOutcome } from './state.js';
import { checkChannel, checkUpdatePolicy, CRASH_LOOP_WINDOW_MS, DEFAULT_DRAIN_TIMEOUT_MS, effectiveUpdates, foldRestarts, MAX_DRAIN_TIMEOUT_MS, nextAutoUpdate, SYSTEM_UPDATES, UPDATE_DEADLINE_GRACE_MS } from './update.js';

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;

/** The reminder that watches the heartbeat window and the pending-reply and folder-request deadlines. */
export const LIVENESS = 'liveness';
export const DEFAULT_HEARTBEAT_WINDOW_MS = 90_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_FS_TIMEOUT_MS = 30_000;
export const DEFAULT_ENV_TIMEOUT_MS = 30_000;
export const DEFAULT_HISTORY_TIMEOUT_MS = 30_000;
/** The code a `putEnvironment` / `removeEnvironment` 503 starts with when the daemon is not connected. */
export const MACHINE_OFFLINE_CODE = 'machine-offline';
/** The reminder floor (architecture §2): nothing is checked more often. */
const REMINDER_FLOOR_MS = 60_000;
/** The liveness tick re-reads the release directory and the workspace's update settings at most this often (#365); `hello` always does. */
export const UPDATE_COMPARE_EVERY_MS = 15 * 60_000;
/** A harness request not answered `done` / `failed` within this fails `timeout` (#370): the daemon's drain (10 min) plus the download. */
export const HARNESS_DEADLINE_MS = 30 * 60_000;

/** Whether the liveness reminder has anything to watch: a connected daemon, an unanswered command, folder, environment, history or harness request. */
function needsLiveness(s: MachineState): boolean {
    const pending = (r: { status: string }) => r.status === 'pending';
    return s.online || s.update?.pending !== undefined || Object.keys(s.pending).length > 0 || Object.values(s.fs ?? {}).some(pending) || Object.values(s.envRequests ?? {}).some(pending) || Object.values(s.history ?? {}).some(pending) || Object.values(s.harnessRequests ?? {}).some(pending);
}

/** Fail every pending history request (#397): the daemon went away, or was revoked — the Session asks again on its next read. */
function failPendingHistory(s: MachineState, at: number, message: string): void {
    for (const r of Object.values(s.history ?? {})) {
        if (r.status !== 'pending') continue;
        r.status = 'error';
        r.error = { code: 'internal', message };
        r.finishedAt = at;
    }
}

/** Fail every pending folder request with `timeout` (the daemon went away, or was revoked). */
function failPendingFs(s: MachineState, at: number, message: string): void {
    for (const r of Object.values(s.fs ?? {})) {
        if (r.status !== 'pending') continue;
        r.status = 'error';
        r.error = { code: 'timeout', message };
        r.finishedAt = at;
    }
}

/** The same for environment requests: whether the daemon applied one it never answered is unknown, and `timeout` says so. */
function failPendingEnv(s: MachineState, at: number, message: string): void {
    for (const r of Object.values(s.envRequests ?? {})) {
        if (r.status !== 'pending') continue;
        r.status = 'error';
        r.error = { code: 'timeout', message };
        r.finishedAt = at;
    }
}

export interface PairInfo {
    readonly name?: string;
    readonly os?: MachineOs;
    readonly daemonVersion?: string;
}

export interface PairedMachine {
    readonly token: string;
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
}

/** What `openSession` says: the daemon was told, or the session waits for a slot (EXE-09). */
export type OpenSessionResult = 'opened' | 'queued';

export interface OpenSessionOptions {
    readonly taskId?: TaskId;
}

/** `fsRequest` — the id `fsResult` reads the answer by. */
export interface FsRequested {
    readonly requestId: string;
}

/**
 * `fsResult(requestId)` — one folder request as stored: `pending` until the
 * daemon's `fs.response` lands (or the deadline / a disconnect fails it with
 * `timeout`), then `done` with `result` or `error` with `error`.
 */
export interface FsResultView {
    readonly requestId: string;
    readonly environmentId: EnvironmentId;
    readonly op: FsOp;
    readonly status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    readonly finishedAt?: number;
    readonly result?: FsResult;
    readonly error?: FsError;
}

/** `putEnvironment` / `removeEnvironment` — the id `envResult` reads the answer by. */
export interface EnvRequested {
    readonly requestId: string;
}

/**
 * `envResult(requestId)` — one environment request as stored: `pending` until
 * the daemon's `env.response` lands (or the deadline / a disconnect fails it
 * with `timeout`), then `done` with `result` or `error` with the daemon's own
 * `error` — its code unchanged (`policy-disabled`, `outside-allowed-roots`, …).
 * The environment itself shows up in `get().environments` with the daemon's `env` frame.
 */
export interface EnvResultView {
    readonly requestId: string;
    readonly op: EnvOp;
    readonly status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    readonly finishedAt?: number;
    readonly result?: EnvResult;
    readonly error?: EnvError;
}

/** `historyRequest` — the id `historyAnswer` / `historyResult` read the answer by. */
export interface HistoryRequested {
    readonly requestId: string;
}

/**
 * `historyResult(requestId)` — one history request as stored (#397): `pending` until the daemon's `history.response`
 * lands (or the deadline / a disconnect fails it), then `done` — the events themselves are read from the
 * `historyAnswer` stream, never from the record — or `error` with the daemon's own error (`gap`, `unknown-session`, …).
 */
export interface HistoryResultView {
    readonly requestId: string;
    readonly sessionId: SessionId;
    readonly range: HistoryRange;
    readonly status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    readonly finishedAt?: number;
    readonly error?: HistoryError;
}

/** What `socketMessage` reports back to the host, for its logs. */
export type SocketMessageResult = { readonly ok: true; readonly t: DaemonFrame['t'] } | { readonly ok: false; readonly code: string; readonly message: string };

/** `Machine.get()` — the record without the token hash. */
export interface MachineView {
    readonly key: string;
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
    readonly name: string;
    readonly os?: MachineOs;
    readonly paired: boolean;
    readonly pairedAt?: number;
    readonly revoked: boolean;
    readonly revokedAt?: number;
    readonly online: boolean;
    readonly lastSeen?: number;
    readonly connectedAt?: number;
    readonly daemonVersion?: string;
    readonly capabilities: readonly CapabilityReport[];
    readonly environments: readonly EnvironmentDescriptor[];
    /** The machine-local policy as last reported: whether the web may manage environments, and inside which roots. Absent → the daemon reports none. */
    readonly policy?: MachinePolicy;
    /** Provider limits by environment id, as last reported (#261); absent until the daemon reports any, and an environment without an entry has reported none yet. */
    readonly quota?: Readonly<Record<string, QuotaSnapshot>>;
    /** What the sessions cost the machine, as last reported (#400): per session (`null` = unknown), per environment, the daemon, the machine; absent until the daemon reports any. */
    readonly telemetry?: MachineTelemetry;
    readonly activeSessions: readonly HostedSession[];
    readonly queued: readonly QueuedSession[];
    readonly pending: readonly PendingCommand[];
    readonly closures: readonly SessionClosure[];
    readonly rejected: number;
    /** What the daemon reported on `hello` (#359): its build, the frame families it answers, its harnesses. */
    readonly build?: DaemonBuild;
    readonly features?: readonly DaemonFeature[];
    readonly harnesses?: readonly HarnessReport[];
    /** Its build is older than `MIN_DAEMON_VERSION`. */
    readonly outdated?: boolean;
    /** An update is pending (#365): no new turn starts where it covers — `freeSlots` reads it. */
    readonly draining?: MachineDraining;
    /** The harness builds the release on the machine's channel ships for its platform, by runtime (#370). */
    readonly harnessesAvailable?: Readonly<Record<string, AvailableHarness>>;
    /** The harness request in flight (#370), for a page that opens while it runs; `harnessResult` follows it. */
    readonly harnessRequest?: HarnessResultView;
}

/** `requestHarness` (#370). */
export interface HarnessRequestInput {
    readonly op: HarnessOp;
    readonly runtime: RuntimeId;
    /** `install` / `update`: a version a release on the machine's channel (or the other one) ships; absent → the channel's. */
    readonly version?: string;
    /** `drain` (default) lets the runtime's running turns end first; `now` closes its sessions at once. */
    readonly mode?: 'drain' | 'now';
}

/** `requestHarness` — the id `harnessResult` reads the request by. */
export interface HarnessRequested {
    readonly requestId: string;
}

/**
 * `harnessResult(requestId)` — one harness request as stored (#370): `pending` with the phase the daemon last reported,
 * then `done`, or `error` with the daemon's code (`in-use`, `checksum`, `download-failed`, …), `timeout` past its
 * deadline, or `interrupted` when the daemon said hello again before it finished.
 */
export interface HarnessResultView {
    readonly requestId: string;
    readonly op: HarnessOp;
    readonly runtime: RuntimeId;
    readonly mode: 'drain' | 'now';
    readonly status: 'pending' | 'done' | 'error';
    readonly requestedAt: number;
    readonly finishedAt?: number;
    readonly from?: string;
    readonly to?: string;
    readonly phase?: HarnessPhase;
    readonly error?: LifecycleError;
}

/** A stored harness request as `harnessResult` shows it — the caller snapshots it. */
function harnessResultOf(r: HarnessRequestRecord): HarnessResultView {
    return {
        requestId: r.requestId,
        op: r.op,
        runtime: r.runtime,
        mode: r.mode,
        status: r.status,
        requestedAt: r.requestedAt,
        ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
        ...(r.from !== undefined ? { from: r.from } : {}),
        ...(r.to !== undefined ? { to: r.to } : {}),
        ...(r.phase ? { phase: r.phase } : {}),
        ...(r.error ? { error: r.error } : {})
    };
}

/** `requestUpdate` (#365). */
export interface UpdateRequestInput {
    /** A version the machine's release directory lists, or `previous`; absent → the newest release on the machine's channel. */
    readonly target?: string;
    /** `drain` (default) lets running turns end first, for at most `drainTimeoutMs`; `now` does not wait. */
    readonly mode?: 'drain' | 'now';
    readonly drainTimeoutMs?: number;
}

/** `Machine.updateState()` (#365): what the Machines page shows and the update confirm asks about. */
export interface MachineUpdateView {
    readonly machineId: MachineId;
    readonly online: boolean;
    readonly build?: DaemonBuild;
    readonly features: readonly DaemonFeature[];
    readonly outdated: boolean;
    readonly channel: ReleaseChannel;
    readonly policy: UpdatePolicy;
    /** Whether the channel / the policy are the workspace's (the machine has none of its own). */
    readonly inherited: { readonly channel: boolean; readonly policy: boolean };
    readonly available?: AvailableUpdate;
    /** When the release manifests it last compared against were read (#468); absent before the first. */
    readonly checkedAt?: number;
    readonly pending?: PendingUpdate;
    readonly last?: UpdateOutcome;
    readonly draining?: MachineDraining;
    readonly restarts?: number;
    readonly lastExit?: DaemonExit;
    /** What an update now would interrupt (#367's confirm): the turns running, and how many sessions are live. */
    readonly impact: { readonly runningTurns: readonly { readonly sessionId: SessionId; readonly taskId?: TaskId; readonly agentId: string }[]; readonly liveSessions: number };
}

/** One environment's doctor verdict as `Machine.doctor()` reports it (EXE-05/07). */
export interface EnvironmentDoctorView {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly runtime: RuntimeId;
    readonly account: EnvironmentDescriptor['account'];
    readonly isolation: IsolationMechanism;
    /** Absent when the daemon reported none (it ran no `doctor`, or predates the field) — listed in `unverified`. */
    readonly verdict?: EnvironmentVerdict;
}

/**
 * `Machine.doctor()` — the daemon's per-environment verdicts as last reported
 * in `hello` / `env`: the shape the Machines page and `environments.doctor`
 * on the MCP surface (#50) show. `ok` only when every environment has a
 * verdict and none is an error.
 */
export interface MachineDoctorView {
    readonly machineId: MachineId;
    readonly online: boolean;
    readonly lastSeen?: number;
    readonly ok: boolean;
    /** Environments the daemon sent no verdict for. */
    readonly unverified: readonly EnvironmentId[];
    readonly environments: readonly EnvironmentDoctorView[];
}

/** One environment's provider limits as `Machine.quota()` reports them; `snapshot: null` until the daemon reports one. */
export interface EnvironmentQuotaView {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly runtime: RuntimeId;
    readonly account: EnvironmentDescriptor['account'];
    readonly snapshot: QuotaSnapshot | null;
}

/** `Machine.quota()` — each environment's provider limits (#261). Kept while offline: staleness is the reader's, from `snapshot.observedAt`. */
export interface MachineQuotaView {
    readonly machineId: MachineId;
    readonly name: string;
    readonly online: boolean;
    readonly lastSeen?: number;
    readonly environments: readonly EnvironmentQuotaView[];
}

/** Only the machine the key names — the daemon's own socket. */
const selfMachine: ActorPolicy = (principal: Principal | null, _rq, op) => {
    if (!op.resource || principal?.kind !== 'machine') return false;
    return parseMachineKey(op.resource.key)?.machineId === principal.machineId;
};
/** The workspace's user (v1: its owner, `sameWorkspace` already ran). */
const owner: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user';
const ownerOrSelf: ActorPolicy = (principal, rq, op) => owner(principal, rq, op) || selfMachine(principal, rq, op);
/** Whoever drives sessions: a user, an agent, or an external client with the `sessions` scope — never a machine. */
const sessionDriver: ActorPolicy = (principal: Principal | null) => !!principal && principal.kind !== 'machine' && hasScope(principal, 'sessions');
const machinesReader: ActorPolicy = (principal: Principal | null) => !!principal && hasScope(principal, 'machines');

/** The wire `AgentCapabilities` a `CapabilityReport` implies — what the daemon's `serveSession` runs with. */
export function toAgentCapabilities(report: CapabilityReport): AgentCapabilities {
    const has = (...ops: string[]) => ops.some((op) => report.supported.includes(op));
    return agentCapabilities({
        resume: report.resume,
        cancel: report.cancel,
        steer: report.steer,
        permissions: report.permissions,
        tools: report.tools,
        // A harness reports its ops under their own names (`HARNESS_OPS`, #453); the short ones are an in-memory runtime's.
        fork: has('session.fork', 'fork'),
        config: has('session.configure-model', 'configure', 'config'),
        structuredOutput: has('turn.structured-output', 'structured-output', 'structuredOutput'),
        listSessions: has('agent.list-sessions', 'list-sessions', 'listSessions')
    });
}

interface SessionClient {
    forwardFrames(frames: readonly WireFrame[]): Promise<void>;
    commandReplied(reply: WireReply): Promise<void>;
    noteRef(ref: SessionRef): Promise<void>;
    noteTitle(title: string): Promise<void>;
    hostEnded(ended: { readonly reason: string; readonly code?: SessionClosedCode }): Promise<void>;
}

/** The Routing actor's machine-facing entry points (`defineRoutingActor`). */
interface RoutingClient {
    machineOnline(machineId: MachineId): Promise<void>;
    /** The machine went offline (#366): its running routes wait `machine-offline` until it is back, or fail `machine-lost`. */
    machineOffline(machineId: MachineId): Promise<void>;
    sessionOpened(sessionId: SessionId, taskId?: TaskId): Promise<void>;
    /** A session is gone; `code` is the daemon's close code (#359), `resume-failed` for a re-open it refused (#366, #433). */
    sessionClosed(sessionId: SessionId, reason: string, taskId?: TaskId, code?: SessionClosedCode): Promise<void>;
    /** A turn ended in the environment, or a session running one closed (#394): a slot is free for a route parked `waiting-capacity` there. */
    slotFreed(machineId: MachineId, environmentId: EnvironmentId, why: string): Promise<void>;
    /** The daemon answered a prompt with an error (#394): `busy` parks the route on capacity, anything else fails its task. */
    promptRefused(sessionId: SessionId, turnId: string, code: string, message: string): Promise<void>;
}

/** The ReleaseDirectory's read (`global:releases`, #365). */
interface ReleasesClient {
    get(): Promise<ReleasesView>;
    /** Read now unless the last read is younger than `minAgeMs` (never below `RELEASE_CHECK_MIN_MS`, #468). */
    check(minAgeMs?: number): Promise<ReleasesView>;
}

/** The slice of the Inbox a machine notifies (#365). */
interface InboxClient {
    push(input: NotificationInput): Promise<unknown>;
}

/** Build the Machine actor definition over its ports. One call per app — the actor `type` is `'machine'`. */
export function defineMachineActor(ports: MachinePorts) {
    const now = ports.now ?? Date.now;
    const heartbeatWindowMs = ports.heartbeatWindowMs ?? DEFAULT_HEARTBEAT_WINDOW_MS;
    const commandTimeoutMs = ports.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const fsTimeoutMs = ports.fsTimeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
    const envTimeoutMs = ports.envTimeoutMs ?? DEFAULT_ENV_TIMEOUT_MS;
    const historyTimeoutMs = ports.historyTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
    const livenessDue = Math.max(REMINDER_FLOOR_MS, Math.min(heartbeatWindowMs, commandTimeoutMs, fsTimeoutMs, envTimeoutMs, historyTimeoutMs));
    /**
     * History answers by `${actor key}:${requestId}` (#397): the events a daemon answered with, held by the activation
     * that took them and handed out by the `historyAnswer` stream. Never on the record — a slice weighs up to half a
     * frame — so an activation that goes between the answer and its reader loses it, and the reader asks again.
     */
    const answers = new Map<string, HistoryAnswer>();
    const answerKey = (key: string, requestId: string): string => `${key}:${requestId}`;

    function view(c: ActorContext<MachineState>): MachineView {
        const s = c.snapshot();
        const ids = parseMachineKey(c.key)!;
        const { tokenHash: _hash, ...rest } = s;
        return {
            key: c.key,
            workspaceId: ids.workspaceId,
            machineId: ids.machineId,
            name: rest.name,
            ...(rest.os ? { os: rest.os } : {}),
            paired: !!s.tokenHash,
            ...(rest.pairedAt !== undefined ? { pairedAt: rest.pairedAt } : {}),
            revoked: rest.revokedAt !== undefined && rest.revokedAt !== null,
            ...(rest.revokedAt !== undefined && rest.revokedAt !== null ? { revokedAt: rest.revokedAt } : {}),
            online: rest.online,
            ...(rest.lastSeen !== undefined ? { lastSeen: rest.lastSeen } : {}),
            ...(rest.connectedAt !== undefined ? { connectedAt: rest.connectedAt } : {}),
            ...(rest.daemonVersion !== undefined ? { daemonVersion: rest.daemonVersion } : {}),
            capabilities: rest.capabilities,
            environments: rest.environments,
            ...(rest.policy ? { policy: rest.policy } : {}),
            ...(rest.quota && Object.keys(rest.quota).length > 0 ? { quota: rest.quota } : {}),
            ...(rest.telemetry ? { telemetry: rest.telemetry } : {}),
            activeSessions: Object.values(rest.activeSessions),
            queued: rest.queued,
            pending: Object.values(rest.pending),
            closures: rest.closures,
            rejected: rest.rejected,
            ...(rest.build ? { build: rest.build } : {}),
            ...(rest.features ? { features: rest.features } : {}),
            ...(rest.harnesses ? { harnesses: rest.harnesses } : {}),
            ...(rest.outdated ? { outdated: true } : {}),
            ...(rest.draining ? { draining: rest.draining } : {}),
            ...(rest.harnessesAvailable ? { harnessesAvailable: rest.harnessesAvailable } : {}),
            ...harnessPending(rest)
        };
    }

    /** The pending harness request, as `MachineView.harnessRequest` (#370). */
    function harnessPending(s: MachineState): { harnessRequest?: HarnessResultView } {
        const r = Object.values(s.harnessRequests ?? {}).find((x) => x.status === 'pending');
        return r ? { harnessRequest: harnessResultOf(r) } : {};
    }

    /** `updateState()` (#365). */
    function updateView(c: ActorContext<MachineState>): MachineUpdateView {
        const s = c.snapshot();
        const u = s.update;
        const { channel, policy, inherited } = effectiveUpdates(u);
        const running = new Map<string, HostedSession>();
        for (const h of Object.values(s.activeSessions)) for (const r of runningIn(s, h.environmentId)) running.set(r.sessionId, r);
        return {
            machineId: parseMachineKey(c.key)!.machineId,
            online: s.online,
            ...(s.build ? { build: s.build } : {}),
            features: s.features ?? [],
            outdated: s.outdated === true,
            channel,
            policy,
            inherited,
            ...(u?.available ? { available: u.available } : {}),
            ...(u?.checkedAt !== undefined ? { checkedAt: u.checkedAt } : {}),
            ...(u?.pending ? { pending: u.pending } : {}),
            ...(u?.last ? { last: u.last } : {}),
            ...(s.draining ? { draining: s.draining } : {}),
            ...(s.restarts !== undefined ? { restarts: s.restarts } : {}),
            ...(s.lastExit ? { lastExit: s.lastExit } : {}),
            impact: {
                runningTurns: [...running.values()].map((h) => ({ sessionId: h.sessionId, ...(h.taskId ? { taskId: h.taskId } : {}), agentId: h.agentId })),
                liveSessions: Object.keys(s.activeSessions).length
            }
        };
    }

    /** The router, told one-way as the machine `c` names — a fresh call, for the reasons `session()` gives; a router that is not wired hears nothing. */
    async function tellRouter(c: ActorContext<MachineState>, call: (routing: RoutingClient) => Promise<void>): Promise<void> {
        const def = ports.routing?.();
        const ids = parseMachineKey(c.key);
        if (!def || !ids) return;
        const client = actor(def, routingKey(ids.workspaceId)).with({ context: asPrincipal(machinePrincipal(ids.workspaceId, ids.machineId)), oneWay: true }) as unknown as RoutingClient;
        await call(client).catch(() => undefined);
    }

    /** Room to open a session in: `freeSlots` without the drain. An open costs no slot (#394), so a drain never holds one back (#365). */
    const openRoom = (s: MachineState, environmentId: EnvironmentId): number => freeSlots({ environments: s.environments, activeSessions: s.activeSessions, pending: s.pending }, environmentId);

    /** Move queued sessions into environments that have room, sending `session.open` for each. */
    function dequeueIn(c: ActorContext<MachineState>): void {
        const s = c.state;
        if (!s.online) return;
        const keep: QueuedSession[] = [];
        for (const q of s.queued) {
            if (openRoom(s, q.environmentId) > 0) {
                const hosted: HostedSession = { sessionId: q.sessionId, environmentId: q.environmentId, agentId: q.agentId, ...(q.taskId ? { taskId: q.taskId } : {}), spec: q.spec, status: 'opening', requestedAt: now() };
                s.activeSessions[q.sessionId] = hosted;
                ports.socket.send(c.key, encodeFrame({ v: V, t: 'session.open', sessionId: hosted.sessionId, environmentId: hosted.environmentId, spec: c.snapshot(hosted.spec) }));
            } else keep.push(q);
        }
        s.queued = keep;
    }

    /**
     * Daemon updates on the machine `c` names (#365): what `hello` reports, the compare against the release directory,
     * the pending `update.request` from asked to judged, the drain it holds, the policy, and the audit records and Inbox
     * rows for all of it. A factory over the context, so a method turn and the liveness reminder share it.
     */
    function updates(c: ActorContext<MachineState>) {
        const { workspaceId, machineId } = parseMachineKey(c.key)!;
        const ref = { kind: 'machine', machineId } as const;
        const byMachine = `machine:${machineId}`;
        const named = (): string => c.state.name || machineId;

        async function inbox(input: NotificationInput): Promise<void> {
            const def = ports.inbox?.();
            if (!def) return;
            try {
                await (c.actor(def, inboxKey(workspaceId)).with({ oneWay: true }) as unknown as InboxClient).push(input);
            } catch {
                // A notification is never a gate on the work.
            }
        }

        /** The release directory's manifests, or `null` when it is not wired or cannot be read; `fresh` reads them now unless the last read is recent (#468). */
        async function directory(fresh = false): Promise<ReleasesView | null> {
            const def = ports.releases?.();
            if (!def) return null;
            try {
                const releases = c.actor(def, RELEASE_DIRECTORY_KEY) as unknown as ReleasesClient;
                return await (fresh ? releases.check() : releases.get());
            } catch {
                return null;
            }
        }

        /** The workspace's `settings.updates` into `update.defaults`; a workspace that cannot be read leaves the last copy. */
        async function readDefaults(): Promise<void> {
            const u = (c.state.update ??= {});
            try {
                const w = await c.actor(Workspace, workspaceKey(workspaceId)).get();
                u.defaults = c.snapshot(w.settings.updates ?? DEFAULT_UPDATE_SETTINGS);
            } catch {
                // Kept: the defaults it last read, else `DEFAULT_UPDATE_SETTINGS`.
            }
        }

        /**
         * The harness builds `manifest` ships for the build's platform, into `harnessesAvailable` (#370); a runtime whose
         * installed version is older than the one shipped is told to the Inbox once per runtime and version.
         */
        async function compareHarnesses(manifest: ReleaseManifest | undefined): Promise<void> {
            const s = c.state;
            const platform = s.build?.platform;
            if (!manifest || !platform) {
                delete s.harnessesAvailable;
                return;
            }
            const available: Record<string, AvailableHarness> = {};
            for (const [runtime, shipped] of Object.entries(manifest.harnesses ?? {})) {
                if (!shipped) continue;
                const asset = shipped.assets[platform];
                available[runtime] = { version: shipped.version, ...(asset ? { asset: c.snapshot(asset) } : {}) };
            }
            s.harnessesAvailable = available;
            const notified = (s.harnessesNotified ??= {});
            for (const report of s.harnesses ?? []) {
                const offer = available[report.runtime];
                const installed = report.installed?.version;
                if (!offer?.asset || installed === undefined || compareVersions(offer.version, installed) <= 0 || notified[report.runtime] === offer.version) continue;
                notified[report.runtime] = offer.version;
                await inbox({ kind: 'harness-update-available', title: `${report.runtime} ${offer.version} is available for ${named()}`, body: `It has ${installed}.`, ref });
            }
        }

        /** `available` from the channel's manifest; a version newly seen is told to the Inbox once. `dir: null` changes nothing. */
        async function compare(dir: ReleasesView | null): Promise<void> {
            const s = c.state;
            const u = (s.update ??= {});
            u.comparedAt = now();
            if (!dir) return;
            if (dir.lastCheckedAt !== undefined) u.checkedAt = dir.lastCheckedAt;
            const manifest = dir.channels[effectiveUpdates(u).channel];
            await compareHarnesses(manifest);
            if (!s.build || !manifest || compareVersions(manifest.version, s.build.version) <= 0) {
                delete u.available;
                return;
            }
            const asset = manifest.assets[s.build.platform];
            u.available = { version: manifest.version, ...(manifest.notesUrl ? { notesUrl: manifest.notesUrl } : {}), ...(dir.lastCheckedAt !== undefined ? { checkedAt: dir.lastCheckedAt } : {}), ...(asset ? { asset: c.snapshot(asset) } : {}) };
            if (u.notified === manifest.version) return;
            u.notified = manifest.version;
            await inbox({ kind: 'update-available', title: `Daemon ${manifest.version} is available for ${named()}`, body: `It runs ${s.build.version}.${asset ? '' : ` The release has no build for ${s.build.platform}.`}`, ref });
        }

        /** While `onHello` runs nothing goes out before `welcome`: a drain it ends is told by `releaseDrain` after. */
        let holding = false;
        let held: string | undefined;

        /** The drain ends (#365): queued opens go out, and the router hears a slot freed in every environment, so parked prompts run. */
        async function endDrain(why: string): Promise<void> {
            const s = c.state;
            if (!s.draining) return;
            delete s.draining;
            if (holding) {
                held ??= why;
                return;
            }
            dequeueIn(c);
            for (const env of s.environments) await tellRouter(c, (r) => r.slotFreed(machineId, env.id, why));
        }

        /** After `welcome` (and the `hello` turn's own `dequeue`): the router hears the slots a drain `onHello` ended freed. */
        async function releaseDrain(): Promise<void> {
            const why = held;
            held = undefined;
            if (why === undefined) return;
            for (const env of c.state.environments) await tellRouter(c, (r) => r.slotFreed(machineId, env.id, why));
        }

        /** Close the pending update: `last` records how it ended, the audit and the Inbox hear it, and its drain ends. */
        async function close(outcome: UpdateOutcome['outcome'], error?: string, to?: string, by = byMachine): Promise<void> {
            const s = c.state;
            const u = s.update;
            const p = u?.pending;
            if (!u || !p) return;
            const at = now();
            const target = to ?? p.target;
            u.last = { requestId: p.requestId, from: p.from, to: target, outcome, at, ...(error ? { error } : {}) };
            delete u.pending;
            if (outcome === 'applied') {
                await recordAudit(c, workspaceId, { key: `${c.key}:update:${p.requestId}:applied`, kind: 'machine.updated', at, by, summary: `machine ${named()} updated ${p.from} → ${target}`, data: { machineId, from: p.from, to: target } });
                await inbox({ kind: 'update-applied', title: `${named()} runs daemon ${target}`, body: `Updated from ${p.from}.`, ref });
            } else if (outcome !== 'cancelled') {
                const message = error ?? outcome;
                await recordAudit(c, workspaceId, { key: `${c.key}:update:${p.requestId}:failed`, kind: 'machine.update-failed', at, by, summary: `machine ${named()} did not update ${p.from} → ${target}: ${message}`, data: { machineId, from: p.from, to: target, error: message } });
                await inbox({ kind: 'update-failed', title: `${named()} did not update to ${target}`, body: message, ref });
            }
            if (s.draining?.requestId === p.requestId) await endDrain(`the update of machine ${machineId} ${outcome === 'applied' ? 'landed' : `ended (${outcome})`}`);
        }

        /**
         * A harness request ended (#370): the record closes — `done`, or `error` with the daemon's code, or `timeout` —
         * `harness.changed` is audited once per outcome, and the drain it held ends.
         */
        async function harnessEnded(r: HarnessRequestRecord, outcome: 'done' | 'failed' | 'timeout', error?: LifecycleError): Promise<void> {
            const at = now();
            r.status = outcome === 'done' ? 'done' : 'error';
            r.finishedAt = at;
            if (outcome !== 'timeout') r.phase = outcome;
            if (error) r.error = { code: error.code, message: error.message };
            else delete r.error;
            const message = error ? `${error.code}: ${error.message}` : undefined;
            const change = r.op === 'remove' ? `removal of the ${r.runtime} harness` : `${r.op} of ${r.runtime} ${r.to ?? ''}`.trimEnd();
            const summary = outcome === 'done'
                ? r.op === 'remove'
                    ? `${r.runtime} harness removed from machine ${named()}`
                    : `${r.runtime} harness on machine ${named()} ${r.op === 'install' ? 'installed at' : `updated ${r.from ?? 'none'} →`} ${r.to ?? '?'}`
                : `${change} on machine ${named()} ${outcome === 'timeout' ? 'timed out' : 'failed'}: ${message ?? outcome}`;
            await recordAudit(c, workspaceId, {
                key: `${c.key}:harness:${r.requestId}:${outcome}`,
                kind: 'harness.changed',
                at,
                by: r.by,
                summary,
                data: { machineId, runtime: r.runtime, op: r.op, ...(r.from !== undefined ? { from: r.from } : {}), ...(r.to !== undefined ? { to: r.to } : {}), outcome, ...(message ? { error: message } : {}) }
            });
            if (c.state.draining?.requestId === r.requestId) await endDrain(`the ${r.runtime} harness change on machine ${machineId} ended (${outcome})`);
        }

        /** Send one `update.request` and hold it pending, with its drain. 503 when no socket takes it. */
        async function request(target: ReleaseAsset | 'previous', to: string, mode: 'drain' | 'now', drainTimeoutMs: number, by: string): Promise<string> {
            const s = c.state;
            const u = (s.update ??= {});
            const at = now();
            const requestId = `update_${crypto.randomUUID()}`;
            if (!ports.socket.send(c.key, encodeFrame({ v: V, t: 'update.request', requestId, target, mode, drainTimeoutMs }))) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" has no open socket`);
            const from = s.build?.version ?? s.daemonVersion ?? 'unknown';
            u.pending = { requestId, target: to, ...(target !== 'previous' ? { asset: target } : {}), mode, from, requestedAt: at, deadline: at + drainTimeoutMs + UPDATE_DEADLINE_GRACE_MS, by };
            s.draining = { requestId, since: at };
            await recordAudit(c, workspaceId, { key: `${c.key}:update:${requestId}`, kind: 'machine.update-requested', at, by, summary: `update of machine ${named()} ${from} → ${to} requested (${mode})`, data: { machineId, from, to, mode, by } });
            return requestId;
        }

        /** The policy's update, when it asks for one now (`nextAutoUpdate`) — requested as `system:updates`. */
        async function autoUpdate(): Promise<void> {
            if (!ports.releases) return;
            const next = nextAutoUpdate(c.state, now());
            if (!next?.asset) return;
            try {
                await request(next.asset, next.version, 'drain', DEFAULT_DRAIN_TIMEOUT_MS, SYSTEM_UPDATES);
            } catch {
                // No socket to send on: the next tick asks again.
            }
        }

        /**
         * What `hello` says about updates, before `welcome` goes out: the build and features, the crash-loop count, the
         * pending update judged (the version asked for → applied; another, or a rollback → failed), the drain cleared, the
         * compare. Returns `welcome.platform`.
         */
        async function onHello(frame: DaemonFrameOf<'hello'>): Promise<PlatformInfo> {
            holding = true;
            try {
                return await hello(frame);
            } finally {
                holding = false;
            }
        }

        async function hello(frame: DaemonFrameOf<'hello'>): Promise<PlatformInfo> {
            const s = c.state;
            const u = (s.update ??= {});
            const at = now();
            if (frame.build) s.build = c.snapshot(frame.build) as DaemonBuild;
            else delete s.build;
            if (frame.features) s.features = [...frame.features];
            else delete s.features;
            if (frame.lastExit) s.lastExit = c.snapshot(frame.lastExit) as DaemonExit;
            if (frame.harnesses) s.harnesses = c.snapshot(frame.harnesses) as HarnessReport[];
            if (s.build) s.outdated = compareVersions(s.build.version, MIN_DAEMON_VERSION) < 0;
            else delete s.outdated;
            if (foldRestarts(s, frame.restarts, at) && (s.crashLoopAt === undefined || s.crashLoopAt <= at - CRASH_LOOP_WINDOW_MS)) {
                s.crashLoopAt = at;
                const restarts = (s.restartLog ?? []).reduce((n, r) => n + r.count, 0);
                await inbox({ kind: 'daemon-crash-loop', title: `The daemon on ${named()} keeps restarting`, body: `${restarts} restarts in the last ${CRASH_LOOP_WINDOW_MS / 60_000} minutes.${s.lastExit ? ` Last exit: ${s.lastExit.reason}.` : ''}`, ref });
            }
            const reported = frame.lastUpdate && frame.lastUpdate.at !== u.reported ? frame.lastUpdate : undefined;
            if (reported) u.reported = reported.at;
            const p = u.pending;
            if (p) {
                const version = s.build?.version;
                const cameBack = `the daemon came back on ${version ?? 'a build it does not name'}`;
                if (reported?.outcome === 'rolled-back' && reported.at >= p.requestedAt) await close('rolled-back', reported.error ?? `rolled back to ${reported.from}`, reported.to);
                else if (p.target === 'previous') await (version !== undefined && version !== p.from ? close('applied', undefined, version) : close('failed', cameBack));
                else if (version === p.target) await close('applied');
                else await close('failed', `${cameBack}, not ${p.target}`);
            } else if (reported?.outcome === 'rolled-back') {
                u.last = { from: reported.from, to: reported.to, outcome: 'rolled-back', at: reported.at, ...(reported.error ? { error: reported.error } : {}) };
                const message = reported.error ?? `rolled back to ${reported.from}`;
                await recordAudit(c, workspaceId, { key: `${c.key}:rollback:${reported.at}`, kind: 'machine.update-failed', at, by: byMachine, summary: `machine ${named()} did not update ${reported.from} → ${reported.to}: ${message}`, data: { machineId, from: reported.from, to: reported.to, error: message } });
                await inbox({ kind: 'update-failed', title: `${named()} did not update to ${reported.to}`, body: message, ref });
            }
            // A harness request the daemon did not finish before this hello is interrupted (#370); a late answer still lands.
            for (const r of Object.values(s.harnessRequests ?? {})) {
                if (r.status !== 'pending') continue;
                r.status = 'error';
                r.error = { code: 'interrupted', message: 'the daemon connected again before it finished the request' };
                r.finishedAt = at;
            }
            // Every `hello` ends a drain: a daemon that came back takes turns again.
            await endDrain(`machine ${machineId} said hello`);
            const dir = await directory();
            if (ports.releases) {
                await readDefaults();
                await compare(dir);
            }
            const stable = dir?.channels.stable?.version;
            const latest = dir?.channels.latest?.version;
            return { version: platformVersion(), minDaemonVersion: MIN_DAEMON_VERSION, ...(stable || latest ? { latest: { ...(stable ? { stable } : {}), ...(latest ? { latest } : {}) } } : {}) };
        }

        /** An `update.status` frame: the phase and progress; `failed` closes the update and ends its drain. Another request's status is ignored. */
        async function onStatus(frame: DaemonFrameOf<'update.status'>): Promise<void> {
            const p = c.state.update?.pending;
            if (!p || p.requestId !== frame.requestId) return;
            p.phase = frame.phase;
            if (frame.progress) p.progress = { bytes: frame.progress.bytes, total: frame.progress.total };
            if (frame.error) p.error = { code: frame.error.code, message: frame.error.message };
            if (frame.phase === 'failed') await close('failed', frame.error ? `${frame.error.code}: ${frame.error.message}` : 'the daemon reported the update failed');
        }

        /** The liveness tick: a pending update past its deadline fails `timeout`; an online machine re-compares (at most every `UPDATE_COMPARE_EVERY_MS`) and runs its policy. */
        async function tick(): Promise<void> {
            const s = c.state;
            const at = now();
            const p = s.update?.pending;
            if (p && p.deadline <= at) await close('timeout', `no daemon on the new version within ${Math.round((p.deadline - p.requestedAt) / 60_000)} minutes`, undefined, SYSTEM_UPDATES);
            if (!s.online || !ports.releases) return;
            if ((s.update?.comparedAt ?? 0) + UPDATE_COMPARE_EVERY_MS <= at) {
                await readDefaults();
                await compare(await directory());
            }
            await autoUpdate();
        }

        return { directory, readDefaults, compare, close, request, autoUpdate, onHello, releaseDrain, onStatus, tick, harnessEnded, inbox, named };
    }

    return defineActor({
        type: 'machine',
        authorize: [sameWorkspace, machinesReader],
        methodAuthorize: {
            pair: ownerOrSelf,
            tokenRecord: ownerOrSelf,
            revoke: owner,
            rename: owner,
            socketMessage: selfMachine,
            socketClosed: selfMachine,
            heartbeat: selfMachine,
            openSession: sessionDriver,
            closeSession: sessionDriver,
            sendCommand: sessionDriver,
            // `worktree` is narrowed to the owner inside the method: a policy sees the method, not the op.
            fsRequest: sessionDriver,
            fsResult: sessionDriver,
            // Owner only, and never a tool (decisions 2026-09-19 (c)): an agent must not widen where agents may work.
            putEnvironment: owner,
            removeEnvironment: owner,
            envResult: owner,
            historyRequest: sessionDriver,
            historyResult: sessionDriver,
            // Owner only, and never a tool (#365, decisions 2026-09-19 (c)): an agent must not replace the daemon it runs on.
            requestUpdate: owner,
            cancelUpdate: owner,
            setUpdatePolicy: owner,
            setChannel: owner,
            updateState: owner,
            checkUpdates: owner,
            // Owner only, and never a tool (#370): an agent must not change the runtimes a machine runs.
            requestHarness: owner,
            harnessResult: owner
        },
        state: (): MachineState => initialMachineState(),
        methods: (ctx) => {
            const ids = parseMachineKey(ctx.key);
            if (!ids) throw new ServerFnError(404, `machine: "${ctx.key}" is not a {ws}:machine:{id} key`);
            const { workspaceId, machineId } = ids;
            const self = machinePrincipal(workspaceId, machineId);

            const send = (frame: PlatformFrame): boolean => ports.socket.send(ctx.key, encodeFrame(frame));

            /**
             * The Session actor for `sessionId`, called as this machine through a
             * FRESH call rather than a `ctx.actor` hop: the daemon path's entry
             * points admit only the hosting machine, and the turn this runs in
             * may belong to a user (`closeSession`), to nobody (the reminder) or
             * to the Session itself (`sendCommand` from its `CommandSink`) — a
             * hop would inherit that caller, or wait on the turn that is waiting
             * on us. `oneWay` queues the call instead of awaiting it.
             */
            function session(sessionId: SessionId, options: { oneWay?: boolean } = {}): SessionClient | null {
                const def = ports.sessions?.();
                if (!def) return null;
                const client = actor(def, actorKey(workspaceId, 'session', sessionId));
                return (options.oneWay ? client.with({ context: asPrincipal(self), oneWay: true }) : client.with({ context: asPrincipal(self) })) as unknown as SessionClient;
            }

            async function replied(sessionId: SessionId, reply: WireReply, options?: { oneWay?: boolean }): Promise<void> {
                await session(sessionId, options)?.commandReplied(reply);
            }

            /** The router, told one-way as this machine (the same fresh-call reasoning as `session()`); a router that is not wired hears nothing. */
            const notify = (call: (routing: RoutingClient) => Promise<void>): Promise<void> => tellRouter(ctx, call);
            const lifecycle = updates(ctx);

            const errorReply = (commandId: string, code: Extract<WireReply, { kind: 'error' }>['code'], message: string): WireReply => ({ v: W, kind: 'error', commandId, code, message });
            /** `commandId` is unique per Session, not per machine: pending replies are keyed by both. */
            const pendingKey = (sessionId: SessionId, commandId: string): string => `${sessionId}:${commandId}`;

            async function armLiveness(): Promise<void> {
                const s = ctx.state;
                if (needsLiveness(s)) await ctx.reminders.set(LIVENESS, { due: livenessDue });
                else await ctx.reminders.clear(LIVENESS);
            }

            function record(closure: SessionClosure): void {
                const s = ctx.state;
                s.closures.push(closure);
                if (s.closures.length > MAX_CLOSURES) s.closures.splice(0, s.closures.length - MAX_CLOSURES);
            }

            function openFrame(h: { sessionId: SessionId; environmentId: EnvironmentId; spec: OpenSpec }): PlatformFrame {
                return { v: V, t: 'session.open', sessionId: h.sessionId, environmentId: h.environmentId, spec: ctx.snapshot(h.spec) };
            }

            /** Move queued sessions into environments that have room, sending `session.open` for each. */
            const dequeue = (): void => dequeueIn(ctx);

            /**
             * Forget a hosted or queued session; answer its open commands with `closed`. A session the daemon had opened is
             * handed to its record first (#420, `Session.hostEnded`): a turn still running there is interrupted — never left
             * `running` for a session nobody hosts — and the record waits `idle` for a re-open. Before the router hears it.
             * `code` is the daemon's (`session.closed.code`, #359), carried to the record as the cause. A re-open the
             * daemon refused (#366: `refused` — its `session.closed` came while the entry was still `opening` — with
             * `resume-failed`, or for a record that opened before and is resumed from its ref) closes the record, so the
             * chat's next message binds a fresh session instead of asking the daemon for this one again.
             */
            async function sessionGone(sessionId: SessionId, reason: string, code?: SessionClosedCode, refused = false): Promise<void> {
                const s = ctx.state;
                const hosted = s.activeSessions[sessionId];
                const reopenRefused = refused && hosted?.status === 'opening' && (code === 'resume-failed' || hosted.spec.resume !== undefined);
                const wasHosted = hosted !== undefined;
                const taskId = hosted?.taskId ?? s.queued.find((q) => q.sessionId === sessionId)?.taskId;
                // A session that held a slot (a turn running, or a prompt out) frees it by closing (#394).
                const held = hosted !== undefined && runningIn(s, hosted.environmentId).some((h) => h.sessionId === sessionId);
                delete s.activeSessions[sessionId];
                pruneTelemetry(s);
                const before = s.queued.length;
                s.queued = s.queued.filter((q) => q.sessionId !== sessionId);
                const known = wasHosted || s.queued.length !== before;
                if (known) record({ sessionId, reason, at: now() });
                if (hosted?.status === 'open' || reopenRefused) {
                    try {
                        await session(sessionId)?.hostEnded({ reason, ...(reopenRefused ? { code: 'resume-failed' as const } : code ? { code } : {}) });
                    } catch (e) {
                        // The record's word, never the socket's: a refusal or a failure here must not take the daemon's connection down.
                        console.warn(`[machine] session ${sessionId} of ${ctx.key} could not be told its host ended (${reason}): ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                const closedCode: SessionClosedCode | undefined = reopenRefused ? 'resume-failed' : code;
                if (known) await notify((r) => r.sessionClosed(sessionId, reason, taskId, closedCode));
                for (const [key, p] of Object.entries(s.pending)) {
                    if (p.sessionId !== sessionId) continue;
                    delete s.pending[key];
                    await replied(sessionId, errorReply(p.command.commandId, 'closed', reason));
                }
                dequeue();
                if (held) await notify((r) => r.slotFreed(machineId, hosted.environmentId, `session ${sessionId} closed while running a turn (${reason})`));
            }

            async function onHello(frame: DaemonFrameOf<'hello'>): Promise<void> {
                const s = ctx.state;
                if (frame.machineId !== machineId) {
                    ports.socket.close(ctx.key, 1008, `hello names machine ${frame.machineId}; this socket belongs to ${machineId}`);
                    return;
                }
                const at = now();
                s.online = true;
                s.lastSeen = at;
                s.connectedAt = at;
                s.os = frame.os;
                s.daemonVersion = frame.daemonVersion;
                s.environments = ctx.snapshot(frame.environments) as EnvironmentDescriptor[];
                s.capabilities = ctx.snapshot(frame.capabilities) as CapabilityReport[];
                // A daemon that reports no policy predates web-managed environments: nothing stale is kept from an older one.
                if (frame.policy) s.policy = ctx.snapshot(frame.policy) as MachinePolicy;
                else delete s.policy;
                pruneQuota(s);
                pruneTelemetry(s);
                // Sessions the daemon still runs, or once ran, replay from the last cursor this machine holds;
                // ones it never heard of (a restart before `session.opened`) are opened again.
                const wanted: Record<string, { epoch: number; seq: number }> = {};
                const reopen: HostedSession[] = [];
                for (const h of Object.values(s.activeSessions)) {
                    if (h.status === 'opening' && !(h.sessionId in frame.resume)) reopen.push(h);
                    else wanted[h.sessionId] = h.cursor ? { epoch: h.cursor.epoch, seq: h.cursor.seq } : { epoch: 0, seq: 0 };
                }
                // The build against the releases, the pending update judged, the drain ended (#365) — and what `welcome` says of the platform.
                const platform = await lifecycle.onHello(frame);
                send({ v: V, t: 'welcome', serverTime: at, wanted, platform });
                for (const h of reopen) send(openFrame(h));
                // Replies are idempotent by commandId on the daemon: what is still pending is asked again.
                for (const p of Object.values(s.pending)) if (p.deadline > at) send({ v: V, t: 'session.command', sessionId: p.sessionId, command: ctx.snapshot(p.command) });
                dequeue();
                await armLiveness();
                // Tasks parked on this machine (`waiting {environment-offline}`, policy `queue`) get their retry (§7).
                await notify((r) => r.machineOnline(machineId));
                await lifecycle.releaseDrain();
                await lifecycle.autoUpdate();
            }

            async function onSessionOpened(frame: DaemonFrameOf<'session.opened'>): Promise<void> {
                const h = ctx.state.activeSessions[frame.sessionId];
                if (!h) return; // not ours (a session this record never opened): nothing to bind it to
                h.status = 'open';
                h.openedAt = now();
                h.ref = frame.ref;
                h.capabilities = frame.capabilities;
                if (!h.cursor || advances(h.cursor, frame.head)) h.cursor = { epoch: frame.head.epoch, seq: frame.head.seq };
                // The daemon's pump skips the wire `hello`; this is where the Session learns its capabilities. The ref it carries is
                // whatever the runtime called the session before its first prompt — the Session ignores it (#389, `onSessionRef`).
                const hello: WireFrame = { v: W, kind: 'hello', agentId: h.agentId, sessionId: frame.sessionId, sessionRef: frame.ref as SessionRef, capabilities: toAgentCapabilities(frame.capabilities), head: frame.head };
                await toSession(() => session(frame.sessionId, { oneWay: true })?.forwardFrames([hello]));
                // The session can take commands now: the router prompts the task that was waiting for this (a queued one included).
                await notify((r) => r.sessionOpened(frame.sessionId, h.taskId));
            }

            /** The runtime's own id for a hosted session (#389), once it names it and on every change: the only ref the record resumes from. */
            async function onSessionRef(frame: DaemonFrameOf<'session.ref'>): Promise<void> {
                const h = ctx.state.activeSessions[frame.sessionId];
                if (!h) return; // not ours: nothing to bind it to
                h.ref = frame.ref;
                await toSession(() => session(frame.sessionId, { oneWay: true })?.noteRef(frame.ref as SessionRef));
            }

            /** The runtime's own title for a hosted session's conversation (#460): handed to the record, which tells its chat. */
            async function onSessionTitle(frame: DaemonFrameOf<'session.title'>): Promise<void> {
                if (!ctx.state.activeSessions[frame.sessionId]) return; // not ours
                await toSession(() => session(frame.sessionId, { oneWay: true })?.noteTitle(frame.title));
            }

            /**
             * A daemon's word about a session goes to its record ONE-WAY (#492): the call is queued on the Session and
             * this turn goes on. A Session's turn can be slow — a turn-end folds the transcript, learns and tells the
             * chat — and while this machine waited on it, every other session's frame, every `get` the router's
             * placement makes and every `openSession` for another chat queued behind that one turn; at the host's call
             * deadline the placement failed, in a chat that never touched the slow session. The mailbox keeps the frames
             * of a session in the order they were sent, so the record sees them as the daemon did.
             *
             * A Session refuses a frame for a session it is not hosted on by this machine (a stale one after a restart,
             * one re-opened elsewhere, one it never opened) with a 403 (#393). One-way, that refusal is raised inside the
             * Session's own turn and dropped there — it never reaches the host's `webSocketMessage`, which would take
             * the daemon's whole socket down with every other session on it. What a one-way dispatch itself can throw
             * is a failure before acceptance — an authorization or placement bug — and that surfaces.
             */
            const toSession = (fn: () => Promise<void> | undefined): Promise<void> => Promise.resolve(fn());

            async function onSessionFrame(frame: DaemonFrameOf<'session.frame'>): Promise<void> {
                const h = ctx.state.activeSessions[frame.sessionId];
                const wire = frame.frame;
                let ended: string | undefined;
                if (h) {
                    if (wire.kind === 'event' && advances(h.cursor, { epoch: wire.epoch, seq: wire.seq })) h.cursor = { epoch: wire.epoch, seq: wire.seq };
                    else if (wire.kind === 'gap') h.cursor = { epoch: wire.resumeAt.epoch, seq: wire.resumeAt.seq };
                    // The turn is over: its slot is free (#394). Any `turn-end` — a session runs one turn at a time.
                    if (wire.kind === 'event' && wire.event.type === 'turn-end' && h.running) {
                        ended = h.running.turnId;
                        delete h.running;
                    }
                }
                await toSession(() => session(frame.sessionId, { oneWay: true })?.forwardFrames([wire]));
                if (h && ended !== undefined) {
                    dequeue();
                    await notify((r) => r.slotFreed(machineId, h.environmentId, `turn ${ended} ended in session ${frame.sessionId}`));
                    // The machine may be idle now: its update policy runs (#365).
                    await lifecycle.autoUpdate();
                }
            }

            async function onSessionReply(frame: DaemonFrameOf<'session.reply'>): Promise<void> {
                const s = ctx.state;
                const key = pendingKey(frame.sessionId, frame.reply.commandId);
                const pending = s.pending[key];
                delete s.pending[key];
                const { reply } = frame;
                const command = pending?.command;
                // A prompt's ack starts the turn that holds the slot (#394); its error frees the pending one and is the router's to judge.
                if (command?.type === 'prompt') {
                    const h = s.activeSessions[frame.sessionId];
                    if (h && reply.kind === 'ack' && !h.running) h.running = { turnId: reply.turnId ?? command.turnId, since: now() };
                    if (reply.kind === 'error') await notify((r) => r.promptRefused(frame.sessionId, command.turnId, reply.code, reply.message));
                }
                await toSession(() => replied(frame.sessionId, reply, { oneWay: true }));
                if (pending?.command.type === 'close' && reply.kind === 'ack') await sessionGone(frame.sessionId, 'closed by command');
            }

            function onToolCall(frame: DaemonFrameOf<'tool.call'>): void {
                const h = ctx.state.activeSessions[frame.sessionId];
                const result = (r: { output?: unknown; error?: { code: string; message: string } }) => send({ v: V, t: 'tool.result', callId: frame.callId, ...r });
                if (!h) {
                    result({ error: { code: 'closed', message: `session ${frame.sessionId} is not hosted by this machine` } });
                    return;
                }
                const tools = ports.tools;
                if (!tools) {
                    result({ error: { code: 'unsupported', message: 'platform tools are not wired on this deployment' } });
                    return;
                }
                // Identity only: `h.taskId` is the task the session was OPENED for, fixed at `openSession`, and a session serves many
                // tasks (#390). The port (`routing/tool-call.ts`) reads the running turn's task (else the spec's) from the Session
                // per call and rebuilds the principal with it; what is minted here names who calls, never which task.
                const principal = mintAgentPrincipal({ workspaceId, agentId: h.agentId as AgentId, sessionId: frame.sessionId, ...(h.taskId ? { taskId: h.taskId } : {}) });
                // Detached on purpose: a tool may take minutes and must not hold the socket's turn. Nothing here touches state.
                void tools
                    .call({ callId: frame.callId, sessionId: frame.sessionId, tool: frame.tool, input: frame.input }, principal)
                    .then((output) => result({ output }))
                    .catch((e: unknown) => result({ error: e instanceof ToolCallError ? { code: e.code, message: e.message } : { code: 'internal', message: e instanceof Error ? e.message : String(e) } }));
            }

            /**
             * The daemon's answer to an `fsRequest`. Unknown ids (evicted, pruned, never ours) are ignored,
             * and so is a second answer — except over a `timeout`: a late answer says what the daemon did.
             * A worktree it added is audited once per request (OPS-03).
             */
            async function onFsResponse(frame: DaemonFrameOf<'fs.response'>): Promise<void> {
                const r = ctx.state.fs?.[frame.requestId];
                if (!r || r.status === 'done' || (r.status === 'error' && r.error?.code !== 'timeout')) return;
                const at = now();
                r.finishedAt = at;
                const result = frame.result;
                if (!result || result.kind !== r.op.kind) {
                    r.status = 'error';
                    r.error = result ? { code: 'internal', message: `the daemon answered a ${r.op.kind} request with a ${result.kind} result` } : structuredClone(frame.error ?? { code: 'internal', message: 'fs.response carried neither result nor error' });
                    delete r.result;
                    return;
                }
                r.status = 'done';
                r.result = structuredClone(result);
                delete r.error;
                if (r.op.kind !== 'worktree' || result.kind !== 'worktree') return;
                await recordAudit(ctx, workspaceId, {
                    key: `${ctx.key}:worktree:${r.requestId}`,
                    kind: 'workdir.worktree-created',
                    at,
                    by: r.by,
                    summary: `worktree ${result.branch} added at ${result.path} on machine ${machineId}`,
                    data: { machineId, environmentId: r.environmentId, repo: r.op.repo, branch: result.branch, path: result.path, ...(r.op.base ? { base: r.op.base } : {}) }
                });
            }

            /**
             * The daemon's answer to `putEnvironment` / `removeEnvironment`. Ignored like a stray `fs.response`
             * (unknown id, second answer — except over a `timeout`). Its error code is stored unchanged, and what
             * was asked and what the machine said goes on the audit log once per request (OPS-03).
             */
            async function onEnvResponse(frame: DaemonFrameOf<'env.response'>): Promise<void> {
                const r = ctx.state.envRequests?.[frame.requestId];
                if (!r || r.status === 'done' || (r.status === 'error' && r.error?.code !== 'timeout')) return;
                const at = now();
                r.finishedAt = at;
                if (frame.result) {
                    r.status = 'done';
                    r.result = structuredClone(frame.result);
                    delete r.error;
                } else {
                    r.status = 'error';
                    r.error = structuredClone(frame.error ?? { code: 'invalid', message: 'env.response carried neither result nor error' });
                    delete r.result;
                }
                const outcome = r.error?.code ?? 'ok';
                const refused = outcome === 'ok' ? '' : ` refused (${outcome})`;
                if (r.op.op === 'put') {
                    const input = r.op.environment;
                    const environmentId = r.result?.environmentId ?? input.id;
                    await recordAudit(ctx, workspaceId, {
                        key: `${ctx.key}:env:${r.requestId}`,
                        kind: 'environment.put',
                        at,
                        by: r.by,
                        summary: `environment ${input.name} on machine ${machineId}${refused || ` set to ${input.cwdRoots.join(', ')}`}`,
                        data: { machineId, ...(environmentId ? { environmentId } : {}), name: input.name, runtime: input.runtime, cwdRoots: [...input.cwdRoots], outcome }
                    });
                    return;
                }
                await recordAudit(ctx, workspaceId, {
                    key: `${ctx.key}:env:${r.requestId}`,
                    kind: 'environment.removed',
                    at,
                    by: r.by,
                    summary: `environment ${r.op.environmentId} on machine ${machineId}${refused || ' removed'}`,
                    data: { machineId, environmentId: r.op.environmentId, outcome }
                });
            }

            /** Send one `env.request` and keep it as pending — the shared half of `putEnvironment` / `removeEnvironment`. */
            async function envRequest(op: EnvOp): Promise<EnvRequested> {
                const s = ctx.state;
                if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                if (!s.online) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" is offline`);
                const at = now();
                const requestId = `env_${crypto.randomUUID()}`;
                if (!send({ v: V, t: 'env.request', requestId, ...op })) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" has no open socket`);
                const requests = (s.envRequests ??= {});
                pruneEnvRequests(requests, at);
                const record: EnvRequestRecord = { requestId, op: structuredClone(op), status: 'pending', requestedAt: at, deadline: at + envTimeoutMs, by: principalLabel(ctx.principal) };
                requests[requestId] = record;
                await armLiveness();
                await ctx.save();
                return { requestId };
            }

            /**
             * The daemon's answer to a `historyRequest` (#397): the record turns `done` or `error` (the daemon's own code —
             * `gap`, `unknown-session`, `internal` — stored unchanged), the events go to the activation's `answers` for the
             * `historyAnswer` stream. An unknown, pruned or already answered id is ignored — except over a `timeout`.
             */
            function onHistoryResponse(frame: DaemonFrameOf<'history.response'>): void {
                const r = ctx.state.history?.[frame.requestId];
                if (!r || r.status === 'done' || (r.status === 'error' && r.error?.code !== 'internal')) return;
                r.finishedAt = now();
                if (frame.result) {
                    r.status = 'done';
                    delete r.error;
                    const events: AgentEvent[] = [];
                    for (const f of frame.result.events) if (f.kind === 'event') events.push(f.event);
                    answers.set(answerKey(ctx.key, r.requestId), { result: { events, ...(frame.result.more ? { more: true } : {}) } });
                } else {
                    r.status = 'error';
                    r.error = structuredClone(frame.error ?? { code: 'internal', message: 'history.response carried neither result nor error' });
                    answers.delete(answerKey(ctx.key, r.requestId));
                }
            }

            /**
             * A harness request's progress (#370): the phase, and on `done` / `failed` the close (`harnessEnded`). Unknown
             * or finished ids are ignored — except a record failed `timeout` / `interrupted`: a late end says what the daemon did.
             */
            async function onHarnessStatus(frame: DaemonFrameOf<'harness.status'>): Promise<void> {
                const r = ctx.state.harnessRequests?.[frame.requestId];
                if (!r || r.status === 'done') return;
                const late = r.status === 'error';
                if (late && r.error?.code !== 'timeout' && r.error?.code !== 'interrupted') return;
                if (frame.phase === 'done') return lifecycle.harnessEnded(r, 'done');
                if (frame.phase === 'failed') return lifecycle.harnessEnded(r, 'failed', frame.error ?? { code: 'io', message: 'the daemon reported the harness change failed' });
                if (!late) r.phase = frame.phase;
            }

            /** Fold an environment's provider limits in (#261): a stream snapshot replaces only the windows it carries. An environment the machine does not report is ignored. */
            function onQuota(frame: DaemonFrameOf<'quota'>): void {
                const s = ctx.state;
                s.lastSeen = now();
                if (!s.environments.some((e) => e.id === frame.environmentId)) return;
                const quota = (s.quota ??= {});
                quota[frame.environmentId] = mergeQuota(quota[frame.environmentId], ctx.snapshot(frame.snapshot) as QuotaSnapshot);
            }

            /**
             * The machine's load as the daemon sampled it (#400): a full snapshot replacing the last, pruned to what this
             * machine hosts. A limit crossed (`telemetryWarnings`: memory only) is told to the Inbox once, and again only
             * after its value cleared (`telemetryWarningCleared`). Nothing here ends a session (#387).
             */
            async function onTelemetry(frame: DaemonFrameOf<'telemetry'>): Promise<void> {
                const s = ctx.state;
                s.lastSeen = now();
                s.telemetry = ctx.snapshot(frame.snapshot) as MachineTelemetry;
                pruneTelemetry(s);
                const t = s.telemetry;
                const warned = (s.telemetryWarned ??= {});
                for (const key of Object.keys(warned)) if (telemetryWarningCleared(key, t)) delete warned[key];
                const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
                for (const w of telemetryWarnings(t)) {
                    const key = telemetryWarningKey(w);
                    if (warned[key] !== undefined) continue;
                    warned[key] = now();
                    if (w.kind === 'machine-memory') {
                        await lifecycle.inbox({
                            kind: 'resource-pressure',
                            title: `${lifecycle.named()} is at ${Math.round(w.value * 100)} % memory`,
                            body: `${gb(t.machine.memoryUsed ?? 0)} of ${gb(t.machine.memoryTotal)} in use; the warning level is ${Math.round(w.limit * 100)} %. Nothing is stopped — see which sessions hold it on the machine's page.`,
                            ref: { kind: 'machine', machineId }
                        });
                    } else {
                        const hosted = Object.hasOwn(s.activeSessions, w.sessionId) ? s.activeSessions[w.sessionId] : undefined;
                        await lifecycle.inbox({
                            kind: 'resource-pressure',
                            title: `A session on ${lifecycle.named()} holds ${gb(w.value)}`,
                            body: `${hosted ? `Agent ${hosted.agentId}'s session` : 'A session'} and what it started hold ${gb(w.value)} resident; the warning level is ${gb(w.limit)}. Nothing is stopped — check what it is running.`,
                            ref: { kind: 'session', sessionId: w.sessionId }
                        });
                    }
                }
                if (Object.keys(warned).length === 0) delete s.telemetryWarned;
            }

            async function handle(frame: DaemonFrame): Promise<void> {
                const s = ctx.state;
                switch (frame.t) {
                    case 'hello':
                        return onHello(frame);
                    case 'env':
                        s.environments = ctx.snapshot(frame.environments) as EnvironmentDescriptor[];
                        // The policy is edited on the machine while the daemon runs; an `env` without one says nothing about it.
                        if (frame.policy) s.policy = ctx.snapshot(frame.policy) as MachinePolicy;
                        pruneQuota(s);
                        pruneTelemetry(s);
                        s.lastSeen = now();
                        dequeue();
                        return;
                    case 'heartbeat':
                        s.lastSeen = now();
                        s.online = true;
                        return;
                    case 'pong':
                        s.lastSeen = now();
                        return;
                    case 'session.opened':
                        return onSessionOpened(frame);
                    case 'session.ref':
                        return onSessionRef(frame);
                    case 'session.title':
                        return onSessionTitle(frame);
                    case 'session.frame':
                        return onSessionFrame(frame);
                    case 'session.reply':
                        return onSessionReply(frame);
                    case 'session.closed':
                        return sessionGone(frame.sessionId, frame.reason, frame.code, true);
                    case 'tool.call':
                        return onToolCall(frame);
                    case 'fs.response':
                        return onFsResponse(frame);
                    case 'env.response':
                        return onEnvResponse(frame);
                    case 'quota':
                        return onQuota(frame);
                    case 'telemetry':
                        return onTelemetry(frame);
                    case 'history.response':
                        return onHistoryResponse(frame);
                    case 'update.status':
                        return lifecycle.onStatus(frame);
                    case 'harness.status':
                        return onHarnessStatus(frame);
                    case 'harnesses':
                        s.harnesses = ctx.snapshot(frame.harnesses) as HarnessReport[];
                        s.lastSeen = now();
                        return;
                }
            }

            return {
                /**
                 * Redeem a pairing code for this machine (USR-04): the Workspace
                 * consumes it over a hop, a token is minted and only its hash kept.
                 * The token is returned once, to the daemon.
                 */
                async pair(code: string, info: PairInfo = {}): Promise<PairedMachine> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (s.tokenHash) throw new ServerFnError(409, `machine "${machineId}" is already paired`);
                    const claimed = await ctx.actor(Workspace, workspaceKey(workspaceId)).claimPairing(code);
                    if (!claimed || claimed.machineId !== machineId) throw new ServerFnError(401, 'pairing code refused');
                    const issued = await issueMachineToken({ workspaceId, machineId });
                    const at = now();
                    s.tokenHash = issued.tokenHash;
                    s.pairedAt = at;
                    if (info.name?.trim()) s.name = info.name.trim();
                    if (info.os) s.os = info.os;
                    if (info.daemonVersion) s.daemonVersion = info.daemonVersion;
                    await ctx.save();
                    // A machine pairs once (409 after): the key needs no counter.
                    await recordAudit(ctx, workspaceId, {
                        key: `${ctx.key}:paired`,
                        kind: 'machine.paired',
                        at,
                        by: principalLabel(ctx.principal),
                        summary: `machine ${machineId}${s.name ? ` (${s.name})` : ''} paired`,
                        data: { machineId, name: s.name, ...(s.os ? { os: s.os } : {}), ...(s.daemonVersion ? { daemonVersion: s.daemonVersion } : {}) }
                    });
                    return { token: issued.token, workspaceId, machineId };
                },

                /** The stored hash and revocation — what `authenticate` and the socket handshake verify a token against. `null` until paired. */
                tokenRecord(): MachineTokenRecord | null {
                    const s = ctx.state;
                    if (!s.tokenHash) return null;
                    return { tokenHash: s.tokenHash, revokedAt: s.revokedAt ?? null };
                },

                /** Refuse the token from now on and drop the daemon (USR-04). */
                async revoke(): Promise<MachineView> {
                    const s = ctx.state;
                    const first = s.revokedAt === undefined || s.revokedAt === null;
                    if (first) s.revokedAt = now();
                    s.online = false;
                    failPendingFs(s, now(), 'machine revoked');
                    failPendingEnv(s, now(), 'machine revoked');
                    failPendingHistory(s, now(), 'machine revoked');
                    ports.socket.close(ctx.key, 1008, 'revoked');
                    await ctx.reminders.clear(LIVENESS);
                    await ctx.save();
                    // Revoking is idempotent; the record says it happened once.
                    if (first) {
                        await recordAudit(ctx, workspaceId, {
                            key: `${ctx.key}:revoked`,
                            kind: 'machine.revoked',
                            at: s.revokedAt!,
                            by: principalLabel(ctx.principal),
                            summary: `machine ${machineId}${s.name ? ` (${s.name})` : ''} revoked`,
                            data: { machineId, name: s.name }
                        });
                    }
                    return view(ctx);
                },

                async rename(name: string): Promise<MachineView> {
                    if (!name.trim()) throw new ServerFnError(400, 'machine: name is required');
                    ctx.state.name = name.trim();
                    await ctx.save();
                    return view(ctx);
                },

                get(): MachineView {
                    return view(ctx);
                },

                /**
                 * The daemon's per-environment `doctor` verdicts (isolation, auth — EXE-05/07) as last reported.
                 * Stored, never recomputed here: the platform cannot see a machine's config dirs. With
                 * `environmentId`, that environment only (404 when the machine does not report it).
                 */
                doctor(environmentId?: EnvironmentId): MachineDoctorView {
                    const s = ctx.state;
                    const envs = environmentId === undefined ? s.environments : s.environments.filter((e) => e.id === environmentId);
                    if (environmentId !== undefined && envs.length === 0) throw new ServerFnError(404, `machine "${machineId}" has no environment "${environmentId}"`);
                    const environments: EnvironmentDoctorView[] = envs.map((e) => ({
                        environmentId: e.id,
                        name: e.name,
                        runtime: e.runtime,
                        account: e.account,
                        isolation: e.isolation,
                        ...(e.doctor === undefined ? {} : { verdict: e.doctor })
                    }));
                    const unverified = environments.filter((e) => e.verdict === undefined).map((e) => e.environmentId);
                    return {
                        machineId,
                        online: s.online,
                        ...(s.lastSeen !== undefined ? { lastSeen: s.lastSeen } : {}),
                        ok: unverified.length === 0 && environments.every((e) => e.verdict?.ok === true),
                        unverified,
                        environments
                    };
                },

                /**
                 * Each environment's provider limits as last reported (#261), under the `machines` reader rule. With
                 * `environmentId`, that environment only (404 when the machine does not report it).
                 */
                quota(environmentId?: EnvironmentId): MachineQuotaView {
                    const s = ctx.state;
                    const envs = environmentId === undefined ? s.environments : s.environments.filter((e) => e.id === environmentId);
                    if (environmentId !== undefined && envs.length === 0) throw new ServerFnError(404, `machine "${machineId}" has no environment "${environmentId}"`);
                    return {
                        machineId,
                        name: s.name,
                        online: s.online,
                        ...(s.lastSeen !== undefined ? { lastSeen: s.lastSeen } : {}),
                        environments: envs.map((e) => ({ environmentId: e.id, name: e.name, runtime: e.runtime, account: e.account, snapshot: s.quota?.[e.id] ?? null }))
                    };
                },

                /** The daemon says it is alive (also folded from the `heartbeat` frame). A revoked machine is refused: `online` never flips back (#172). */
                async heartbeat(active: readonly SessionId[] = []): Promise<void> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    s.lastSeen = now();
                    s.online = true;
                    void active;
                    await armLiveness();
                    await ctx.save();
                },

                /**
                 * One WebSocket text message from the daemon. Malformed input is
                 * counted and dropped — the socket stays (§5b envelope contract).
                 */
                async socketMessage(raw: string): Promise<SocketMessageResult> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) {
                        ports.socket.close(ctx.key, 1008, 'revoked');
                        return { ok: false, code: 'revoked', message: 'the machine is revoked' };
                    }
                    const decoded = decodeDaemonFrame(raw);
                    if (!decoded.ok) {
                        s.rejected++;
                        await ctx.save();
                        return { ok: false, code: decoded.error.code, message: decoded.error.message };
                    }
                    await handle(decoded.frame);
                    await ctx.save();
                    return { ok: true, t: decoded.frame.t };
                },

                /**
                 * The daemon socket closed or failed: offline at once, before any heartbeat window (acceptance). The router
                 * hears it (#366): the turns running here wait `machine-offline` for the daemon to come back.
                 */
                async socketClosed(): Promise<void> {
                    const s = ctx.state;
                    const was = s.online;
                    s.online = false;
                    // No socket, no answer: a folder request never outlives the connection it was sent on.
                    failPendingFs(s, now(), 'machine went offline');
                    failPendingEnv(s, now(), 'machine went offline');
                    failPendingHistory(s, now(), 'machine went offline');
                    await armLiveness();
                    await ctx.save();
                    if (was) await notify((r) => r.machineOffline(machineId));
                },

                /**
                 * Host `sessionId` in `environmentId`: `session.open` goes out when
                 * the environment has a free slot — `concurrency.max` minus the
                 * sessions running a turn (#394), never minus the sessions merely
                 * open — otherwise the request queues until a turn ends there or a
                 * running session closes (EXE-09). Idempotent by session id.
                 */
                async openSession(sessionId: SessionId, environmentId: EnvironmentId, spec: OpenSpec, options: OpenSessionOptions = {}): Promise<OpenSessionResult> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (sessionId in s.activeSessions) return 'opened';
                    if (s.queued.some((q) => q.sessionId === sessionId)) return 'queued';
                    if (!s.environments.some((e) => e.id === environmentId)) throw new ServerFnError(404, `machine "${machineId}" has no environment "${environmentId}"`);
                    if (!s.online) throw new ServerFnError(503, `machine "${machineId}" is offline`);
                    const at = now();
                    const base = { sessionId, environmentId, agentId: spec.agentId, ...(options.taskId ? { taskId: options.taskId } : {}), spec: structuredClone(spec) };
                    // A drain holds back turns, not opens (#365): `openRoom` is `freeSlots` without it.
                    if (openRoom(s, environmentId) > 0) {
                        const hosted: HostedSession = { ...base, status: 'opening', requestedAt: at };
                        s.activeSessions[sessionId] = hosted;
                        send(openFrame(hosted));
                        await ctx.save();
                        return 'opened';
                    }
                    s.queued.push({ ...base, queuedAt: at });
                    await ctx.save();
                    return 'queued';
                },

                /**
                 * Tell the daemon to close the session (or drop it from the queue). The daemon's `session.closed` frees the slot.
                 * With the daemon offline nobody would answer (#366: the router lets go of a machine-lost task's session): the
                 * session is forgotten here, its record told the host ended (`hostEnded`) — a running turn interrupted, the
                 * record left `idle` with its ref for a re-open once the machine is back.
                 */
                async closeSession(sessionId: SessionId): Promise<void> {
                    const s = ctx.state;
                    if (sessionId in s.activeSessions) {
                        if (s.online) send({ v: V, t: 'session.close', sessionId });
                        else await sessionGone(sessionId, `machine ${machineId} is offline; the session was let go`);
                    } else if (s.queued.some((q) => q.sessionId === sessionId)) await sessionGone(sessionId, 'closed while queued');
                    await ctx.save();
                },

                /**
                 * The `CommandSink` end: record the command as pending with a
                 * deadline, send it now if the daemon is connected — otherwise
                 * the next `hello` re-sends it (replies are idempotent by
                 * `commandId`). The Session is told `closed` at once for a
                 * session this machine does not host.
                 */
                async sendCommand(sessionId: SessionId, command: WireCommand): Promise<void> {
                    const s = ctx.state;
                    const hosted = sessionId in s.activeSessions;
                    const queued = s.queued.some((q) => q.sessionId === sessionId);
                    if (!hosted && !queued) {
                        await replied(sessionId, errorReply(command.commandId, 'closed', `session ${sessionId} is not hosted by machine ${machineId}`), { oneWay: true });
                        return;
                    }
                    const key = pendingKey(sessionId, command.commandId);
                    if (key in s.pending) return;
                    const at = now();
                    s.pending[key] = { sessionId, command: structuredClone(command), sentAt: at, deadline: at + commandTimeoutMs };
                    if (hosted && s.online) send({ v: V, t: 'session.command', sessionId, command });
                    await armLiveness();
                    await ctx.save();
                },

                /**
                 * Ask the daemon to list a folder or add a git worktree in
                 * `environmentId` (#189): `fs.request` goes out and the answer
                 * lands in state when its `fs.response` arrives, in a later
                 * `socketMessage` turn — read it with `fsResult(requestId)`
                 * (live). `list` is open to session drivers; `worktree`
                 * changes the machine, so only its owner asks for one. 400 for
                 * a malformed op, 403 revoked, 404 unknown environment, 503
                 * offline (or no socket to send on).
                 */
                async fsRequest(environmentId: EnvironmentId, op: FsOp): Promise<FsRequested> {
                    const parsed = fsOpSchema.safeParse(op);
                    if (!parsed.success) throw new ServerFnError(400, `machine: invalid fs op: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
                    if ((parsed.data.kind === 'worktree' || parsed.data.kind === 'locate') && (ctx.principal as Principal | null)?.kind !== 'user') {
                        throw new ServerFnError(403, `machine: only the owner may ${parsed.data.kind === 'worktree' ? 'create a worktree' : 'locate checkouts'}`);
                    }
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (!s.environments.some((e) => e.id === environmentId)) throw new ServerFnError(404, `machine "${machineId}" has no environment "${environmentId}"`);
                    if (!s.online) throw new ServerFnError(503, `machine "${machineId}" is offline`);
                    const at = now();
                    const requestId = `fs_${crypto.randomUUID()}`;
                    if (!send({ v: V, t: 'fs.request', requestId, environmentId, op: parsed.data })) throw new ServerFnError(503, `machine "${machineId}" has no open socket`);
                    const fs = (s.fs ??= {});
                    pruneFs(fs, at);
                    const record: FsRequestRecord = { requestId, environmentId, op: structuredClone(parsed.data), status: 'pending', requestedAt: at, deadline: at + fsTimeoutMs, by: principalLabel(ctx.principal) };
                    fs[requestId] = record;
                    await armLiveness();
                    await ctx.save();
                    return { requestId };
                },

                /** One `fsRequest` as stored — a primitive argument, so `useActorState(Machine, () => [k, 'fsResult', id], { live: true })` can key on it. 404 for an unknown, evicted or pruned id. */
                fsResult(requestId: string): FsResultView {
                    const r = ctx.state.fs?.[requestId];
                    if (!r) throw new ServerFnError(404, `machine "${machineId}" has no fs request "${requestId}"`);
                    return ctx.snapshot({
                        requestId: r.requestId,
                        environmentId: r.environmentId,
                        op: r.op,
                        status: r.status,
                        requestedAt: r.requestedAt,
                        ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
                        ...(r.result ? { result: r.result } : {}),
                        ...(r.error ? { error: r.error } : {})
                    }) as FsResultView;
                },

                /**
                 * Ask the daemon to create an environment, or change the one
                 * `input.id` names (#237): `env.request` goes out and the
                 * answer lands in state with its `env.response` — read it with
                 * `envResult(requestId)` (live), as `fsRequest` / `fsResult`
                 * do. OWNER ONLY, and on no tool surface: the daemon's
                 * machine-local policy decides, and its refusal
                 * (`policy-disabled`, `outside-allowed-roots`, …) comes back
                 * unchanged. No profile directory is accepted — the schema is
                 * strict. 400 for a malformed input, 403 revoked, 503
                 * `machine-offline`.
                 */
                async putEnvironment(input: EnvironmentInput): Promise<EnvRequested> {
                    const parsed = environmentInputSchema.safeParse(input);
                    if (!parsed.success) throw new ServerFnError(400, `machine: invalid environment: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
                    return envRequest({ op: 'put', environment: parsed.data });
                },

                /**
                 * Ask the daemon to forget an environment; its profile
                 * directory stays on the machine. In `fsRequest`'s order: 403
                 * revoked, 404 when the machine does not report it, 503
                 * `machine-offline`, then 409 `in-use` while a turn runs there
                 * or a session is queued for it — naming them (#394). An idle
                 * hosted session does not block it: a chat member's session
                 * lives for the chat's life, so it is closed here first
                 * (`session.close`, ahead of the `env.request` on the same
                 * socket — the daemon refuses removal while it hosts any) and
                 * its chat re-opens a fresh one wherever the member runs next
                 * (EXE-12).
                 */
                async removeEnvironment(environmentId: EnvironmentId): Promise<EnvRequested> {
                    const s = ctx.state;
                    // The order of `fsRequest`: revoked before anything the machine last reported.
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (!s.environments.some((e) => e.id === environmentId)) throw new ServerFnError(404, `machine "${machineId}" has no environment "${environmentId}"`);
                    if (!s.online) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" is offline`);
                    const promptOut = (sessionId: SessionId): string | undefined => {
                        for (const p of Object.values(s.pending)) if (p.sessionId === sessionId && p.command.type === 'prompt') return p.command.turnId;
                        return undefined;
                    };
                    const running = runningIn(s, environmentId).map((h) => `session ${h.sessionId} (agent ${h.agentId}, turn ${h.running?.turnId ?? promptOut(h.sessionId) ?? '?'})`);
                    const queued = s.queued.filter((q) => q.environmentId === environmentId).map((q) => `session ${q.sessionId} (agent ${q.agentId}${q.taskId ? `, task ${q.taskId}` : ''})`);
                    if (running.length || queued.length) {
                        const what = [...(running.length ? [`running: ${running.join(', ')}`] : []), ...(queued.length ? [`queued: ${queued.join(', ')}`] : [])].join('; ');
                        throw new ServerFnError(409, `in-use: environment "${environmentId}" on machine "${machineId}" has work in it — ${what}`);
                    }
                    for (const h of hostedIn(s, environmentId)) send({ v: V, t: 'session.close', sessionId: h.sessionId });
                    return envRequest({ op: 'remove', environmentId });
                },

                /** One environment request as stored — a primitive argument, so a live read can key on it. 404 for an unknown, evicted or pruned id. */
                envResult(requestId: string): EnvResultView {
                    const r = ctx.state.envRequests?.[requestId];
                    if (!r) throw new ServerFnError(404, `machine "${machineId}" has no environment request "${requestId}"`);
                    return ctx.snapshot({
                        requestId: r.requestId,
                        op: r.op,
                        status: r.status,
                        requestedAt: r.requestedAt,
                        ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
                        ...(r.result ? { result: r.result } : {}),
                        ...(r.error ? { error: r.error } : {})
                    }) as EnvResultView;
                },

                /**
                 * Ask the daemon for a session's events in a cursor range (#397), from its own log — what the Session
                 * reads when the range is older than the pages it kept: `history.request` goes out and the answer lands
                 * with its `history.response` in a later `socketMessage` turn; `historyAnswer(requestId)` yields it, and
                 * `historyResult(requestId)` shows the status. The session need not be hosted here any more: the log
                 * outlives the runtime session. 403 revoked, 503 offline (or no socket to send on).
                 */
                async historyRequest(sessionId: SessionId, range: HistoryRange): Promise<HistoryRequested> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (!s.online) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" is offline`);
                    const at = now();
                    const requestId = `history_${crypto.randomUUID()}`;
                    if (!send({ v: V, t: 'history.request', requestId, sessionId, ...range })) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" has no open socket`);
                    const requests = (s.history ??= {});
                    pruneHistory(requests, at);
                    // An answer whose record was just pruned is nobody's any more.
                    for (const key of answers.keys()) if (key.startsWith(`${ctx.key}:`) && !(key.slice(ctx.key.length + 1) in requests)) answers.delete(key);
                    const record: HistoryRequestRecord = { requestId, sessionId, range: structuredClone(range), status: 'pending', requestedAt: at, deadline: at + historyTimeoutMs };
                    requests[requestId] = record;
                    await armLiveness();
                    await ctx.save();
                    return { requestId };
                },

                /** One history request as stored — its status and the daemon's error, never the events. 404 for an unknown, evicted or pruned id. */
                historyResult(requestId: string): HistoryResultView {
                    const r = ctx.state.history?.[requestId];
                    if (!r) throw new ServerFnError(404, `machine "${machineId}" has no history request "${requestId}"`);
                    return ctx.snapshot({
                        requestId: r.requestId,
                        sessionId: r.sessionId,
                        range: r.range,
                        status: r.status,
                        requestedAt: r.requestedAt,
                        ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
                        ...(r.error ? { error: r.error } : {})
                    }) as HistoryResultView;
                },

                /**
                 * Ask the daemon to update itself (#365): `update.request` goes out with the asset for the build's
                 * platform, the update is pending and the machine drains — no new turn starts until the next `hello`
                 * judges it (the version asked for → `machine.updated`), a `failed` phase, `cancelUpdate` or its
                 * deadline. OWNER ONLY, on no tool surface. 403 revoked, 503 offline or no release directory, 409 an
                 * update pending or a daemon that cannot update itself ("reinstall once"), 400 an unknown version, a
                 * release without a build for the platform, or the version the daemon already runs.
                 */
                async requestUpdate(input: UpdateRequestInput = {}): Promise<{ requestId: string }> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (!s.online) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" is offline`);
                    if (s.update?.pending) throw new ServerFnError(409, `machine "${machineId}" has an update pending (${s.update.pending.requestId})`);
                    const harness = Object.values(s.harnessRequests ?? {}).find((r) => r.status === 'pending');
                    if (harness) throw new ServerFnError(409, `machine "${machineId}" is changing its ${harness.runtime} harness (${harness.requestId})`);
                    if (!s.build || !s.features?.includes('update')) throw new ServerFnError(409, `machine "${machineId}" runs a daemon that cannot update itself: reinstall once`);
                    const mode = input.mode ?? 'drain';
                    if (mode !== 'drain' && mode !== 'now') throw new ServerFnError(400, 'machine: mode must be "drain" or "now"');
                    const drainTimeoutMs = input.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
                    if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 0 || drainTimeoutMs > MAX_DRAIN_TIMEOUT_MS) throw new ServerFnError(400, `machine: drainTimeoutMs must be a whole number of ms up to ${MAX_DRAIN_TIMEOUT_MS}`);
                    let target: ReleaseAsset | 'previous' = 'previous';
                    let to = 'previous';
                    if (input.target !== 'previous') {
                        const dir = await lifecycle.directory();
                        if (!dir) throw new ServerFnError(503, `machine: no release directory to update "${machineId}" from`);
                        const { channel } = effectiveUpdates(s.update);
                        const version = input.target ?? dir.channels[channel]?.version;
                        const manifest = [dir.channels[channel], dir.channels[channel === 'stable' ? 'latest' : 'stable']].find((m) => m !== undefined && m.version === version);
                        if (!manifest) throw new ServerFnError(400, `machine: no release ${version ?? `on the ${channel} channel`} is known`);
                        const asset = manifest.assets[s.build.platform];
                        if (!asset) throw new ServerFnError(400, `machine: release ${manifest.version} has no build for ${s.build.platform}`);
                        if (manifest.version === s.build.version) throw new ServerFnError(400, `machine "${machineId}" already runs ${manifest.version}`);
                        target = structuredClone(asset);
                        to = manifest.version;
                    }
                    const requestId = await lifecycle.request(target, to, mode, drainTimeoutMs, principalLabel(ctx.principal));
                    await armLiveness();
                    await ctx.save();
                    return { requestId };
                },

                /** Take back the pending update (#365): `update.cancel` goes out, the drain ends. `false` when nothing is pending. */
                async cancelUpdate(): Promise<boolean> {
                    const p = ctx.state.update?.pending;
                    if (!p) return false;
                    send({ v: V, t: 'update.cancel', requestId: p.requestId });
                    await lifecycle.close('cancelled', `cancelled by ${principalLabel(ctx.principal)}`);
                    await armLiveness();
                    await ctx.save();
                    return true;
                },

                /** When this machine takes updates (#365); `null` follows the workspace's default again. The policy runs at once. */
                async setUpdatePolicy(policy: UpdatePolicy | null): Promise<MachineUpdateView> {
                    const u = (ctx.state.update ??= {});
                    if (policy === null) delete u.policy;
                    else {
                        try {
                            u.policy = checkUpdatePolicy(policy);
                        } catch (e) {
                            throw new ServerFnError(400, `machine: ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                    await recordAudit(ctx, workspaceId, { key: `${ctx.key}:update-policy:${crypto.randomUUID()}`, kind: 'machine.update-policy-set', at: now(), by: principalLabel(ctx.principal), summary: `machine ${ctx.state.name || machineId} takes updates ${u.policy ? u.policy.kind : 'as the workspace says'}`, data: { machineId, policy: u.policy ? ctx.snapshot(u.policy) : null } });
                    await lifecycle.autoUpdate();
                    await armLiveness();
                    await ctx.save();
                    return updateView(ctx);
                },

                /** The release channel this machine follows (#365); `null` follows the workspace's default again. `available` is compared again. */
                async setChannel(channel: ReleaseChannel | null): Promise<MachineUpdateView> {
                    const u = (ctx.state.update ??= {});
                    if (channel === null) delete u.channel;
                    else {
                        try {
                            u.channel = checkChannel(channel);
                        } catch (e) {
                            throw new ServerFnError(400, `machine: ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                    await recordAudit(ctx, workspaceId, { key: `${ctx.key}:channel:${crypto.randomUUID()}`, kind: 'machine.channel-set', at: now(), by: principalLabel(ctx.principal), summary: `machine ${ctx.state.name || machineId} follows ${u.channel ?? 'the workspace channel'}`, data: { machineId, channel: u.channel ?? null } });
                    if (ports.releases) {
                        await lifecycle.readDefaults();
                        await lifecycle.compare(await lifecycle.directory());
                    }
                    await ctx.save();
                    return updateView(ctx);
                },

                /** The machine's update record (#365) — a live read for the Machines page: channel, policy, what is available, pending and last, and what an update now would interrupt. */
                updateState(): MachineUpdateView {
                    return updateView(ctx);
                },

                /**
                 * Check for updates now (#468): the release directory reads the manifests unless it did within
                 * `RELEASE_CHECK_MIN_MS`, and the machine compares at once — the page's open and its "Check for updates",
                 * instead of waiting for the hourly read and the 15-minute compare. Returns the update record.
                 */
                async checkUpdates(): Promise<MachineUpdateView> {
                    if (ports.releases) {
                        await lifecycle.readDefaults();
                        await lifecycle.compare(await lifecycle.directory(true));
                        await ctx.save();
                    }
                    return updateView(ctx);
                },

                /**
                 * Install, update or remove a runtime's harness on the machine (#370): `harness.request` goes out with the
                 * build the release ships for the machine's platform, and while it is pending the machine drains that
                 * runtime only — `freeSlots` is 0 in its environments, a session on another runtime still runs. The
                 * daemon's `harness.status` frames move it (`harnessResult`, live); `done` / `failed` end it and the drain,
                 * audited as `harness.changed`. OWNER ONLY, on no tool surface. 400 a malformed input, an unknown version,
                 * a release without a build for the platform, or the version already installed; 403 revoked; 503 offline
                 * or no release directory; 409 a daemon without the `harness` feature ("reinstall once"), a harness request
                 * or a daemon update pending, `update` of a harness not installed, and `remove` `in-use` while an
                 * environment runs on the runtime (the daemon checks too) or `not-installed`.
                 */
                async requestHarness(input: HarnessRequestInput): Promise<HarnessRequested> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    const op = input?.op;
                    if (op !== 'install' && op !== 'update' && op !== 'remove') throw new ServerFnError(400, 'machine: op must be "install", "update" or "remove"');
                    const runtime = (typeof input.runtime === 'string' ? input.runtime.trim() : '') as RuntimeId;
                    if (!runtime) throw new ServerFnError(400, 'machine: a runtime is required');
                    const mode = input.mode ?? 'drain';
                    if (mode !== 'drain' && mode !== 'now') throw new ServerFnError(400, 'machine: mode must be "drain" or "now"');
                    const asked = typeof input.version === 'string' ? input.version.trim() : input.version;
                    if (asked !== undefined && (typeof asked !== 'string' || !asked)) throw new ServerFnError(400, 'machine: version must be a non-empty string');
                    if (!s.online) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" is offline`);
                    if (!s.build || !s.features?.includes('harness')) throw new ServerFnError(409, `machine "${machineId}" runs a daemon that cannot manage harnesses: reinstall once`);
                    // One at a time: the daemon runs them in order, and the machine holds one drain.
                    const running = Object.values(s.harnessRequests ?? {}).find((r) => r.status === 'pending');
                    if (running) throw new ServerFnError(409, `machine "${machineId}" is already changing ${running.runtime === runtime ? 'this' : `its ${running.runtime}`} harness (${running.requestId})`);
                    if (s.update?.pending) throw new ServerFnError(409, `machine "${machineId}" has a daemon update pending (${s.update.pending.requestId})`);
                    const report = s.harnesses?.find((h) => h.runtime === runtime);
                    const from = report?.installed?.version;
                    let target: ReleaseAsset | undefined;
                    let to: string | undefined;
                    if (op === 'remove') {
                        const users = s.environments.filter((e) => e.runtime === runtime);
                        if (users.length) throw new ServerFnError(409, `in-use: environment${users.length === 1 ? '' : 's'} ${users.map((e) => e.name).join(', ')} on machine "${machineId}" run${users.length === 1 ? 's' : ''} on ${runtime}; remove ${users.length === 1 ? 'it' : 'them'} first`);
                        if (from === undefined && report?.status !== 'broken') throw new ServerFnError(409, `not-installed: machine "${machineId}" has no ${runtime} harness installed`);
                    } else {
                        if (op === 'update' && from === undefined) throw new ServerFnError(409, `not-installed: machine "${machineId}" has no ${runtime} harness to update; install it`);
                        const dir = await lifecycle.directory();
                        if (!dir) throw new ServerFnError(503, `machine: no release directory to install the ${runtime} harness from`);
                        const { channel } = effectiveUpdates(s.update);
                        const version = asked ?? dir.channels[channel]?.harnesses?.[runtime]?.version;
                        const shipped = [dir.channels[channel], dir.channels[channel === 'stable' ? 'latest' : 'stable']].map((m) => m?.harnesses?.[runtime]).find((h) => h !== undefined && h.version === version);
                        if (!shipped) throw new ServerFnError(400, `machine: no release ships ${runtime}${version ? ` ${version}` : ` on the ${channel} channel`}`);
                        const asset = shipped.assets[s.build.platform];
                        if (!asset) throw new ServerFnError(400, `machine: ${runtime} ${shipped.version} has no build for ${s.build.platform}`);
                        if (from === shipped.version && report?.status === 'ready') throw new ServerFnError(400, `machine "${machineId}" already has ${runtime} ${shipped.version}`);
                        target = structuredClone(asset);
                        to = shipped.version;
                    }
                    const at = now();
                    const requestId = `harness_${crypto.randomUUID()}`;
                    if (!send({ v: V, t: 'harness.request', requestId, op, runtime, ...(target ? { target } : {}), mode })) throw new ServerFnError(503, `${MACHINE_OFFLINE_CODE}: machine "${machineId}" has no open socket`);
                    const requests = (s.harnessRequests ??= {});
                    pruneHarnessRequests(requests, at);
                    requests[requestId] = { requestId, op, runtime, mode, status: 'pending', requestedAt: at, deadline: at + HARNESS_DEADLINE_MS, by: principalLabel(ctx.principal), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
                    // Only this runtime drains: its prompts park on capacity, every other runtime keeps running.
                    s.draining = { requestId, since: at, runtime };
                    await armLiveness();
                    await ctx.save();
                    return { requestId };
                },

                /** One harness request as stored (#370) — a primitive argument, so a live read can key on it. 404 for an unknown, evicted or pruned id. */
                harnessResult(requestId: string): HarnessResultView {
                    const r = ctx.state.harnessRequests?.[requestId];
                    if (!r) throw new ServerFnError(404, `machine "${machineId}" has no harness request "${requestId}"`);
                    return ctx.snapshot(harnessResultOf(r)) as HarnessResultView;
                }
            };
        },
        streams: (ctx) => ({
            /**
             * The answer to `historyRequest(requestId)` (#397), yielded once — when the daemon's `history.response` has
             * landed, or the request failed (its deadline, a disconnect, a revoke): the events, or the daemon's named
             * error. An id this record does not hold, or an answer this activation no longer has, is an `internal` error
             * the caller answers by asking again.
             */
            async *historyAnswer(requestId: string): AsyncIterable<HistoryAnswer> {
                for await (const s of ctx.changes({ initial: true, throttleMs: 20 })) {
                    const r = s.history?.[requestId];
                    if (!r) {
                        yield { error: { code: 'internal', message: `machine has no history request "${requestId}"` } };
                        return;
                    }
                    if (r.status === 'pending') continue;
                    if (r.status === 'error') {
                        yield { error: r.error ?? { code: 'internal', message: 'the history request failed' } };
                        return;
                    }
                    yield answers.get(answerKey(ctx.key, requestId)) ?? { error: { code: 'internal', message: `the answer to history request "${requestId}" did not survive the machine's activation; ask again` } };
                    return;
                }
            }
        }),
        /** The liveness reminder: a silent daemon goes offline, an unanswered command answers `internal`, an unanswered folder or environment request fails `timeout`, and finished ones past their TTL are pruned. */
        onReminder: async (ctx, name) => {
            if (name !== LIVENESS) return;
            const s = ctx.state;
            const at = now();
            const ids = parseMachineKey(ctx.key);
            // A silent daemon past the heartbeat window is offline, and the router hears it (#366) as it does a closed socket.
            const silent = s.online && (s.lastSeen ?? 0) + heartbeatWindowMs <= at;
            if (silent) s.online = false;
            const routing = ports.routing?.();
            if (silent && routing && ids) {
                const client = actor(routing, routingKey(ids.workspaceId)).with({ context: asPrincipal(machinePrincipal(ids.workspaceId, ids.machineId)), oneWay: true }) as unknown as RoutingClient;
                await client.machineOffline(ids.machineId).catch(() => undefined);
            }
            const def = ports.sessions?.();
            for (const [key, p] of Object.entries(s.pending)) {
                if (p.deadline > at) continue;
                delete s.pending[key];
                if (def && ids) {
                    const client = actor(def, actorKey(ids.workspaceId, 'session', p.sessionId)).with({ context: asPrincipal(machinePrincipal(ids.workspaceId, ids.machineId)) }) as unknown as SessionClient;
                    await client.commandReplied({ v: W, kind: 'error', commandId: p.command.commandId, code: 'internal', message: `no reply from machine ${ids.machineId} within ${commandTimeoutMs} ms` });
                }
            }
            if (s.fs) {
                for (const r of Object.values(s.fs)) {
                    if (r.status !== 'pending' || r.deadline > at) continue;
                    r.status = 'error';
                    r.error = { code: 'timeout', message: `no answer from machine ${ids?.machineId ?? ctx.key} within ${fsTimeoutMs} ms` };
                    r.finishedAt = at;
                }
                pruneFs(s.fs, at, false);
            }
            if (s.envRequests) {
                for (const r of Object.values(s.envRequests)) {
                    if (r.status !== 'pending' || r.deadline > at) continue;
                    r.status = 'error';
                    r.error = { code: 'timeout', message: `no answer from machine ${ids?.machineId ?? ctx.key} within ${envTimeoutMs} ms` };
                    r.finishedAt = at;
                }
                pruneEnvRequests(s.envRequests, at, false);
            }
            if (s.history) {
                for (const r of Object.values(s.history)) {
                    if (r.status !== 'pending' || r.deadline > at) continue;
                    r.status = 'error';
                    r.error = { code: 'internal', message: `no answer from machine ${ids?.machineId ?? ctx.key} within ${historyTimeoutMs} ms` };
                    r.finishedAt = at;
                }
                pruneHistory(s.history, at, false);
                for (const key of answers.keys()) if (key.startsWith(`${ctx.key}:`) && !(key.slice(ctx.key.length + 1) in s.history)) answers.delete(key);
            }
            const lifecycle = ids ? updates(ctx) : undefined;
            if (s.harnessRequests) {
                // A harness request past its deadline fails `timeout` and its drain ends (#370).
                for (const r of Object.values(s.harnessRequests)) {
                    if (r.status !== 'pending' || r.deadline > at) continue;
                    await lifecycle?.harnessEnded(r, 'timeout', { code: 'timeout', message: `no end from machine ${ids?.machineId ?? ctx.key} within ${Math.round(HARNESS_DEADLINE_MS / 60_000)} minutes` });
                }
                pruneHarnessRequests(s.harnessRequests, at, false);
            }
            // Daemon updates (#365): a pending one past its deadline fails, the build is compared again, the policy runs.
            await lifecycle?.tick();
            if (needsLiveness(s)) await ctx.reminders.set(LIVENESS, { due: livenessDue });
            await ctx.save();
        }
    });
}

export type MachineActor = ReturnType<typeof defineMachineActor>;
