/** The update policy helpers (#365): idle, the window, when a policy asks, the checks, the crash-loop count. */
import { describe, expect, it } from 'vitest';
import type { EnvironmentId, SessionId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';

import { freeSlots, isIdle, initialMachineState, type MachineState } from '../../src/machine/index';
import { checkUpdatePolicy, effectiveUpdates, foldRestarts, inWindow, nextAutoUpdate } from '../../src/machine/update';

const E1 = 'env_1' as EnvironmentId;
const NOON = Date.UTC(2026, 8, 21, 12, 0, 0);
const asset = { url: 'https://example.test/a.zip', sha256: 'a'.repeat(64), bytes: 1, version: '0.2.0' };

function machine(patch: Partial<MachineState> = {}): MachineState {
    return {
        ...initialMachineState(),
        online: true,
        environments: [inMemoryEnvironment(undefined, E1)],
        build: { version: '0.1.0', commit: 'abc', protocol: 1, channel: 'stable', platform: 'win32-x64' },
        features: ['update'],
        update: { policy: { kind: 'auto-when-idle' }, available: { version: '0.2.0', asset } },
        ...patch
    };
}

describe('update policy (#365)', () => {
    it('idle means no running turn; an open session without one does not count; a drain empties freeSlots', () => {
        const s = machine();
        s.activeSessions['s1'] = { sessionId: 's1' as SessionId, environmentId: E1, agentId: 'a', spec: { agentId: 'a', cwd: '/w', system: '', tools: [] }, status: 'open', requestedAt: 0 };
        expect(isIdle(s)).toBe(true);
        s.activeSessions['s1']!.running = { turnId: 't', since: 0 };
        expect(isIdle(s)).toBe(false);
        delete s.activeSessions['s1']!.running;
        s.pending['s1:c1'] = { sessionId: 's1' as SessionId, command: { v: 1, type: 'prompt', commandId: 'c1', turnId: 't', input: [] } as never, sentAt: 0, deadline: 1 };
        expect(isIdle(s)).toBe(false); // a prompt out holds the slot
        s.pending = { 'q:c1': { ...s.pending['s1:c1']!, sessionId: 'q' as SessionId } };
        expect(isIdle(s)).toBe(true); // not for a session this machine does not host
        s.activeSessions['s1']!.running = { turnId: 't', since: 0 };
        expect(freeSlots(s, E1)).toBeGreaterThan(0);
        expect(freeSlots({ ...s, draining: { requestId: 'u', since: 0 } }, E1)).toBe(0);
        expect(freeSlots({ ...s, draining: { requestId: 'u', since: 0, runtime: 'claude-code' } }, E1)).toBeGreaterThan(0);
    });

    it('a window is open from each cron occurrence for its duration', () => {
        const w = { kind: 'window', cron: '0 13 * * *', tz: 'UTC', durationMs: 3_600_000 } as const;
        expect(inWindow(w, NOON)).toBe(false);
        expect(inWindow(w, NOON + 3_600_000)).toBe(true);
        expect(inWindow(w, NOON + 2 * 3_600_000 - 1)).toBe(true);
        expect(inWindow(w, NOON + 2 * 3_600_000 + 1)).toBe(false);
    });

    it('nextAutoUpdate asks only when everything lines up', () => {
        expect(nextAutoUpdate(machine(), NOON)?.version).toBe('0.2.0');
        expect(nextAutoUpdate(machine({ update: { available: { version: '0.2.0', asset } } }), NOON)).toBeNull(); // manual by default
        expect(nextAutoUpdate(machine({ online: false }), NOON)).toBeNull();
        expect(nextAutoUpdate(machine({ features: [] }), NOON)).toBeNull();
        expect(nextAutoUpdate(machine({ update: { policy: { kind: 'auto-when-idle' }, available: { version: '0.2.0' } } }), NOON)).toBeNull(); // no asset for the platform
        expect(nextAutoUpdate(machine({ update: { policy: { kind: 'auto-when-idle' }, available: { version: '0.2.0', asset }, last: { from: '0.1.0', to: '0.2.0', outcome: 'failed', at: 0 } } }), NOON)).toBeNull();
        const window = { kind: 'window', cron: '0 13 * * *', tz: 'UTC', durationMs: 3_600_000 } as const;
        expect(nextAutoUpdate(machine({ update: { defaults: { defaultChannel: 'stable', defaultPolicy: window }, available: { version: '0.2.0', asset } } }), NOON)).toBeNull();
        expect(nextAutoUpdate(machine({ update: { defaults: { defaultChannel: 'stable', defaultPolicy: window }, available: { version: '0.2.0', asset } } }), NOON + 3_600_000)?.version).toBe('0.2.0');
    });

    it('the machine own channel and policy win over the workspace defaults', () => {
        expect(effectiveUpdates(undefined)).toEqual({ channel: 'stable', policy: { kind: 'manual' }, inherited: { channel: true, policy: true } });
        expect(effectiveUpdates({ channel: 'latest', defaults: { defaultChannel: 'stable', defaultPolicy: { kind: 'auto-when-idle' } } })).toEqual({ channel: 'latest', policy: { kind: 'auto-when-idle' }, inherited: { channel: false, policy: true } });
    });

    it('checkUpdatePolicy rebuilds a policy and refuses a bad window', () => {
        expect(checkUpdatePolicy({ kind: 'manual', extra: 1 })).toEqual({ kind: 'manual' });
        expect(() => checkUpdatePolicy({ kind: 'window', cron: '0 3 * * *', tz: 'Nowhere/City', durationMs: 3_600_000 })).toThrow(/time zone/);
        expect(() => checkUpdatePolicy({ kind: 'window', cron: '0 3 * * *', tz: 'UTC', durationMs: 5 })).toThrow(/one minute/);
        expect(() => checkUpdatePolicy(null)).toThrow(/object/);
    });

    it('foldRestarts counts restart deltas inside ten minutes', () => {
        const s = machine();
        expect(foldRestarts(s, 5, NOON)).toBe(false); // the first count is a baseline
        expect(foldRestarts(s, 7, NOON + 60_000)).toBe(false);
        expect(foldRestarts(s, 8, NOON + 120_000)).toBe(true);
        expect(foldRestarts(s, 8, NOON + 11 * 60_000)).toBe(false); // the old ones fell off
        expect(foldRestarts(s, 0, NOON + 12 * 60_000)).toBe(false); // a reset counter adds nothing
        expect(s.restarts).toBe(0);
    });
});
