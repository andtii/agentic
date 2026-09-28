/**
 * `createDaemonSocketRegistry().port.isConnected` (#984, #1002): a socket whose auto-answered ping is fresh vouches for
 * the machine, a stale one does not, and one never pinged (an older daemon) cannot say — `undefined`, so the Machine
 * keeps its heartbeat window for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectStateLike, DurableWebSocketLike } from '@sigx/actors-cloudflare';

import { createDaemonSocketRegistry, DAEMON_PING_STALE_MS } from '../src/daemon/index';

const KEY = 'u1:machine:machine_1';

/** An object state whose daemon sockets last had their ping answered at the given times (`null`: never). */
function stateWith(pings: (number | null)[]): DurableObjectStateLike {
    const sockets = pings.map((at) => ({ at }) as unknown as DurableWebSocketLike);
    return {
        getWebSockets: () => sockets,
        getWebSocketAutoResponseTimestamp: (ws: DurableWebSocketLike) => {
            const at = (ws as unknown as { at: number | null }).at;
            return at === null ? null : new Date(at);
        }
    } as unknown as DurableObjectStateLike;
}

function connected(pings: (number | null)[]): boolean | undefined {
    const registry = createDaemonSocketRegistry();
    registry.bind(KEY, stateWith(pings));
    return registry.port.isConnected?.(KEY);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10 * DAEMON_PING_STALE_MS);
});
afterEach(() => vi.useRealTimers());

describe('daemon socket registry isConnected (#1002)', () => {
    const fresh = () => Date.now() - 30_000;
    const stale = () => Date.now() - DAEMON_PING_STALE_MS - 1;

    it('is false with no socket', () => {
        expect(connected([])).toBe(false);
        expect(createDaemonSocketRegistry().port.isConnected?.(KEY)).toBe(false);
    });

    it('is true for a socket that pinged lately (a new daemon)', () => {
        expect(connected([fresh()])).toBe(true);
    });

    it('is false for a socket whose last ping is stale (a half-open path)', () => {
        expect(connected([stale()])).toBe(false);
    });

    it('is undefined for a socket that never pinged (an older daemon)', () => {
        expect(connected([null])).toBeUndefined();
        expect(connected([stale(), null])).toBeUndefined();
    });

    it('is true when any socket of the key is fresh, a never-pinged one beside it included', () => {
        expect(connected([null, fresh()])).toBe(true);
        expect(connected([stale(), fresh()])).toBe(true);
    });

    it('is undefined on a runtime that cannot report ping times', () => {
        const registry = createDaemonSocketRegistry();
        registry.bind(KEY, { getWebSockets: () => [{} as DurableWebSocketLike] } as unknown as DurableObjectStateLike);
        expect(registry.port.isConnected?.(KEY)).toBeUndefined();
    });
});
