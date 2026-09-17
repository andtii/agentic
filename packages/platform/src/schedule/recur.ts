/**
 * Recurrence math for schedules (AST-02, AST-07): a cron subset evaluated
 * on the wall clock of an IANA time zone, resolved to instants through
 * `Intl.DateTimeFormat` only — no dependency, no `node:` import, so it runs
 * unchanged on Workers.
 *
 * DST rules (architecture §4 Schedule):
 *
 * - **Spring gap** — a wall time that does not exist (02:30 on the day
 *   Europe/Stockholm jumps 02:00 → 03:00) is SKIPPED: nothing fires, the
 *   next matching wall time is used.
 * - **Fall overlap** — a wall time that exists twice (02:30 on the day the
 *   clock falls back 03:00 → 02:00) fires on its FIRST occurrence only (the
 *   summer-offset instant). The repeated hour never fires a second time,
 *   whatever the cron's minute pattern is.
 *
 * A calendar date's weekday is zone-independent, so day matching runs on
 * `Date.UTC` of the wall date; only the final wall-time → instant step is
 * zone-aware.
 */

// ---------------------------------------------------------------------------
// Public shapes

/** One-shot at an instant, or a cron expression on a zone's wall clock. */
export type Recurrence =
    | { readonly kind: 'at'; readonly at: number }
    | { readonly kind: 'cron'; readonly cron: string; readonly tz: string };

/** Wall-clock fields of an instant in a zone (month 1-12, weekday 0 = Sunday). */
export interface WallTime {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
}

/** A parsed 5-field cron expression; `null` = every value. */
export interface CronFields {
    readonly minute: ReadonlySet<number> | null;
    readonly hour: ReadonlySet<number> | null;
    readonly dayOfMonth: ReadonlySet<number> | null;
    readonly month: ReadonlySet<number> | null;
    readonly dayOfWeek: ReadonlySet<number> | null;
}

/** How a wall time maps onto the instant line in a zone. */
export type WallResolution =
    | { readonly kind: 'unique'; readonly instant: number }
    | { readonly kind: 'gap' }
    | { readonly kind: 'overlap'; readonly first: number; readonly second: number };

// ---------------------------------------------------------------------------
// Cron parsing (subset: `*`, `n`, `a-b`, `a,b`, `*/n`, `a-b/n`; 7 = Sunday)

interface FieldSpec {
    readonly name: string;
    readonly min: number;
    readonly max: number;
}

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { name: 'day-of-month', min: 1, max: 31 };
const MONTH: FieldSpec = { name: 'month', min: 1, max: 12 };
const DAY_OF_WEEK: FieldSpec = { name: 'day-of-week', min: 0, max: 7 };

/**
 * Parse a 5-field cron expression. Throws on anything outside the subset —
 * names (`MON`, `JAN`), `L`, `W`, `#`, `?` and a sixth field are rejected,
 * so a schedule never stores an expression that would silently misfire.
 */
export function parseCron(expression: string): CronFields {
    const parts = expression.trim().split(/\s+/);
    const [minute, hour, dayOfMonth, month, dayOfWeek, extra] = parts;
    if (
        minute === undefined ||
        hour === undefined ||
        dayOfMonth === undefined ||
        month === undefined ||
        dayOfWeek === undefined ||
        extra !== undefined
    ) {
        throw new Error(`[schedule] cron needs 5 fields (minute hour day month weekday), got "${expression}"`);
    }
    const fields = {
        minute: parseField(minute, MINUTE, expression),
        hour: parseField(hour, HOUR, expression),
        dayOfMonth: parseField(dayOfMonth, DAY_OF_MONTH, expression),
        month: parseField(month, MONTH, expression)
    };
    let dow = parseField(dayOfWeek, DAY_OF_WEEK, expression);
    if (dow) {
        // 7 is an alias of 0 (Sunday) in every cron dialect we accept.
        const norm = new Set<number>();
        for (const d of dow) norm.add(d === 7 ? 0 : d);
        dow = norm;
    }
    return { ...fields, dayOfWeek: dow };
}

