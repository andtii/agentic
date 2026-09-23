/**
 * Daemon updates on the Machine (#365; EXE-08, OPS-03, OPS-04): the build compared against the release directory on
 * `hello`, the pending `update.request` from asked to judged, the drain it holds, the update policies, the channel, and
 * the audit records and Inbox rows. Driven with daemon frames directly — the in-memory harness reports no build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentId, MachineId, OpenSpec, Principal, ReleaseManifest, SessionId, UpdatePolicy, WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { defineActor } from '@sigx/actors';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import { WIRE_PROTOCOL_VERSION } from '@sigx/ai-agent/wire';

import { AuditActor, auditKey, type AuditKind } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, freeSlots, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { Inbox, inboxKey } from '../../src/notify/index';
import { defineReleaseDirectory, RELEASE_CHECK_MIN_MS, RELEASE_DIRECTORY_KEY, RELEASE_SOURCES } from '../../src/releases/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const M1 = 'machine_1' as MachineId;
const E1 = 'env_1' as EnvironmentId;
const K1 = machineKey(WS, M1);
const daemonPrincipal: Principal = { kind: 'machine', workspaceId: WS, machineId: M1 };
const agentPrincipal: Principal = { kind: 'agent', workspaceId: WS, agentId: 'agent_1' as never, sessionId: 's' as never, scopes: ['sessions', 'machines'] } as Principal;
const TICK = 60_000;
const SHA = 'b'.repeat(64);
const openSpec: OpenSpec = { agentId: 'agent_1', cwd: '/work', system: 'Be brief.', tools: [] };

const manifest = (version: string, channel: 'stable' | 'latest' = 'stable', platforms = ['win32-x64', 'linux-x64']): ReleaseManifest => ({
    version,
    channel,
    publishedAt: 1_700_000_000_000,
    commit: 'abc1234',
    protocol: 1,
    notesUrl: `https://example.test/notes/${version}`,
    assets: Object.fromEntries(platforms.map((p) => [p, { url: `https://example.test/${version}/agentic-daemon-${p}.zip`, sha256: SHA, bytes: 100, version }])),
    harnesses: {}
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

/** A stand-in router that records what the machine tells it. */
const slotFreed: { environmentId: string; why: string }[] = [];
const Router = defineActor({
    type: 'routing',
    state: () => ({}),
    methods: () => ({
        async slotFreed(_m: string, environmentId: string, why: string) {
            slotFreed.push({ environmentId, why });
        },
        async machineOnline() {},
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
    served = { [RELEASE_SOURCES.stable]: manifest('0.2.0'), [RELEASE_SOURCES.latest]: manifest('0.3.0-main.abc1234', 'latest') };
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
const build = (version: string, platform = 'win32-x64') => ({ version, commit: 'abc1234', protocol: 1, channel: 'stable', platform });
/** A `hello` from the daemon: an older build that answers `update` unless told otherwise. */
const hello = (extra: Record<string, unknown> = {}) =>
    daemon().socketMessage(JSON.stringify({ v: 1, t: 'hello', machineId: M1, daemonVersion: '0.1.0', os: 'windows', environments: [inMemoryEnvironment(M1, E1)], capabilities: [], resume: {}, build: build('0.1.0'), features: ['update'], ...extra }));
const status = (requestId: string, phase: string, extra: Record<string, unknown> = {}) => daemon().socketMessage(JSON.stringify({ v: 1, t: 'update.status', requestId, phase, ...extra }));
const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS)).list();
const audits = async (kinds: AuditKind[]) => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds })).events;
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

