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

import { actorKey, hasScope, mergeQuota, type AgentId, type CapabilityReport, type EnvError, type EnvOp, type EnvResult, type EnvironmentDescriptor, type EnvironmentId, type EnvironmentInput, type EnvironmentVerdict, type FsError, type FsOp, type FsResult, type HistoryError, type HistoryRange, type IsolationMechanism, type MachineId, type MachinePolicy, type OpenSpec, type Principal, type QuotaSnapshot, type RuntimeId, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION, decodeDaemonFrame, encodeFrame, environmentInput as environmentInputSchema, fsOp as fsOpSchema, type DaemonFrame, type DaemonFrameOf, type PlatformFrame } from '@agentic/daemon-protocol';
import { actor, defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { capabilities as agentCapabilities, type AgentCapabilities, type AgentEvent, type SessionRef } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { isServerFnError, ServerFnError } from '@sigx/server';

import { principalLabel } from '../agent/index.js';
import { recordAudit } from '../audit/port.js';
import { asPrincipal, issueMachineToken, machinePrincipal, mintAgentPrincipal, sameWorkspace, workspaceKey, type MachineTokenRecord } from '../auth/index.js';
import { routingKey } from '../routing/key.js';
import { Workspace } from '../workspace/index.js';
import type { MachinePorts } from './ports.js';
import { ToolCallError } from './ports.js';
import type { HistoryAnswer } from '../session/ports.js';
import { advances, freeSlots, hostedIn, initialMachineState, MAX_CLOSURES, parseMachineKey, pruneEnvRequests, pruneFs, pruneHistory, pruneQuota, runningIn, type EnvRequestRecord, type FsRequestRecord, type HistoryRequestRecord, type HostedSession, type MachineOs, type MachineState, type PendingCommand, type QueuedSession, type SessionClosure } from './state.js';

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

/** Whether the liveness reminder has anything to watch: a connected daemon, an unanswered command, folder, environment or history request. */
function needsLiveness(s: MachineState): boolean {
    const pending = (r: { status: string }) => r.status === 'pending';
    return s.online || Object.keys(s.pending).length > 0 || Object.values(s.fs ?? {}).some(pending) || Object.values(s.envRequests ?? {}).some(pending) || Object.values(s.history ?? {}).some(pending);
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
    readonly activeSessions: readonly HostedSession[];
    readonly queued: readonly QueuedSession[];
    readonly pending: readonly PendingCommand[];
    readonly closures: readonly SessionClosure[];
    readonly rejected: number;
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
        fork: has('fork'),
        config: has('configure', 'config'),
        structuredOutput: has('structured-output', 'structuredOutput'),
        listSessions: has('list-sessions', 'listSessions')
    });
}

interface SessionClient {
    forwardFrames(frames: readonly WireFrame[]): Promise<void>;
    commandReplied(reply: WireReply): Promise<void>;
    noteRef(ref: SessionRef): Promise<void>;
    hostEnded(ended: { readonly reason: string; readonly code?: string }): Promise<void>;
}

