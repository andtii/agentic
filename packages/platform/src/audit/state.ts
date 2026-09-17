/**
 * Audit state and the entry reducer. Every mutation is one `AuditEntry`
 * folded by the pure `applyAuditEntry` — no clock, no ids — so the record
 * is snapshot + log either way: `ctx.append` where the runtime ships it,
 * the reducer plus `ctx.save()` where it does not.
 *
 * The same shape serves both keys. On the LIVE key (`{ws}:audit`) `events`
 * is the window of the newest events, `seq` the next position, `windowFrom`
 * the position of `events[0]` and `months` the archives already written; on
 * an ARCHIVE key (`{ws}:audit:{yyyy-mm}`) `events` is that month's slice,
 * in the order it was rolled over, and the rest stays at its initial value.
 */

import type { AuditEvent, AuditEventInput } from './events.js';

export type AuditEntry =
    /** Live key: one recorded occurrence, given the next `seq`. */
    | { readonly t: 'record'; readonly event: AuditEventInput }
    /** Live key: the oldest `count` events of the window were archived under `months`. */
    | { readonly t: 'rolled'; readonly count: number; readonly months: readonly string[] }
    /** Archive key: events the live log rolled over here, `seq` already stamped. */
    | { readonly t: 'archive'; readonly events: readonly AuditEvent[] };

export interface AuditState {
    v: 1;
    /** Oldest first. */
    events: AuditEvent[];
    /** Event keys folded and still present, for idempotent records. */
    seen: Record<string, 1>;
    /** Live key: the `seq` the next event gets — also the count ever recorded. */
    seq: number;
    /** Live key: the `seq` of `events[0]`; every event below it lives in an archive. */
    windowFrom: number;
    /** Live key: archive months holding rolled-over events, oldest first. */
    months: string[];
}

export function initialAuditState(): AuditState {
    return { v: 1, events: [], seen: {}, seq: 0, windowFrom: 0, months: [] };
}

export function applyAuditEntry(state: AuditState, entry: unknown): void {
    const e = entry as AuditEntry;
    switch (e.t) {
        case 'record': {
            if (Object.hasOwn(state.seen, e.event.key)) return;
            state.seen[e.event.key] = 1;
            state.events.push({ ...e.event, seq: state.seq } as AuditEvent);
            state.seq += 1;
            return;
        }
        case 'rolled': {
            const dropped = state.events.splice(0, e.count);
            for (const ev of dropped) delete state.seen[ev.key];
            state.windowFrom += dropped.length;
            for (const m of e.months) if (!state.months.includes(m)) state.months.push(m);
            state.months.sort();
            return;
        }
        case 'archive': {
            for (const ev of e.events) {
                if (Object.hasOwn(state.seen, ev.key)) continue;
                state.seen[ev.key] = 1;
                state.events.push(ev);
            }
            return;
        }
    }
}
