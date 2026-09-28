/**
 * Liveness on the socket, not on frames (#984): with a socket port that says whether the daemon is connected, an idle
 * online machine arms no reminder and stays online with no frames at all; the socket closing takes it offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, Principal, WorkspaceId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';

import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const M1 = 'machine_1' as MachineId;
const K1 = machineKey(WS, M1);
const asMachine: Principal = { kind: 'machine', workspaceId: WS, machineId: M1 };
const TICK = 60_000;

/** The host's view of the daemon socket: open or not, and how often liveness asked. */
class Sockets implements MachineSocketPort {
    open = false;
    asked = 0;
    seat: PlatformSeat | undefined;
    send(_key: string, text: string): boolean {
        if (!this.open) return false;
        this.seat?.send(JSON.parse(text));
        return true;
    }
    close(): void {
        this.open = false;
        this.seat?.drop();
    }
    isConnected(): boolean {
        this.asked++;
        return this.open;
    }
}

let app: TestActorApp;
let sockets: Sockets;
let scheduler: ManualScheduler;
let Machine: ReturnType<typeof defineMachineActor>;
const daemons: InMemoryDaemon[] = [];

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sockets = new Sockets();
    scheduler = manualScheduler();
    Machine = defineMachineActor({ socket: sockets, heartbeatWindowMs: 90_000 });
    app = testActorApp([Machine], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
    await app.start();
});

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
    vi.useRealTimers();
});

const machine = (principal: Principal = owner) => app.as(principal).actor(Machine, K1);

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = performance.now() + 3_000;
    while (!(await check())) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const advance = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= TICK) {
        vi.setSystemTime(Date.now() + TICK);
        scheduler.advance(TICK);
        await new Promise((r) => setTimeout(r, 0));
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Time and the reminder clock forward by `ms` in one step. */
const jump = async (ms: number): Promise<void> => {
    vi.setSystemTime(Date.now() + ms);
    scheduler.advance(ms);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A daemon that never heartbeats on its own: every frame after `hello` is one the test sends. */
function connect(): void {
    const d = inMemoryHarness({ machineId: M1, environments: [inMemoryEnvironment(M1, 'env_1' as never)] }).start({ events: 1, heartbeatMs: 24 * 60 * 60_000 }) as InMemoryDaemon;
    daemons.push(d);
    const seat = d.dial();
    sockets.seat = seat;
    sockets.open = true;
    void (async () => {
        try {
            for (;;) await machine(asMachine).socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
    })();
}

describe('Machine liveness on the socket (#984)', () => {
    it('stays online with no frames past the heartbeat window, and arms no reminder while idle', async () => {
        connect();
        await until(async () => (await machine().get()).online, 'online');
        await advance(30 * TICK);
        expect((await machine().get()).online).toBe(true);
        expect(sockets.asked).toBe(0);
    });

    it('an idle sweep every few hours takes it offline once the host no longer vouches for the socket', async () => {
        connect();
        await until(async () => (await machine().get()).online, 'online');
        sockets.open = false; // gone without a close event
        await jump(60 * TICK);
        expect((await machine().get()).online).toBe(true);
        await jump(5 * 60 * TICK);
        expect((await machine().get()).online).toBe(false);
        expect(sockets.asked).toBe(1);
    });

    it('goes offline when the socket closes', async () => {
        connect();
        await until(async () => (await machine().get()).online, 'online');
        sockets.close();
        await machine(asMachine).socketClosed();
        expect((await machine().get()).online).toBe(false);
    });

    it('a legacy heartbeat frame is still taken', async () => {
        connect();
        await until(async () => (await machine().get()).online, 'online');
        await advance(10 * TICK);
        const before = (await machine().get()).lastSeen!;
        expect(await machine(asMachine).socketMessage(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'heartbeat', at: Date.now(), active: [] }))).toMatchObject({ ok: true, t: 'heartbeat' });
        expect((await machine().get()).lastSeen).toBeGreaterThan(before);
    });
});
