/**
 * The daemon's log on the Machine page (#481): `logTail` (owner) sends `log.request`, the daemon's `log.response` is read
 * with `logResult` — its lines held by the activation, never on the record — with the daemon's own error stored
 * unchanged, `timeout` at the deadline and on a disconnect, 409 without the `log` feature, and never a tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentId, MachineId, Principal, WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import { memoryStorage, recordingStorage } from '../../src/testing/index';
import { AuditActor } from '../../src/audit/index';
import { DEFAULT_ENV_TIMEOUT_MS, defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { LOG_RESULT_TTL_MS, MAX_LOG_REQUESTS } from '../../src/machine/state';
import { elevatedPrincipal, statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const M1 = 'machine_1' as MachineId;
const E1 = 'env_1' as EnvironmentId;
const K1 = machineKey(WS, M1);
const daemonPrincipal: Principal = { kind: 'machine', workspaceId: WS, machineId: M1 };
const TICK = 60_000;

class FakeSockets implements MachineSocketPort {
    readonly sent: string[] = [];
    connected = true;
    send(_key: string, text: string): boolean {
        if (!this.connected) return false;
        this.sent.push(text);
        return true;
    }
    close(): void {
        this.connected = false;
    }
    frames(t: string): Record<string, unknown>[] {
        return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.t === t);
    }
}

let app: TestActorApp;
let sockets: FakeSockets;
let scheduler: ManualScheduler;
let Machine: ReturnType<typeof defineMachineActor>;
let storage: ReturnType<typeof recordingStorage>;

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 22, 12, 0, 0));
    sockets = new FakeSockets();
    scheduler = manualScheduler();
    storage = recordingStorage(memoryStorage());
    Machine = defineMachineActor({ socket: sockets });
    app = testActorApp([Machine, Workspace, AuditActor], { scheduler, storage, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
    await app.start();
});

afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const machine = (principal: Principal = owner) => app.as(principal).actor(Machine, K1);
const daemon = () => machine(daemonPrincipal);
const hello = (features: string[] = ['update', 'log']) =>
    daemon().socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '0.2.0', os: 'windows', environments: [inMemoryEnvironment(M1, E1)], capabilities: [], resume: {}, build: { version: '0.2.0', commit: 'abc1234', protocol: 1, channel: 'stable', platform: 'win32-x64' }, features }));
const answer = (requestId: string, body: Record<string, unknown>) => daemon().socketMessage(JSON.stringify({ v: 1, t: 'log.response', requestId, ...body }));
const requests = () => sockets.frames('log.request') as { requestId: string; lines: number }[];
const tick = async () => {
    vi.setSystemTime(Date.now() + TICK);
    scheduler.advance(TICK);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Machine.logTail (#481)', () => {
    it('sends log.request for the owner; the answer is read with logResult and its lines never touch the record', async () => {
        await hello();
        const { requestId } = await machine().logTail(3);
        expect(requests()).toEqual([{ v: 1, t: 'log.request', requestId, lines: 3 }]);
        expect(await machine().logResult(requestId)).toMatchObject({ requestId, lines: 3, status: 'pending' });
        const lines = ['{"level":"info","msg":"daemon: started"}', '{"level":"info","msg":"welcome"}', 'SECRET-SHAPED-BUT-REDACTED-ON-THE-MACHINE'];
        await answer(requestId, { result: { lines, truncated: true } });
        expect(await machine().logResult(requestId)).toMatchObject({ status: 'done', result: { lines, truncated: true } });
        // The record as saved never carries a log line: the lines live in the activation only.
        const saved = await storage.load('machine', K1);
        expect(JSON.stringify(saved?.state)).not.toContain('daemon: started');
        expect(JSON.stringify(saved?.state)).toContain(requestId);
        // The default is 200 lines; out of range is 400.
        const { requestId: second } = await machine().logTail();
        expect(requests().at(-1)).toMatchObject({ requestId: second, lines: 200 });
        expect(await statusOf(machine().logTail(0))).toBe(400);
        expect(await statusOf(machine().logTail(501))).toBe(400);
        expect(await statusOf(machine().logResult('log_nope'))).toBe(404);
    });

    it('the daemon’s own error is stored unchanged; the deadline and a disconnect fail a pending request timeout; a second answer is ignored', async () => {
        await hello();
        const a = await machine().logTail(10);
        await answer(a.requestId, { error: { code: 'no-log', message: 'the daemon runs in a terminal' } });
        expect(await machine().logResult(a.requestId)).toMatchObject({ status: 'error', error: { code: 'no-log' } });
        await answer(a.requestId, { result: { lines: ['late'], truncated: false } });
        expect(await machine().logResult(a.requestId)).toMatchObject({ status: 'error', error: { code: 'no-log' } });

        const b = await machine().logTail(10);
        expect(DEFAULT_ENV_TIMEOUT_MS).toBeLessThan(TICK);
        await tick(); // past the deadline, before the result TTL
        expect(await machine().logResult(b.requestId)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
        // A late answer over a timeout still lands.
        await answer(b.requestId, { result: { lines: ['late'], truncated: false } });
        expect(await machine().logResult(b.requestId)).toMatchObject({ status: 'done', result: { lines: ['late'] } });

        const c = await machine().logTail(10);
        sockets.connected = false;
        await daemon().socketClosed();
        expect(await machine().logResult(c.requestId)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
        expect(await statusOf(machine().logTail(10))).toBe(503);
    });

    it('refuses without the log feature (409), revoked (403), and for anyone but the owner; finished requests are pruned', async () => {
        await hello(['update']);
        expect(await statusOf(machine().logTail(10))).toBe(409);
        await hello();
        for (const who of [daemonPrincipal, { kind: 'agent', workspaceId: WS, agentId: 'a', sessionId: 's' } as Principal, { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['machines', 'sessions'] } as Principal]) {
            expect(await statusOf(machine(who).logTail(10))).toBe(403);
            expect(await statusOf(machine(who).logResult('x'))).toBe(403);
        }
        const ids: string[] = [];
        for (let i = 0; i < MAX_LOG_REQUESTS + 2; i++) {
            const { requestId } = await machine().logTail(1);
            ids.push(requestId);
            await answer(requestId, { result: { lines: [`line ${i}`], truncated: false } });
        }
        // The oldest made room.
        expect(await statusOf(machine().logResult(ids[0]!))).toBe(404);
        expect(await machine().logResult(ids.at(-1)!)).toMatchObject({ status: 'done' });
        for (let t = 0; t <= LOG_RESULT_TTL_MS; t += TICK) await tick();
        expect(await statusOf(machine().logResult(ids.at(-1)!))).toBe(404);

        await machine(elevatedPrincipal('u1')).revoke();
        expect(await statusOf(machine().logTail(10))).toBe(403);
    });
});
