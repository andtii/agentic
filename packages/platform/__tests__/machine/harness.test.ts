/**
 * Harnesses on the Machine (#370; EXE-08, AGT-09, OPS-03, PLG-02, PLG-09): what the daemon reports on `hello` and in
 * `harnesses` frames, the builds the channel's release ships compared against it (and the Inbox told once per version),
 * `requestHarness` from asked to `done` / `failed` / `timeout`, the drain it holds on its runtime only, and the
 * `harness.changed` audit record. Driven with daemon frames directly, as the update tests are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentDescriptor, EnvironmentId, HarnessReport, MachineId, Principal, ReleaseManifest, SessionId, WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';

import { AuditActor, auditKey } from '../../src/audit/index';
import { defineMachineActor, freeSlots, HARNESS_DEADLINE_MS, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { Inbox, inboxKey } from '../../src/notify/index';
import { defineReleaseDirectory, RELEASE_DIRECTORY_KEY, RELEASE_SOURCES } from '../../src/releases/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const M1 = 'machine_1' as MachineId;
const CC = 'env_cc' as EnvironmentId;
const CX = 'env_codex' as EnvironmentId;
const K1 = machineKey(WS, M1);
const daemonPrincipal: Principal = { kind: 'machine', workspaceId: WS, machineId: M1 };
const agentPrincipal: Principal = { kind: 'agent', workspaceId: WS, agentId: 'agent_1' as never, sessionId: 's' as never, scopes: ['sessions', 'machines'] } as Principal;
const TICK = 60_000;
const SHA = 'd'.repeat(64);

const asset = (runtime: string, version: string, platform: string) => ({ url: `https://example.test/harness-${runtime}-${version}-${platform}.zip`, sha256: SHA, bytes: 1000, version });
const harnesses = (versions: Record<string, string>, platforms = ['win32-x64']): ReleaseManifest['harnesses'] =>
    Object.fromEntries(Object.entries(versions).map(([runtime, version]) => [runtime, { version, assets: Object.fromEntries(platforms.map((p) => [p, asset(runtime, version, p)])) }]));
const manifest = (version: string, channel: 'stable' | 'latest', shipped: ReleaseManifest['harnesses']): ReleaseManifest => ({
    version,
    channel,
    publishedAt: 1_700_000_000_000,
    commit: 'abc1234',
    protocol: 1,
    assets: { 'win32-x64': { url: `https://example.test/${version}/agentic-daemon-win32-x64.zip`, sha256: SHA, bytes: 100, version } },
    harnesses: shipped
});

let served: Record<string, ReleaseManifest>;
const fakeFetch = (async (input: RequestInfo | URL) => {
    const m = served[String(input)];
    return m ? new Response(JSON.stringify(m)) : new Response('missing', { status: 404 });
}) as typeof fetch;

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

const slotFreed: { environmentId: string; why: string }[] = [];
const Router = defineActor({
    type: 'routing',
    state: () => ({}),
    methods: () => ({
        async slotFreed(_m: string, environmentId: string, why: string) {
            slotFreed.push({ environmentId, why });
        },
        async machineOnline() {},
        async machineOffline() {},
        async sessionOpened() {},
        async sessionClosed() {},
        async promptRefused() {}
    })
});

let app: TestActorApp;
let sockets: FakeSockets;
let scheduler: ManualScheduler;
let Machine: ReturnType<typeof defineMachineActor>;
const Releases = defineReleaseDirectory({ fetch: fakeFetch });

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 21, 12, 0, 0));
    served = {
        [RELEASE_SOURCES.stable]: manifest('0.2.0', 'stable', harnesses({ 'claude-code': '2.1.0', 'codex-cli': '0.46.0', 'copilot-cli': '1.0.14' })),
        [RELEASE_SOURCES.latest]: manifest('0.3.0-main.abc1234', 'latest', harnesses({ 'claude-code': '2.2.0-beta.1', 'codex-cli': '0.47.0', 'copilot-cli': '1.0.15' }))
    };
    slotFreed.length = 0;
    sockets = new FakeSockets();
    scheduler = manualScheduler();
    Machine = defineMachineActor({ socket: sockets, releases: () => Releases, inbox: () => Inbox, routing: () => Router });
    app = testActorApp([Machine, Workspace, AuditActor, Inbox, Releases, Router], { scheduler, defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 } });
    await app.start();
    await app.as(owner).actor(Releases, RELEASE_DIRECTORY_KEY).refresh();
});

afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const machine = (principal: Principal = owner) => app.as(principal).actor(Machine, K1);
const daemon = () => machine(daemonPrincipal);
const environment = (id: EnvironmentId, name: string, runtime: string): EnvironmentDescriptor => ({ id, machineId: M1, name, runtime, account: { label: name, authStatus: 'ok' }, cwdRoots: ['/work'], concurrency: { max: 2, active: 0 }, isolation: 'config-dir' });
const installed: HarnessReport[] = [
    { runtime: 'claude-code', installed: { version: '2.0.0', at: 1 }, status: 'ready', current: false },
    { runtime: 'codex-cli', installed: { version: '0.46.0', at: 1 }, status: 'ready', current: true },
    { runtime: 'copilot-cli', status: 'missing' }
];
/** A `hello` from a daemon that answers `harness`, with a claude-code and a codex environment. */
const hello = (extra: Record<string, unknown> = {}) =>
    daemon().socketMessage(JSON.stringify({
        v: 1,
        t: 'hello',
        machineId: M1,
        daemonVersion: '0.2.0',
        os: 'windows',
        environments: [environment(CC, 'work', 'claude-code'), environment(CX, 'codex', 'codex-cli')],
        capabilities: [],
        resume: {},
        build: { version: '0.2.0', commit: 'abc1234', protocol: 1, channel: 'stable', platform: 'win32-x64' },
        features: ['update', 'harness'],
        harnesses: installed,
        ...extra
    }));