describe('the build against the releases (#365)', () => {
    it('an older build shows the channel release as available, tells the Inbox once, and welcome carries the platform', async () => {
        await hello();
        const state = await machine().updateState();
        expect(state).toMatchObject({ channel: 'stable', policy: { kind: 'manual' }, inherited: { channel: true, policy: true }, build: build('0.1.0'), features: ['update'], outdated: false });
        expect(state.available).toMatchObject({ version: '0.2.0', notesUrl: 'https://example.test/notes/0.2.0', asset: { url: 'https://example.test/0.2.0/agentic-daemon-win32-x64.zip', sha256: SHA } });
        expect(sockets.frames('welcome')[0]!.platform).toEqual({ version: expect.any(String), minDaemonVersion: '0.0.0-0', latest: { stable: '0.2.0', latest: '0.3.0-main.abc1234' } });
        await until(async () => (await inbox()).length === 1, 'the update-available row');
        expect((await inbox())[0]).toMatchObject({ kind: 'update-available', ref: { kind: 'machine', machineId: M1 } });
        // A reconnect on the same build says nothing new.
        await hello();
        await new Promise((r) => setTimeout(r, 20));
        expect((await inbox()).filter((n) => n.kind === 'update-available')).toHaveLength(1);
        expect((await machine().get()).build).toEqual(build('0.1.0'));
    });

    it('a build as new as the channel has nothing available; a daemon without a build is compared with nothing', async () => {
        await hello({ build: build('0.2.0') });
        expect((await machine().updateState()).available).toBeUndefined();
        await hello({ build: undefined, features: undefined });
        const state = await machine().updateState();
        expect(state.available).toBeUndefined();
        expect(state.build).toBeUndefined();
        expect(state.features).toEqual([]);
    });

    // #437: main builds are `x.y.z-main.<commit time>.<sha7>`, so the channel compare follows the commit time, not the sha.
    it('on latest, a main build older than the channel shows it available; a newer one does not, whatever the shas', async () => {
        served = { ...served, [RELEASE_SOURCES.latest]: manifest('0.3.0-main.1790000000.0000abc', 'latest') };
        await app.as(owner).actor(Releases, RELEASE_DIRECTORY_KEY).refresh();
        await machine().setChannel('latest');
        await hello({ build: build('0.3.0-main.1789999940.fffffff') });
        expect((await machine().updateState()).available).toMatchObject({ version: '0.3.0-main.1790000000.0000abc' });
        await hello({ build: build('0.3.0-main.1790000060.abcdef1') });
        expect((await machine().updateState()).available).toBeUndefined();
    });

    it('setChannel compares again, and the workspace default channel applies until the machine has its own', async () => {
        await app.as(owner).actor(Workspace, workspaceKey(WS)).updateSettings({ updates: { defaultChannel: 'latest' } });
        await hello();
        expect(await machine().updateState()).toMatchObject({ channel: 'latest', inherited: { channel: true }, available: { version: '0.3.0-main.abc1234' } });
        const set = await machine().setChannel('stable');
        expect(set).toMatchObject({ channel: 'stable', inherited: { channel: false }, available: { version: '0.2.0' } });
        expect((await machine().setChannel(null)).channel).toBe('latest');
        await until(async () => (await audits(['machine.channel-set'])).length === 2, 'two channel-set records');
        expect((await audits(['machine.channel-set'])).map((e) => e.data)).toEqual([
            { machineId: M1, channel: null },
            { machineId: M1, channel: 'stable' }
        ]);
        expect(await statusOf(machine().setChannel('beta' as never))).toBe(400);
    });
});