function parseField(field: string, spec: FieldSpec, expression: string): ReadonlySet<number> | null {
    if (field === '*') return null;
    const out = new Set<number>();
    for (const item of field.split(',')) {
        const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(item);
        if (!m) throw new Error(`[schedule] bad ${spec.name} "${item}" in cron "${expression}"`);
        const [, startRaw, endRaw, stepRaw] = m;
        const step = stepRaw === undefined ? 1 : Number(stepRaw);
        let start: number;
        let end: number;
        if (startRaw === '*') {
            start = spec.min;
            end = spec.max;
        } else {
            start = Number(startRaw);
            end = endRaw === undefined ? (stepRaw === undefined ? start : spec.max) : Number(endRaw);
        }
        if (step < 1 || start < spec.min || end > spec.max || start > end) {
            throw new Error(`[schedule] ${spec.name} "${item}" out of range ${spec.min}-${spec.max} in cron "${expression}"`);
        }
        for (let v = start; v <= end; v += step) out.add(v);
    }
    // `*/n` on the whole range and a full explicit range both mean "every".
    return out.size === spec.max - spec.min + 1 ? null : out;
}

// ---------------------------------------------------------------------------
// Zone math via Intl.DateTimeFormat

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric'
        });
        formatters.set(tz, f);
    }
    return f;
}

/** True when the runtime's ICU data knows `tz` as an IANA zone. */
export function isValidTimeZone(tz: string): boolean {
    try {
        formatterFor(tz);
        return true;
    } catch {
        return false;
    }
}

/** The wall clock of `instant` in `tz`, to the minute. */
export function wallTimeOf(instant: number, tz: string): WallTime {
    const parts = formatterFor(tz).formatToParts(new Date(instant));
    const get = (type: Intl.DateTimeFormatPartTypes): number => {
        const p = parts.find((x) => x.type === type);
        return p ? Number(p.value) : 0;
    };
    // `hourCycle: 'h23'` yields "24" on some ICU builds for midnight — clamp.
    const hour = get('hour') % 24;
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

/** The zone's UTC offset at `instant`, in ms (positive east of UTC). */
export function offsetAt(instant: number, tz: string): number {
    const w = wallTimeOf(instant, tz);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0);
    // Truncate the instant to the minute the wall time was read at.
    return asUtc - Math.floor(instant / 60_000) * 60_000;
}

const DAY_MS = 86_400_000;

/**
 * Map a wall time in `tz` onto the instant line: unique, a spring gap, or a
 * fall overlap (both instants, ascending).
 */
export function resolveWallTime(wall: WallTime, tz: string): WallResolution {
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
    // The zone's offset a day before and a day after bracket any transition
    // near this wall time; each candidate offset gives one candidate instant.
    const offsets = new Set<number>([offsetAt(asUtc - DAY_MS, tz), offsetAt(asUtc, tz), offsetAt(asUtc + DAY_MS, tz)]);
    const hits: number[] = [];
    for (const offset of offsets) {
        const candidate = asUtc - offset;
        if (sameWall(wallTimeOf(candidate, tz), wall)) hits.push(candidate);
    }
    hits.sort((a, b) => a - b);
    if (hits.length === 0) return { kind: 'gap' };
    if (hits.length === 1) return { kind: 'unique', instant: hits[0]! };
    return { kind: 'overlap', first: hits[0]!, second: hits[hits.length - 1]! };
}