const status = (requestId: string, phase: string, extra: Record<string, unknown> = {}) => daemon().socketMessage(JSON.stringify({ v: 1, t: 'harness.status', requestId, phase, ...extra }));
const report = (list: HarnessReport[]) => daemon().socketMessage(JSON.stringify({ v: 1, t: 'harnesses', harnesses: list }));
const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS)).list();
const changed = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['harness.changed'] })).events;
const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 3_000): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!(await check())) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};
const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
        const step = Math.min(left, TICK);
        vi.setSystemTime(Date.now() + step);
        scheduler.advance(TICK);
        await new Promise((r) => setTimeout(r, 0));
        left -= step;
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the harnesses a machine reports, against the release (#370)', () => {
    it('stores hello.harnesses, compares them with the channel release for the platform, and tells the Inbox once per runtime and version', async () => {
        await hello();
        const view = await machine().get();
        expect(view.harnesses).toEqual(installed);
        expect(view.harnessesAvailable).toEqual({
            'claude-code': { version: '2.1.0', asset: asset('claude-code', '2.1.0', 'win32-x64') },
            'codex-cli': { version: '0.46.0', asset: asset('codex-cli', '0.46.0', 'win32-x64') },
            'copilot-cli': { version: '1.0.14', asset: asset('copilot-cli', '1.0.14', 'win32-x64') }
        });
        // Only claude-code is installed and older: codex is current, copilot is not installed.
        await until(async () => (await inbox()).some((n) => n.kind === 'harness-update-available'), 'the harness-update-available row');
        await hello();
        await new Promise((r) => setTimeout(r, 20));
        const rows = (await inbox()).filter((n) => n.kind === 'harness-update-available');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ title: 'claude-code 2.1.0 is available for machine_1', ref: { kind: 'machine', machineId: M1 } });
        // Another channel is another version: told once more.
        await machine().setChannel('latest');
        expect((await machine().get()).harnessesAvailable?.['claude-code']?.version).toBe('2.2.0-beta.1');
        await until(async () => (await inbox()).filter((n) => n.kind === 'harness-update-available').length === 3, 'claude-code and codex on latest');
    });

    it('a `harnesses` frame replaces the report; a release without a build for the platform offers the version without an asset', async () => {
        await hello({ build: { version: '0.2.0', commit: 'abc1234', protocol: 1, channel: 'stable', platform: 'linux-arm64' } });
        expect((await machine().get()).harnessesAvailable?.['claude-code']).toEqual({ version: '2.1.0' });
        await report([{ runtime: 'claude-code', installed: { version: '2.1.0', at: 2 }, status: 'ready', current: true }]);
        expect((await machine().get()).harnesses).toEqual([{ runtime: 'claude-code', installed: { version: '2.1.0', at: 2 }, status: 'ready', current: true }]);
    });
});

