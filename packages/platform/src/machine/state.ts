/**
 * Machine actor state — `{ws}:machine:{id}` (architecture §4 Machine, §5b).
 *
 * Plain JSON, saved whole with `ctx.save()` at the end of every mutating
 * turn: on Cloudflare `onDeactivate` never runs. The token is never here —
 * only its hash (`machine-token.ts`); the daemon keeps the token.
 */

import type { CapabilityReport, Cursor, EnvError, EnvOp, EnvResult, EnvironmentDescriptor, EnvironmentId, FsError, FsOp, FsResult, MachineId, MachinePolicy, OpenSpec, QuotaSnapshot, SessionId, TaskId, WorkspaceId } from '@agentic/core';
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
     * The turn in flight (#394): set by a prompt's ack (`onSessionReply`), cleared by the turn's `turn-end`
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

export interface SessionClosure {
    readonly sessionId: SessionId;
    readonly reason: string;
    readonly at: number;
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
    /** The machine-local policy the daemon last reported (`hello` / `env`); absent when it reports none (it predates web-managed environments). */
    policy?: MachinePolicy;
    /**
     * Each environment's provider limits as the daemon last reported them (`quota` frames, #261), merged with `mergeQuota`;
     * kept while the machine is offline (readers judge staleness from `observedAt`), dropped with the environment.
     * Absent on a record saved before #268.
     */
    quota?: Record<string, QuotaSnapshot>;
    /** The most recent closures, newest last (capped). */
    closures: SessionClosure[];
    /** Daemon messages refused by the protocol codec since pairing. */
    rejected: number;
}

export const MAX_CLOSURES = 32;
/** At most this many `fsRequest` entries are kept; the oldest is evicted first. */
export const MAX_FS_REQUESTS = 16;
/** A finished `fsRequest` entry is pruned this long after it finished. */
export const FS_RESULT_TTL_MS = 120_000;
/** At most this many environment requests are kept; the oldest is evicted first. */
export const MAX_ENV_REQUESTS = 16;
/** A finished environment request is pruned this long after it finished. */
export const ENV_RESULT_TTL_MS = 120_000;

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

/** Free slots in an environment as the daemon last described it — `concurrency.max` minus the turns running; `0` for an unknown environment. */
export function freeSlots(view: CapacityView, environmentId: EnvironmentId | string): number {
    const env = view.environments.find((e) => e.id === environmentId);
    if (!env) return 0;
    return Math.max(0, env.concurrency.max - activeIn(view, environmentId));
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

function prune(entries: Record<string, { readonly requestId: string; readonly status: string; readonly requestedAt: number; readonly finishedAt?: number }>, at: number, room: boolean, ttlMs: number, max: number): void {
    for (const [id, r] of Object.entries(entries)) if (r.status !== 'pending' && (r.finishedAt ?? r.requestedAt) + ttlMs <= at) delete entries[id];
    if (!room) return;
    const byAge = Object.values(entries).sort((a, b) => a.requestedAt - b.requestedAt);
    while (byAge.length >= max) delete entries[byAge.shift()!.requestId];
}