describe('requestUpdate, the drain and the judging hello (#365)', () => {
    it('refuses without the update feature or a build ("reinstall once"), offline, and for an unknown version', async () => {
        await hello({ features: [] });
        await expect(machine().requestUpdate()).rejects.toThrow(/reinstall once/);
        expect(await statusOf(machine().requestUpdate())).toBe(409);
        await hello({ build: undefined });
        expect(await statusOf(machine().requestUpdate())).toBe(409);
        await hello();
        expect(await statusOf(machine().requestUpdate({ target: '9.9.9' }))).toBe(400);
        expect(await statusOf(machine().requestUpdate({ mode: 'later' as never }))).toBe(400);
        await hello({ build: build('0.1.0', 'freebsd-x64') });
        await expect(machine().requestUpdate()).rejects.toThrow(/no build for freebsd-x64/);
        await daemon().socketClosed();
        expect(await statusOf(machine().requestUpdate())).toBe(503);
        expect(sockets.frames('update.request')).toEqual([]);
    });

    it('drains, sends the asset for the platform, and the hello on the new version records machine.updated and ends the drain', async () => {
        await hello();
        const { requestId } = await machine().requestUpdate();
        const [frame] = sockets.frames('update.request');
        expect(frame).toMatchObject({ requestId, mode: 'drain', drainTimeoutMs: 30 * 60_000, target: manifest('0.2.0').assets['win32-x64'] });
        expect(await statusOf(machine().requestUpdate())).toBe(409);
        // Draining: no turn starts, but a session still opens (an open costs no slot).
        const view = await machine().get();
        expect(view.draining).toMatchObject({ requestId });
        expect(freeSlots(view, E1)).toBe(0);
        expect(await machine().openSession('sess_1' as SessionId, E1, openSpec)).toBe('opened');
        await status(requestId, 'downloading', { progress: { bytes: 10, total: 100 } });
        expect((await machine().updateState()).pending).toMatchObject({ requestId, target: '0.2.0', from: '0.1.0', phase: 'downloading', progress: { bytes: 10, total: 100 }, by: 'user:u1' });
        await status('update_other', 'failed');
        expect((await machine().updateState()).pending?.phase).toBe('downloading');

        await hello({ build: build('0.2.0') });
        const after = await machine().updateState();
        expect(after.pending).toBeUndefined();
        expect(after.draining).toBeUndefined();
        expect(after.last).toMatchObject({ requestId, from: '0.1.0', to: '0.2.0', outcome: 'applied' });
        expect(after.available).toBeUndefined();
        expect(freeSlots(await machine().get(), E1)).toBeGreaterThan(0);
        await until(() => slotFreed.length > 0, 'the router told a slot freed');
        expect(slotFreed[0]).toMatchObject({ environmentId: E1 });
        await until(async () => (await audits(['machine.updated'])).length === 1, 'machine.updated');
        expect((await audits(['machine.update-requested']))[0]!.data).toEqual({ machineId: M1, from: '0.1.0', to: '0.2.0', mode: 'drain', by: 'user:u1' });
        expect((await audits(['machine.updated']))[0]!.data).toEqual({ machineId: M1, from: '0.1.0', to: '0.2.0' });
        await until(async () => (await inbox()).some((n) => n.kind === 'update-applied'), 'update-applied');
    });

    it('a hello on the old version, or a rolled-back lastUpdate, records machine.update-failed and ends the drain', async () => {
        await hello();
        const first = await machine().requestUpdate();
        await hello();
        expect(await machine().updateState()).toMatchObject({ last: { requestId: first.requestId, outcome: 'failed', error: expect.stringMatching(/came back on 0\.1\.0, not 0\.2\.0/) } });
        expect((await machine().get()).draining).toBeUndefined();

        const second = await machine().requestUpdate({ mode: 'now' });
        await hello({ lastUpdate: { from: '0.1.0', to: '0.2.0', outcome: 'rolled-back', at: Date.now(), error: 'the new build did not start' } });
        expect(await machine().updateState()).toMatchObject({ last: { requestId: second.requestId, outcome: 'rolled-back', error: 'the new build did not start' } });
        await until(async () => (await audits(['machine.update-failed'])).length === 2, 'two update-failed records');
        await until(async () => (await inbox()).filter((n) => n.kind === 'update-failed').length === 2, 'two update-failed rows');
        // The same lastUpdate on the next hello is not reported again.
        await hello({ lastUpdate: { from: '0.1.0', to: '0.2.0', outcome: 'rolled-back', at: Date.now(), error: 'the new build did not start' } });
        await new Promise((r) => setTimeout(r, 20));
        expect(await audits(['machine.update-failed'])).toHaveLength(2);
    });

    it('a failed phase closes the update; cancelUpdate sends update.cancel; both end the drain', async () => {
        await hello();
        const a = await machine().requestUpdate();
        await status(a.requestId, 'failed', { error: { code: 'sha256-mismatch', message: 'the download did not match' } });
        expect(await machine().updateState()).toMatchObject({ last: { outcome: 'failed', error: 'sha256-mismatch: the download did not match' } });
        expect((await machine().get()).draining).toBeUndefined();

        const b = await machine().requestUpdate();
        expect(await machine().cancelUpdate()).toBe(true);
        expect(sockets.frames('update.cancel')).toEqual([{ v: 1, t: 'update.cancel', requestId: b.requestId }]);
        expect(await machine().updateState()).toMatchObject({ last: { outcome: 'cancelled' } });
        expect((await machine().get()).draining).toBeUndefined();
        expect(await machine().cancelUpdate()).toBe(false);
    });

    it('a pending update past its deadline fails as timeout on the liveness tick', async () => {
        await hello();
        await machine().requestUpdate({ drainTimeoutMs: 0 });
        // Keep the daemon alive through the ticks: only the update times out.
        for (let i = 0; i < 11; i++) {
            await daemon().heartbeat();
            await advance(TICK);
        }
        await until(async () => (await machine().updateState()).last?.outcome === 'timeout', 'the timeout');
        expect((await machine().get()).draining).toBeUndefined();
        await until(async () => (await audits(['machine.update-failed'])).some((e) => e.by === 'system:updates'), 'a timeout record by system:updates');
    });

    // #481: a restart from the web rides the update machinery — nothing downloaded, judged by the next hello alone.
    it('requestRestart sends update.request target restart, drains, and the next hello — whatever its build — records machine.restarted with no Inbox row', async () => {
        await hello();
        const { requestId } = await machine().requestRestart();
        expect(requestId).toMatch(/^restart_/);
        expect(sockets.frames('update.request')).toMatchObject([{ requestId, target: 'restart', mode: 'drain', drainTimeoutMs: 30 * 60_000 }]);
        expect(await statusOf(machine().requestRestart())).toBe(409);
        expect(await statusOf(machine().requestUpdate())).toBe(409);
        const view = await machine().get();
        expect(view.draining).toMatchObject({ requestId });
        expect(freeSlots(view, E1)).toBe(0);
        expect((await machine().updateState()).pending).toMatchObject({ requestId, target: 'restart', from: '0.1.0', by: 'user:u1' });
        expect((await machine().updateState()).pending?.asset).toBeUndefined();
        await status(requestId, 'draining');
        expect((await machine().updateState()).pending?.phase).toBe('draining');
        expect((await audits(['machine.restart-requested']))[0]!.data).toEqual({ machineId: M1, mode: 'drain' });
        expect(await audits(['machine.update-requested'])).toEqual([]);

        // The same build comes back: restarted — not "failed, came back on 0.1.0".
        await hello();
        const after = await machine().updateState();
        expect(after.pending).toBeUndefined();
        expect(after.draining).toBeUndefined();
        expect(after.last).toMatchObject({ requestId, from: '0.1.0', to: 'restart', outcome: 'restarted' });
        expect(freeSlots(await machine().get(), E1)).toBeGreaterThan(0);
        await until(async () => (await audits(['machine.restarted'])).length === 1, 'machine.restarted');
        expect((await audits(['machine.restarted']))[0]!.data).toEqual({ machineId: M1 });
        expect((await inbox()).filter((n) => n.kind === 'update-applied' || n.kind === 'update-failed')).toEqual([]);
        // `now` is passed through; a failed phase closes it as any update's.
        const second = await machine().requestRestart({ mode: 'now' });
        expect(sockets.frames('update.request').at(-1)).toMatchObject({ requestId: second.requestId, target: 'restart', mode: 'now' });
        await status(second.requestId, 'failed', { error: { code: 'busy', message: 'an update is staged' } });
        expect((await machine().updateState()).last).toMatchObject({ requestId: second.requestId, outcome: 'failed', error: 'busy: an update is staged' });
    });

    it('requestRestart refuses like requestUpdate: 403 revoked, 503 offline, 409 pending or without the update feature, 400 a bad mode; owner only', async () => {
        await hello({ features: [] });
        expect(await statusOf(machine().requestRestart())).toBe(409);
        await hello();
        expect(await statusOf(machine().requestRestart({ mode: 'later' as never }))).toBe(400);
        expect(await statusOf(machine().requestRestart({ drainTimeoutMs: -1 }))).toBe(400);
        for (const who of [agentPrincipal, daemonPrincipal]) expect(await statusOf(machine(who).requestRestart())).toBe(403);
        await daemon().socketClosed();
        expect(await statusOf(machine().requestRestart())).toBe(503);
    });

    it('only the owner reaches the update methods', async () => {
        await hello();
        for (const who of [agentPrincipal, daemonPrincipal]) {
            expect(await statusOf(machine(who).requestUpdate())).toBe(403);
            expect(await statusOf(machine(who).cancelUpdate())).toBe(403);
            expect(await statusOf(machine(who).setUpdatePolicy({ kind: 'auto-when-idle' }))).toBe(403);
            expect(await statusOf(machine(who).setChannel('latest'))).toBe(403);
            expect(await statusOf(machine(who).updateState())).toBe(403);
            expect(await statusOf(machine(who).checkUpdates())).toBe(403);
        }
    });

    it('checkUpdates shows a new release at once, not after the hourly read and the 15-minute compare (#468)', async () => {
        await hello({ build: build('0.2.0') });
        const before = await machine().updateState();
        expect(before.available).toBeUndefined();
        expect(before.checkedAt).toBe(Date.now());
        served[RELEASE_SOURCES.stable] = manifest('0.2.1');
        // Within the check floor the directory is not read again: still nothing.
        expect((await machine().checkUpdates()).available).toBeUndefined();
        vi.setSystemTime(Date.now() + RELEASE_CHECK_MIN_MS);
        const after = await machine().checkUpdates();
        expect(after.available).toMatchObject({ version: '0.2.1' });
        expect(after.checkedAt).toBe(Date.now());
        await until(async () => (await inbox()).some((n) => n.kind === 'update-available'), 'the update-available row');
    });
});

