/**
 * Host rows placed in the thread by time (#870): cards a page keeps beside
 * the transcript — a request another project triages, the divider its accept
 * draws, the result card — sit between the messages they happened between,
 * not after the whole thread.
 *
 * Pure: the thread hands each message's time (from its author's `time`), and
 * an insert goes before the first message that is strictly later than it —
 * a message at the same instant keeps its place ahead of the insert. A
 * message with no time (a feed's in-flight row) counts as now, so inserts
 * land before it; a thread with no times at all keeps every insert after it.
 */
import type { AgentMessage } from '@sigx/ai-agent/app';

/** Anything with an instant (epoch ms) to be placed at. */
export interface Timed {
    readonly at: number;
}

export interface Placement<T extends Timed> {
    /** Inserts before a message, by message id, oldest first. */
    readonly before: ReadonlyMap<string, readonly T[]>;
    /** Inserts later than every message, oldest first. */
    readonly after: readonly T[];
}

export function placeInserts<T extends Timed>(messages: readonly AgentMessage[], inserts: readonly T[], timeOf: (message: AgentMessage) => number | undefined): Placement<T> {
    const sorted = inserts
        .map((insert, i) => ({ insert, i }))
        .sort((a, b) => a.insert.at - b.insert.at || a.i - b.i)
        .map((x) => x.insert);
    const times = messages.map((m) => {
        const t = timeOf(m);
        return t === undefined || Number.isNaN(t) ? undefined : t;
    });
    if (times.every((t) => t === undefined)) return { before: new Map(), after: sorted };
    const before = new Map<string, T[]>();
    const after: T[] = [];
    let m = 0;
    for (const insert of sorted) {
        // Inserts are oldest first, so the message they precede only moves forward.
        while (m < messages.length && (times[m] ?? Infinity) <= insert.at) m++;
        if (m === messages.length) {
            after.push(insert);
            continue;
        }
        const id = messages[m]!.id;
        const list = before.get(id);
        if (list) list.push(insert);
        else before.set(id, [insert]);
    }
    return { before, after };
}

/** A message's time from its author's `<time dateTime>` (ISO), when the page gave one. */
export function isoTime(dateTime: string | undefined): number | undefined {
    if (!dateTime) return undefined;
    const t = Date.parse(dateTime);
    return Number.isNaN(t) ? undefined : t;
}
