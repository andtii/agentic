/**
 * Daemon update policy (#365; OPS-03, EXE-08): when a machine takes an update on its own, and the checks its owner's
 * choices go through. Pure over the Machine's state — the actor evaluates it on `hello`, when a turn ends and on the
 * liveness tick, and asks for the update itself as `system:updates`.
 */

import { DEFAULT_UPDATE_SETTINGS, type ReleaseChannel, type UpdatePolicy } from '@agentic/core';

import { isValidTimeZone, nextOccurrence, parseCron } from '../schedule/recur.js';
import { isIdle, type AvailableUpdate, type MachineState, type MachineUpdateState } from './state.js';

/** Who a policy's update is requested and audited as. */
export const SYSTEM_UPDATES = 'system:updates';
/** How long a `drain` update waits for running turns by default. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60_000;
export const MAX_DRAIN_TIMEOUT_MS = 24 * 60 * 60_000;
/** A pending update fails as `timeout` this long after its drain could have ended. */
export const UPDATE_DEADLINE_GRACE_MS = 10 * 60_000;
/** `daemon-crash-loop`: this many restarts inside this window. */
export const CRASH_LOOP_RESTARTS = 3;
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
/** The longest update window a policy may open. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** A release channel, or a 400-worthy message. */
export function checkChannel(channel: unknown): ReleaseChannel {
    if (channel !== 'stable' && channel !== 'latest') throw new Error('channel must be "stable" or "latest"');
    return channel;
}

/** An update policy rebuilt field by field, or a 400-worthy message: a window needs a valid cron, an IANA zone and a duration. */
export function checkUpdatePolicy(policy: unknown): UpdatePolicy {
    const p = policy as { kind?: unknown; cron?: unknown; tz?: unknown; durationMs?: unknown } | null;
    if (!p || typeof p !== 'object') throw new Error('policy must be an object');
    if (p.kind === 'manual' || p.kind === 'auto-when-idle') return { kind: p.kind };
    if (p.kind !== 'window') throw new Error('policy.kind must be manual, auto-when-idle or window');
    if (typeof p.cron !== 'string') throw new Error('a window needs a cron');
    try {
        parseCron(p.cron);
    } catch (e) {
        throw new Error(`the window's cron is invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof p.tz !== 'string' || !isValidTimeZone(p.tz)) throw new Error('a window needs an IANA time zone');
    if (typeof p.durationMs !== 'number' || !Number.isFinite(p.durationMs) || p.durationMs < 60_000 || p.durationMs > MAX_WINDOW_MS) throw new Error('a window lasts between one minute and seven days');
    return { kind: 'window', cron: p.cron, tz: p.tz, durationMs: p.durationMs };
}

/** The channel and policy a machine follows: its own, else the workspace's (`defaults`), else `stable` / `manual`. */
export function effectiveUpdates(u: MachineUpdateState | undefined): { channel: ReleaseChannel; policy: UpdatePolicy; inherited: { channel: boolean; policy: boolean } } {
    const defaults = u?.defaults ?? DEFAULT_UPDATE_SETTINGS;
    return {
        channel: u?.channel ?? defaults.defaultChannel,
        policy: u?.policy ?? defaults.defaultPolicy,
        inherited: { channel: u?.channel === undefined, policy: u?.policy === undefined }
    };
}

/** Whether `now` falls inside a window policy's window: an occurrence of its cron at most `durationMs` ago. */
export function inWindow(policy: Extract<UpdatePolicy, { kind: 'window' }>, now: number): boolean {
    const opened = nextOccurrence({ kind: 'cron', cron: policy.cron, tz: policy.tz }, now - policy.durationMs);
    return opened !== null && opened <= now;
}

/**
 * The update a machine's policy asks for now, or `null`: the daemon is online and answers `update`, a newer release
 * with an asset for its platform is `available`, nothing is pending, no turn runs anywhere (`isIdle`) and — for a
 * `window` — the window is open. A version whose last attempt failed is not tried again on its own.
 */
export function nextAutoUpdate(s: MachineState, now: number): AvailableUpdate | null {
    const { policy } = effectiveUpdates(s.update);
    if (policy.kind === 'manual') return null;
    if (!s.online || !s.build || !s.features?.includes('update') || s.revokedAt) return null;
    const available = s.update?.available;
    if (!available?.asset || s.update?.pending) return null;
    const last = s.update?.last;
    if (last && last.to === available.version && last.outcome !== 'applied') return null;
    if (!isIdle(s)) return null;
    if (policy.kind === 'window' && !inWindow(policy, now)) return null;
    return available;
}

/**
 * Fold a `hello.restarts` count into the machine's restart log (#365): the delta since the last `hello` is one entry,
 * entries older than `CRASH_LOOP_WINDOW_MS` fall off. A counter that went down (the supervisor itself restarted) adds
 * nothing. `true` when the log now holds `CRASH_LOOP_RESTARTS` restarts or more.
 */
export function foldRestarts(s: MachineState, restarts: number | undefined, now: number): boolean {
    if (restarts === undefined) return false;
    const previous = s.restarts;
    s.restarts = restarts;
    const log = (s.restartLog ?? []).filter((r) => r.at > now - CRASH_LOOP_WINDOW_MS);
    if (previous !== undefined && restarts > previous) log.push({ at: now, count: restarts - previous });
    if (log.length) s.restartLog = log;
    else delete s.restartLog;
    return log.reduce((n, r) => n + r.count, 0) >= CRASH_LOOP_RESTARTS;
}
