// @vitest-environment node
import type { ApprovalRule, CapabilityReport, EnvironmentId, LocalEnvironment, OpenSpecPolicy, SessionId } from '@agentic/core';
import { mockAgent, type MockStep } from '@sigx/ai-agent/testing';
import { decodeDaemonFrame, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame, type DaemonFrameOf, type DaemonFrameType } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCapabilitiesOf, createDaemon, follows, type Daemon, type DaemonDriver } from '../src/daemon';
import { withinRoots } from '../src/fs';
import { ndjsonEventLog } from '../src/event-log';
import { agentDriver, scriptedDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay } from './helpers/relay';

async function next(seat: PlatformSeat): Promise<DaemonFrame> {
    const decoded = decodeDaemonFrame((await seat.next()) as string);
    if (!decoded.ok) throw new Error(decoded.error.message);
    return decoded.frame;
}
async function expectFrame<T extends DaemonFrameType>(seat: PlatformSeat, t: T): Promise<DaemonFrameOf<T>> {
    for (;;) {
        const frame = await next(seat);
        if (frame.t === t) return frame as DaemonFrameOf<T>;
        if (frame.t !== 'heartbeat') throw new Error(`expected ${t}, got ${frame.t}`);
    }
}

describe('daemon', () => {
    let dir: string;
    let relay: Relay;
    let daemons: Daemon[];
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-daemon-'));
        relay = await startRelay();
        daemons = [];
    });
    afterEach(async () => {
        for (const d of daemons) await d.stop();
        await relay.close();
        await rm(dir, { recursive: true, force: true });
    });

    const env = (id: string, extra: Partial<LocalEnvironment> = {}): LocalEnvironment => ({ id: id as EnvironmentId, name: id, runtime: 'scripted', cwdRoots: [dir], concurrency: 1, ...extra });

    async function start(environments: LocalEnvironment[], drivers: DaemonDriver[] = [scriptedDriver({ events: 5, heartbeatMs: 1_000 })], toolTimeoutMs?: number) {
        const daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments,
            drivers,
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 1_000,
            ...(toolTimeoutMs ? { toolTimeoutMs } : {})
        });
        daemons.push(daemon);
        await daemon.start();
        const seat = await relay.nextSeat();
        const hello = await expectFrame(seat, 'hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });
        return { daemon, seat, hello };
    }

    const open = (seat: PlatformSeat, sessionId: string, environmentId: string, cwd = dir, policy?: OpenSpecPolicy) =>
        seat.send({ v: V, t: 'session.open', sessionId: sessionId as SessionId, environmentId, spec: { agentId: 'agent_1', cwd, system: 's', tools: [], ...(policy ? { policy } : {}) } });

    it('dials /_agentic/daemon/{machineId} with the token as a bearer header', async () => {
        await start([env('env_a')]);
        expect(relay.dialled).toEqual([`/_agentic/daemon/${TEST_MACHINE}`]);
        expect(relay.refused).toBe(0);
    });

    it("hello carries each driver's doctor verdict per environment; a driver whose checks throw yields an error verdict (EXE-05/07)", async () => {
        const base = scriptedDriver({ events: 1, heartbeatMs: 1_000 });
        const sharing: DaemonDriver = {
            ...base,
            async doctor(envs) {
                const [a, b, c] = envs.map((e) => e.id);
                return {
                    ok: false,
                    findings: [
                        { level: 'error', code: 'shared-config-dir', message: 'a and b share a config dir', environmentIds: [a!, b!] },
                        { level: 'info', code: 'auth-ok', message: 'c is signed in', environmentIds: [c!] }
                    ]
                };
            }
        };
        const broken: DaemonDriver = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), runtime: 'broken', doctor: async () => Promise.reject(new Error('no claude binary')) };
        const { hello } = await start([env('env_a'), env('env_b'), env('env_c'), env('env_d', { runtime: 'broken' })], [sharing, broken]);
        const verdict = (id: string) => hello.environments.find((e) => e.id === id)!.doctor!;
        expect(verdict('env_a')).toMatchObject({ ok: false, findings: [{ code: 'shared-config-dir', environmentIds: ['env_a', 'env_b'] }] });
        expect(verdict('env_b')).toMatchObject({ ok: false, findings: [{ code: 'shared-config-dir' }] });
        expect(verdict('env_c')).toMatchObject({ ok: true, findings: [{ code: 'auth-ok' }] });
        expect(verdict('env_d')).toMatchObject({ ok: false, findings: [{ level: 'error', code: 'driver-doctor-failed', environmentIds: ['env_d'] }] });
        expect(verdict('env_d').findings[0]!.message).toContain('no claude binary');
        for (const e of hello.environments) expect(typeof e.doctor?.checkedAt).toBe('number');
    });

    it('leaves out environments without a driver and reports an inspection failure as unknown auth', async () => {
        const failing: DaemonDriver = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), runtime: 'flaky', inspect: async () => Promise.reject(new Error('no claude binary')) };
        const { hello } = await start([env('env_a'), env('env_b', { runtime: 'nobody' }), env('env_c', { runtime: 'flaky' })], [scriptedDriver({ events: 1, heartbeatMs: 1_000 }), failing]);
        expect(hello.environments.map((e) => e.id)).toEqual(['env_a', 'env_c']);
        expect(hello.environments[1]!.account.authStatus).toBe('unknown');
        expect(hello.capabilities.find((c) => c.runtime === 'flaky')!.unsupported).toEqual([{ op: '*', reason: 'no claude binary' }]);
    });

    it('refuses unknown environments, a cwd outside cwdRoots and work beyond concurrency — with a reason', async () => {
        const { seat } = await start([env('env_a')]);
        open(seat, 'session_1', 'env_nope');
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/unknown environment/);
        open(seat, 'session_2', 'env_a', join(dir, '..'));
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/outside the environment's cwdRoots/);
        await mkdir(join(dir, 'sub'));
        open(seat, 'session_3', 'env_a', join(dir, 'sub'));
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_3');
        open(seat, 'session_4', 'env_a');
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/at capacity/);
        // Opening the same session again is idempotent.
        open(seat, 'session_3', 'env_a');
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_3');
    });

    it('refuses a session cwd that is missing or that a symlink / junction leads out of the roots (#188)', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'agentic-daemon-outside-'));
        try {
            const root = join(dir, 'root');
            await mkdir(join(root, 'inside'), { recursive: true });
            await mkdir(join(outside, 'deeper'));
            await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
            const { seat } = await start([env('env_a', { cwdRoots: [root], concurrency: 4 })]);
            open(seat, 'session_1', 'env_a', join(root, 'escape'));
            expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/outside the environment's cwdRoots/);
            open(seat, 'session_2', 'env_a', join(root, 'escape', 'deeper'));
            expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/outside the environment's cwdRoots/);
            open(seat, 'session_3', 'env_a', join(root, 'missing'));
            expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/does not exist/);
            open(seat, 'session_4', 'env_a', join(root, 'inside'));
            expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_4');
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('answers fs.request with fs.response (#188)', async () => {
        const root = join(dir, 'root');
        await mkdir(join(root, 'b'), { recursive: true });
        await mkdir(join(root, 'A'));
        const { seat } = await start([env('env_a', { cwdRoots: [root] })]);
        seat.send({ v: V, t: 'fs.request', requestId: 'fs_1', environmentId: 'env_a', op: { kind: 'list', path: root } });
        const listed = await expectFrame(seat, 'fs.response');
        expect(listed.requestId).toBe('fs_1');
        expect(listed.result).toMatchObject({ kind: 'list', truncated: false });
        expect(listed.result?.kind === 'list' && listed.result.entries.map((e) => e.name)).toEqual(['A', 'b']);
        seat.send({ v: V, t: 'fs.request', requestId: 'fs_2', environmentId: 'env_nope', op: { kind: 'list', path: root } });
        expect(await expectFrame(seat, 'fs.response')).toMatchObject({ requestId: 'fs_2', error: { code: 'unknown-environment' } });
    });

    it('a command for a session it does not run is answered, not dropped', async () => {
        const { seat } = await start([env('env_a')]);
        seat.send({ v: V, t: 'session.command', sessionId: 'session_x' as SessionId, command: { v: 1, commandId: 'c1', type: 'cancel' } });
        expect((await expectFrame(seat, 'session.reply')).reply).toMatchObject({ kind: 'error', code: 'closed', commandId: 'c1' });
    });

    it('after a daemon restart, a wanted session is replayed from its log and reported closed', async () => {
        const first = await start([env('env_a')]);
        open(first.seat, 'session_1', 'env_a');
        const opened = await expectFrame(first.seat, 'session.opened');
        first.seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'go' }] } });
        let seen = 0;
        while (seen < 2) if ((await next(first.seat)).t === 'session.frame') seen++;
        await first.daemon.stop();
        daemons.length = 0;

        const second = await (async () => {
            const daemon = createDaemon({ credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token }, environments: [env('env_a')], drivers: [scriptedDriver({ events: 5, heartbeatMs: 1_000 })], eventLog: ndjsonEventLog(join(dir, 'sessions')), backoff: { initialMs: 5, maxMs: 20 } });
            daemons.push(daemon);
            await daemon.start();
            return { daemon, seat: await relay.nextSeat() };
        })();
        const hello = await expectFrame(second.seat, 'hello');
        expect(hello.resume).toEqual({});
        second.seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: { session_1: { epoch: opened.head.epoch, seq: 2 } } });
        const seqs: number[] = [];
        for (;;) {
            const frame = await next(second.seat);
            if (frame.t === 'session.frame' && frame.frame.kind === 'event') seqs.push(frame.frame.seq);
            if (frame.t === 'session.closed') {
                expect(frame.reason).toMatch(/daemon restarted/);
                break;
            }
        }
        expect(seqs).toEqual([3, 4, 5]);
    });

    it('bridges platform tools as tool.call; an unanswered call times out', async () => {
        const script = { events: 2, heartbeatMs: 1_000, tool: { name: 'memory_search', input: { q: 'x' } } };
        const { seat } = await start([env('env_a')], [scriptedDriver(script)], 50);
        open(seat, 'session_1', 'env_a');
        await expectFrame(seat, 'session.opened');
        seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'go' }] } });
        expect((await expectFrame(seat, 'session.reply')).reply.kind).toBe('ack');
        const call = await expectFrame(seat, 'tool.call');
        expect(call).toMatchObject({ sessionId: 'session_1', tool: 'memory_search', input: { q: 'x' } });
        // No answer: the scripted runtime swallows the timeout and finishes its turn.
        const frames: string[] = [];
        for (;;) {
            const frame = await next(seat);
            frames.push(frame.t);
            if (frame.t === 'session.frame' && frame.frame.kind === 'event' && frame.frame.event.type === 'turn-end') break;
        }
        expect(frames).toContain('session.frame');
    });

    describe('daemon: the session policy compiled from OpenSpec.policy (#121; OPS-02, COL-10, AC-12)', () => {
        const ASK_DESTRUCTIVE: ApprovalRule = { id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' };
        const ALLOW_READ: ApprovalRule = { id: 'category:read', match: { categories: ['read'] }, outcome: 'allow' };
        const ALLOW_ALL: ApprovalRule = { id: 'allow-everything', match: {}, outcome: 'allow' };
        const GRANTS = [{ name: 'rm' }, { name: 'ls' }];

        /** The runtime: `destroy` runs a destructive tool, `read` a read-only one. */
        function policyAgent() {
            const rm: MockStep = { tool: { name: 'rm', category: 'destructive', input: { path: '/tmp/x' }, output: 'gone', annotations: { destructive: true } } };
            const ls: MockStep = { tool: { name: 'ls', category: 'read', input: { path: '.' }, output: 'a b', annotations: { readOnly: true } } };
            return mockAgent({
                respond: (input) => {
                    const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
                    return [text.startsWith('destroy') ? rm : ls, { text: 'done' }];
                }
            });
        }

        /** The `session.opened` for a session opened while another one's trailing frames (`state`, `usage`) may still arrive. */
        async function opened(seat: PlatformSeat): Promise<void> {
            for (;;) {
                const frame = await next(seat);
                if (frame.t === 'session.opened') return;
                if (frame.t !== 'session.frame' && frame.t !== 'heartbeat') throw new Error(`expected session.opened, got ${frame.t}`);
            }
        }

        /** Drive one turn: the event frames until `turn-end`, answering every `request` with `decision`. */
        async function turn(seat: PlatformSeat, sessionId: string, n: number, text: string, decision: 'allow' | 'deny' = 'allow'): Promise<{ requests: { toolName?: string; kind: string }[]; stopReason: string }> {
            seat.send({ v: V, t: 'session.command', sessionId: sessionId as SessionId, command: { v: 1, commandId: `c${n}`, type: 'prompt', turnId: `t${n}`, input: [{ type: 'text', text }] } });
            // The prompt's ack and the turn's frames interleave freely: every reply is checked, every event read.
            let acked = false;
            const requests: { toolName?: string; kind: string }[] = [];
            for (;;) {
                const frame = await next(seat);
                if (frame.t === 'session.reply') {
                    expect(frame.reply.kind).toBe('ack');
                    if (frame.reply.commandId === `c${n}`) acked = true;
                    continue;
                }
                if (frame.t !== 'session.frame' || frame.frame.kind !== 'event') continue;
                const ev = frame.frame.event;
                if (ev.type === 'request') {
                    requests.push({ kind: ev.kind, ...(ev.toolName ? { toolName: ev.toolName } : {}) });
                    seat.send({ v: V, t: 'session.command', sessionId: sessionId as SessionId, command: { v: 1, commandId: `r${n}:${ev.requestId}`, type: 'respond', requestId: ev.requestId, decision: { type: 'permission', outcome: decision, scope: 'once' } } });
                }
                if (ev.type === 'turn-end') {
                    expect(acked).toBe(true);
                    return { requests, stopReason: ev.stopReason };
                }
            }
        }

        it('under `ask on destructive` a destructive call raises one request frame and a read-only one none; under `allow` neither does', async () => {
            const driver = agentDriver('mock', policyAgent());
            const { seat } = await start([env('env_mock', { runtime: 'mock', concurrency: 4 })], [driver]);
            open(seat, 'session_ask', 'env_mock', dir, { rules: [ASK_DESTRUCTIVE, ALLOW_READ], grants: GRANTS });
            await opened(seat);
            expect(driver.contexts[0]?.policy).toBeDefined();
            expect(await turn(seat, 'session_ask', 1, 'destroy it')).toEqual({ requests: [{ kind: 'permission', toolName: 'rm' }], stopReason: 'end_turn' });
            expect(await turn(seat, 'session_ask', 2, 'read it')).toEqual({ requests: [], stopReason: 'end_turn' });

            open(seat, 'session_allow', 'env_mock', dir, { rules: [ALLOW_ALL], grants: GRANTS });
            await opened(seat);
            expect(await turn(seat, 'session_allow', 3, 'destroy it')).toEqual({ requests: [], stopReason: 'end_turn' });
            expect(await turn(seat, 'session_allow', 4, 'read it')).toEqual({ requests: [], stopReason: 'end_turn' });
        });

        it("a child's session is never wider than its ancestors: the constraints' `ask` tightens the agent's own `allow`, and a `deny` grant refuses", async () => {
            const driver = agentDriver('mock', policyAgent());
            const { seat } = await start([env('env_mock', { runtime: 'mock', concurrency: 4 })], [driver]);
            open(seat, 'session_child', 'env_mock', dir, { rules: [ALLOW_ALL], grants: GRANTS, constraints: [ASK_DESTRUCTIVE] });
            await opened(seat);
            expect(await turn(seat, 'session_child', 1, 'destroy it')).toEqual({ requests: [{ kind: 'permission', toolName: 'rm' }], stopReason: 'end_turn' });
            expect(await turn(seat, 'session_child', 2, 'read it')).toEqual({ requests: [], stopReason: 'end_turn' });

            open(seat, 'session_denied', 'env_mock', dir, { rules: [ALLOW_ALL], grants: [{ name: 'rm', mode: 'deny' }, { name: 'ls' }] });
            await opened(seat);
            // Denied by its grant: no question, and the call fails in the runtime (the turn still ends).
            expect(await turn(seat, 'session_denied', 3, 'destroy it')).toEqual({ requests: [], stopReason: 'end_turn' });
        });

        it('without a policy the driver is opened with none — the harness asks on its own terms', async () => {
            const driver = agentDriver('mock', policyAgent());
            const { seat } = await start([env('env_mock', { runtime: 'mock', concurrency: 4 })], [driver]);
            open(seat, 'session_bare', 'env_mock');
            await opened(seat);
            expect(driver.contexts[0]?.policy).toBeUndefined();
        });
    });
});

