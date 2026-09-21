/**
 * `QuotaMonitor` — keeps each environment's provider limits fresh and reports
 * them as `quota` frames (#271, part of #261; OPS-07).
 *
 * - Passive: every live session event goes through `observe`; an `ext` (or an
 *   `error`, as `{ ns: 'error', name: <code> }`) that the environment's source
 *   maps (`fromSignal`) is merged into what is known and sent.
 * - Probes, when `probe` is on: every environment once welcomed, idle ones
 *   every `pollMs`, one `turnEndDebounceMs` after a turn ends, and one right
 *   away after a rejection (`error rate_limited` naming an exhausted window,
 *   #452): the stream names one window, the probe every per-model one. One
 *   probe at a time — each starts a CLI process.
 * - A snapshot equal to the last one sent (ignoring when and how it was
 *   observed) is dropped, unless that send is older than `refreshMs`: the
 *   platform judges staleness from `observedAt`, so a quiet account is still
 *   confirmed now and then.
 *
 * Only normalized snapshots leave the machine; a source reads the account
 * locally (EXE-10).
 */

import { mergeQuota, type EnvironmentId, type LocalEnvironment, type PluginContext, type QuotaSignal, type QuotaSnapshot, type QuotaSource } from '@agentic/core';
import type { Logger } from './logger.js';

export interface QuotaMonitorOptions {
    readonly sources: readonly QuotaSource[];
    /** Send one `quota` frame; `false` when there is no socket (the snapshot is sent again later). */
    readonly send: (environmentId: EnvironmentId, snapshot: QuotaSnapshot) => boolean;
    readonly environments: () => readonly LocalEnvironment[];
    /** Whether a session is running in the environment (the poll leaves those to the stream and the turn-end probe). */
    readonly busy: (environmentId: EnvironmentId) => boolean;
    readonly logger: Logger;
    /** Probe accounts (`quota.probe`). Default on; off is passive only. */
    readonly probe?: boolean;
    /** Idle environments are probed this often (`quota.pollMs`). Default 5 min; 0 turns the poll off. */
    readonly pollMs?: number;
    /** A probe this long after a turn ends. Default 30 s. */
    readonly turnEndDebounceMs?: number;
    /** An unchanged snapshot is sent again once the last send is this old. Default 15 min. */
    readonly refreshMs?: number;
    readonly now?: () => number;
}

export interface QuotaMonitor {
    /** Start the idle poll. */
    start(): void;
    stop(): void;
    /** The socket was welcomed: probe everything, send what is known and was not delivered. */
    welcomed(): void;
    /** One live session event in `environmentId`. */
    observe(environmentId: EnvironmentId, event: { readonly type: string }): void;
    /** The environments changed: forget removed ones, probe new ones. */
    environmentsChanged(): void;
    /** Probe one environment now (queued behind a running probe). Resolves when done. */
    probe(environmentId: EnvironmentId): Promise<void>;
}

export const DEFAULT_QUOTA_POLL_MS = 5 * 60_000;
export const DEFAULT_QUOTA_TURN_END_DEBOUNCE_MS = 30_000;
export const DEFAULT_QUOTA_REFRESH_MS = 15 * 60_000;

/** What makes two snapshots the same news: not when or how they were observed. */
const fingerprint = (s: QuotaSnapshot): string => JSON.stringify({ ...s, observedAt: undefined, via: undefined });

/** The signal a session event carries for a quota source, if any. */
export function quotaSignalOf(event: { readonly type: string }): QuotaSignal | undefined {
    const e = event as { readonly type: string; readonly [key: string]: unknown };
    if (e.type === 'ext' && typeof e.ns === 'string' && typeof e.name === 'string') return { ns: e.ns, name: e.name, data: e.data };
    if (e.type === 'error' && typeof e.code === 'string') return { ns: 'error', name: e.code, data: e.data };
    return undefined;
}

