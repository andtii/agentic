import type { MachineTelemetry, ResourceSample, SessionId } from '../src/index';
import { TELEMETRY_LIMITS, telemetryWarningCleared, telemetryWarningKey, telemetryWarnings } from '../src/index';

const GiB = 2 ** 30;
const sample = (rss: number, cpu: number | null = 0.1): ResourceSample => ({ cpu, rss, processes: 2 });
const snap = (sessions: Readonly<Record<string, ResourceSample | null>>, machine: Partial<MachineTelemetry['machine']> = {}): MachineTelemetry => ({
    observedAt: 1,
    intervalMs: 30_000,
    cpus: 8,
    machine: { cpu: 0.3, memoryUsed: 8 * GiB, memoryTotal: 32 * GiB, ...machine },
    daemon: sample(80_000_000, 0.01),
    environments: {},
    sessions,
    availability: 'reported'
});

describe('telemetryWarnings (#400)', () => {
    it('is quiet under the limits', () => {
        expect(telemetryWarnings(snap({ s1: sample(GiB), s2: null }))).toEqual([]);
    });

    it('names a session over its resident memory limit, never an unknown one', () => {
        const warnings = telemetryWarnings(snap({ s1: sample(3 * GiB), s2: null, s3: sample(GiB) }));
        expect(warnings).toEqual([{ kind: 'session-memory', sessionId: 's1', value: 3 * GiB, limit: TELEMETRY_LIMITS.sessionRss }]);
        expect(telemetryWarningKey(warnings[0]!)).toBe('session:s1');
    });

    it('names the machine over its memory fraction, and says nothing when the OS could not', () => {
        const [w] = telemetryWarnings(snap({}, { memoryUsed: 30 * GiB }));
        expect(w).toEqual({ kind: 'machine-memory', value: 30 / 32, limit: TELEMETRY_LIMITS.machineMemory });
        expect(telemetryWarningKey(w!)).toBe('machine:memory');
        expect(telemetryWarnings(snap({}, { memoryUsed: null }))).toEqual([]);
        expect(telemetryWarnings(snap({}, { memoryUsed: 1, memoryTotal: 0 }))).toEqual([]);
    });

    it('never warns on CPU', () => {
        expect(telemetryWarnings(snap({ s1: sample(GiB, 1) }, { cpu: 1 }))).toEqual([]);
    });

    it('takes other limits', () => {
        expect(telemetryWarnings(snap({ s1: sample(200_000_000) }), { sessionRss: 100_000_000, machineMemory: 0.9 })).toHaveLength(1);
    });
});

describe('telemetryWarningCleared (#400)', () => {
    it('re-arms a session warning under 80 % of the limit, or when the session is gone — not while it hovers or is unknown', () => {
        expect(telemetryWarningCleared('session:s1', snap({ s1: sample(1.9 * GiB) }))).toBe(false);
        expect(telemetryWarningCleared('session:s1', snap({ s1: sample(1.5 * GiB) }))).toBe(true);
        expect(telemetryWarningCleared('session:s1', snap({ s1: null }))).toBe(false);
        expect(telemetryWarningCleared('session:s1', snap({}))).toBe(true);
        expect(telemetryWarningCleared('session:s1', snap({ ['s1' as SessionId]: sample(3 * GiB) }))).toBe(false);
    });

    it('re-arms the machine warning under 72 % in use, never on an unknown reading', () => {
        expect(telemetryWarningCleared('machine:memory', snap({}, { memoryUsed: 25 * GiB }))).toBe(false);
        expect(telemetryWarningCleared('machine:memory', snap({}, { memoryUsed: 20 * GiB }))).toBe(true);
        expect(telemetryWarningCleared('machine:memory', snap({}, { memoryUsed: null }))).toBe(false);
    });

    it('forgets a key it does not know', () => {
        expect(telemetryWarningCleared('something:else', snap({}))).toBe(true);
    });
});
