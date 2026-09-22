/** Every frame kind: one valid frame parses, one invalid frame is refused with a field-level issue. */

import { DAEMON_FRAME_TYPES, DAEMON_PROTOCOL_VERSION, FS_LIST_MAX_ENTRIES, FS_LOCATE_MAX_MATCHES, PLATFORM_FRAME_TYPES } from '@agentic/core';
import { WIRE_PROTOCOL_VERSION } from '@sigx/ai-agent/wire';
import type { DaemonFrame, DaemonFrameType, PlatformFrame, PlatformFrameType } from '../src/index';
import {
    HARNESS_PHASES,
    LIMITS,
    SESSION_CLOSED_CODES,
    UPDATE_PHASES,
    daemonFrame,
    daemonFrameSchemas,
    harnessReport,
    harnessReports,
    harnessRequestFrame,
    harnessStatusFrame,
    harnessesFrame,
    lifecycleError,
    platformFrame,
    platformFrameSchemas,
    releaseAsset,
    updateCancelFrame,
    updateRequestFrame,
    updateStatusFrame
} from '../src/index';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '../src/testing/index';

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;
const env = inMemoryEnvironment();
const cursor = { epoch: 0, seq: 3 };

const week = { id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.5, unit: 'percent', resetsAt: '2026-09-22T18:00:00Z', status: 'ok' } as const;
const quotaOf = (windows: readonly unknown[]) =>
    ({ sourceId: 'agentic.quota.claude-code', runtime: 'claude-code', environmentId: env.id, plan: 'max', availability: 'reported', windows, observedAt: 1, via: 'probe' }) as never;

const telemetryOf = (sessions: Readonly<Record<string, unknown>>) => ({
    observedAt: 1,
    intervalMs: 30_000,
    cpus: 8,
    machine: { cpu: 0.34, memoryUsed: 12_000_000_000, memoryTotal: 32_000_000_000 },
    daemon: { cpu: 0.01, rss: 90_000_000, processes: 1 },
    environments: { [env.id]: { sample: { cpu: 0.12, rss: 1_500_000_000, processes: 3 }, attribution: 'session' } },
    sessions,
    availability: 'partial'
});

type Case<T> = { readonly valid: T; readonly invalid: unknown; readonly path: string };

const daemonCases: { readonly [T in DaemonFrameType]: Case<Extract<DaemonFrame, { t: T }>> } = {
    hello: {
        valid: { v: V, t: 'hello', machineId: env.machineId, daemonVersion: '1.0.0', os: 'windows', environments: [env], capabilities: [IN_MEMORY_CAPABILITIES], resume: { s1: cursor } },
        invalid: { v: V, t: 'hello', machineId: env.machineId, daemonVersion: '1.0.0', os: 'amiga', environments: [env], capabilities: [], resume: {} },
        path: 'os'
    },
    env: {
        valid: { v: V, t: 'env', environments: [{ ...env, doctor: { ok: false, findings: [{ level: 'error', code: 'shared-config-dir', message: 'shared', environmentIds: [env.id] }], checkedAt: 1 } }] },
        invalid: { v: V, t: 'env', environments: [{ ...env, account: { label: 'x' } }] },
        path: 'environments.0.account.authStatus'
    },
    heartbeat: { valid: { v: V, t: 'heartbeat', at: 1, active: [env.id as unknown as never] }, invalid: { v: V, t: 'heartbeat', at: -1, active: [] }, path: 'at' },
    'session.opened': {
        valid: { v: V, t: 'session.opened', sessionId: 's1' as never, ref: { agent: 'fake', v: 1, id: 's1' }, capabilities: IN_MEMORY_CAPABILITIES, head: cursor },
        invalid: { v: V, t: 'session.opened', sessionId: 's1', ref: { agent: 'fake', v: 1, id: 's1' }, capabilities: IN_MEMORY_CAPABILITIES, head: { epoch: 0 } },
        path: 'head.seq'
    },
    'session.ref': {
        valid: { v: V, t: 'session.ref', sessionId: 's1' as never, ref: { agent: 'claude-code', v: 1, id: 'a1b2c3', data: { cwd: '/work', epoch: 0 } } },
        invalid: { v: V, t: 'session.ref', sessionId: 's1' },
        path: 'ref'
    },
    'session.title': {
        valid: { v: V, t: 'session.title', sessionId: 's1' as never, title: 'Chat list auto-generated titles' },
        invalid: { v: V, t: 'session.title', sessionId: 's1', title: '   ' },
        path: 'title'
    },
    'session.frame': {
        valid: { v: V, t: 'session.frame', sessionId: 's1' as never, frame: { v: W, kind: 'event', epoch: 0, seq: 1, event: { type: 'part-delta', partId: 'p', delta: 'x', sessionId: 's1', epoch: 0, seq: 1 } } },
        invalid: { v: V, t: 'session.frame', sessionId: 's1', frame: { v: W, kind: 'event', epoch: 0, seq: 1, event: { type: 'part-delta', partId: 'p', delta: 'x' } } },
        path: 'frame.event'
    },
    'session.reply': {
        valid: { v: V, t: 'session.reply', sessionId: 's1' as never, reply: { v: W, kind: 'error', commandId: 'c1', code: 'busy', message: 'a turn is running' } },
        invalid: { v: V, t: 'session.reply', sessionId: 's1', reply: { v: W, kind: 'error', commandId: 'c1', code: 'teapot', message: 'no' } },
        path: 'reply.code'
    },
    'session.closed': { valid: { v: V, t: 'session.closed', sessionId: 's1' as never, reason: 'done' }, invalid: { v: V, t: 'session.closed', sessionId: '', reason: 'done' }, path: 'sessionId' },
    'tool.call': { valid: { v: V, t: 'tool.call', callId: 'k1', sessionId: 's1' as never, tool: 'echo', input: { x: 1 } }, invalid: { v: V, t: 'tool.call', callId: 'k1', sessionId: 's1', input: {} }, path: 'tool' },
    pong: { valid: { v: V, t: 'pong', at: 5 }, invalid: { v: V, t: 'pong', at: 'now' }, path: 'at' },
    'fs.response': {
        valid: {
            v: V,
            t: 'fs.response',
            requestId: 'fs_1',
            result: {
                kind: 'list',
                path: '/work',
                entries: [
                    { name: 'app', path: '/work/app', git: { kind: 'repo', branch: 'main', origin: 'git@github.com:andtii/agentic.git' } },
                    { name: 'wt', path: '/work/wt', git: { kind: 'worktree', head: 'abc1234' } }
                ],
                truncated: false
            }
        },
        invalid: { v: V, t: 'fs.response', requestId: 'fs_1', result: { kind: 'worktree', path: '/work/b', branch: 'b' }, error: { code: 'exists', message: 'taken' } },
        path: 'error'
    },
    'env.response': {
        valid: { v: V, t: 'env.response', requestId: 'env_1', error: { code: 'outside-allowed-roots', message: '/etc is not inside an allowed root' } },
        invalid: { v: V, t: 'env.response', requestId: 'env_1' },
        path: 'result'
    },
    quota: {
        valid: { v: V, t: 'quota', environmentId: env.id, snapshot: quotaOf([{ ...week, utilization: 0.76 }]) },
        invalid: { v: V, t: 'quota', environmentId: env.id, snapshot: quotaOf([{ ...week, utilization: 76 }]) },
        path: 'snapshot.windows.0.utilization'
    },
    telemetry: {
        valid: { v: V, t: 'telemetry', snapshot: telemetryOf({ s1: { cpu: 0.12, rss: 1_500_000_000, processes: 3 }, s2: null }) as never },
        invalid: { v: V, t: 'telemetry', snapshot: telemetryOf({ s1: { cpu: 12, rss: 1_500_000_000, processes: 3 } }) },
        path: 'snapshot.sessions.s1.cpu'
    },
    'history.response': {
        valid: { v: V, t: 'history.response', requestId: 'h_1', result: { events: [{ v: W, kind: 'event', epoch: 0, seq: 1, event: { type: 'part-delta', partId: 'p', delta: 'x', sessionId: 's1', epoch: 0, seq: 1 } }], more: true } },
        invalid: { v: V, t: 'history.response', requestId: 'h_1', result: { events: [] }, error: { code: 'gap', message: 'forgotten', earliest: cursor } },
        path: 'error'
    },
    'update.status': {
        valid: { v: V, t: 'update.status', requestId: 'u_1', phase: 'downloading', progress: { bytes: 10, total: 100 } },
        invalid: { v: V, t: 'update.status', requestId: 'u_1', phase: 'installing' },
        path: 'phase'
    },
    'harness.status': {
        valid: { v: V, t: 'harness.status', requestId: 'hr_1', phase: 'failed', error: { code: 'checksum', message: 'digest mismatch' } },
        invalid: { v: V, t: 'harness.status', requestId: 'hr_1', phase: 'restarting' },
        path: 'phase'
    },
    harnesses: {
        valid: { v: V, t: 'harnesses', harnesses: [{ runtime: 'claude-code', installed: { version: '2.1.0', at: 1 }, status: 'ready', current: true }, { runtime: 'codex-cli', status: 'missing' }] },
        invalid: { v: V, t: 'harnesses', harnesses: [{ runtime: 'claude-code', status: 'gone' }] },
        path: 'harnesses.0.status'
    },
    'policy.response': {
        valid: { v: V, t: 'policy.response', requestId: 'p_1', result: { policy: { webManaged: true, allowedRoots: ['/home/me'], source: 'web', requested: ['~'] } } },
        invalid: { v: V, t: 'policy.response', requestId: 'p_1', result: { policy: { webManaged: true, allowedRoots: ['/home/me'] } }, error: { code: 'policy-locked', message: 'locked' } },
        path: 'error'
    },
    'log.response': {
        valid: { v: V, t: 'log.response', requestId: 'l_1', result: { lines: ['{"level":"info","msg":"daemon: started"}'], truncated: false } },
        invalid: { v: V, t: 'log.response', requestId: 'l_1', error: { code: 'gone', message: 'no' } },
        path: 'error.code'
    },
    'login.status': {
        valid: { v: V, t: 'login.status', requestId: 'lg_1', environmentId: env.id, phase: 'action', action: { kind: 'device-code', url: 'https://github.com/login/device', code: 'ABCD-1234', expectsPaste: false } },
        invalid: { v: V, t: 'login.status', requestId: 'lg_1', environmentId: env.id, phase: 'waiting', action: { kind: 'open-url', url: 'https://x.test', expectsPaste: true } },
        path: 'action'
    }
};