/** The Routing actor's machine-facing entry points (`defineRoutingActor`). */
interface RoutingClient {
    machineOnline(machineId: MachineId): Promise<void>;
    sessionOpened(sessionId: SessionId, taskId?: TaskId): Promise<void>;
    sessionClosed(sessionId: SessionId, reason: string, taskId?: TaskId): Promise<void>;
    /** A turn ended in the environment, or a session running one closed (#394): a slot is free for a route parked `waiting-capacity` there. */
    slotFreed(machineId: MachineId, environmentId: EnvironmentId, why: string): Promise<void>;
    /** The daemon answered a prompt with an error (#394): `busy` parks the route on capacity, anything else fails its task. */
    promptRefused(sessionId: SessionId, turnId: string, code: string, message: string): Promise<void>;
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
            activeSessions: Object.values(rest.activeSessions),
            queued: rest.queued,
            pending: Object.values(rest.pending),
            closures: rest.closures,
            rejected: rest.rejected
        };
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
            historyResult: sessionDriver
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
            async function notify(call: (routing: RoutingClient) => Promise<void>): Promise<void> {
                const def = ports.routing?.();
                if (!def) return;
                const client = actor(def, routingKey(workspaceId)).with({ context: asPrincipal(self), oneWay: true }) as unknown as RoutingClient;
                await call(client).catch(() => undefined);
            }

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
            function dequeue(): void {
                const s = ctx.state;
                if (!s.online) return;
                const keep: QueuedSession[] = [];
                for (const q of s.queued) {
                    if (freeSlots(s, q.environmentId) > 0) {
                        const hosted: HostedSession = { sessionId: q.sessionId, environmentId: q.environmentId, agentId: q.agentId, ...(q.taskId ? { taskId: q.taskId } : {}), spec: q.spec, status: 'opening', requestedAt: now() };
                        s.activeSessions[q.sessionId] = hosted;
                        send(openFrame(hosted));
                    } else keep.push(q);
                }
                s.queued = keep;
            }

            /**
             * Forget a hosted or queued session; answer its open commands with `closed`. A session the daemon had opened is
             * handed to its record first (#420, `Session.hostEnded`): a turn still running there is interrupted — never left
             * `running` for a session nobody hosts — and the record waits `idle` for a re-open. Before the router hears it.
             */
            async function sessionGone(sessionId: SessionId, reason: string): Promise<void> {
                const s = ctx.state;
                const hosted = s.activeSessions[sessionId];
                const wasHosted = hosted !== undefined;
                const taskId = hosted?.taskId ?? s.queued.find((q) => q.sessionId === sessionId)?.taskId;
                // A session that held a slot (a turn running, or a prompt out) frees it by closing (#394).
                const held = hosted !== undefined && runningIn(s, hosted.environmentId).some((h) => h.sessionId === sessionId);
                delete s.activeSessions[sessionId];
                const before = s.queued.length;
                s.queued = s.queued.filter((q) => q.sessionId !== sessionId);
                const known = wasHosted || s.queued.length !== before;
                if (known) record({ sessionId, reason, at: now() });
                if (hosted?.status === 'open') {
                    try {
                        await session(sessionId)?.hostEnded({ reason });
                    } catch (e) {
                        // The record's word, never the socket's: a refusal or a failure here must not take the daemon's connection down.
                        console.warn(`[machine] session ${sessionId} of ${ctx.key} could not be told its host ended (${reason}): ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                if (known) await notify((r) => r.sessionClosed(sessionId, reason, taskId));
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
                // Sessions the daemon still runs, or once ran, replay from the last cursor this machine holds;
                // ones it never heard of (a restart before `session.opened`) are opened again.
                const wanted: Record<string, { epoch: number; seq: number }> = {};
                const reopen: HostedSession[] = [];
                for (const h of Object.values(s.activeSessions)) {
                    if (h.status === 'opening' && !(h.sessionId in frame.resume)) reopen.push(h);
                    else wanted[h.sessionId] = h.cursor ? { epoch: h.cursor.epoch, seq: h.cursor.seq } : { epoch: 0, seq: 0 };
                }
                send({ v: V, t: 'welcome', serverTime: at, wanted });
                for (const h of reopen) send(openFrame(h));
                // Replies are idempotent by commandId on the daemon: what is still pending is asked again.
                for (const p of Object.values(s.pending)) if (p.deadline > at) send({ v: V, t: 'session.command', sessionId: p.sessionId, command: ctx.snapshot(p.command) });
                dequeue();
                await armLiveness();
                // Tasks parked on this machine (`waiting {environment-offline}`, policy `queue`) get their retry (§7).
                await notify((r) => r.machineOnline(machineId));
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
                await session(frame.sessionId)?.forwardFrames([hello]);
                // The session can take commands now: the router prompts the task that was waiting for this (a queued one included).
                await notify((r) => r.sessionOpened(frame.sessionId, h.taskId));
            }

            /** The runtime's own id for a hosted session (#389), once it names it and on every change: the only ref the record resumes from. */
            async function onSessionRef(frame: DaemonFrameOf<'session.ref'>): Promise<void> {
                const h = ctx.state.activeSessions[frame.sessionId];
                if (!h) return; // not ours: nothing to bind it to
                h.ref = frame.ref;
                await session(frame.sessionId)?.noteRef(frame.ref as SessionRef);
            }

            /**
             * Hand a daemon's word about a session to its record, and keep the socket whatever the record says (#393):
             * a Session refuses a frame for a session it is not hosted on by this machine (a stale one after a restart,
             * one re-opened elsewhere, one it never opened) with a 403, and that refusal must not reach the host's
             * `webSocketMessage` — it would take the daemon's whole socket down with every other session on it.
             */
            async function toSession(fn: () => Promise<void> | undefined): Promise<void> {
                try {
                    await fn();
                } catch (e) {
                    // Only the record's refusal (403): the frame is dropped, the socket stays. Anything else is a bug and surfaces.
                    if (!(isServerFnError(e) && e.status === 403)) throw e;
                }
            }

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
                await toSession(() => session(frame.sessionId)?.forwardFrames([wire]));
                if (h && ended !== undefined) {
                    dequeue();
                    await notify((r) => r.slotFreed(machineId, h.environmentId, `turn ${ended} ended in session ${frame.sessionId}`));
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
                await toSession(() => replied(frame.sessionId, reply));
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

            /** Fold an environment's provider limits in (#261): a stream snapshot replaces only the windows it carries. An environment the machine does not report is ignored. */
            function onQuota(frame: DaemonFrameOf<'quota'>): void {
                const s = ctx.state;
                s.lastSeen = now();
                if (!s.environments.some((e) => e.id === frame.environmentId)) return;
                const quota = (s.quota ??= {});
                quota[frame.environmentId] = mergeQuota(quota[frame.environmentId], ctx.snapshot(frame.snapshot) as QuotaSnapshot);
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
                    case 'session.frame':
                        return onSessionFrame(frame);
                    case 'session.reply':
                        return onSessionReply(frame);
                    case 'session.closed':
                        return sessionGone(frame.sessionId, frame.reason);
                    case 'tool.call':
                        return onToolCall(frame);
                    case 'fs.response':
                        return onFsResponse(frame);
                    case 'env.response':
                        return onEnvResponse(frame);
                    case 'quota':
                        return onQuota(frame);
                    case 'history.response':
                        return onHistoryResponse(frame);
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

                /** The daemon socket closed or failed: offline at once, before any heartbeat window (acceptance). */
                async socketClosed(): Promise<void> {
                    const s = ctx.state;
                    s.online = false;
                    // No socket, no answer: a folder request never outlives the connection it was sent on.
                    failPendingFs(s, now(), 'machine went offline');
                    failPendingEnv(s, now(), 'machine went offline');
                    failPendingHistory(s, now(), 'machine went offline');
                    await armLiveness();
                    await ctx.save();
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
                    if (freeSlots(s, environmentId) > 0) {
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

                /** Tell the daemon to close the session (or drop it from the queue). The daemon's `session.closed` frees the slot. */
                async closeSession(sessionId: SessionId): Promise<void> {
                    const s = ctx.state;
                    if (sessionId in s.activeSessions) send({ v: V, t: 'session.close', sessionId });
                    else if (s.queued.some((q) => q.sessionId === sessionId)) await sessionGone(sessionId, 'closed while queued');
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
            if (s.online && (s.lastSeen ?? 0) + heartbeatWindowMs <= at) s.online = false;
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
            if (needsLiveness(s)) await ctx.reminders.set(LIVENESS, { due: livenessDue });
            await ctx.save();
        }
    });
}

export type MachineActor = ReturnType<typeof defineMachineActor>;
