/**
 * Slow-turn reporting for the hosted actors (#492). A turn that ran, or
 * waited in its actor's queue, longer than `SLOW_TURN_MS` is one `console.warn`
 * line in the Worker's log — type, key, method, how long it queued, how long
 * it ran, whether it threw. The host's own slow-turn warning is dev-only;
 * this one is for `wrangler tail`, where the 2026-09-21 stall (a 94 s
 * `routing.machineOnline`, an 85 s `session.forwardFrames`) showed only as
 * wall time on the object, never as which turn held it.
 *
 * Registered once per host (`observeSlowTurns`); the host takes its per-turn
 * timestamps only while an observer is attached.
 */
import type { ActorRef, Host } from '@sigx/actors';

/** Queued plus ran, in ms, past which a turn is reported. */
export const SLOW_TURN_MS = 5_000;

const observed = new WeakSet<Host>();

/** The line a slow turn logs, or `undefined` when the turn was quick enough. */
export function slowTurnLine(ref: ActorRef, method: string, queuedMs: number, elapsedMs: number, failed: boolean, thresholdMs: number = SLOW_TURN_MS): string | undefined {
    if (queuedMs + elapsedMs < thresholdMs) return undefined;
    const queued = queuedMs >= 1_000 ? `, queued ${Math.round(queuedMs)} ms behind the actor's other turns` : '';
    return `[actors] slow turn: ${ref.type}/${ref.key}.${method}() ran ${Math.round(elapsedMs)} ms${queued}${failed ? ' and threw' : ''}`;
}

/** Attach the slow-turn observer to `host`, once. */
export function observeSlowTurns(host: Host, log: (line: string) => void = (line) => console.warn(line)): void {
    if (observed.has(host)) return;
    observed.add(host);
    host.observeTurns((ref, method, queuedMs, elapsedMs, failed) => {
        const line = slowTurnLine(ref, method, queuedMs, elapsedMs, failed);
        if (line) log(line);
    });
}