const platformCases: { readonly [T in PlatformFrameType]: Case<Extract<PlatformFrame, { t: T }>> } = {
    welcome: { valid: { v: V, t: 'welcome', serverTime: 1, wanted: { s1: cursor } }, invalid: { v: V, t: 'welcome', serverTime: 1, wanted: { s1: { epoch: 0, seq: 1.5 } } }, path: 'wanted.s1.seq' },
    'session.open': {
        valid: { v: V, t: 'session.open', sessionId: 's1' as never, environmentId: env.id, spec: { agentId: 'a', cwd: '/work', system: 'be good', tools: ['echo'], maxTurns: 3 } },
        invalid: { v: V, t: 'session.open', sessionId: 's1', environmentId: env.id, spec: { agentId: 'a', cwd: '/work', system: 'be good', tools: ['echo'], maxTurns: 0 } },
        path: 'spec.maxTurns'
    },
    'session.command': {
        valid: { v: V, t: 'session.command', sessionId: 's1' as never, command: { v: W, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'hi' }] } },
        invalid: { v: V, t: 'session.command', sessionId: 's1', command: { v: W, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'image', mediaType: 'image/png' }] } },
        path: 'command.input.0'
    },
    'session.close': { valid: { v: V, t: 'session.close', sessionId: 's1' as never }, invalid: { v: V, t: 'session.close' }, path: 'sessionId' },
    'tool.result': {
        valid: { v: V, t: 'tool.result', callId: 'k1', error: { code: 'boom', message: 'no' } },
        invalid: { v: V, t: 'tool.result', callId: 'k1', output: 1, error: { code: 'boom', message: 'no' } },
        path: 'error'
    },
    ping: { valid: { v: V, t: 'ping' }, invalid: { v: V, t: 'ping', extra: 1 }, path: '' },
    'fs.request': {
        valid: { v: V, t: 'fs.request', requestId: 'fs_1', environmentId: env.id, op: { kind: 'worktree', repo: '/work/app', branch: 'feat/x', base: 'main', path: '/work/app-worktrees/feat-x' } },
        invalid: { v: V, t: 'fs.request', requestId: 'fs_1', environmentId: env.id, op: { kind: 'list', path: '' } },
        path: 'op.path'
    },
    'env.request': {
        valid: { v: V, t: 'env.request', requestId: 'env_1', op: 'put', environment: { id: env.id, name: 'Work', runtime: 'in-memory', cwdRoots: ['/work/app'], concurrency: 2, accountLabel: 'work' } },
        // A profile directory never crosses the wire: the input is strict, so the key fails the frame instead of being stripped.
        invalid: { v: V, t: 'env.request', requestId: 'env_1', op: 'put', environment: { name: 'Work', runtime: 'in-memory', cwdRoots: ['/work/app'], profileDir: '/home/me/.claude' } },
        path: 'environment'
    },
    'history.request': {
        valid: { v: V, t: 'history.request', requestId: 'h_1', sessionId: 's1' as never, from: cursor, to: { epoch: 0, seq: 9 }, limit: 100 },
        invalid: { v: V, t: 'history.request', requestId: 'h_1', sessionId: 's1', from: cursor, limit: 0 },
        path: 'limit'
    },
    'update.request': {
        valid: { v: V, t: 'update.request', requestId: 'u_1', target: { url: 'https://example.test/d.zip', sha256: 'ab12'.repeat(16), bytes: 100, version: '1.2.0' }, mode: 'drain', drainTimeoutMs: 600000 },
        invalid: { v: V, t: 'update.request', requestId: 'u_1', target: 'previous', mode: 'later', drainTimeoutMs: 0 },
        path: 'mode'
    },
    'update.cancel': { valid: { v: V, t: 'update.cancel', requestId: 'u_1' }, invalid: { v: V, t: 'update.cancel', requestId: '' }, path: 'requestId' },
    'harness.request': {
        valid: { v: V, t: 'harness.request', requestId: 'hr_1', op: 'remove', runtime: 'codex-cli', mode: 'now' },
        invalid: { v: V, t: 'harness.request', requestId: 'hr_1', op: 'upgrade', runtime: 'codex-cli', mode: 'now' },
        path: 'op'
    },
    'policy.request': {
        valid: { v: V, t: 'policy.request', requestId: 'p_1', op: 'set', policy: { allowedRoots: ['~', 'C:\\src'] } },
        // The input is strict: a key the contract does not name fails the frame.
        invalid: { v: V, t: 'policy.request', requestId: 'p_1', op: 'set', policy: { allowedRoots: ['~'], locked: false } },
        path: 'policy'
    },
    'log.request': { valid: { v: V, t: 'log.request', requestId: 'l_1', lines: 200 }, invalid: { v: V, t: 'log.request', requestId: 'l_1', lines: 0 }, path: 'lines' },
    'login.request': { valid: { v: V, t: 'login.request', requestId: 'lg_1', environmentId: env.id }, invalid: { v: V, t: 'login.request', requestId: 'lg_1' }, path: 'environmentId' },
    'login.answer': { valid: { v: V, t: 'login.answer', requestId: 'lg_1', text: 'code#state' }, invalid: { v: V, t: 'login.answer', requestId: 'lg_1', text: '' }, path: 'text' },
    'login.cancel': { valid: { v: V, t: 'login.cancel', requestId: 'lg_1' }, invalid: { v: V, t: 'login.cancel' }, path: 'requestId' }
};

