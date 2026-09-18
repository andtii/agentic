/**
 * Time formatting for the agent pages: relative ages switch to a date after
 * 24 h, every time in the workspace zone (`docs/design/HANDOFF.md` → Edge
 * cases, "Time zones"). `now` is injectable so tests and mock data agree; on
 * the platform it is the real clock, and the live page passes the
 * workspace's own zone (`useWorkspaceZone`, #150).
 */
import { dataMode } from '../../data-mode';

export const MOCK_NOW = Date.parse('2026-09-17T14:20:00Z');
export const WORKSPACE_ZONE = 'Europe/Stockholm';

/** The clock ages are measured against: the real one on the platform, the mock workspace's otherwise. */
export const agentClock = (): number => (dataMode() === 'live' ? Date.now() : MOCK_NOW);

/** `14m`, `3h`, else `16 Sep`. */
export function age(at: number | string, now = agentClock(), zone = WORKSPACE_ZONE): string {
    const t = typeof at === 'string' ? Date.parse(at) : at;
    const diff = Math.max(0, now - t);
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
    return shortDate(t, zone);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formats = new Map<string, Intl.DateTimeFormat>();
function formatOf(zone: string): Intl.DateTimeFormat {
    let fmt = formats.get(zone);
    if (!fmt) {
        const options = { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false } as const;
        try {
            fmt = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone });
        } catch {
            // A zone `Intl` does not know prints as UTC, like `zoneFormat` — and is never cached under its own name.
            return formatOf('UTC');
        }
        formats.set(zone, fmt);
    }
    return fmt;
}

function parts(t: number, zone: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of formatOf(zone).formatToParts(t)) out[p.type] = p.value;
    return out;
}

/** `16 Sep` in the workspace zone (three-letter months, whatever the locale prints). */
export function shortDate(at: number | string, zone = WORKSPACE_ZONE): string {
    const t = typeof at === 'string' ? Date.parse(at) : at;
    const p = parts(t, zone);
    return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]}`;
}

/** `16 Sep 21:40` in the workspace zone. */
export function dateTime(at: number | string, zone = WORKSPACE_ZONE): string {
    const t = typeof at === 'string' ? Date.parse(at) : at;
    const p = parts(t, zone);
    return `${shortDate(t, zone)} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
