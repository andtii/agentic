/**
 * The thread's window — pure functions over the message list, so the sizing
 * rule is testable without a DOM.
 *
 * A UNIT is one part (a message with no parts still counts one, so an empty
 * row is not lost). A ROW is a contiguous run of one message's units inside
 * the window, so a message with two thousand parts renders at most the
 * window's worth of them, and the row count never exceeds the unit count.
 */
import type { AgentMessage } from '@sigx/ai-agent/app';

export interface WindowRange {
    /** First unit rendered (inclusive). */
    readonly start: number;
    /** Last unit rendered (exclusive). */
    readonly end: number;
}

export interface ThreadRow {
    /**
     * The message id alone — a message is at most one row, and the window
     * slides one part at a time while following, so a key carrying `from`
     * would remount the whole row (every part in it) on every new part.
     */
    readonly key: string;
    readonly message: AgentMessage;
    /** The part slice this row shows — `[from, to)` into `message.parts`. */
    readonly from: number;
    readonly to: number;
    /** True when the row shows less than the whole message. */
    readonly partial: boolean;
}

export const DEFAULT_WINDOW = 150;

export function unitsOf(message: AgentMessage): number {
    return Math.max(1, message.parts.length);
}

export function unitCount(messages: readonly AgentMessage[]): number {
    let n = 0;
    for (const m of messages) n += unitsOf(m);
    return n;
}

/** The range that follows the tail: the last `size + extra` units. */
export function followRange(total: number, size: number, extra = 0): WindowRange {
    return { start: Math.max(0, total - size - extra), end: total };
}

/** A frozen range, clamped to what still exists and widened backwards by `extra`. */
export function frozenRange(total: number, end: number, size: number, extra = 0): WindowRange {
    const clampedEnd = Math.min(end, total);
    return { start: Math.max(0, clampedEnd - size - extra), end: clampedEnd };
}

export function windowRows(messages: readonly AgentMessage[], range: WindowRange): ThreadRow[] {
    const rows: ThreadRow[] = [];
    let offset = 0;
    for (const message of messages) {
        const units = unitsOf(message);
        const messageStart = offset;
        const messageEnd = offset + units;
        offset = messageEnd;
        if (messageEnd <= range.start) continue;
        if (messageStart >= range.end) break;
        const from = Math.max(0, range.start - messageStart);
        const to = Math.min(units, range.end - messageStart);
        rows.push({
            key: message.id,
            message,
            from,
            to: Math.min(to, message.parts.length),
            partial: from > 0 || to < units
        });
    }
    return rows;
}