describe('daemon frame schemas', () => {
    it('session.ref needs both the session and the ref (#388)', () => {
        const ref = { agent: 'claude-code', v: 1, id: 'a1b2c3' };
        expect(daemonFrameSchemas['session.ref'].safeParse({ v: V, t: 'session.ref', sessionId: 's1', ref }).success).toBe(true);
        const noSession = daemonFrameSchemas['session.ref'].safeParse({ v: V, t: 'session.ref', ref });
        expect(noSession.success).toBe(false);
        if (!noSession.success) expect(noSession.error.issues.map((i) => i.path.join('.'))).toContain('sessionId');
        const noRef = daemonFrameSchemas['session.ref'].safeParse({ v: V, t: 'session.ref', sessionId: 's1' });
        expect(noRef.success).toBe(false);
        if (!noRef.success) expect(noRef.error.issues.map((i) => i.path.join('.'))).toContain('ref');
        expect(daemonFrameSchemas['session.ref'].safeParse({ v: V, t: 'session.ref', sessionId: 's1', ref: { agent: 'claude-code', v: 1 } }).success).toBe(false);
    });

    it('cover every kind core declares', () => {
        expect(Object.keys(daemonFrameSchemas).sort()).toEqual([...DAEMON_FRAME_TYPES].sort());
        expect(Object.keys(platformFrameSchemas).sort()).toEqual([...PLATFORM_FRAME_TYPES].sort());
    });

    for (const t of DAEMON_FRAME_TYPES) {
        const c = daemonCases[t];
        it(`${t}: accepts a valid frame and refuses an invalid one`, () => {
            expect(daemonFrameSchemas[t].safeParse(c.valid).success).toBe(true);
            expect(daemonFrame.safeParse(c.valid)).toEqual({ success: true, data: c.valid });
            const bad = daemonFrameSchemas[t].safeParse(c.invalid);
            expect(bad.success).toBe(false);
            if (c.path && !bad.success) expect(bad.error.issues.map((i) => i.path.join('.'))).toContain(c.path);
            expect(daemonFrame.safeParse(c.invalid).success).toBe(false);
        });
    }

    for (const t of PLATFORM_FRAME_TYPES) {
        const c = platformCases[t];
        it(`${t}: accepts a valid frame and refuses an invalid one`, () => {
            expect(platformFrameSchemas[t].safeParse(c.valid).success).toBe(true);
            expect(platformFrame.safeParse(c.valid)).toEqual({ success: true, data: c.valid });
            const bad = platformFrameSchemas[t].safeParse(c.invalid);
            if (t === 'ping') {
                // Unknown keys are stripped rather than refused: forward compatibility within a version.
                expect(bad).toEqual({ success: true, data: c.valid });
                return;
            }
            expect(bad.success).toBe(false);
            if (c.path && !bad.success) expect(bad.error.issues.map((i) => i.path.join('.'))).toContain(c.path);
            expect(platformFrame.safeParse(c.invalid).success).toBe(false);
        });
    }

    it('env.request: each op carries its own field, and only a bounded, non-empty input', () => {
        const put = { v: V, t: 'env.request', requestId: 'env_1', op: 'put', environment: { name: 'Work', runtime: 'in-memory', cwdRoots: ['/work'] } };
        expect(platformFrame.safeParse(put)).toEqual({ success: true, data: put });
        const remove = { v: V, t: 'env.request', requestId: 'env_2', op: 'remove', environmentId: env.id };
        expect(platformFrame.safeParse(remove)).toEqual({ success: true, data: remove });
        expect(platformFrame.safeParse({ v: V, t: 'env.request', requestId: 'env_3', op: 'put', environmentId: env.id }).success).toBe(false);
        expect(platformFrame.safeParse({ v: V, t: 'env.request', requestId: 'env_4', op: 'remove' }).success).toBe(false);
        expect(platformFrame.safeParse({ v: V, t: 'env.request', requestId: 'env_5', op: 'rename', environmentId: env.id }).success).toBe(false);
        expect(platformFrame.safeParse({ ...put, environment: { ...put.environment, cwdRoots: [] } }).success).toBe(false);
        expect(platformFrame.safeParse({ ...put, environment: { ...put.environment, concurrency: 0 } }).success).toBe(false);
    });

    it('hello and env may carry the machine policy; an env.response carries result or error, never both', () => {
        const policy = { webManaged: true, allowedRoots: ['/work'] };
        const hello = { ...daemonCases.hello.valid, policy };
        expect(daemonFrame.safeParse(hello)).toEqual({ success: true, data: hello });
        const changed = { v: V, t: 'env', environments: [env], policy: { webManaged: false, allowedRoots: [] } };
        expect(daemonFrame.safeParse(changed)).toEqual({ success: true, data: changed });
        expect(daemonFrame.safeParse({ ...hello, policy: { webManaged: 'yes', allowedRoots: [] } }).success).toBe(false);
        const ok = { v: V, t: 'env.response', requestId: 'env_1', result: { environmentId: env.id } };
        expect(daemonFrame.safeParse(ok)).toEqual({ success: true, data: ok });
        expect(daemonFrame.safeParse({ ...ok, error: { code: 'io', message: 'disk' } }).success).toBe(false);
        expect(daemonFrame.safeParse({ v: V, t: 'env.response', requestId: 'env_1', error: { code: 'nope', message: 'x' } }).success).toBe(false);
    });

    it('a capability says how its environments sign in (#484): relay, terminal, or nothing from an older daemon', () => {
        const relay = { ...daemonCases.hello.valid, capabilities: [{ ...IN_MEMORY_CAPABILITIES, login: 'relay' }] };
        expect(daemonFrame.safeParse(relay)).toEqual({ success: true, data: relay });
        const terminal = { ...daemonCases.hello.valid, capabilities: [{ ...IN_MEMORY_CAPABILITIES, login: 'terminal' }] };
        expect(daemonFrame.safeParse(terminal)).toEqual({ success: true, data: terminal });
        const { login: _login, ...older } = IN_MEMORY_CAPABILITIES;
        const old = { ...daemonCases.hello.valid, capabilities: [older] };
        expect(daemonFrame.safeParse(old)).toEqual({ success: true, data: old });
        expect(daemonFrame.safeParse({ ...daemonCases.hello.valid, capabilities: [{ ...IN_MEMORY_CAPABILITIES, login: 'browser' }] }).success).toBe(false);
    });

    it('hello, welcome and session.closed keep the lifecycle fields (#359); an older frame still parses', () => {
        const hello = {
            ...daemonCases.hello.valid,
            build: { version: '1.2.0', commit: 'abc1234', protocol: V, channel: 'stable', platform: 'win32-x64' },
            features: ['update', 'harness'],
            restarts: 2,
            lastExit: { at: 1, reason: 'crashed', code: 1 },
            lastUpdate: { from: '1.1.0', to: '1.2.0', outcome: 'applied', at: 2 },
            harnesses: [{ runtime: 'claude-code', status: 'ready' }]
        };
        expect(daemonFrame.safeParse(hello)).toEqual({ success: true, data: hello });
        // A feature this end does not know is dropped (#360): a newer daemon still pairs.
        expect(daemonFrame.safeParse({ ...hello, features: ['suspend'] })).toMatchObject({ success: true, data: { features: [] } });
        // The asset key the platform picks a release asset by is required on a build.
        expect(daemonFrame.safeParse({ ...hello, build: { version: '1.2.0', commit: 'abc1234', protocol: V, channel: 'stable' } }).success).toBe(false);
        const welcome = { ...platformCases.welcome.valid, platform: { version: '1.3.0', minDaemonVersion: '1.0.0', latest: { stable: '1.2.0', latest: '1.3.0-rc.1' } } };
        expect(platformFrame.safeParse(welcome)).toEqual({ success: true, data: welcome });
        const closed = { v: V, t: 'session.closed', sessionId: 's1', reason: 'the daemon is updating', code: 'update' };
        expect(daemonFrame.safeParse(closed)).toEqual({ success: true, data: closed });
        expect(daemonFrame.safeParse({ ...closed, code: 'suspended' }).success).toBe(false);
    });

    it('a quota frame carries a normalized snapshot for its own environment (#261)', () => {
        const session = { id: 'five_hour', label: 'Current session', period: 'session', utilization: null, unit: 'percent', status: 'unknown' };
        const ok = { v: V, t: 'quota', environmentId: env.id, snapshot: quotaOf([week, session]) };
        expect(daemonFrame.safeParse(ok)).toEqual({ success: true, data: ok });
        const none = { v: V, t: 'quota', environmentId: env.id, snapshot: { ...(quotaOf([]) as object), availability: 'not-reported', reason: 'API-key login: no subscription limits' } };
        expect(daemonFrame.safeParse(none).success).toBe(true);
        expect(daemonFrame.safeParse({ ...none, snapshot: { ...none.snapshot, reason: undefined } }).success).toBe(false);
        expect(daemonFrame.safeParse({ ...none, snapshot: { ...none.snapshot, windows: [week] } }).success).toBe(false);
        expect(daemonFrame.safeParse({ ...ok, snapshot: { ...(quotaOf([]) as object), environmentId: 'env_other' } }).success).toBe(false);
        expect(daemonFrame.safeParse({ ...ok, snapshot: quotaOf([{ ...week, resetsAt: 'next tuesday' }]) }).success).toBe(false);
        expect(daemonFrame.safeParse({ ...ok, snapshot: quotaOf([{ ...week, status: 'fine' }]) }).success).toBe(false);
    });

    it('a telemetry frame says what it could not attribute, and a not-reported one why (#400)', () => {
        const ok = { v: V, t: 'telemetry', snapshot: telemetryOf({ s1: { cpu: 0.12, rss: 1_500_000_000, processes: 3 }, s2: null }) };
        expect(daemonFrame.safeParse(ok)).toEqual({ success: true, data: ok });
        const none = { v: V, t: 'telemetry', snapshot: { ...telemetryOf({}), availability: 'not-reported', reason: 'telemetry is off (--telemetry off)' } };
        expect(daemonFrame.safeParse(none).success).toBe(true);
        expect(daemonFrame.safeParse({ ...none, snapshot: { ...none.snapshot, reason: undefined } }).success).toBe(false);
        expect(daemonFrame.safeParse({ ...ok, snapshot: { ...ok.snapshot, environments: { [env.id]: { sample: null, attribution: 'guess' } } } }).success).toBe(false);
        expect(daemonFrame.safeParse({ ...ok, snapshot: { ...ok.snapshot, machine: { ...ok.snapshot.machine, memoryTotal: -1 } } }).success).toBe(false);
        expect(daemonFrame.safeParse({ ...ok, snapshot: telemetryOf({ s1: { cpu: null, rss: 1.5, processes: 1 } }) }).success).toBe(false);
    });

    it('are Standard Schemas', async () => {
        const std = daemonFrameSchemas.pong['~standard'];
        expect(std.version).toBe(1);
        expect(std.vendor).toBe('zod');
        expect(await std.validate({ v: V, t: 'pong', at: 1 })).toEqual({ value: { v: V, t: 'pong', at: 1 } });
        const bad = await std.validate({ v: V, t: 'pong' });
        expect(bad.issues?.length).toBeGreaterThan(0);
    });

    it('bound every list, string and record', () => {
        const long = 'x'.repeat(LIMITS.id + 1);
        expect(daemonFrameSchemas.pong.safeParse({ v: V, t: 'pong', at: 1 }).success).toBe(true);
        expect(daemonFrameSchemas['session.closed'].safeParse({ v: V, t: 'session.closed', sessionId: long, reason: '' }).success).toBe(false);
        expect(daemonFrameSchemas['session.closed'].safeParse({ v: V, t: 'session.closed', sessionId: 's', reason: 'y'.repeat(LIMITS.text + 1) }).success).toBe(false);
        expect(platformFrameSchemas['session.open'].safeParse({ ...platformCases['session.open'].valid, spec: { ...platformCases['session.open'].valid.spec, tools: Array.from({ length: LIMITS.list + 1 }, () => 't') } }).success).toBe(false);
        const wanted = Object.fromEntries(Array.from({ length: LIMITS.list + 1 }, (_, i) => [`s${i}`, cursor]));
        expect(platformFrameSchemas.welcome.safeParse({ v: V, t: 'welcome', serverTime: 1, wanted }).success).toBe(false);
    });

    it('session.open carries the compiled-policy input (#121): rules, grants and constraints survive decoding, a bad outcome is refused', () => {
        const spec = { ...platformCases['session.open'].valid.spec, policy: { rules: [{ id: 'r1', match: { categories: ['destructive'] }, outcome: 'ask' }], grants: [{ name: 'rm', mode: 'ask' }, { name: 'ls' }], constraints: [{ id: 'c1', match: { tools: ['rm'] }, outcome: 'deny', scope: 'once' }] } };
        const parsed = platformFrameSchemas['session.open'].safeParse({ ...platformCases['session.open'].valid, spec });
        expect(parsed.success).toBe(true);
        expect((parsed.data as { spec: unknown }).spec).toEqual(spec);
        expect(platformFrameSchemas['session.open'].safeParse({ ...platformCases['session.open'].valid, spec: { ...spec, policy: { rules: [{ id: 'r1', match: {}, outcome: 'maybe' }], grants: [] } } }).success).toBe(false);
        expect(platformFrameSchemas['session.open'].safeParse({ ...platformCases['session.open'].valid, spec: { ...spec, policy: { rules: Array.from({ length: LIMITS.list + 1 }, (_, i) => ({ id: `r${i}`, match: {}, outcome: 'allow' })), grants: [] } } }).success).toBe(false);
    });

    it('session.open carries the permission mode and env frames the account’s models and bypass flag (#450); both stay optional', () => {
        const spec = { ...platformCases['session.open'].valid.spec, model: 'claude-fable-5-1', permissionMode: 'plan' };
        const parsed = platformFrameSchemas['session.open'].safeParse({ ...platformCases['session.open'].valid, spec });
        expect(parsed.success).toBe(true);
        expect((parsed.data as { spec: unknown }).spec).toEqual(spec);
        const described = { ...env, models: [{ id: 'claude-fable-5-1', label: 'Fable', description: 'most capable' }, { id: 'opus' }], allowBypassPermissions: true };
        const frame = daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [described] });
        expect(frame.success).toBe(true);
        expect(frame.data?.environments[0]).toEqual(described);
        expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [{ ...env, models: [{ label: 'no id' }] }] }).success).toBe(false);
        expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [{ ...env, allowBypassPermissions: 'yes' }] }).success).toBe(false);
    });

    it('session.open carries the agent’s MCP connectors (#280) with secret names; a bad transport or a value-shaped auth is refused', () => {
        const connectors = [
            { id: 'acme', transport: 'streamable-http', url: 'https://mcp.acme.test/mcp', auth: { bearer: 'acme.token', headers: { 'X-Team': 'acme.team' } } },
            { id: 'files', transport: 'stdio', command: 'files-mcp', args: ['--ro'], cwd: '/work/repo', auth: { env: { FILES_KEY: 'files.key' } } }
        ];
        const open = (c: unknown) => platformFrameSchemas['session.open'].safeParse({ ...platformCases['session.open'].valid, spec: { ...platformCases['session.open'].valid.spec, connectors: c } });
        const parsed = open(connectors);
        expect(parsed.success).toBe(true);
        expect((parsed.data as { spec: { connectors: unknown } }).spec.connectors).toEqual(connectors);
        expect(open([{ id: 'x', transport: 'websocket' }]).success).toBe(false);
        expect(open([{ id: 'x', transport: 'stdio', auth: { env: { KEY: { value: 'v' } } } }]).success).toBe(false);
        expect(open([{ id: '', transport: 'stdio' }]).success).toBe(false);
    });

    it('bound the wire command payloads: output spec name and configure patch', () => {
        const command = (c: Record<string, unknown>) => platformFrameSchemas['session.command'].safeParse({ v: V, t: 'session.command', sessionId: 's1', command: { v: W, commandId: 'c1', ...c } }).success;
        const prompt = { type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'hi' }] };
        expect(command({ ...prompt, output: { schema: {}, name: 'answer' } })).toBe(true);
        expect(command({ ...prompt, output: { schema: {}, name: 'x'.repeat(LIMITS.id + 1) } })).toBe(false);
        expect(command({ ...prompt, output: { schema: {}, name: '' } })).toBe(false);
        expect(command({ type: 'configure', patch: { model: 'opus' } })).toBe(true);
        expect(command({ type: 'configure', patch: { '': 'opus' } })).toBe(false);
        const patch = Object.fromEntries(Array.from({ length: LIMITS.list + 1 }, (_, i) => [`k${i}`, 'v']));
        expect(command({ type: 'configure', patch })).toBe(false);
    });

    it('require exactly one of output or error on tool.result', () => {
        const result = (f: Record<string, unknown>) => platformFrameSchemas['tool.result'].safeParse({ v: V, t: 'tool.result', callId: 'k1', ...f });
        expect(result({ output: { x: 1 } }).success).toBe(true);
        expect(result({ output: null }).success).toBe(true);
        expect(result({ error: { code: 'boom', message: 'no' } }).success).toBe(true);
        const neither = result({});
        expect(neither.success).toBe(false);
        expect(neither.error?.issues[0]?.path).toEqual(['output']);
    });

    it('require exactly one of result or error on fs.response, and bound a listing (#187)', () => {
        const response = (f: Record<string, unknown>) => daemonFrameSchemas['fs.response'].safeParse({ v: V, t: 'fs.response', requestId: 'fs_1', ...f });
        const listing = (n: number) => ({ kind: 'list', path: '/work', parent: '/', entries: Array.from({ length: n }, (_, i) => ({ name: `d${i}`, path: `/work/d${i}` })), truncated: n === FS_LIST_MAX_ENTRIES });
        expect(response({ result: listing(FS_LIST_MAX_ENTRIES) }).success).toBe(true);
        expect(response({ result: listing(FS_LIST_MAX_ENTRIES + 1) }).success).toBe(false);
        expect(response({ result: { kind: 'worktree', path: '/work/b', branch: 'feat/b' } }).success).toBe(true);
        const located = (n: number) => ({ kind: 'locate', origin: 'https://github.com/andtii/agentic.git', matches: Array.from({ length: n }, (_, i) => ({ path: `/work/r${i}`, git: { kind: 'repo', branch: 'main', origin: 'https://github.com/andtii/agentic.git' } })), truncated: n === FS_LOCATE_MAX_MATCHES });
        expect(response({ result: located(0) }).success).toBe(true);
        expect(response({ result: located(FS_LOCATE_MAX_MATCHES) }).success).toBe(true);
        expect(response({ result: located(FS_LOCATE_MAX_MATCHES + 1) }).success).toBe(false);
        expect(response({ result: { kind: 'locate', origin: '', matches: [], truncated: false } }).success).toBe(false);
        expect(response({ result: { kind: 'locate', origin: 'x', matches: [{ path: '/work/r', git: { kind: 'repo', origin: '' } }], truncated: false } }).success).toBe(false);
        expect(response({ error: { code: 'outside-roots', message: 'no' } }).success).toBe(true);
        expect(response({ error: { code: 'teapot', message: 'no' } }).success).toBe(false);
        const neither = response({});
        expect(neither.success).toBe(false);
        expect(neither.error?.issues[0]?.path).toEqual(['result']);
        expect(daemonFrameSchemas['fs.response'].safeParse({ v: V, t: 'fs.response', error: { code: 'internal', message: 'x' } }).success).toBe(false);
        expect(platformFrameSchemas['fs.request'].safeParse({ v: V, t: 'fs.request', requestId: 'fs_1', environmentId: env.id, op: { kind: 'delete', path: '/work' } }).success).toBe(false);
    });

    it('fs.request locate names an origin, with an optional depth (#331)', () => {
        const request = (op: Record<string, unknown>) => platformFrameSchemas['fs.request'].safeParse({ v: V, t: 'fs.request', requestId: 'fs_1', environmentId: env.id, op });
        const locate = { kind: 'locate', origin: 'git@github.com:andtii/agentic.git' };
        expect(request(locate)).toMatchObject({ success: true, data: { op: locate } });
        expect(request({ ...locate, depth: 2 }).success).toBe(true);
        expect(request({ ...locate, depth: 1.5 }).success).toBe(false);
        expect(request({ ...locate, depth: -1 }).success).toBe(false);
        const missing = request({ kind: 'locate' });
        expect(missing.success).toBe(false);
        if (!missing.success) expect(missing.error.issues.map((i) => i.path.join('.'))).toContain('op.origin');
        expect(request({ kind: 'locate', origin: '' }).success).toBe(false);
        expect(request({ kind: 'locate', origin: 'x'.repeat(LIMITS.text + 1) }).success).toBe(false);
    });

    it('history frames (#397): a platform-stamped cursor may be fractional, the answer carries event frames and exactly one of result or error, a gap may name the earliest cursor', () => {
        const request = (f: Record<string, unknown>) => platformFrameSchemas['history.request'].safeParse({ v: V, t: 'history.request', requestId: 'h_1', sessionId: 's1', ...f });
        expect(request({ from: { epoch: 1, seq: 5.5 } }).success).toBe(true);
        expect(request({ from: { epoch: 1, seq: 5 }, to: { epoch: 1, seq: 7.5 } }).success).toBe(true);
        expect(request({ from: { epoch: 1, seq: -1 } }).success).toBe(false);
        expect(request({ from: { epoch: 1, seq: Infinity } }).success).toBe(false);
        expect(request({ from: { epoch: 1, seq: 1 }, to: { epoch: 1, seq: Number.NaN } }).success).toBe(false);
        expect(request({ from: { epoch: 1 } }).success).toBe(false);
        expect(request({}).success).toBe(false);
        expect(request({ from: cursor, limit: LIMITS.list + 1 }).success).toBe(false);
        expect(request({ from: cursor, limit: 1.5 }).success).toBe(false);

        const response = (f: Record<string, unknown>) => daemonFrameSchemas['history.response'].safeParse({ v: V, t: 'history.response', requestId: 'h_1', ...f });
        const frame = (seq: number) => ({ v: W, kind: 'event', epoch: 0, seq, event: { type: 'part-delta', partId: 'p', delta: 'x', sessionId: 's1', epoch: 0, seq } });
        expect(response({ result: { events: [] } }).success).toBe(true);
        expect(response({ result: { events: [frame(1), frame(2)], more: false } }).success).toBe(true);
        // Only event frames: a hello or a gap is no history.
        expect(response({ result: { events: [{ v: W, kind: 'gap', from: cursor, resumeAt: cursor }] } }).success).toBe(false);
        expect(response({ result: { events: [{ ...frame(1), event: { type: 'part-delta' } }] } }).success).toBe(false);
        expect(response({ result: { events: Array.from({ length: LIMITS.list + 1 }, (_, i) => frame(i + 1)) } }).success).toBe(false);
        expect(response({ error: { code: 'gap', message: 'the log starts later', earliest: { epoch: 0, seq: 40 } } }).success).toBe(true);
        expect(response({ error: { code: 'unknown-session', message: 'no log' } }).success).toBe(true);
        expect(response({ error: { code: 'teapot', message: 'no' } }).success).toBe(false);
        const neither = response({});
        expect(neither.success).toBe(false);
        expect(neither.error?.issues[0]?.path).toEqual(['result']);
        expect(response({ result: { events: [] }, error: { code: 'internal', message: 'both' } }).success).toBe(false);
    });

    describe('lifecycle frames (#360)', () => {
        const asset = { url: 'https://releases.example.test/agentic-daemon-1.2.0-win32-x64.zip', sha256: 'ab'.repeat(32), bytes: 100, version: '1.2.0' };
        const request = (target: unknown, extra: Record<string, unknown> = {}) => platformFrameSchemas['update.request'].safeParse({ v: V, t: 'update.request', requestId: 'u_1', target, mode: 'drain', drainTimeoutMs: 600_000, ...extra });
        const issues = (r: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[] }[] } }) => r.error?.issues.map((i) => i.path.join('.')) ?? [];

        it('an update target is a strict release asset over https with a 64-hex digest, or previous', () => {
            expect(request(asset)).toEqual({ success: true, data: { v: V, t: 'update.request', requestId: 'u_1', target: asset, mode: 'drain', drainTimeoutMs: 600_000 } });
            expect(request('previous').success).toBe(true);
            expect(request('restart').success).toBe(true); // #355: the same build again, nothing downloaded
            expect(request({ ...asset, sha256: 'AB'.repeat(32) }).success).toBe(true);
            expect(request('latest').success).toBe(false);
            for (const bad of [
                { ...asset, url: 'http://releases.example.test/d.zip' },
                { ...asset, url: 'file:///C:/d.zip' },
                { ...asset, url: 'not a url' },
                { ...asset, url: `https://x.test/${'x'.repeat(LIMITS.text)}` },
                { ...asset, sha256: 'ab12' },
                { ...asset, sha256: 'zz'.repeat(32) },
                { ...asset, sha256: 'ab'.repeat(33) },
                { ...asset, bytes: 0 },
                { ...asset, bytes: 1.5 },
                { ...asset, version: '' },
                { ...asset, token: 'secret' }
            ])
                expect(request(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
            expect(issues(request({ ...asset, url: 'http://x.test/d.zip' }))).toContain('target.url');
            expect(request(asset, { drainTimeoutMs: LIMITS.drainTimeoutMs }).success).toBe(true);
            expect(request(asset, { drainTimeoutMs: LIMITS.drainTimeoutMs + 1 }).success).toBe(false);
            expect(request(asset, { drainTimeoutMs: -1 }).success).toBe(false);
        });

        it('a harness request names a runtime, an op, a mode and at most a strict asset', () => {
            const harness = (f: Record<string, unknown>) => platformFrameSchemas['harness.request'].safeParse({ v: V, t: 'harness.request', requestId: 'hr_1', op: 'install', runtime: 'claude-code', mode: 'drain', ...f });
            expect(harness({ target: asset }).success).toBe(true);
            expect(harness({ op: 'remove', mode: 'now' }).success).toBe(true);
            expect(harness({ target: { ...asset, url: 'http://x.test/h.zip' } }).success).toBe(false);
            expect(harness({ target: 'previous' }).success).toBe(false);
            expect(harness({ runtime: '' }).success).toBe(false);
            expect(harness({ runtime: 'x'.repeat(LIMITS.id + 1) }).success).toBe(false);
            expect(harness({ mode: 'later' }).success).toBe(false);
            expect(platformFrameSchemas['update.cancel'].safeParse({ v: V, t: 'update.cancel', requestId: 'x'.repeat(LIMITS.id + 1) }).success).toBe(false);
        });

        it('a status carries an error exactly when it failed, and progress never passes its total', () => {
            const update = (f: Record<string, unknown>) => daemonFrameSchemas['update.status'].safeParse({ v: V, t: 'update.status', requestId: 'u_1', ...f });
            for (const phase of UPDATE_PHASES.filter((p) => p !== 'failed')) expect(update({ phase }).success, phase).toBe(true);
            expect(update({ phase: 'failed', error: { code: 'checksum', message: 'digest mismatch' } }).success).toBe(true);
            expect(issues(update({ phase: 'failed' }))).toContain('error');
            expect(issues(update({ phase: 'staged', error: { code: 'x', message: 'y' } }))).toContain('error');
            expect(update({ phase: 'failed', error: { code: '', message: 'y' } }).success).toBe(false);
            expect(update({ phase: 'failed', error: { code: 'x', message: 'y'.repeat(LIMITS.text + 1) } }).success).toBe(false);
            expect(update({ phase: 'downloading', progress: { bytes: 100, total: 100 } }).success).toBe(true);
            expect(issues(update({ phase: 'downloading', progress: { bytes: 101, total: 100 } }))).toContain('progress.bytes');
            expect(update({ phase: 'downloading', progress: { bytes: -1, total: 100 } }).success).toBe(false);

            const harness = (f: Record<string, unknown>) => daemonFrameSchemas['harness.status'].safeParse({ v: V, t: 'harness.status', requestId: 'hr_1', ...f });
            for (const phase of HARNESS_PHASES.filter((p) => p !== 'failed')) expect(harness({ phase }).success, phase).toBe(true);
            expect(harness({ phase: 'failed', error: { code: 'in-use', message: 'an environment runs on it' } }).success).toBe(true);
            expect(harness({ phase: 'failed' }).success).toBe(false);
            expect(harness({ phase: 'done', error: { code: 'x', message: 'y' } }).success).toBe(false);
        });

        it('a daemon reports at most 16 harnesses, each bounded', () => {
            const report = (i: number) => ({ runtime: `runtime-${i}`, installed: { version: '1.0.0', at: 1 }, status: 'ready' });
            const frame = (harnesses: unknown[]) => daemonFrameSchemas.harnesses.safeParse({ v: V, t: 'harnesses', harnesses });
            expect(LIMITS.harnesses).toBe(16);
            expect(frame(Array.from({ length: 16 }, (_, i) => report(i))).success).toBe(true);
            expect(frame(Array.from({ length: 17 }, (_, i) => report(i))).success).toBe(false);
            expect(frame([{ runtime: 'claude-code', status: 'missing' }]).success).toBe(true);
            expect(frame([{ ...report(0), installed: { version: '', at: 1 } }]).success).toBe(false);
            expect(frame([{ ...report(0), installed: { version: '1.0.0', at: -1 } }]).success).toBe(false);
            expect(daemonFrame.safeParse({ ...daemonCases.hello.valid, harnesses: Array.from({ length: 17 }, (_, i) => report(i)) }).success).toBe(false);
        });

        it('hello: the build and the lifecycle history are bounded; a feature this end does not know is dropped, not fatal', () => {
            const build = { version: '1.2.0', commit: 'abc1234', protocol: V, channel: 'stable', platform: 'darwin-arm64' };
            const hello = (f: Record<string, unknown>) => daemonFrame.safeParse({ ...daemonCases.hello.valid, build, ...f });
            expect(hello({})).toEqual({ success: true, data: { ...daemonCases.hello.valid, build } });
            expect(hello({ features: ['update', 'suspend', 'harness'] })).toMatchObject({ success: true, data: { features: ['update', 'harness'] } });
            expect(hello({ features: Array.from({ length: 17 }, () => 'update') }).success).toBe(false);
            expect(hello({ features: [''] }).success).toBe(false);
            expect(hello({ build: { ...build, platform: '' } }).success).toBe(false);
            expect(hello({ build: { ...build, commit: 'x'.repeat(LIMITS.id + 1) } }).success).toBe(false);
            expect(hello({ build: { ...build, protocol: -1 } }).success).toBe(false);
            expect(hello({ restarts: -1 }).success).toBe(false);
            expect(hello({ restarts: 1.5 }).success).toBe(false);
            expect(hello({ lastExit: { at: 1, reason: 'x'.repeat(LIMITS.text + 1) } }).success).toBe(false);
            expect(hello({ lastExit: { at: 1, reason: 'killed', code: 1.5 } }).success).toBe(false);
            expect(hello({ lastUpdate: { from: '1.1.0', to: '1.2.0', outcome: 'skipped', at: 1 } }).success).toBe(false);
            expect(hello({ lastUpdate: { from: '1.1.0', to: '1.2.0', outcome: 'rolled-back', at: 1, error: 'y'.repeat(LIMITS.text + 1) } }).success).toBe(false);
        });

        it('welcome.platform is bounded; session.closed takes every SessionClosedCode and nothing else', () => {
            const welcome = (platform: unknown) => platformFrameSchemas.welcome.safeParse({ ...platformCases.welcome.valid, platform });
            expect(welcome({ version: '1.3.0' }).success).toBe(true);
            expect(welcome({ version: '' }).success).toBe(false);
            expect(welcome({ version: '1.3.0', minDaemonVersion: 'x'.repeat(LIMITS.id + 1) }).success).toBe(false);
            expect(welcome({ version: '1.3.0', latest: { stable: '' } }).success).toBe(false);
            const closed = (code: unknown) => daemonFrameSchemas['session.closed'].safeParse({ v: V, t: 'session.closed', sessionId: 's1', reason: 'r', code });
            for (const code of SESSION_CLOSED_CODES) expect(closed(code).success, code).toBe(true);
            expect(closed('suspended').success).toBe(false);
            expect(closed(1).success).toBe(false);
        });

        it('are exported by name, next to the building blocks', () => {
            expect(updateStatusFrame).toBe(daemonFrameSchemas['update.status']);
            expect(harnessStatusFrame).toBe(daemonFrameSchemas['harness.status']);
            expect(harnessesFrame).toBe(daemonFrameSchemas.harnesses);
            expect(updateRequestFrame).toBe(platformFrameSchemas['update.request']);
            expect(updateCancelFrame).toBe(platformFrameSchemas['update.cancel']);
            expect(harnessRequestFrame).toBe(platformFrameSchemas['harness.request']);
            expect(releaseAsset.safeParse(asset).success).toBe(true);
            expect(harnessReports.safeParse([{ runtime: 'codex-cli', status: 'broken' }]).success).toBe(true);
            expect(harnessReport.safeParse({ runtime: 'codex-cli', status: 'gone' }).success).toBe(false);
            expect(lifecycleError.safeParse({ code: 'cancelled', message: 'the update was cancelled' }).success).toBe(true);
        });
    });

    it('refuse the wrong protocol version at the schema level too', () => {
        expect(daemonFrameSchemas.pong.safeParse({ v: V + 1, t: 'pong', at: 1 }).success).toBe(false);
        expect(platformFrameSchemas['session.command'].safeParse({ ...platformCases['session.command'].valid, command: { ...platformCases['session.command'].valid.command, v: W + 1 } }).success).toBe(false);
    });
});

