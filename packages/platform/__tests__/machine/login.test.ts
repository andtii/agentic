/**
 * A sign-in relayed from the Machine page (#484): `requestLogin` (owner) sends `login.request`, the daemon's
 * `login.status` frames move `loginState` through the phases, `answerLogin` forwards the pasted text inside the turn and
 * the record's saves never contain it, `cancelLogin` ends one, `machine.login` is audited on every end; the refusals
 * (404 / 409 / 503, owner only), a disconnect and a revoke fail a running one, the deadline fails it `timeout`, pruning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityReport, EnvironmentDescriptor, EnvironmentId, MachineId, Principal, WorkspaceId } from '@agentic/core';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import { memoryStorage, recordingStorage } from '../../src/testing/index';
import { AuditActor, auditKey, type AuditEvent } from '../../src/audit/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { LOGIN_RESULT_TTL_MS, LOGIN_TIMEOUT_MS } from '../../src/machine/state';
import { elevatedPrincipal, statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const M1 = 'machine_1' as MachineId;
const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
const K1 = machineKey(WS, M1);
const daemonPrincipal: Principal = { kind: 'machine', workspaceId: WS, machineId: M1 };
const TICK = 60_000;
const CODE = 'pasted-code-9x7q';

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
const env = (id: EnvironmentId, runtime = 'in-memory', authStatus: EnvironmentDescriptor['account']['authStatus'] = 'missing'): EnvironmentDescriptor => ({ ...inMemoryEnvironment(M1, id), runtime, account: { label: id, authStatus } });
const RELAY: CapabilityReport = { ...IN_MEMORY_CAPABILITIES, login: 'relay' };
const TERMINAL: CapabilityReport = { ...IN_MEMORY_CAPABILITIES, runtime: 'other', login: 'terminal' };
const hello = (features: string[] = ['login'], capabilities: CapabilityReport[] = [RELAY, TERMINAL], environments: EnvironmentDescriptor[] = [env(E1), env(E2, 'other')]) =>
    daemon().socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '0.2.0', os: 'windows', environments, capabilities, resume: {}, build: { version: '0.2.0', commit: 'abc1234', protocol: 1, channel: 'stable', platform: 'win32-x64' }, features }));
const status = (requestId: string, environmentId: EnvironmentId, phase: string, extra: Record<string, unknown> = {}) => daemon().socketMessage(JSON.stringify({ v: 1, t: 'login.status', requestId, environmentId, phase, ...extra }));
const frames = (t: string) => sockets.frames(t) as { requestId: string; environmentId?: string; text?: string }[];
const audits = async (): Promise<readonly AuditEvent[]> => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['machine.login'] })).events;
const tick = async () => {
    vi.setSystemTime(Date.now() + TICK);
    scheduler.advance(TICK);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Machine.requestLogin / answerLogin / cancelLogin / loginState (#484)', () => {
    it('relays a sign-in: the request, the phases, the paste forwarded and stored nowhere, done audited', async () => {
        await hello();
        expect(await machine().loginState(E1)).toBeNull();
        const { requestId } = await machine().requestLogin(E1);
        expect(requestId).toMatch(/^login_/);
        expect(frames('login.request')).toEqual([{ v: 1, t: 'login.request', requestId, environmentId: E1 }]);
        expect(await machine().loginState(E1)).toMatchObject({ requestId, environmentId: E1, phase: 'started', by: 'user:u1' });
        // Nothing to paste yet: 409.
        expect(await statusOf(machine().answerLogin(E1, CODE))).toBe(409);

        await status(requestId, E1, 'action', { action: { kind: 'open-url', url: 'https://claude.example.test/auth', expectsPaste: true } });
        expect(await machine().loginState(E1)).toMatchObject({ phase: 'action', action: { kind: 'open-url', expectsPaste: true } });
        await status(requestId, E1, 'waiting');
        expect((await machine().loginState(E1))!.phase).toBe('waiting');
        await machine().answerLogin(E1, ` ${CODE} `);
        expect(frames('login.answer')).toEqual([{ v: 1, t: 'login.answer', requestId, text: CODE }]);
        // The text went out inside the turn and landed nowhere: not the record's saves, not the audit.
        expect(JSON.stringify(storage.saves)).not.toContain(CODE);
        expect(JSON.stringify(await storage.load('machine', K1))).not.toContain(CODE);
        expect(JSON.stringify(await machine().loginState(E1))).not.toContain(CODE);

        await status(requestId, E1, 'done');
        expect(await machine().loginState(E1)).toMatchObject({ phase: 'done', finishedAt: Date.now() });
        const rows = await audits();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'machine.login', by: 'user:u1', data: { machineId: M1, environmentId: E1, outcome: 'done' } });
        expect(JSON.stringify(rows)).not.toContain(CODE);
        // Over: a late frame changes nothing, an answer is 404, a new sign-in may start.
        await status(requestId, E1, 'failed', { error: { code: 'failed', message: 'late' } });
        expect((await machine().loginState(E1))!.phase).toBe('done');
        expect(await statusOf(machine().answerLogin(E1, CODE))).toBe(404);
        const again = await machine().requestLogin(E1);
        expect(again.requestId).not.toBe(requestId);
        expect((await machine().loginState(E1))!.phase).toBe('started');
    });

    it('a failed sign-in keeps the daemon’s error; cancel sends login.cancel and the daemon’s cancelled ends it; offline, cancel ends it here', async () => {
        await hello();
        const a = await machine().requestLogin(E1);
        await status(a.requestId, E1, 'failed', { error: { code: 'failed', message: 'Login failed: Request failed with status code 400' } });
        expect(await machine().loginState(E1)).toMatchObject({ phase: 'failed', error: { code: 'failed', message: 'Login failed: Request failed with status code 400' } });
        expect((await audits())[0]).toMatchObject({ data: { environmentId: E1, outcome: 'failed', error: 'Login failed: Request failed with status code 400' } });

        const b = await machine().requestLogin(E1);
        await machine().cancelLogin(E1);
        expect(frames('login.cancel')).toEqual([{ v: 1, t: 'login.cancel', requestId: b.requestId }]);
        expect((await machine().loginState(E1))!.phase).toBe('started'); // the daemon has the last word
        await status(b.requestId, E1, 'failed', { error: { code: 'cancelled', message: 'the sign-in was cancelled' } });
        expect(await machine().loginState(E1)).toMatchObject({ phase: 'failed', error: { code: 'cancelled' } });
        expect((await audits())[0]).toMatchObject({ data: { environmentId: E1, outcome: 'cancelled' } });
        expect(await statusOf(machine().cancelLogin(E1))).toBe(404);

        // A disconnect fails a running one; a cancel while offline ends the record here.
        const c = await machine().requestLogin(E1);
        sockets.connected = false;
        await daemon().socketClosed();
        expect(await machine().loginState(E1)).toMatchObject({ requestId: c.requestId, phase: 'failed', error: { code: 'failed' } });
        expect((await audits())[0]).toMatchObject({ data: { outcome: 'failed' } });
        expect(await statusOf(machine().requestLogin(E1))).toBe(503);
    });

    it('refuses: 404 an unknown environment, 409 a terminal runtime, a daemon without the feature, or one running; owner only; the deadline times out; revoke cancels', async () => {
        await hello(['update']);
        expect(await statusOf(machine().requestLogin(E1))).toBe(409);
        await hello();
        expect(await statusOf(machine().requestLogin('env_nope' as EnvironmentId))).toBe(404);
        expect(await statusOf(machine().requestLogin(E2))).toBe(409); // `login: 'terminal'`
        expect(await statusOf(machine().answerLogin(E1, ''))).toBe(400);
        expect(await statusOf(machine().answerLogin(E1, 'x'.repeat(3000)))).toBe(400);
        for (const who of [daemonPrincipal, { kind: 'agent', workspaceId: WS, agentId: 'a', sessionId: 's' } as Principal, { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['machines', 'sessions'] } as Principal]) {
            expect(await statusOf(machine(who).requestLogin(E1))).toBe(403);
            expect(await statusOf(machine(who).answerLogin(E1, 'x'))).toBe(403);
            expect(await statusOf(machine(who).cancelLogin(E1))).toBe(403);
            expect(await statusOf(machine(who).loginState(E1))).toBe(403);
        }
        const a = await machine().requestLogin(E1);
        expect(await statusOf(machine().requestLogin(E1))).toBe(409);
        // The deadline: past the daemon's own cap with no end reported.
        for (let t = 0; t < LOGIN_TIMEOUT_MS; t += TICK) await tick();
        expect(await machine().loginState(E1)).toMatchObject({ requestId: a.requestId, phase: 'failed', error: { code: 'timeout' } });
        expect((await audits())[0]).toMatchObject({ data: { environmentId: E1, outcome: 'timeout' } });
        // Pruned after its TTL.
        for (let t = 0; t <= LOGIN_RESULT_TTL_MS; t += TICK) await tick();
        expect(await machine().loginState(E1)).toBeNull();

        await hello();
        await machine().requestLogin(E1);
        await machine(elevatedPrincipal('u1')).revoke();
        expect(await machine().loginState(E1)).toMatchObject({ phase: 'failed', error: { code: 'cancelled', message: 'machine revoked' } });
        expect(await statusOf(machine().requestLogin(E1))).toBe(403);
    });
});
