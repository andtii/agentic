/** Every frame kind: one valid frame parses, one invalid frame is refused with a field-level issue. */

import { DAEMON_FRAME_TYPES, DAEMON_PROTOCOL_VERSION, FS_LIST_MAX_ENTRIES, PLATFORM_FRAME_TYPES } from '@agentic/core';
import { WIRE_PROTOCOL_VERSION } from '@sigx/ai-agent/wire';
import type { DaemonFrame, DaemonFrameType, PlatformFrame, PlatformFrameType } from '../src/index';
import { LIMITS, daemonFrame, daemonFrameSchemas, platformFrame, platformFrameSchemas } from '../src/index';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '../src/testing/index';

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;
const env = inMemoryEnvironment();
const cursor = { epoch: 0, seq: 3 };

const week = { id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.5, unit: 'percent', resetsAt: '2026-09-22T18:00:00Z', status: 'ok' } as const;
const quotaOf = (windows: readonly unknown[]) =>
    ({ sourceId: 'agentic.quota.claude-code', runtime: 'claude-code', environmentId: env.id, plan: 'max', availability: 'reported', windows, observedAt: 1, via: 'probe' }) as never;

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
            result: { kind: 'list', path: '/work', entries: [{ name: 'app', path: '/work/app', git: { kind: 'repo', branch: 'main' } }, { name: 'wt', path: '/work/wt', git: { kind: 'worktree', head: 'abc1234' } }], truncated: false }
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
    }
};

describe('daemon frame schemas', () => {
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
        expect(response({ error: { code: 'outside-roots', message: 'no' } }).success).toBe(true);
        expect(response({ error: { code: 'teapot', message: 'no' } }).success).toBe(false);
        const neither = response({});
        expect(neither.success).toBe(false);
        expect(neither.error?.issues[0]?.path).toEqual(['result']);
        expect(daemonFrameSchemas['fs.response'].safeParse({ v: V, t: 'fs.response', error: { code: 'internal', message: 'x' } }).success).toBe(false);
        expect(platformFrameSchemas['fs.request'].safeParse({ v: V, t: 'fs.request', requestId: 'fs_1', environmentId: env.id, op: { kind: 'delete', path: '/work' } }).success).toBe(false);
    });

    it('refuse the wrong protocol version at the schema level too', () => {
        expect(daemonFrameSchemas.pong.safeParse({ v: V + 1, t: 'pong', at: 1 }).success).toBe(false);
        expect(platformFrameSchemas['session.command'].safeParse({ ...platformCases['session.command'].valid, command: { ...platformCases['session.command'].valid.command, v: W + 1 } }).success).toBe(false);
    });
});
