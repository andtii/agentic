import {
    countOccurrences,
    isValidTimeZone,
    nextCron,
    nextOccurrence,
    offsetAt,
    parseCron,
    resolveWallTime,
    validateRecurrence,
    wallTimeOf
} from '../../src/schedule/recur';

const TZ = 'Europe/Stockholm';
const T = (iso: string) => Date.parse(iso);

// Europe/Stockholm 2026: spring forward Sun 29 Mar 01:00Z (02:00 CET → 03:00 CEST),
// fall back Sun 25 Oct 01:00Z (03:00 CEST → 02:00 CET).

describe('cron parsing', () => {
    it('accepts the subset and normalises 7 → Sunday', () => {
        const f = parseCron('*/15 9-17 1,15 * 1-5,7');
        expect([...f.minute!]).toEqual([0, 15, 30, 45]);
        expect([...f.hour!]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
        expect([...f.dayOfMonth!]).toEqual([1, 15]);
        expect(f.month).toBeNull();
        expect([...f.dayOfWeek!].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('collapses a full range to "every"', () => {
        expect(parseCron('0-59 * * * *').minute).toBeNull();
        expect(parseCron('*/1 * * * *').minute).toBeNull();
    });

    it('rejects names, six fields and out-of-range values', () => {
        expect(() => parseCron('0 9 * * MON')).toThrow(/bad day-of-week/);
        expect(() => parseCron('0 0 9 * * *')).toThrow(/5 fields/);
        expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
        expect(() => parseCron('0 24 * * *')).toThrow(/out of range/);
        expect(() => parseCron('*/0 * * * *')).toThrow(/out of range/);
    });
});

describe('zone math', () => {
    it('reads wall time and offset through Intl only', () => {
        expect(wallTimeOf(T('2026-01-15T11:05:00Z'), TZ)).toEqual({ year: 2026, month: 1, day: 15, hour: 12, minute: 5 });
        expect(wallTimeOf(T('2026-07-15T23:30:00Z'), TZ)).toEqual({ year: 2026, month: 7, day: 16, hour: 1, minute: 30 });
        expect(offsetAt(T('2026-01-15T11:05:00Z'), TZ)).toBe(3_600_000);
        expect(offsetAt(T('2026-07-15T11:05:00Z'), TZ)).toBe(7_200_000);
        expect(offsetAt(T('2026-07-15T11:05:00Z'), 'UTC')).toBe(0);
        expect(offsetAt(T('2026-07-15T11:05:00Z'), 'America/New_York')).toBe(-4 * 3_600_000);
    });

    it('resolves a normal wall time uniquely', () => {
        expect(resolveWallTime({ year: 2026, month: 3, day: 28, hour: 2, minute: 30 }, TZ)).toEqual({
            kind: 'unique',
            instant: T('2026-03-28T01:30:00Z')
        });
    });

    it('reports the spring gap', () => {
        expect(resolveWallTime({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, TZ)).toEqual({ kind: 'gap' });
        expect(resolveWallTime({ year: 2026, month: 3, day: 29, hour: 3, minute: 0 }, TZ)).toEqual({
            kind: 'unique',
            instant: T('2026-03-29T01:00:00Z')
        });
    });

    it('reports both instants of the fall overlap, first = summer offset', () => {
        expect(resolveWallTime({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, TZ)).toEqual({
            kind: 'overlap',
            first: T('2026-10-25T00:30:00Z'),
            second: T('2026-10-25T01:30:00Z')
        });
    });

    it('validates zones', () => {
        expect(isValidTimeZone(TZ)).toBe(true);
        expect(isValidTimeZone('Mars/Olympus')).toBe(false);
        expect(() => validateRecurrence({ kind: 'cron', cron: '0 9 * * *', tz: 'Nope/Nope' })).toThrow(/unknown IANA/);
        expect(() => validateRecurrence({ kind: 'cron', cron: 'x', tz: TZ })).toThrow(/5 fields/);
        expect(() => validateRecurrence({ kind: 'at', at: Number.NaN })).toThrow(/epoch-ms/);
    });
});

describe('nextCron in Europe/Stockholm', () => {
    it('fires daily at the wall time across a normal day', () => {
        const f = parseCron('30 2 * * *');
        expect(nextCron(f, TZ, T('2026-03-27T10:00:00Z'))).toBe(T('2026-03-28T01:30:00Z'));
    });

    it('SKIPS the spring gap: 02:30 on 29 Mar does not exist, next is 30 Mar 02:30 CEST', () => {
        const f = parseCron('30 2 * * *');
        const fired28 = T('2026-03-28T01:30:00Z');
        expect(nextCron(f, TZ, fired28)).toBe(T('2026-03-30T00:30:00Z'));
    });

    it('an every-15-minutes cron rides through the spring gap without a burst', () => {
        const f = parseCron('*/15 * * * *');
        // 01:45 CET = 00:45Z; the wall clock then jumps to 03:00 CEST = 01:00Z.
        expect(nextCron(f, TZ, T('2026-03-29T00:45:00Z'))).toBe(T('2026-03-29T01:00:00Z'));
        expect(nextCron(f, TZ, T('2026-03-29T01:00:00Z'))).toBe(T('2026-03-29T01:15:00Z'));
    });

    it('fires the FIRST occurrence on the fall overlap and not the second', () => {
        const f = parseCron('30 2 * * *');
        const fired24 = T('2026-10-24T00:30:00Z'); // 02:30 CEST on the 24th
        const first = nextCron(f, TZ, fired24);
        expect(first).toBe(T('2026-10-25T00:30:00Z')); // 02:30 CEST, the first pass
        // Re-armed after the first pass: the second 02:30 (01:30Z) is not an occurrence.
        expect(nextCron(f, TZ, first!)).toBe(T('2026-10-26T01:30:00Z')); // 02:30 CET next day
    });

    it('the repeated hour never fires twice, even for a sub-hourly cron', () => {
        const f = parseCron('*/30 * * * *');
        // 02:30 CEST first pass = 00:30Z. The wall clock then reaches 03:00 CEST
        // which is 02:00 CET = 01:00Z on the clock face — a second 02:00.
        expect(nextCron(f, TZ, T('2026-10-25T00:30:00Z'))).toBe(T('2026-10-25T02:00:00Z')); // 03:00 CET
        // Arming from inside the second pass still yields nothing in it.
        expect(nextCron(f, TZ, T('2026-10-25T01:10:00Z'))).toBe(T('2026-10-25T02:00:00Z'));
    });

    it('honours weekday, day-of-month OR rule and month', () => {
        // Mondays at 09:00: 2026-09-17 is a Thursday → next Monday 21 Sep 09:00 CEST = 07:00Z.
        expect(nextCron(parseCron('0 9 * * 1'), TZ, T('2026-09-17T10:00:00Z'))).toBe(T('2026-09-21T07:00:00Z'));
        // 1st of the month OR Sunday: from Thu 17 Sep → Sun 20 Sep.
        expect(nextCron(parseCron('0 9 1 * 0'), TZ, T('2026-09-17T10:00:00Z'))).toBe(T('2026-09-20T07:00:00Z'));
        // February 30 never exists → null within the search window.
        expect(nextCron(parseCron('0 9 30 2 *'), TZ, T('2026-09-17T10:00:00Z'))).toBeNull();
        // Next 1 Jan 00:00 CET = 23:00Z on 31 Dec.
        expect(nextCron(parseCron('0 0 1 1 *'), TZ, T('2026-09-17T10:00:00Z'))).toBe(T('2026-12-31T23:00:00Z'));
    });

    it('is strictly after: arming at an exact occurrence moves on', () => {
        const f = parseCron('0 * * * *');
        expect(nextCron(f, TZ, T('2026-09-17T10:00:00Z'))).toBe(T('2026-09-17T11:00:00Z'));
        expect(nextCron(f, TZ, T('2026-09-17T10:00:00.500Z'))).toBe(T('2026-09-17T11:00:00Z'));
        expect(nextCron(f, TZ, T('2026-09-17T09:59:59Z'))).toBe(T('2026-09-17T10:00:00Z'));
    });
});

describe('nextOccurrence / countOccurrences', () => {
    it('one-shot fires once', () => {
        const at = T('2026-09-18T08:00:00Z');
        expect(nextOccurrence({ kind: 'at', at }, at - 1)).toBe(at);
        expect(nextOccurrence({ kind: 'at', at }, at)).toBeNull();
    });

    it('counts the missed occurrences a skip policy reports', () => {
        const rec = { kind: 'cron', cron: '*/15 * * * *', tz: TZ } as const;
        expect(countOccurrences(rec, T('2026-09-17T10:00:00Z'), T('2026-09-17T11:00:00Z'))).toBe(4);
        expect(countOccurrences(rec, T('2026-09-17T10:00:00Z'), T('2026-09-17T10:00:00Z'))).toBe(0);
        expect(countOccurrences({ kind: 'cron', cron: '* * * * *', tz: 'UTC' }, 0, 365 * 86_400_000, 50)).toBe(50);
    });
});