describe('daemon helpers', () => {
    it('follows: next seq in the epoch, or the first of a later one', () => {
        expect(follows({ epoch: 1, seq: 5 }, { epoch: 1, seq: 4 })).toBe(true);
        expect(follows({ epoch: 1, seq: 6 }, { epoch: 1, seq: 4 })).toBe(false);
        expect(follows({ epoch: 1, seq: 1 }, { epoch: 0, seq: 0 })).toBe(true);
        expect(follows({ epoch: 2, seq: 3 }, { epoch: 1, seq: 9 })).toBe(false);
    });
    it('withinRoots refuses escapes and is case-insensitive on Windows', () => {
        expect(withinRoots('/src/app', ['/src'], 'linux')).toBe(true);
        expect(withinRoots('/src/../etc', ['/src'], 'linux')).toBe(false);
        expect(withinRoots('/srcother', ['/src'], 'linux')).toBe(false);
        if (process.platform === 'win32') expect(withinRoots('C:\\SRC\\app', ['c:\\src'], 'win32')).toBe(true);
    });
    it('agentCapabilitiesOf maps the report onto what serveSession checks', () => {
        const report: CapabilityReport = { runtime: 'x', supported: ['prompt', 'configure', 'fork'], unsupported: [], resume: 'local', cancel: true, steer: true, permissions: 'every-call', tools: 'mcp' };
        expect(agentCapabilitiesOf(report)).toMatchObject({ resume: 'local', cancel: true, steer: true, config: true, fork: true, structuredOutput: false, permissions: 'every-call', tools: 'mcp' });
    });
});

describe('builtin drivers', () => {
    it('ship the Claude Code driver, disposable', async () => {
        const { builtinDrivers, isDisposable } = await import('../src/drivers');
        const drivers = builtinDrivers();
        expect(drivers.map((d) => d.runtime)).toEqual(['claude-code']);
        expect(drivers.every(isDisposable)).toBe(true);
    });
});