function sameWall(a: WallTime, b: WallTime): boolean {
    return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

// ---------------------------------------------------------------------------
// Next occurrence

/** How far ahead `nextCron` searches before giving up (a `30 2 30 2 *` never matches). */
const MAX_SEARCH_DAYS = 366 * 5;

function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMatches(fields: CronFields, year: number, month: number, day: number): boolean {
    if (fields.month && !fields.month.has(month)) return false;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const domOk = !fields.dayOfMonth || fields.dayOfMonth.has(day);
    const dowOk = !fields.dayOfWeek || fields.dayOfWeek.has(weekday);
    // Classic cron: when BOTH day fields are restricted, either matching is enough.
    if (fields.dayOfMonth && fields.dayOfWeek) return domOk || dowOk;
    return domOk && dowOk;
}

function* ascending(set: ReadonlySet<number> | null, min: number, max: number, from: number): Generator<number> {
    if (!set) {
        for (let v = Math.max(min, from); v <= max; v++) yield v;
        return;
    }
    for (const v of [...set].sort((a, b) => a - b)) if (v >= from) yield v;
}

/**
 * The first instant strictly after `after` whose wall clock in `tz`
 * matches `fields`, applying the DST rules above. `null` when nothing
 * matches within five years.
 */
export function nextCron(fields: CronFields, tz: string, after: number): number | null {
    // Start from the wall minute after `after`. In a fall overlap the wall
    // clock runs backwards here, which is exactly why a match resolving to
    // an instant ≤ after is CONSUMED rather than fired on its second pass.
    const start = wallTimeOf(Math.floor(after / 60_000) * 60_000 + 60_000, tz);
    let year = start.year;
    let month = start.month;
    let day = start.day;
    let firstDay = true;
    for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
        if (day > daysInMonth(year, month)) {
            day = 1;
            month++;
            if (month > 12) {
                month = 1;
                year++;
            }
            firstDay = false;
            continue;
        }
        if (dayMatches(fields, year, month, day)) {
            const hourFrom = firstDay ? start.hour : 0;
            for (const hour of ascending(fields.hour, 0, 23, hourFrom)) {
                const minuteFrom = firstDay && hour === start.hour ? start.minute : 0;
                for (const minute of ascending(fields.minute, 0, 59, minuteFrom)) {
                    const resolved = resolveWallTime({ year, month, day, hour, minute }, tz);
                    if (resolved.kind === 'gap') continue; // spring: skip
                    const instant = resolved.kind === 'unique' ? resolved.instant : resolved.first; // fall: first
                    if (instant > after) return instant;
                }
            }
        }
        day++;
        firstDay = false;
    }
    return null;
}

/** The first instant strictly after `after` for any recurrence, or `null` when it is exhausted. */
export function nextOccurrence(recurrence: Recurrence, after: number): number | null {
    if (recurrence.kind === 'at') return recurrence.at > after ? recurrence.at : null;
    return nextCron(parseCron(recurrence.cron), recurrence.tz, after);
}

/**
 * How many occurrences fall in `(from, to]` — what a `skip` catch-up policy
 * reports as missed. Capped at `limit` so a schedule that slept for a year
 * on an every-minute cron costs a bounded scan.
 */
export function countOccurrences(recurrence: Recurrence, from: number, to: number, limit = 1000): number {
    // Parse the cron once, not once per occurrence.
    const fields = recurrence.kind === 'cron' ? parseCron(recurrence.cron) : null;
    let n = 0;
    let cursor = from;
    while (n < limit) {
        const next = fields && recurrence.kind === 'cron' ? nextCron(fields, recurrence.tz, cursor) : nextOccurrence(recurrence, cursor);
        if (next === null || next > to) break;
        n++;
        cursor = next;
    }
    return n;
}

/** Validate a recurrence up front so a bad one never reaches durable state. */
export function validateRecurrence(recurrence: Recurrence): void {
    if (recurrence.kind === 'at') {
        if (!Number.isFinite(recurrence.at)) throw new Error('[schedule] "at" must be an epoch-ms number');
        return;
    }
    if (!isValidTimeZone(recurrence.tz)) throw new Error(`[schedule] unknown IANA time zone "${recurrence.tz}"`);
    parseCron(recurrence.cron);
}