describe('requestHarness (#370)', () => {
    it('refuses what it cannot do, and only the owner reaches it', async () => {
        await hello({ features: ['update'] });
        await expect(machine().requestHarness({ op: 'install', runtime: 'copilot-cli' })).rejects.toThrow(/reinstall once/);
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: 'copilot-cli' }))).toBe(409);
        await hello();
        expect(await statusOf(machine().requestHarness({ op: 'upgrade' as never, runtime: 'copilot-cli' }))).toBe(400);
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: '' }))).toBe(400);
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: '   ' }))).toBe(400);
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: 'copilot-cli', version: '  ' }))).toBe(400);
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: 'copilot-cli', mode: 'later' as never }))).toBe(400);
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: 'copilot-cli', version: '9.9.9' }))).toBe(400);
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: 'gemini-cli' }))).toBe(400);
        expect(await statusOf(machine().requestHarness({ op: 'update', runtime: 'codex-cli' }))).toBe(400); // already 0.46.0
        await expect(machine().requestHarness({ op: 'update', runtime: 'copilot-cli' })).rejects.toThrow(/^not-installed/);
        await expect(machine().requestHarness({ op: 'remove', runtime: 'copilot-cli' })).rejects.toThrow(/^not-installed/);
        // Remove while an environment runs on it: refused, naming it.
        await expect(machine().requestHarness({ op: 'remove', runtime: 'codex-cli' })).rejects.toThrow(/^in-use: environment codex on machine "machine_1" runs on codex-cli; remove it first/);
        expect(await statusOf(machine().requestHarness({ op: 'remove', runtime: 'codex-cli' }))).toBe(409);
        for (const who of [agentPrincipal, daemonPrincipal]) {
            expect(await statusOf(machine(who).requestHarness({ op: 'install', runtime: 'copilot-cli' }))).toBe(403);
            expect(await statusOf(machine(who).harnessResult('harness_x'))).toBe(403);
        }
        expect(await statusOf(machine().harnessResult('harness_x'))).toBe(404);
        await daemon().socketClosed();
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: 'copilot-cli' }))).toBe(503);
        expect(sockets.frames('harness.request')).toEqual([]);
    });

    it('an update drains its runtime only; the phases land on harnessResult; done ends the drain and records harness.changed', async () => {
        await hello();
        const { requestId } = await machine().requestHarness({ op: 'update', runtime: 'claude-code' });
        expect(sockets.frames('harness.request')).toEqual([{ v: 1, t: 'harness.request', requestId, op: 'update', runtime: 'claude-code', target: asset('claude-code', '2.1.0', 'win32-x64'), mode: 'drain' }]);
        // Drain per runtime: claude-code takes no new turn, codex does.
        const view = await machine().get();
        expect(view.draining).toMatchObject({ requestId, runtime: 'claude-code' });
        expect(freeSlots(view, CC)).toBe(0);
        expect(freeSlots(view, CX)).toBe(2);
        expect(await machine().openSession('sess_codex' as SessionId, CX, { agentId: 'agent_1', cwd: '/work', system: '', tools: [] })).toBe('opened');
        expect(view.harnessRequest).toMatchObject({ requestId, op: 'update', runtime: 'claude-code', status: 'pending', from: '2.0.0', to: '2.1.0' });
        // One at a time, and no daemon update meanwhile.
        expect(await statusOf(machine().requestHarness({ op: 'install', runtime: 'copilot-cli' }))).toBe(409);
        expect(await statusOf(machine().requestUpdate({ target: '0.3.0-main.abc1234' }))).toBe(409);

        await status(requestId, 'downloading');
        await status(requestId, 'draining');
        expect(await machine().harnessResult(requestId)).toMatchObject({ status: 'pending', phase: 'draining' });
        await status(requestId, 'done');
        await report([{ ...installed[0]!, installed: { version: '2.1.0', at: 3 }, current: true }, installed[1]!, installed[2]!]);
        const result = await machine().harnessResult(requestId);
        expect(result).toMatchObject({ status: 'done', phase: 'done', from: '2.0.0', to: '2.1.0' });
        const after = await machine().get();
        expect(after.draining).toBeUndefined();
        expect(after.harnessRequest).toBeUndefined();
        expect(after.harnesses?.[0]?.installed?.version).toBe('2.1.0');
        expect(freeSlots(after, CC)).toBe(2);
        await until(() => slotFreed.some((s) => s.environmentId === CC), 'the router told the claude-code slot freed');
        await until(async () => (await changed()).length === 1, 'harness.changed');
        const [event] = await changed();
        expect(event!.data).toEqual({ machineId: M1, runtime: 'claude-code', op: 'update', from: '2.0.0', to: '2.1.0', outcome: 'done' });
        expect(event!.by).toBe('user:u1');
        expect(event!.summary).toBe('claude-code harness on machine machine_1 updated 2.0.0 → 2.1.0');
    });

    it('install of a missing harness names the target; a failed phase records the error and ends the drain', async () => {
        await hello();
        // The runtime and version are taken trimmed.
        const { requestId } = await machine().requestHarness({ op: 'install', runtime: ' copilot-cli ', version: ' 1.0.14 ', mode: 'now' });
        expect(sockets.frames('harness.request')[0]).toMatchObject({ op: 'install', runtime: 'copilot-cli', mode: 'now', target: { version: '1.0.14' } });
        await status(requestId, 'failed', { error: { code: 'checksum', message: 'the download does not match its sha256' } });
        expect(await machine().harnessResult(requestId)).toMatchObject({ status: 'error', phase: 'failed', error: { code: 'checksum' } });
        expect((await machine().get()).draining).toBeUndefined();
        await until(async () => (await changed()).length === 1, 'harness.changed');
        expect((await changed())[0]!.data).toEqual({ machineId: M1, runtime: 'copilot-cli', op: 'install', to: '1.0.14', outcome: 'failed', error: 'checksum: the download does not match its sha256' });
        // A remove of an unused, installed harness goes out without a target.
        await report([...installed.slice(0, 2), { runtime: 'copilot-cli', installed: { version: '1.0.14', at: 4 }, status: 'ready' }]);
        await machine().requestHarness({ op: 'remove', runtime: 'copilot-cli' });
        expect(sockets.frames('harness.request')[1]).not.toHaveProperty('target');
    });

    it('a pending request past its deadline fails timeout; a hello interrupts one, and a late done still lands', async () => {
        await hello();
        const first = await machine().requestHarness({ op: 'install', runtime: 'copilot-cli' });
        // Past the deadline, with the daemon still alive: only the request times out.
        vi.setSystemTime(Date.now() + HARNESS_DEADLINE_MS);
        await daemon().heartbeat();
        await advance(TICK);
        await until(async () => (await machine().harnessResult(first.requestId)).status === 'error', 'the timeout');
        expect(await machine().harnessResult(first.requestId)).toMatchObject({ error: { code: 'timeout' } });
        expect((await machine().get()).draining).toBeUndefined();
        await until(async () => (await changed()).some((e) => (e.data as { outcome?: string }).outcome === 'timeout'), 'a timeout record');

        const second = await machine().requestHarness({ op: 'install', runtime: 'copilot-cli' });
        await hello();
        expect(await machine().harnessResult(second.requestId)).toMatchObject({ status: 'error', error: { code: 'interrupted' } });
        expect((await machine().get()).draining).toBeUndefined();
        await status(second.requestId, 'done');
        expect(await machine().harnessResult(second.requestId)).toMatchObject({ status: 'done' });
        await until(async () => (await changed()).some((e) => (e.data as { outcome?: string }).outcome === 'done'), 'the late done');
    });
});
