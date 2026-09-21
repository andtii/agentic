/**
 * Machine telemetry — what a machine's live sessions cost it (#400; EXE-06, EXE-08, EXE-09, OPS-04).
 * #387 keeps a chat's runtime session alive for the life of the chat and refuses to cap or evict them, so
 * resource pressure is answered with visibility: the daemon samples process CPU and resident memory per
 * session (the runtime process and everything it spawned — a dev server the agent started is that session's
 * cost), rolls it up per environment and adds the machine's own totals, on the heartbeat cadence. A session
 * whose process it cannot attribute reads `null` (unknown), never zero. Thresholds warn; nothing enforces.
 */

import type { EnvironmentId, SessionId } from './ids.js';

/** One process tree's cost at a sample. */
export interface ResourceSample {
    /** 0..1 of the whole machine (all cores); `null` on the first sample, when there is no interval to measure over. */
    readonly cpu: number | null;
    /** Resident memory of the tree, bytes (a sum of RSS — shared pages count once per process). */
    readonly rss: number;
    /** Processes in the tree. */
    readonly processes: number;
}

/**
 * How an environment's sample was made: from its sessions' own processes (`'session'`, Claude Code — one
 * process per session), from one process the runtime keeps per environment (`'environment'`, Codex's
 * app-server — its sessions are then unknown), or not at all (`'none'`, a runtime whose process the daemon
 * cannot see — Copilot's SDK spawns its own).
 */
export type TelemetryAttribution = 'session' | 'environment' | 'none';

export interface EnvironmentTelemetry {
    readonly sample: ResourceSample | null;
    readonly attribution: TelemetryAttribution;
}

/** Everything a machine reports about its load at `observedAt`; a full snapshot, replacing the previous one. */
export interface MachineTelemetry {
    /** Epoch ms; readers compute staleness from it. */
    readonly observedAt: number;
    /** The sampling interval CPU deltas were measured over, ms. */
    readonly intervalMs: number;
    /** Logical cores; `cpu` fractions are of all of them. */
    readonly cpus: number;
    readonly machine: {
        /** 0..1 of all cores; `null` on the first sample. */
        readonly cpu: number | null;
        /** Bytes in use as the OS reports it; `null` when it cannot say. */
        readonly memoryUsed: number | null;
        readonly memoryTotal: number;
    };
    /** The daemon process itself. */
    readonly daemon: ResourceSample;
    readonly environments: Readonly<Record<EnvironmentId, EnvironmentTelemetry>>;
    /** Per hosted session; `null` = unknown (its process could not be attributed, or was not sampled). */
    readonly sessions: Readonly<Record<SessionId, ResourceSample | null>>;
    /** `partial` when any session or environment is unknown; `not-reported` when sampling failed or is off. */
    readonly availability: 'reported' | 'partial' | 'not-reported';
    /** Why nothing, or not everything, is reported (PLG-09: say it, don't imply it). */
    readonly reason?: string;
}

/**
 * The named thresholds (#400). Memory only: a session over `sessionRss` resident bytes, a machine over
 * `machineMemory` of its memory in use. CPU is shown, never warned — a build pegging every core for a while
 * is normal work. Crossing one warns the user; nothing ends a session (#387).
 */
export const TELEMETRY_LIMITS = {
    sessionRss: 2 * 2 ** 30,
    machineMemory: 0.9
} as const;

/** Below this fraction of its limit a warning re-arms, so a value hovering at the limit does not warn on every sample. */
export const TELEMETRY_REARM = 0.8;

export interface TelemetryWarning {
    readonly kind: 'session-memory' | 'machine-memory';
    readonly sessionId?: SessionId;
    /** The measured value in the limit's unit: bytes for a session, a 0..1 fraction for the machine. */
    readonly value: number;
    readonly limit: number;
}

/** A warning's identity across samples — what the platform remembers as told, and re-arms. */
export function telemetryWarningKey(w: TelemetryWarning): string {
    return w.kind === 'session-memory' ? `session:${w.sessionId}` : 'machine:memory';
}

/** The limits a snapshot crosses (pure; the UI and the platform share it). */
export function telemetryWarnings(t: MachineTelemetry, limits: typeof TELEMETRY_LIMITS = TELEMETRY_LIMITS): TelemetryWarning[] {
    const out: TelemetryWarning[] = [];
    const used = t.machine.memoryUsed;
    if (used !== null && t.machine.memoryTotal > 0) {
        const fraction = used / t.machine.memoryTotal;
        if (fraction >= limits.machineMemory) out.push({ kind: 'machine-memory', value: fraction, limit: limits.machineMemory });
    }
    for (const [sessionId, sample] of Object.entries(t.sessions)) {
        if (sample && sample.rss >= limits.sessionRss) out.push({ kind: 'session-memory', sessionId: sessionId as SessionId, value: sample.rss, limit: limits.sessionRss });
    }
    return out;
}

/**
 * Whether a warning told earlier has cleared: its value fell under `TELEMETRY_REARM` of the limit, or what it
 * named is gone from the snapshot. `true` means the next crossing is news again.
 */
export function telemetryWarningCleared(key: string, t: MachineTelemetry, limits: typeof TELEMETRY_LIMITS = TELEMETRY_LIMITS): boolean {
    if (key === 'machine:memory') {
        const used = t.machine.memoryUsed;
        if (used === null || t.machine.memoryTotal <= 0) return false;
        return used / t.machine.memoryTotal < limits.machineMemory * TELEMETRY_REARM;
    }
    const sessionId = key.startsWith('session:') ? key.slice('session:'.length) : undefined;
    if (sessionId === undefined) return true;
    const sample = t.sessions[sessionId as SessionId];
    if (sample === undefined) return true;
    if (sample === null) return false;
    return sample.rss < limits.sessionRss * TELEMETRY_REARM;
}