describe('update policies (#365)', () => {
    it('auto-when-idle requests the available update as system:updates, and not again after it failed', async () => {
        await hello();
        const state = await machine().setUpdatePolicy({ kind: 'auto-when-idle' });
        expect(state.policy).toEqual({ kind: 'auto-when-idle' });
        const [frame] = sockets.frames('update.request');
        expect(frame).toMatchObject({ mode: 'drain', target: { version: '0.2.0' } });
        expect((await machine().updateState()).pending?.by).toBe('system:updates');
        await until(async () => (await audits(['machine.update-requested'])).some((e) => e.by === 'system:updates'), 'the policy request');
        await until(async () => (await audits(['machine.update-policy-set'])).length === 1, 'update-policy-set');
        // The daemon comes back on the old version: failed, and the policy does not try 0.2.0 again.
        await hello();
        expect((await machine().updateState()).last?.outcome).toBe('failed');
        expect(sockets.frames('update.request')).toHaveLength(1);
        expect(await statusOf(machine().setUpdatePolicy({ kind: 'sometimes' } as never))).toBe(400);
    });

    it('does not request while a turn runs', async () => {
        await hello();
        await machine().openSession('sess_1' as SessionId, E1, openSpec);
        // A prompt out holds the slot (#394): the machine is not idle.
        await machine().sendCommand('sess_1' as SessionId, { v: WIRE_PROTOCOL_VERSION, type: 'prompt', commandId: 'c1', turnId: 't1', input: [{ type: 'text', text: 'go' }] });
        await machine().setUpdatePolicy({ kind: 'auto-when-idle' });
        expect(sockets.frames('update.request')).toEqual([]);
        expect((await machine().updateState()).impact.runningTurns).toEqual([{ sessionId: 'sess_1', agentId: 'agent_1' }]);
    });

    it('does not request while a turn the runtime started itself runs, and does once it ends (#510)', async () => {
        await hello();
        await machine().openSession('sess_1' as SessionId, E1, openSpec);
        await daemon().socketMessage(JSON.stringify({ v: 1, t: 'session.opened', sessionId: 'sess_1', ref: { agent: 'in-memory', v: 1, id: 'r' }, capabilities: {}, head: { epoch: 0, seq: 0 } }));
        // No prompt of ours is out: the runtime began the turn itself (Claude Code after a background task).
        const event = (seq: number, event: Record<string, unknown>) =>
            daemon().socketMessage(JSON.stringify({ v: 1, t: 'session.frame', sessionId: 'sess_1', frame: { v: WIRE_PROTOCOL_VERSION, kind: 'event', epoch: 0, seq, event: { ...event, turnId: 'rt-1', sessionId: 'sess_1', epoch: 0, seq } } }));
        const free = freeSlots(await machine().get(), E1);
        await event(1, { type: 'turn-start', input: [] });
        await machine().setUpdatePolicy({ kind: 'auto-when-idle' });
        expect(sockets.frames('update.request')).toEqual([]);
        expect((await machine().updateState()).impact.runningTurns).toEqual([{ sessionId: 'sess_1', agentId: 'agent_1' }]);
        expect(freeSlots(await machine().get(), E1)).toBe(free - 1);

        await event(2, { type: 'turn-end', stopReason: 'end_turn' });
        await until(() => sockets.frames('update.request').length === 1, 'the update once the turn ended');
        // Its end frees the slot for the router, as a prompted turn's does.
        expect(slotFreed).toContainEqual({ environmentId: E1, why: 'turn rt-1 ended in session sess_1' });
    });

    it('window (the workspace default) requests only inside the window, on the liveness tick', async () => {
        // A daily window at 13:00 UTC for an hour; it is 12:00.
        const policy: UpdatePolicy = { kind: 'window', cron: '0 13 * * *', tz: 'UTC', durationMs: 60 * 60_000 };
        await app.as(owner).actor(Workspace, workspaceKey(WS)).updateSettings({ updates: { defaultPolicy: policy } });
        await hello();
        expect(await machine().updateState()).toMatchObject({ policy, inherited: { policy: true } });
        expect(sockets.frames('update.request')).toEqual([]);
        await daemon().heartbeat();
        await advance(TICK);
        expect(sockets.frames('update.request')).toEqual([]);
        // The window opens at 13:00: the next tick inside it asks, as system:updates.
        vi.setSystemTime(Date.UTC(2026, 8, 21, 12, 59, 30));
        await daemon().heartbeat();
        await advance(TICK);
        expect(new Date(Date.now()).getUTCHours()).toBe(13);
        await until(() => sockets.frames('update.request').length === 1, 'the window request');
        expect((await machine().updateState()).pending?.by).toBe('system:updates');
    });
});