describe('machines managed from the web (#355)', () => {
    const issues = (r: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[] }[] } }) => r.error?.issues.map((i) => i.path.join('.')) ?? [];

    it('hello and env carry the policy with or without source, locked and requested', () => {
        const bare = { webManaged: true, allowedRoots: ['/work'] };
        const full = { webManaged: true, allowedRoots: ['/home/me/src'], source: 'web', locked: false, requested: ['~/src'] };
        const off = { webManaged: false, allowedRoots: [], locked: true };
        for (const policy of [bare, full, off]) {
            expect(daemonFrameSchemas.hello.safeParse({ ...daemonCases.hello.valid, policy }).success, JSON.stringify(policy)).toBe(true);
            expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [env], policy }).success, JSON.stringify(policy)).toBe(true);
        }
        expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [env], policy: { ...bare, source: 'cloud' } }).success).toBe(false);
        expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [env], policy: { ...bare, requested: Array.from({ length: LIMITS.policyRoots + 1 }, (_, i) => `/r${i}`) } }).success).toBe(false);
        // A reported policy is bounded like a requested one: at most `policyRoots` folders of at most `policyRoot` characters.
        expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [env], policy: { ...bare, allowedRoots: Array.from({ length: LIMITS.policyRoots + 1 }, (_, i) => `/r${i}`) } }).success).toBe(false);
        expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [env], policy: { ...bare, allowedRoots: [`/${'x'.repeat(LIMITS.policyRoot)}`] } }).success).toBe(false);
        expect(daemonFrameSchemas.env.safeParse({ v: V, t: 'env', environments: [env], policy: { ...bare, allowedRoots: [`/${'x'.repeat(LIMITS.policyRoot - 1)}`] } }).success).toBe(true);
    });

    it('a policy request sets a bounded list of folders or browses one; the set input is strict', () => {
        const set = (policy: unknown) => platformFrameSchemas['policy.request'].safeParse({ v: V, t: 'policy.request', requestId: 'p_1', op: 'set', policy });
        expect(set({ allowedRoots: [] }).success).toBe(true);
        expect(set({ allowedRoots: ['~'] }).success).toBe(true);
        expect(set({ allowedRoots: Array.from({ length: LIMITS.policyRoots }, (_, i) => `/r${i}`) }).success).toBe(true);
        expect(set({ allowedRoots: Array.from({ length: LIMITS.policyRoots + 1 }, (_, i) => `/r${i}`) }).success).toBe(false);
        expect(set({ allowedRoots: [''] }).success).toBe(false);
        expect(set({ allowedRoots: [`/${'x'.repeat(LIMITS.policyRoot)}`] }).success).toBe(false);
        expect(set({ allowedRoots: ['~'], webManaged: true }).success).toBe(false);
        expect(set({ allowedRoots: ['~'], profileDir: '/x' }).success).toBe(false);
        const browse = (extra: Record<string, unknown>) => platformFrameSchemas['policy.request'].safeParse({ v: V, t: 'policy.request', requestId: 'p_1', op: 'browse', ...extra });
        expect(browse({}).success).toBe(true);
        expect(browse({ path: 'C:\\' }).success).toBe(true);
        expect(browse({ path: '' }).success).toBe(false);
        expect(platformFrameSchemas['policy.request'].safeParse({ v: V, t: 'policy.request', requestId: 'p_1', op: 'lock' }).success).toBe(false);
    });

    it('a policy response is exactly one of a policy, a listing or a named error', () => {
        const answer = (f: Record<string, unknown>) => daemonFrameSchemas['policy.response'].safeParse({ v: V, t: 'policy.response', requestId: 'p_1', ...f });
        expect(answer({ result: { policy: { webManaged: false, allowedRoots: [], source: 'web', requested: [] } } }).success).toBe(true);
        expect(answer({ result: { listing: { path: '', entries: [{ name: 'C:', path: 'C:\\' }], truncated: false } } }).success).toBe(true);
        expect(answer({ result: { listing: { path: '/home', parent: '/', entries: [], truncated: true } } }).success).toBe(true);
        for (const code of ['policy-locked', 'invalid', 'not-found', 'not-a-directory', 'remote-path', 'protected', 'io', 'timeout', 'unsupported']) expect(answer({ error: { code, message: code } }).success, code).toBe(true);
        expect(answer({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
        expect(answer({ result: { listing: { path: '', entries: Array.from({ length: FS_LIST_MAX_ENTRIES + 1 }, (_, i) => ({ name: `d${i}`, path: `/d${i}` })), truncated: true } } }).success).toBe(false);
        expect(issues(answer({})).at(0)).toBe('result');
        expect(answer({ result: { policy: { webManaged: false, allowedRoots: [] } }, error: { code: 'io', message: 'both' } }).success).toBe(false);
    });

    it('a log request and its answer are bounded, and the answer is result or error', () => {
        const ask = (lines: unknown) => platformFrameSchemas['log.request'].safeParse({ v: V, t: 'log.request', requestId: 'l_1', lines });
        expect(ask(1).success).toBe(true);
        expect(ask(LIMITS.logLines).success).toBe(true);
        expect(ask(LIMITS.logLines + 1).success).toBe(false);
        expect(ask(1.5).success).toBe(false);
        const answer = (f: Record<string, unknown>) => daemonFrameSchemas['log.response'].safeParse({ v: V, t: 'log.response', requestId: 'l_1', ...f });
        expect(answer({ result: { lines: Array.from({ length: LIMITS.logLines }, () => 'x'), truncated: true } }).success).toBe(true);
        expect(answer({ result: { lines: Array.from({ length: LIMITS.logLines + 1 }, () => 'x'), truncated: true } }).success).toBe(false);
        expect(answer({ error: { code: 'no-log', message: 'the daemon runs in a terminal' } }).success).toBe(true);
        expect(answer({}).success).toBe(false);
    });

    it('a login status carries its action exactly in the action phase and its error exactly when failed', () => {
        const status = (f: Record<string, unknown>) => daemonFrameSchemas['login.status'].safeParse({ v: V, t: 'login.status', requestId: 'lg_1', environmentId: env.id, ...f });
        const action = { kind: 'open-url', url: 'https://claude.ai/oauth/authorize?x=1', expectsPaste: true };
        expect(status({ phase: 'started' }).success).toBe(true);
        expect(status({ phase: 'action', action }).success).toBe(true);
        expect(status({ phase: 'action' }).success).toBe(false);
        expect(status({ phase: 'started', action }).success).toBe(false);
        expect(status({ phase: 'waiting' }).success).toBe(true);
        expect(status({ phase: 'done' }).success).toBe(true);
        expect(status({ phase: 'failed', error: { code: 'cancelled', message: 'cancelled' } }).success).toBe(true);
        expect(status({ phase: 'failed' }).success).toBe(false);
        expect(status({ phase: 'done', error: { code: 'failed', message: 'x' } }).success).toBe(false);
        expect(status({ phase: 'signing' }).success).toBe(false);
        expect(status({ phase: 'action', action: { ...action, kind: 'sms' } }).success).toBe(false);
    });

    it('a login answer is bounded text and nothing else', () => {
        const answer = (f: Record<string, unknown>) => platformFrameSchemas['login.answer'].safeParse({ v: V, t: 'login.answer', requestId: 'lg_1', ...f });
        expect(answer({ text: 'x'.repeat(LIMITS.loginAnswer) }).success).toBe(true);
        expect(answer({ text: 'x'.repeat(LIMITS.loginAnswer + 1) }).success).toBe(false);
        expect(answer({ text: '' }).success).toBe(false);
        expect(answer({}).success).toBe(false);
        // Unknown keys are stripped like on every frame: a value could not smuggle a second field through.
        expect(answer({ text: 'code', profileDir: '/x' })).toEqual({ success: true, data: { v: V, t: 'login.answer', requestId: 'lg_1', text: 'code' } });
    });

    it('an environment input may set allowBypassPermissions and still never a profile directory', () => {
        const put = (environment: Record<string, unknown>) => platformFrameSchemas['env.request'].safeParse({ v: V, t: 'env.request', requestId: 'env_1', op: 'put', environment: { name: 'Work', runtime: 'in-memory', cwdRoots: ['/work'], ...environment } });
        expect(put({ allowBypassPermissions: true }).success).toBe(true);
        expect(put({ allowBypassPermissions: false }).success).toBe(true);
        expect(put({ allowBypassPermissions: 'yes' }).success).toBe(false);
        expect(put({ allowBypassPermissions: true, profileDir: '/home/me/.claude' }).success).toBe(false);
    });

    it('hello.features lists the new families and drops what this end does not know', () => {
        const hello = daemonFrameSchemas.hello.safeParse({ ...daemonCases.hello.valid, features: ['update', 'policy', 'log', 'login', 'teleport'] });
        expect(hello.success).toBe(true);
        if (hello.success) expect(hello.data.features).toEqual(['update', 'policy', 'log', 'login']);
    });
});
