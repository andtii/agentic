/**
 * Time formatting for the agent pages: relative ages switch to a date after
 * 24 h, every time in the workspace zone (`docs/design/HANDOFF.md` → Edge
 * cases, "Time zones"). `now` is injectable so tests and mock data agree.
 */

export const MOCK_NOW = Date.parse('2026-09-17T14:20:00Z');
export const WORKSPACE_ZONE = 'Europe/Stockholm';

/** `14m`, `3h`, else `16 Sep`. */
export function age(at: number | string, now = MOCK_NOW): string {
    const t = typeof at === 'string' ? Date.parse(at) : at;
    const diff = Math.max(0, now - t);
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
    return shortDate(t);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(t: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: WORKSPACE_ZONE }).formatToParts(t)) {
        out[p.type] = p.value;
    }
    return out;
}

/** `16 Sep` in the workspace zone (three-letter months, whatever the locale prints). */
export function shortDate(at: number | string): string {
    const t = typeof at === 'string' ? Date.parse(at) : at;
    const p = parts(t);
    return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]}`;
}

/** `16 Sep 21:40` in the workspace zone. */
export function dateTime(at: number | string): string {
    const t = typeof at === 'string' ? Date.parse(at) : at;
    const p = parts(t);
    return `${shortDate(t)} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