describe('crash loops and settings (#365)', () => {
    it('three restarts within ten minutes tell the Inbox once', async () => {
        await hello({ restarts: 0 });
        await hello({ restarts: 1 });
        await hello({ restarts: 2 });
        await new Promise((r) => setTimeout(r, 20));
        expect((await inbox()).filter((n) => n.kind === 'daemon-crash-loop')).toHaveLength(0);
        await hello({ restarts: 3, lastExit: { at: Date.now(), reason: 'crashed', code: 1 } });
        await hello({ restarts: 4 });
        await until(async () => (await inbox()).some((n) => n.kind === 'daemon-crash-loop'), 'the crash-loop row');
        await new Promise((r) => setTimeout(r, 20));
        expect((await inbox()).filter((n) => n.kind === 'daemon-crash-loop')).toHaveLength(1);
        expect((await machine().updateState()).restarts).toBe(4);
    });

    it('Workspace.updateSettings validates and keeps updates', async () => {
        const ws = app.as(owner).actor(Workspace, workspaceKey(WS));
        expect((await ws.updateSettings({ timeZone: 'UTC' })).updates).toBeUndefined();
        expect((await ws.updateSettings({ updates: {} })).updates).toBeUndefined();
        expect(await statusOf(ws.updateSettings({ updates: { defaultChannel: 'nightly' as never } }))).toBe(400);
        expect(await statusOf(ws.updateSettings({ updates: { defaultPolicy: { kind: 'window', cron: 'nope', tz: 'UTC', durationMs: 60_000 } } }))).toBe(400);
        const settings = await ws.updateSettings({ updates: { defaultPolicy: { kind: 'auto-when-idle' } } });
        expect(settings.updates).toEqual({ defaultChannel: 'stable', defaultPolicy: { kind: 'auto-when-idle' } });
        expect((await ws.updateSettings({ timeZone: 'Europe/Stockholm' })).updates).toEqual(settings.updates);
    });
});

