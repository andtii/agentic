/**
 * Machine actor state — `{ws}:machine:{id}` (architecture §4 Machine, §5b).
 *
 * Plain JSON, saved whole with `ctx.save()` at the end of every mutating
 * turn: on Cloudflare `onDeactivate` never runs. The token is never here —
 * only its hash (`machine-token.ts`); the daemon keeps the token.
 */

import type { CapabilityReport, Cursor, EnvironmentDescriptor, EnvironmentId, FsError, FsOp, FsResult, MachineId, OpenSpec, SessionId, TaskId, WorkspaceId } from '@agentic/core';
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

/** Sessions hosted in `environmentId`, opening or open. */
export function activeIn(state: MachineState, environmentId: EnvironmentId | string): number {
    let n = 0;
    for (const s of Object.values(state.activeSessions)) if (s.environmentId === environmentId) n++;
    return n;
}

/** Free slots in an environment as the daemon last described it; `0` for an unknown environment. */
export function freeSlots(state: MachineState, environmentId: EnvironmentId | string): number {
    const env = state.environments.find((e) => e.id === environmentId);
    if (!env) return 0;
    return Math.max(0, env.concurrency.max - activeIn(state, environmentId));
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
    for (const [id, r] of Object.entries(fs)) if (r.status !== 'pending' && (r.finishedAt ?? r.requestedAt) + FS_RESULT_TTL_MS <= at) delete fs[id];
    if (!room) return;
    const byAge = Object.values(fs).sort((a, b) => a.requestedAt - b.requestedAt);
    while (byAge.length >= MAX_FS_REQUESTS) delete fs[byAge.shift()!.requestId];
}
