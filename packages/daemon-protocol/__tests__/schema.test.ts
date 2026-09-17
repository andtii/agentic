/** Every frame kind: one valid frame parses, one invalid frame is refused with a field-level issue. */

import { DAEMON_FRAME_TYPES, DAEMON_PROTOCOL_VERSION, PLATFORM_FRAME_TYPES } from '@agentic/core';
import { WIRE_PROTOCOL_VERSION } from '@sigx/ai-agent/wire';
import type { DaemonFrame, DaemonFrameType, PlatformFrame, PlatformFrameType } from '../src/index';
import { LIMITS, daemonFrame, daemonFrameSchemas, platformFrame, platformFrameSchemas } from '../src/index';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '../src/testing/index';

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;
const env = inMemoryEnvironment();
const cursor = { epoch: 0, seq: 3 };

type Case<T> = { readonly valid: T; readonly invalid: unknown; readonly path: string };

const daemonCases: { readonly [T in DaemonFrameType]: Case<Extract<DaemonFrame, { t: T }>> } = {
    hello: {
        valid: { v: V, t: 'hello', machineId: env.machineId, daemonVersion: '1.0.0', os: 'windows', environments: [env], capabilities: [IN_MEMORY_CAPABILITIES], resume: { s1: cursor } },
        invalid: { v: V, t: 'hello', machineId: env.machineId, daemonVersion: '1.0.0', os: 'amiga', environments: [env], capabilities: [], resume: {} },
        path: 'os'
    },
    env: { valid: { v: V, t: 'env', environments: [env] }, invalid: { v: V, t: 'env', environments: [{ ...env, account: { label: 'x' } }] }, path: 'environments.0.account.authStatus' },
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
    pong: { valid: { v: V, t: 'pong', at: 5 }, invalid: { v: V, t: 'pong', at: 'now' }, path: 'at' }
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
    ping: { valid: { v: V, t: 'ping' }, invalid: { v: V, t: 'ping', extra: 1 }, path: '' }
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

    it('refuse the wrong protocol version at the schema level too', () => {
        expect(daemonFrameSchemas.pong.safeParse({ v: V + 1, t: 'pong', at: 1 }).success).toBe(false);
        expect(platformFrameSchemas['session.command'].safeParse({ ...platformCases['session.command'].valid, command: { ...platformCases['session.command'].valid.command, v: W + 1 } }).success).toBe(false);
    });
});