export function createQuotaMonitor(options: QuotaMonitorOptions): QuotaMonitor {
    const { logger } = options;
    // No source can probe: nothing to schedule.
    const probing = (options.probe ?? true) && options.sources.some((s) => s.probe);
    const pollMs = options.pollMs ?? DEFAULT_QUOTA_POLL_MS;
    const debounceMs = options.turnEndDebounceMs ?? DEFAULT_QUOTA_TURN_END_DEBOUNCE_MS;
    const refreshMs = options.refreshMs ?? DEFAULT_QUOTA_REFRESH_MS;
    const now = options.now ?? Date.now;
    const ctx: PluginContext = { now, log: (level, message, data) => logger[level](message, data) };

    const known = new Map<EnvironmentId, QuotaSnapshot>();
    const sent = new Map<EnvironmentId, { readonly key: string; readonly at: number }>();
    const debounces = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
    const queued = new Set<EnvironmentId>();
    let queue: Promise<void> = Promise.resolve();
    let poll: ReturnType<typeof setInterval> | undefined;
    let stopped = false;

    const envOf = (id: EnvironmentId) => options.environments().find((e) => e.id === id);
    const sourceOf = (env: LocalEnvironment) => options.sources.find((s) => s.runtime === env.runtime);

    /** Send `snapshot` unless it is what the platform already has (and that is recent). */
    function deliver(environmentId: EnvironmentId, snapshot: QuotaSnapshot): void {
        const key = fingerprint(snapshot);
        const last = sent.get(environmentId);
        if (last && last.key === key && now() - last.at < refreshMs) return;
        if (options.send(environmentId, snapshot)) sent.set(environmentId, { key, at: now() });
    }

    function record(environmentId: EnvironmentId, snapshot: QuotaSnapshot): void {
        const merged = mergeQuota(known.get(environmentId), snapshot);
        known.set(environmentId, merged);
        deliver(environmentId, merged);
    }

    function probe(environmentId: EnvironmentId): Promise<void> {
        if (!probing || stopped || queued.has(environmentId)) return queue;
        queued.add(environmentId);
        queue = queue.then(async () => {
            queued.delete(environmentId);
            const env = envOf(environmentId);
            const source = env && sourceOf(env);
            if (stopped || !env || !source?.probe) return;
            try {
                const snapshot = await source.probe(env, ctx);
                // A probe that could not read the account leaves what the stream said in place.
                if (snapshot && !stopped && envOf(environmentId)) record(environmentId, snapshot);
            } catch (e) {
                logger.warn('quota: probe failed', { environment: environmentId, error: e });
            }
        });
        return queue;
    }

    function probeAll(filter: (env: LocalEnvironment) => boolean = () => true): void {
        for (const env of options.environments()) if (filter(env)) void probe(env.id);
    }

    return {
        start() {
            stopped = false;
            if (!probing || pollMs <= 0) return;
            poll = setInterval(() => probeAll((env) => !options.busy(env.id)), pollMs);
            poll.unref?.();
        },
        stop() {
            stopped = true;
            if (poll !== undefined) clearInterval(poll);
            poll = undefined;
            for (const t of debounces.values()) clearTimeout(t);
            debounces.clear();
        },
        welcomed() {
            // Anything the socket missed goes out now; a probe follows with fresh numbers.
            for (const [id, snapshot] of known) deliver(id, snapshot);
            probeAll();
        },
        observe(environmentId, event) {
            if (stopped) return;
            if (event.type === 'turn-end') {
                if (!probing) return;
                const pending = debounces.get(environmentId);
                if (pending !== undefined) clearTimeout(pending);
                const timer = setTimeout(() => {
                    debounces.delete(environmentId);
                    void probe(environmentId);
                }, debounceMs);
                timer.unref?.();
                debounces.set(environmentId, timer);
                return;
            }
            const signal = quotaSignalOf(event);
            if (!signal) return;
            const env = envOf(environmentId);
            const source = env && sourceOf(env);
            if (!env || !source?.fromSignal) return;
            const snapshot = source.fromSignal(signal, env);
            if (!snapshot) return;
            record(environmentId, snapshot);
            // A rejection: which limit ran out is the probe's to say — it replaces a bare window the stream named with the account's per-model ones.
            if (signal.ns === 'error' && signal.name === 'rate_limited' && snapshot.windows.some((w) => w.status === 'exhausted')) void probe(environmentId);
        },
        environmentsChanged() {
            const ids = new Set(options.environments().map((e) => e.id));
            for (const id of [...known.keys(), ...sent.keys()]) {
                if (ids.has(id)) continue;
                known.delete(id);
                sent.delete(id);
            }
            probeAll((env) => !known.has(env.id));
        },
        probe
    };
}
