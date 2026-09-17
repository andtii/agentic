/** Small formatting helpers shared by the operations pages. */

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

/** "Thursday 17 September" for an ISO local time. */
export function dayLabel(iso: string): string {
    return DAY.format(new Date(iso));
}

/** "14:20:03" — the time part of an ISO local time. */
export function clock(iso: string): string {
    return iso.slice(11, 19);
}

/** Group ISO-timed items by calendar day, newest first — the days, and the items inside each day. */
export function groupByDay<T extends { at: string }>(items: readonly T[]): { day: string; label: string; items: T[] }[] {
    const sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const groups: { day: string; label: string; items: T[] }[] = [];
    for (const item of sorted) {
        const day = item.at.slice(0, 10);
        const last = groups[groups.length - 1];
        if (last && last.day === day) last.items.push(item);
        else groups.push({ day, label: dayLabel(item.at), items: [item] });
    }
    return groups;
}

/** mm:ss for a countdown. */
export function mmss(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
