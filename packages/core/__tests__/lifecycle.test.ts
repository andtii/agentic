/** The daemon lifecycle contract (#359): frame lists, the machine-offline wait, update defaults and machine notifications. */

import { DAEMON_FRAME_TYPES, DEFAULT_UPDATE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS, NOTIFICATION_KINDS, PLATFORM_FRAME_TYPES } from '../src/index';
import type { DaemonFrame, ExecutionDefaults, MachineId, NotificationRef, PlatformFrame, ReleaseManifest, WaitReason, WorkspaceSettings } from '../src/index';

describe('daemon lifecycle contract', () => {
    it('lists the update and harness frames in both directions', () => {
        expect(DAEMON_FRAME_TYPES.slice(-3)).toEqual(['update.status', 'harness.status', 'harnesses']);
        expect(PLATFORM_FRAME_TYPES.slice(-3)).toEqual(['update.request', 'update.cancel', 'harness.request']);
        expect(new Set(DAEMON_FRAME_TYPES).size).toBe(DAEMON_FRAME_TYPES.length);
        expect(new Set(PLATFORM_FRAME_TYPES).size).toBe(PLATFORM_FRAME_TYPES.length);
    });

    it('keeps an older hello, welcome and session.closed valid: every addition is optional', () => {
        const hello: DaemonFrame = { v: 1, t: 'hello', machineId: 'm1' as MachineId, daemonVersion: '1.0.0', os: 'windows', environments: [], capabilities: [], resume: {} };
        const welcome: PlatformFrame = { v: 1, t: 'welcome', serverTime: 1, wanted: {} };
        const closed: DaemonFrame = { v: 1, t: 'session.closed', sessionId: 's1' as never, reason: 'done' };
        expect([hello.t, welcome.t, closed.t]).toEqual(['hello', 'welcome', 'session.closed']);
    });

    it('waits on an offline machine and defaults an interrupted turn to asking', () => {
        const wait: WaitReason = { kind: 'machine-offline', machineId: 'm1' as MachineId, since: 1 };
        const exec: ExecutionDefaults = { runtime: 'claude-code', limits: {}, offlinePolicy: 'queue' };
        expect(wait.kind).toBe('machine-offline');
        expect(exec.onInterrupt ?? 'ask').toBe('ask');
    });

    it('names the update notifications and points them at a machine', () => {
        expect(NOTIFICATION_KINDS).toEqual(expect.arrayContaining(['update-available', 'update-applied', 'update-failed', 'daemon-crash-loop', 'harness-update-available']));
        const ref: NotificationRef = { kind: 'machine', machineId: 'm1' as MachineId };
        expect(ref.kind).toBe('machine');
    });

    it('updates default to the stable channel, by hand; a workspace carries none until it chooses', () => {
        expect(DEFAULT_UPDATE_SETTINGS).toEqual({ defaultChannel: 'stable', defaultPolicy: { kind: 'manual' } });
        expect('updates' in DEFAULT_WORKSPACE_SETTINGS).toBe(false);
        const settings: WorkspaceSettings = { ...DEFAULT_WORKSPACE_SETTINGS, updates: { defaultChannel: 'latest', defaultPolicy: { kind: 'window', cron: '0 3 * * *', tz: 'Europe/Stockholm', durationMs: 3_600_000 } } };
        expect(settings.updates?.defaultPolicy.kind).toBe('window');
    });

    it('a release manifest pins each asset by digest, per platform and per harness', () => {
        const asset = { url: 'https://example.test/d.zip', sha256: 'ab12', bytes: 1, version: '1.2.0' };
        const manifest: ReleaseManifest = { version: '1.2.0', channel: 'stable', publishedAt: 1, commit: 'abc1234', protocol: 1, assets: { 'win32-x64': asset }, harnesses: { 'claude-code': { version: '2.1.0', assets: { 'win32-x64': { ...asset, version: '2.1.0' } } } } };
        expect(Object.keys(manifest.assets)).toEqual(['win32-x64']);
    });
});
