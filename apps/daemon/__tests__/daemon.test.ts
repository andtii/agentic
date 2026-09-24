// @vitest-environment node
import type { ApprovalRule, CapabilityReport, EnvironmentId, LocalEnvironment, OpenSpecPolicy, SessionId } from '@agentic/core';
import { mockAgent, type MockStep } from '@sigx/ai-agent/testing';
import { decodeDaemonFrame, isDrainingReply, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame, type DaemonFrameOf, type DaemonFrameType } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCapabilitiesOf, createDaemon, follows, sameRefIdentity, type Daemon, type DaemonDriver, type DaemonOptions } from '../src/daemon';
import { harnessMissingDriver } from '../src/drivers';
import { harnessStore } from '../src/harness';
import { withinRoots } from '../src/fs';
import { ndjsonEventLog } from '../src/event-log';
import { agentDriver, ghostDriver, namingDriver, scriptedDriver, SCRIPTED_REPORT, titlingDriver } from './helpers/drivers';
import { fakeHarnessZip, fakeReleases } from './helpers/harness';
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
        if (frame.t !== 'heartbeat' && frame.t !== 'telemetry') throw new Error(`expected ${t}, got ${frame.t}`);
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

    async function start(environments: LocalEnvironment[], drivers: DaemonDriver[] = [scriptedDriver({ events: 5, heartbeatMs: 1_000 })], toolTimeoutMs?: number, extra: Partial<DaemonOptions> = {}) {
        const daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments,
            drivers,
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 1_000,
            ...(toolTimeoutMs ? { toolTimeoutMs } : {}),
            ...extra
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

    it('a driver error that names a local path reaches the platform without it (#274)', async () => {
        const reasons = [
            "EACCES: permission denied, open 'C:\\Users\\RUNNER~1\\AppData\\Roaming\\agentic\\profiles\\p7x1\\.credentials.json'",
            'ENOENT: no such file or directory, scandir /home/q8w3/.config/agentic/profiles/r4t5',
            'cannot read \\\\fileserver\\share\\s6u7 and D:/keep/v1w2/x'
        ];
        for (const reason of reasons) {
            const broken: DaemonDriver = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), runtime: 'broken', doctor: async () => Promise.reject(new Error(reason)) };
            const { hello } = await start([env('env_d', { runtime: 'broken' })], [broken]);
            const message = hello.environments[0]!.doctor!.findings[0]!.message;
            for (const secret of ['RUNNER~1', 'p7x1', 'q8w3', 'r4t5', 'fileserver', 's6u7', 'v1w2']) expect(message).not.toContain(secret);
            expect(message).toMatch(/EACCES|ENOENT|cannot read/);
            expect(message).toContain('agentic-daemon doctor');
        }
    });

    it('leaves out environments without a driver and reports an inspection failure as unknown auth', async () => {
        const failing: DaemonDriver = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), runtime: 'flaky', inspect: async () => Promise.reject(new Error('no claude binary')) };
        const { hello } = await start([env('env_a'), env('env_b', { runtime: 'nobody' }), env('env_c', { runtime: 'flaky' })], [scriptedDriver({ events: 1, heartbeatMs: 1_000 }), failing]);
        expect(hello.environments.map((e) => e.id)).toEqual(['env_a', 'env_c']);
        expect(hello.environments[1]!.account.authStatus).toBe('unknown');
        expect(hello.capabilities.find((c) => c.runtime === 'flaky')!.unsupported).toEqual([{ op: '*', reason: 'no claude binary' }]);
    });

    it('reports a runtime no environment runs on yet from its driver, and not one whose harness is missing (#541)', async () => {
        const fresh = { ...SCRIPTED_REPORT, runtime: 'fresh', supported: ['prompt'] };
        const idle: DaemonDriver = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), runtime: 'fresh', report: () => fresh };
        // An environment's own inspection wins for its runtime over the driver's environment-free report.
        const scripted: DaemonDriver = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), report: () => ({ ...SCRIPTED_REPORT, supported: ['not this one'] }) };
        const { hello } = await start([env('env_a')], [scripted, idle, harnessMissingDriver('gone')]);
        expect(hello.capabilities.map((c) => c.runtime)).toEqual(['scripted', 'fresh']);
        expect(hello.capabilities[0]!.supported).toEqual(SCRIPTED_REPORT.supported);
        expect(hello.capabilities[1]).toEqual(fresh);
    });

    it('a sign-in shows up without a restart: environments that are not signed in are inspected again (#235)', async () => {
        const driver = scriptedDriver({ events: 1, heartbeatMs: 1_000 });
        driver.auth.set('env_b', 'missing');
        let inspected = 0;
        const counting: DaemonDriver = { ...driver, inspect: (e) => (inspected++, driver.inspect(e)) };
        const daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments: [env('env_a'), env('env_b')],
            drivers: [counting],
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 1_000,
            reinspectMs: 15
        });
        daemons.push(daemon);
        await daemon.start();
        const seat = await relay.nextSeat();
        const hello = await expectFrame(seat, 'hello');
        expect(hello.environments.map((e) => e.account.authStatus)).toEqual(['ok', 'missing']);
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });

        driver.auth.set('env_b', 'ok');
        const announced = await expectFrame(seat, 'env');
        expect(announced.environments.map((e) => e.account.authStatus)).toEqual(['ok', 'ok']);

        // Everything signed in: the timer leaves the machine alone, and nothing changed means no frame.
        const settled = inspected;
        await new Promise((r) => setTimeout(r, 80));
        expect(inspected).toBe(settled);
        expect(await daemon.reinspect()).toBe(false);
    });

    it('reports what each account may run once welcomed (#453): the list rides on the descriptors, asked once, the bypass flag with it', async () => {
        const base = scriptedDriver({ events: 1, heartbeatMs: 1_000 });
        let asked = 0;
        const listing: DaemonDriver = { ...base, models: async (e) => (asked++, e.id === 'env_a' ? [{ id: 'claude-fable-5-1', label: 'Fable' }, { id: 'sonnet' }] : null) };
        const { hello, seat, daemon } = await start([env('env_a', { allowBypassPermissions: true }), env('env_b')], [listing]);
        expect(hello.environments[0]).toMatchObject({ id: 'env_a', allowBypassPermissions: true });
        expect(hello.environments[0]!.models).toBeUndefined();
        const announced = await expectFrame(seat, 'env');
        expect(announced.environments.map((e) => [e.id, e.models])).toEqual([
            ['env_a', [{ id: 'claude-fable-5-1', label: 'Fable' }, { id: 'sonnet' }]],
            ['env_b', undefined]
        ]);
        expect(asked).toBe(2);
        // A later inspection keeps the list; nothing changed means no frame.
        expect(await daemon.reinspect()).toBe(false);
    });

    it('refuses unknown environments and a cwd outside cwdRoots — with a reason; an open session never counts against concurrency (#394)', async () => {
        const { seat } = await start([env('env_a')]);
        open(seat, 'session_1', 'env_nope');
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/unknown environment/);
        open(seat, 'session_2', 'env_a', join(dir, '..'));
        expect((await expectFrame(seat, 'session.closed')).reason).toMatch(/outside the environment's cwdRoots/);
        await mkdir(join(dir, 'sub'));
        open(seat, 'session_3', 'env_a', join(dir, 'sub'));
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_3');
        // Concurrency 1, one session open and idle: a second conversation opens — the budget is turns, not sessions.
        open(seat, 'session_4', 'env_a');
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_4');
        // Opening the same session again is idempotent.
        open(seat, 'session_3', 'env_a');
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('session_3');
    });

    it('capacity counts running turns (#394): at capacity an open is refused and a prompt is answered busy; the turn ending frees the slot, the session stays', async () => {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const holding = mockAgent({
            respond: async () => {
                await held;
                return [{ text: 'done' }];
            }
        });
        const { seat, hello } = await start([env('env_mock', { runtime: 'mock', concurrency: 1 })], [agentDriver('mock', holding)]);
        expect(hello.environments[0]!.concurrency).toEqual({ max: 1, active: 0 });
        /** The reply to `commandId`, whatever frames of a running turn interleave with it. */
        const replyFor = async (commandId: string) => {
            for (;;) {
                const frame = await next(seat);
                if (frame.t === 'session.reply' && frame.reply.commandId === commandId) return frame.reply;
            }
        };
        const closedFor = async (sessionId: string) => {
            for (;;) {
                const frame = await next(seat);
                if (frame.t === 'session.closed' && frame.sessionId === sessionId) return frame;
            }
        };
        const prompt = (sessionId: string, n: number) => seat.send({ v: V, t: 'session.command', sessionId: sessionId as SessionId, command: { v: 1, commandId: `c${n}`, type: 'prompt', turnId: `t${n}`, input: [{ type: 'text', text: 'go' }] } });

        open(seat, 's1', 'env_mock');
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('s1');
        open(seat, 's2', 'env_mock');
        expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('s2');

        // s1 takes the one slot.
        prompt('s1', 1);
        expect(await replyFor('c1')).toMatchObject({ kind: 'ack' });
        // A prompt on s2 is the environment's admission to refuse, not the runtime's: `busy`, naming the capacity.
        prompt('s2', 2);
        const busy = await replyFor('c2');
        expect(busy).toMatchObject({ kind: 'error', code: 'busy' });
        expect(busy.kind === 'error' && busy.message).toMatch(/env_mock is at capacity \(1\): 1 turn running/);
        // And a third conversation cannot open while the slot is taken.
        open(seat, 's3', 'env_mock');
        expect((await closedFor('s3')).reason).toMatch(/at capacity \(1\): 1 turn running/);
        expect([...daemons[0]!.activeSessions].sort()).toEqual(['s1', 's2']);

        // The turn ends: s1 stays open, and the slot is s2's for the asking.
        release();
        for (;;) {
            const frame = await next(seat);
            if (frame.t === 'session.frame' && frame.sessionId === 's1' && frame.frame.kind === 'event' && frame.frame.event.type === 'turn-end') break;
        }
        prompt('s2', 3);
        expect(await replyFor('c3')).toMatchObject({ kind: 'ack' });
        expect([...daemons[0]!.activeSessions].sort()).toEqual(['s1', 's2']);
    });

    describe('a turn nobody asked for (#604)', () => {
        const command = (seat: PlatformSeat, sessionId: string, command: Record<string, unknown>) => seat.send({ v: V, t: 'session.command', sessionId: sessionId as SessionId, command: { v: 1, ...command } as never });
        /** Frames until `pred` holds, whatever interleaves; the frames seen, the matching one last. */
        const until = async (seat: PlatformSeat, pred: (frame: DaemonFrame) => boolean) => {
            const seen: DaemonFrame[] = [];
            for (;;) {
                const frame = await next(seat);
                seen.push(frame);
                if (pred(frame)) return seen;
            }
        };
        const turnEnd = (turnId: (id: string | undefined) => boolean) => (frame: DaemonFrame) => frame.t === 'session.frame' && frame.frame.kind === 'event' && frame.frame.event.type === 'turn-end' && turnId(frame.frame.event.turnId);
        const endOf = (frames: DaemonFrame[]) => {
            const last = frames.at(-1)!;
            return last.t === 'session.frame' && last.frame.kind === 'event' ? last.frame.event : undefined;
        };

        it('configure then prompt: the configure runs first, its ghost turn is cancelled, and the prompt is answered', async () => {
            const ghost = ghostDriver({ configureMs: 30 });
            const { seat } = await start([env('env_g', { runtime: 'ghost' })], [ghost]);
            open(seat, 's1', 'env_g');
            await expectFrame(seat, 'session.opened');
            // Back to back, the way the router sends a member's new model before its next prompt.
            command(seat, 's1', { commandId: 'c1', type: 'configure', patch: { model: 'haiku' } });
            command(seat, 's1', { commandId: 'c2', type: 'prompt', turnId: 't2', input: [{ type: 'text', text: 'go' }] });
            const seen = await until(seat, turnEnd((id) => id === 't2'));
            const replies = seen.flatMap((f) => (f.t === 'session.reply' ? [f.reply] : []));
            expect(replies.find((r) => r.commandId === 'c1')).toMatchObject({ kind: 'ack' });
            expect(replies.find((r) => r.commandId === 'c2')).toMatchObject({ kind: 'ack', turnId: 't2' });
            expect(ghost.configured).toEqual(['haiku']);
            expect(ghost.prompted).toEqual(['t2']);
            // The implicit turn ended — cancelled — before t2 started.
            const ends = seen.flatMap((f) => (f.t === 'session.frame' && f.frame.kind === 'event' && f.frame.event.type === 'turn-end' ? [f.frame.event] : []));
            expect(ends.map((e) => [e.turnId === 't2' ? 't2' : 'ghost', e.type === 'turn-end' && e.stopReason])).toEqual([
                ['ghost', 'cancelled'],
                ['t2', 'end_turn']
            ]);
        });

        it('an empty implicit turn left alone is cancelled after the quiet window, and the slot is free again', async () => {
            const { seat } = await start([env('env_g', { runtime: 'ghost' })], [ghostDriver()], undefined, { ghostTurnMs: 40 });
            open(seat, 's1', 'env_g');
            await expectFrame(seat, 'session.opened');
            command(seat, 's1', { commandId: 'c1', type: 'configure', patch: { model: 'haiku' } });
            const seen = await until(seat, turnEnd(() => true));
            expect(endOf(seen)).toMatchObject({ type: 'turn-end', stopReason: 'cancelled' });
            command(seat, 's1', { commandId: 'c2', type: 'prompt', turnId: 't2', input: [{ type: 'text', text: 'go' }] });
            const after = await until(seat, (f) => f.t === 'session.reply' && f.reply.commandId === 'c2');
            expect(after.at(-1)).toMatchObject({ reply: { kind: 'ack', turnId: 't2' } });
        });

        it('an implicit turn that carries content is left alone (#510)', async () => {
            const { seat } = await start([env('env_g', { runtime: 'ghost' })], [ghostDriver({ content: true })], undefined, { ghostTurnMs: 20 });
            open(seat, 's1', 'env_g');
            await expectFrame(seat, 'session.opened');
            command(seat, 's1', { commandId: 'c1', type: 'configure', patch: { model: 'haiku' } });
            await until(seat, (f) => f.t === 'session.frame' && f.frame.kind === 'event' && f.frame.event.type === 'part-delta');
            await new Promise((r) => setTimeout(r, 150));
            expect(daemons[0]!.activeSessions).toContain('s1');
            // Still running: a prompt now is the runtime's to refuse, and nothing cancelled the turn.
            command(seat, 's1', { commandId: 'c2', type: 'prompt', turnId: 't2', input: [{ type: 'text', text: 'go' }] });
            const seen = await until(seat, (f) => f.t === 'session.reply' && f.reply.commandId === 'c2');
            expect(seen.at(-1)).toMatchObject({ reply: { kind: 'error', code: 'busy' } });
            expect(seen.some(turnEnd(() => true))).toBe(false);
        });
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

    it('answers a locate with the checkouts of the origin under the roots (#331)', async () => {
        const root = join(dir, 'root');
        await mkdir(join(root, 'agentic', '.git'), { recursive: true });
        await writeFile(join(root, 'agentic', '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await writeFile(join(root, 'agentic', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/andtii/agentic.git\n');
        const { seat } = await start([env('env_a', { cwdRoots: [root] })]);
        seat.send({ v: V, t: 'fs.request', requestId: 'fs_3', environmentId: 'env_a', op: { kind: 'locate', origin: 'git@github.com:andtii/agentic' } });
        const found = await expectFrame(seat, 'fs.response');
        expect(found).toEqual({
            v: V,
            t: 'fs.response',
            requestId: 'fs_3',
            result: { kind: 'locate', origin: 'git@github.com:andtii/agentic', matches: [{ path: join(root, 'agentic'), git: { kind: 'repo', branch: 'main', origin: 'https://github.com/andtii/agentic.git' } }], truncated: false }
        });
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

        const second = await restarted();
        const hello = await expectFrame(second.seat, 'hello');
        expect(hello.resume).toEqual({});
        second.seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: { session_1: { epoch: opened.head.epoch, seq: 2 }, session_never: { epoch: 0, seq: 0 } } });
        const seqs: number[] = [];
        const closed = new Map<string, DaemonFrameOf<'session.closed'>>();
        while (closed.size < 2) {
            const frame = await next(second.seat);
            if (frame.t === 'session.frame' && frame.frame.kind === 'event') seqs.push(frame.frame.seq);
            if (frame.t === 'session.closed') closed.set(frame.sessionId, frame);
        }
        expect(seqs).toEqual([3, 4, 5]);
        // A log on disk: this machine ran it, so the platform re-opens it (#363). No log: an unknown session, no code.
        expect(closed.get('session_1')).toMatchObject({ reason: expect.stringMatching(/daemon restarted/), code: 'restart' });
        expect(closed.get('session_never')).toEqual({ v: V, t: 'session.closed', sessionId: 'session_never', reason: 'unknown session' });
    });

    /** A second daemon over the same state dir, as the supervisor starts it after a restart; the caller reads its hello. */
    async function restarted(drivers: DaemonDriver[] = [scriptedDriver({ events: 5, heartbeatMs: 1_000 })]) {
        const daemon = createDaemon({ credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token }, environments: [env('env_a')], drivers, eventLog: ndjsonEventLog(join(dir, 'sessions')), backoff: { initialMs: 5, maxMs: 20 } });
        daemons.push(daemon);
        await daemon.start();
        return { daemon, seat: await relay.nextSeat() };
    }

    /** The next `count` session.closed frames, passing over the rest. */
    async function closedFrames(seat: PlatformSeat, count: number) {
        const out: DaemonFrameOf<'session.closed'>[] = [];
        while (out.length < count) {
            const frame = await next(seat);
            if (frame.t === 'session.closed') out.push(frame);
        }
        return out;
    }

    /** Prompt a session and take its events up to `turn-end`. */
    async function wholeTurn(seat: PlatformSeat, sessionId: string, n: number) {
        seat.send({ v: V, t: 'session.command', sessionId: sessionId as SessionId, command: { v: 1, commandId: `c${n}`, type: 'prompt', turnId: `t${n}`, input: [{ type: 'text', text: 'go' }] } });
        const events: { epoch: number; seq: number }[] = [];
        for (;;) {
            const frame = await next(seat);
            if (frame.t !== 'session.frame' || frame.frame.kind !== 'event') continue;
            events.push({ epoch: frame.frame.epoch, seq: frame.frame.seq });
            if (frame.frame.event.type === 'turn-end') return events;
        }
    }

    it('stop closes every live session with the code its reason maps to; a plain stop with none (#363)', async () => {
        for (const [reason, code] of [['restart', 'restart'], ['update', 'update'], ['harness-update', 'harness-update'], ['stop', undefined]] as const) {
            const { daemon, seat } = await start([env('env_a')]);
            for (const id of ['session_1', 'session_2']) {
                open(seat, id, 'env_a');
                await expectFrame(seat, 'session.opened');
            }
            // Read while stopping: the frames go out before the socket closes, and a closed seat forgets what it buffered.
            const closing = closedFrames(seat, 2);
            await daemon.stop({ reason });
            const closed = await closing;
            expect(closed.map((c) => [c.sessionId, c.code])).toEqual([
                ['session_1', code],
                ['session_2', code]
            ]);
            if (!code) expect(closed.every((c) => !('code' in c))).toBe(true);
        }
    });

    describe('harnesses (#369)', () => {
        /** Frames until `done` says it has seen everything it waits for; heartbeats and session traffic pass by. */
        async function collect(seat: PlatformSeat, done: (seen: readonly DaemonFrame[]) => boolean): Promise<DaemonFrame[]> {
            const seen: DaemonFrame[] = [];
            while (!done(seen)) seen.push(await next(seat));
            return seen;
        }
        const phases = (frames: readonly DaemonFrame[], requestId: string) => frames.flatMap((f) => (f.t === 'harness.status' && f.requestId === requestId ? [f.phase] : []));
        const replyOf = (frames: readonly DaemonFrame[], commandId: string) => frames.find((f): f is DaemonFrameOf<'session.reply'> => f.t === 'session.reply' && f.reply.commandId === commandId)?.reply;
        const closedOf = (frames: readonly DaemonFrame[], sessionId: string) => frames.find((f): f is DaemonFrameOf<'session.closed'> => f.t === 'session.closed' && f.sessionId === sessionId);
        /** A harness request's end: its `done` (or `failed`) and, after a change, the `harnesses` frame that follows it. */
        const settled = (requestId: string) => (seen: readonly DaemonFrame[]) => {
            const end = seen.findIndex((f) => f.t === 'harness.status' && f.requestId === requestId && (f.phase === 'done' || f.phase === 'failed'));
            if (end < 0) return false;
            const last = seen[end] as DaemonFrameOf<'harness.status'>;
            return last.phase === 'failed' || seen.slice(end).some((f) => f.t === 'harnesses');
        };
        const prompt = (seat: PlatformSeat, sessionId: string, n: number) => seat.send({ v: V, t: 'session.command', sessionId: sessionId as SessionId, command: { v: 1, commandId: `c${n}`, type: 'prompt', turnId: `t${n}`, input: [{ type: 'text', text: 'go' }] } });

        /** Harness builds at `https://releases.test/…`, and the `fetch` the daemon downloads them with. */
        async function withHarnessServer<T>(run: (target: (runtime: string, version: string) => Promise<import('@agentic/core').ReleaseAsset>, fetch: typeof globalThis.fetch) => Promise<T>): Promise<T> {
            const releases = fakeReleases();
            return await run(async (runtime, version) => {
                const zip = await fakeHarnessZip(dir, runtime, version);
                releases.put(`${runtime}-${version}.zip`, zip.bytes);
                return zip.asset(releases.url(`${runtime}-${version}.zip`));
            }, releases.fetch);
        }

        it('an update drains only its runtime: its prompts are answered draining and its opens refused, the rest runs; its sessions close harness-update once its turns end', async () => {
            await withHarnessServer(async (target, fetch) => {
                let release!: () => void;
                const held = new Promise<void>((r) => (release = r));
                const holding = mockAgent({ respond: async () => (await held, [{ text: 'done' }]) });
                const store = harnessStore({ root: join(dir, 'harnesses'), bundled: false });
                const rebuilt: string[] = [];
                const scripted = scriptedDriver({ events: 3, heartbeatMs: 1_000 });
                const { daemon, seat, hello } = await start([env('env_mock', { runtime: 'mock', concurrency: 4 }), env('env_s')], [agentDriver('mock', holding), scripted], undefined, {
                    harnesses: {
                        store,
                        fetch,
                        rebuild: (runtime) => (rebuilt.push(runtime), runtime === 'mock' ? agentDriver('mock', mockAgent({ respond: async () => [{ text: 'new' }] })) : scripted)
                    }
                });
                expect(hello.features).toEqual(['files', 'run', 'worktrees', 'harness']);
                expect(hello.harnesses).toEqual([
                    { runtime: 'mock', status: 'missing' },
                    { runtime: 'scripted', status: 'missing' }
                ]);
                for (const [id, environmentId] of [['s1', 'env_mock'], ['s2', 'env_mock'], ['s3', 'env_s']] as const) {
                    open(seat, id, environmentId);
                    await expectFrame(seat, 'session.opened');
                }
                prompt(seat, 's1', 1);
                expect(replyOf(await collect(seat, (f) => !!replyOf(f, 'c1')), 'c1')).toMatchObject({ kind: 'ack' });

                seat.send({ v: V, t: 'harness.request', requestId: 'h1', op: 'update', runtime: 'mock', target: await target('mock', '2.0.0'), mode: 'drain' });
                expect(phases(await collect(seat, (f) => phases(f, 'h1').includes('draining')), 'h1')).toEqual(['downloading', 'verifying', 'staged', 'draining']);

                // Draining mock: a new turn is refused, a new session too; the scripted runtime is untouched.
                prompt(seat, 's2', 2);
                open(seat, 's4', 'env_mock');
                prompt(seat, 's3', 3);
                const during = await collect(seat, (f) => !!replyOf(f, 'c2') && !!closedOf(f, 's4') && !!replyOf(f, 'c3'));
                expect(isDrainingReply(replyOf(during, 'c2')!)).toBe(true);
                expect(replyOf(during, 'c2')).toMatchObject({ message: 'draining: the mock harness is being updated to 2.0.0' });
                expect(closedOf(during, 's4')).toMatchObject({ code: 'draining' });
                expect(replyOf(during, 'c3')).toMatchObject({ kind: 'ack' });
                expect(phases(during, 'h1')).toEqual([]);
                expect([...daemon.activeSessions].sort()).toEqual(['s1', 's2', 's3']);

                // s1's turn ends: the drain is over, mock's sessions close for the update, the switch is reported.
                release();
                const after = await collect(seat, settled('h1'));
                expect(phases(after, 'h1')).toEqual(['applying', 'done']);
                expect(closedOf(after, 's1')).toMatchObject({ code: 'harness-update' });
                expect(closedOf(after, 's2')).toMatchObject({ code: 'harness-update' });
                expect(closedOf(after, 's3')).toBeUndefined();
                expect(after.find((f) => f.t === 'harnesses')).toMatchObject({ harnesses: [{ runtime: 'mock', installed: { version: '2.0.0' }, status: 'ready' }, { runtime: 'scripted', status: 'missing' }] });
                // The rebuilt driver reports the environment as before: no `env` frame.
                expect(after.some((f) => f.t === 'env')).toBe(false);
                expect(daemon.activeSessions).toEqual(['s3']);
                expect(rebuilt).toEqual(['mock']);
                expect(store.locate('mock')?.version).toBe('2.0.0');

                // The rebuilt driver takes the re-open (the platform's, from spec.resume).
                open(seat, 's1', 'env_mock');
                expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('s1');
            });
        });

        it('mode now does not wait for running turns; a harness an environment uses is not removed; the old version is gone after the switch', async () => {
            await withHarnessServer(async (target, fetch) => {
                let release!: () => void;
                const held = new Promise<void>((r) => (release = r));
                const never = mockAgent({ respond: async () => (await held, [{ text: 'late' }]) });
                const store = harnessStore({ root: join(dir, 'harnesses'), bundled: false });
                const { daemon, seat } = await start([env('env_mock', { runtime: 'mock', concurrency: 2 })], [agentDriver('mock', never)], undefined, {
                    harnesses: { store, fetch, rebuild: () => agentDriver('mock', never) }
                });
                seat.send({ v: V, t: 'harness.request', requestId: 'h1', op: 'install', runtime: 'mock', target: await target('mock', '1.0.0'), mode: 'drain' });
                // Nothing runs on mock: no draining phase.
                expect(phases(await collect(seat, settled('h1')), 'h1')).toEqual(['downloading', 'verifying', 'staged', 'applying', 'done']);

                open(seat, 's1', 'env_mock');
                await expectFrame(seat, 'session.opened');
                prompt(seat, 's1', 1);
                await collect(seat, (f) => !!replyOf(f, 'c1'));
                seat.send({ v: V, t: 'harness.request', requestId: 'h2', op: 'update', runtime: 'mock', target: await target('mock', '1.1.0'), mode: 'now' });
                // Applying while the turn still runs: `now` never waits for it (the session's close is the runtime's to end the turn).
                const applying = await collect(seat, (f) => phases(f, 'h2').includes('applying'));
                expect(phases(applying, 'h2')).toEqual(['downloading', 'verifying', 'staged', 'draining', 'applying']);
                release();
                const now = [...applying, ...(await collect(seat, settled('h2')))];
                expect(phases(now, 'h2')).toEqual(['downloading', 'verifying', 'staged', 'draining', 'applying', 'done']);
                expect(closedOf(now, 's1')).toMatchObject({ code: 'harness-update' });
                expect(daemon.activeSessions).toEqual([]);
                expect((await readdir(join(dir, 'harnesses', 'mock'))).sort()).toEqual(['1.1.0', 'current.json']);

                seat.send({ v: V, t: 'harness.request', requestId: 'h3', op: 'remove', runtime: 'mock', mode: 'now' });
                const removal = await collect(seat, (f) => phases(f, 'h3').includes('failed'));
                expect(removal.find((f) => f.t === 'harness.status' && f.requestId === 'h3' && f.phase === 'failed')).toMatchObject({ error: { code: 'in-use' } });
                expect(store.locate('mock')?.version).toBe('1.1.0');

                // A request for a runtime without a driver, and an install without a target, are named failures.
                seat.send({ v: V, t: 'harness.request', requestId: 'h4', op: 'install', runtime: 'nope', mode: 'now' });
                seat.send({ v: V, t: 'harness.request', requestId: 'h5', op: 'install', runtime: 'mock', mode: 'now' });
                const refused = await collect(seat, (f) => phases(f, 'h4').includes('failed') && phases(f, 'h5').includes('failed'));
                const errorOf = (id: string) => refused.find((f): f is DaemonFrameOf<'harness.status'> => f.t === 'harness.status' && f.requestId === id)?.error?.code;
                expect([errorOf('h4'), errorOf('h5')]).toEqual(['invalid', 'invalid']);
            });
        });

        describe('the heal on start: an update from a build that bundled the runtimes', () => {
            const BUILTIN = ['claude-code', 'copilot-cli', 'codex-cli'];
            /** The three harness builds and a manifest naming them, at `https://releases.test/manifest.json`. */
            async function servedRelease() {
                const releases = fakeReleases();
                const harnesses: Record<string, { version: string; assets: Record<string, import('@agentic/core').ReleaseAsset> }> = {};
                for (const runtime of BUILTIN) {
                    const zip = await fakeHarnessZip(dir, runtime, '1.0.0');
                    releases.put(`harness-${runtime}.zip`, zip.bytes);
                    harnesses[runtime] = { version: '1.0.0', assets: { [`${process.platform}-${process.arch}`]: zip.asset(releases.url(`harness-${runtime}.zip`)) } };
                }
                releases.put('manifest.json', JSON.stringify({ version: '0.2.0', channel: 'stable', publishedAt: 0, commit: 'abcdef0', protocol: 1, assets: {}, harnesses }));
                return releases;
            }
            const startHealing = async (releases: ReturnType<typeof fakeReleases>, store: ReturnType<typeof harnessStore>) => {
                const build = (runtime: string) => (store.locate(runtime) ? agentDriver(runtime, mockAgent({ respond: async () => [{ text: 'hi' }] })) : harnessMissingDriver(runtime));
                return start([env('env_c', { runtime: 'claude-code' })], BUILTIN.map(build), undefined, {
                    harnesses: { store, fetch: releases.fetch, rebuild: build, heal: { manifestUrl: releases.url('manifest.json') } }
                });
            };
            const until = async (check: () => boolean) => {
                for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
                expect(check()).toBe(true);
            };

            it('no harnesses and no selection file: all three are installed from the channel manifest, a harnesses frame after each, and the sessions open', async () => {
                const releases = await servedRelease();
                const store = harnessStore({ root: join(dir, 'harnesses'), bundled: false });
                const { seat, hello } = await startHealing(releases, store);
                expect(hello.harnesses?.map((h) => h.status)).toEqual(['missing', 'missing', 'missing']);
                const frames = await collect(seat, (f) => f.filter((x) => x.t === 'harnesses').length === 3);
                const last = frames.filter((f): f is DaemonFrameOf<'harnesses'> => f.t === 'harnesses').at(-1)!;
                expect(last.harnesses.map((h) => [h.runtime, h.status, h.installed?.version])).toEqual(BUILTIN.map((r) => [r, 'ready', '1.0.0']));
                expect(frames.find((f) => f.t === 'env')).toMatchObject({ environments: [{ id: 'env_c', doctor: { ok: true } }] });
                for (const runtime of BUILTIN) expect(store.locate(runtime)?.version).toBe('1.0.0');
                expect(store.selection()).toBeUndefined();
                expect(store.failures()).toEqual({});
                open(seat, 's1', 'env_c');
                expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('s1');
            });

            it('an empty selection installs nothing; a failed install is recorded for doctor and tried again on the next start', async () => {
                const releases = await servedRelease();
                const store = harnessStore({ root: join(dir, 'harnesses'), bundled: false });
                await store.setSelection([]);
                const first = await startHealing(releases, store);
                await new Promise((r) => setTimeout(r, 300));
                expect(releases.requests).toEqual([]);
                expect(BUILTIN.map((r) => store.state(r).status)).toEqual(['missing', 'missing', 'missing']);
                open(first.seat, 's1', 'env_c');
                expect(await expectFrame(first.seat, 'session.closed')).toMatchObject({ code: 'harness-missing' });
                await first.daemon.stop();

                // Selected, but the release is unreachable: named, never fatal.
                await store.setSelection(['codex-cli']);
                const offline = fakeReleases();
                const second = await startHealing(offline, store);
                await until(() => 'codex-cli' in store.failures());
                expect(Object.keys(store.failures())).toEqual(['codex-cli']);
                expect(store.failures()['codex-cli']!.message).toMatch(/no release manifest at https:\/\/releases\.test\/manifest\.json/);
                expect(second.daemon.connected).toBe(true);
                await second.daemon.stop();

                // The next start: the release is back, codex-cli is installed and its failure cleared; the others stay unselected.
                const third = await startHealing(releases, store);
                await collect(third.seat, (f) => f.some((x) => x.t === 'harnesses'));
                expect(store.locate('codex-cli')?.version).toBe('1.0.0');
                expect(store.locate('claude-code')).toBeUndefined();
                expect(store.failures()).toEqual({});
            });

            it('a ready harness older than the build pins is updated on start and the old version pruned; a current one downloads nothing (#600)', async () => {
                const releases = await servedRelease();
                const old = await fakeHarnessZip(dir, 'claude-code', '0.9.0');
                releases.put('harness-claude-code-old.zip', old.bytes);
                let pin = '1.0.0';
                const store = harnessStore({ root: join(dir, 'harnesses'), bundled: false, pinned: () => pin });
                await store.setSelection(['claude-code']);
                const staged = await store.stage('claude-code', old.asset(releases.url('harness-claude-code-old.zip')), { fetch: releases.fetch });
                await store.activate('claude-code', staged.version);
                expect(store.reports(['claude-code'])).toMatchObject([{ status: 'ready', installed: { version: '0.9.0' }, current: false }]);

                const first = await startHealing(releases, store);
                const frames = await collect(first.seat, (f) => f.some((x) => x.t === 'harnesses'));
                expect(frames.find((f) => f.t === 'harnesses')).toMatchObject({ harnesses: [{ runtime: 'claude-code', status: 'ready', installed: { version: '1.0.0' }, current: true }, {}, {}] });
                expect(store.locate('claude-code')?.version).toBe('1.0.0');
                expect((await readdir(join(dir, 'harnesses', 'claude-code'))).sort()).toEqual(['1.0.0', 'current.json']);
                expect(store.failures()).toEqual({});
                await first.daemon.stop();

                // Current: the next start does not even read the manifest.
                releases.requests.length = 0;
                const second = await startHealing(releases, store);
                await new Promise((r) => setTimeout(r, 300));
                expect(releases.requests).toEqual([]);
                await second.daemon.stop();

                // A pin the release cannot serve (offline): recorded, and the installed harness keeps running.
                pin = '1.1.0';
                const third = await startHealing(fakeReleases(), store);
                await until(() => 'claude-code' in store.failures());
                expect(store.locate('claude-code')?.version).toBe('1.0.0');
                open(third.seat, 's1', 'env_c');
                expect((await expectFrame(third.seat, 'session.opened')).sessionId).toBe('s1');
            });
        });

        it('removes a harness no environment uses, and a runtime without one refuses its sessions with harness-missing', async () => {
            await withHarnessServer(async (target, fetch) => {
                const store = harnessStore({ root: join(dir, 'harnesses'), bundled: false });
                const { seat, hello } = await start([env('env_mock', { runtime: 'mock' })], [harnessMissingDriver('mock'), harnessMissingDriver('spare')], undefined, {
                    harnesses: { store, fetch, rebuild: (runtime) => (store.locate(runtime) ? agentDriver(runtime, mockAgent({ respond: async () => [{ text: 'hi' }] })) : harnessMissingDriver(runtime)) }
                });
                expect(hello.environments[0]!.doctor).toMatchObject({ ok: false, findings: [{ code: 'harness-missing' }] });
                open(seat, 's1', 'env_mock');
                expect(await expectFrame(seat, 'session.closed')).toMatchObject({ sessionId: 's1', code: 'harness-missing', reason: expect.stringMatching(/agentic-daemon harness install mock/) });

                seat.send({ v: V, t: 'harness.request', requestId: 'h1', op: 'install', runtime: 'spare', target: await target('spare', '1.0.0'), mode: 'now' });
                await collect(seat, settled('h1'));
                seat.send({ v: V, t: 'harness.request', requestId: 'h2', op: 'remove', runtime: 'spare', mode: 'drain' });
                const removed = await collect(seat, settled('h2'));
                expect(phases(removed, 'h2')).toEqual(['applying', 'done']);
                expect(removed.find((f) => f.t === 'harnesses')).toMatchObject({ harnesses: [{ runtime: 'mock', status: 'missing' }, { runtime: 'spare', status: 'missing' }] });
                seat.send({ v: V, t: 'harness.request', requestId: 'h3', op: 'remove', runtime: 'spare', mode: 'drain' });
                const again = await collect(seat, (f) => phases(f, 'h3').includes('failed'));
                expect(again.find((f) => f.t === 'harness.status' && f.requestId === 'h3')).toMatchObject({ phase: 'failed', error: { code: 'not-installed' } });

                // Installing the missing one changes what its environment reports: `env` goes out, and the session opens.
                seat.send({ v: V, t: 'harness.request', requestId: 'h4', op: 'install', runtime: 'mock', target: await target('mock', '1.0.0'), mode: 'drain' });
                const installed = await collect(seat, settled('h4'));
                expect(installed.find((f) => f.t === 'env')).toMatchObject({ environments: [{ id: 'env_mock', doctor: { ok: true } }] });
                open(seat, 's2', 'env_mock');
                expect((await expectFrame(seat, 'session.opened')).sessionId).toBe('s2');
            });
        });
    });

    it('re-opens from spec.resume on the same log: the head continues on the next epoch, not at (0, 0) (#363)', async () => {
        const driver = scriptedDriver({ events: 5, heartbeatMs: 1_000 });
        const first = await start([env('env_a')], [driver]);
        open(first.seat, 'session_1', 'env_a');
        const opened = await expectFrame(first.seat, 'session.opened');
        expect(opened.head).toEqual({ epoch: 0, seq: 0 });
        expect(await wholeTurn(first.seat, 'session_1', 1)).toEqual([1, 2, 3, 4, 5].map((seq) => ({ epoch: 0, seq })));
        const closing = closedFrames(first.seat, 1);
        await first.daemon.stop({ reason: 'restart' });
        expect((await closing)[0]).toMatchObject({ sessionId: 'session_1', code: 'restart' });
        daemons.length = 0;

        const second = await restarted([driver]);
        await expectFrame(second.seat, 'hello');
        second.seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: { session_1: { epoch: 0, seq: 5 } } });
        expect(await expectFrame(second.seat, 'session.closed')).toMatchObject({ sessionId: 'session_1', code: 'restart' });

        // The platform re-opens it with the ref it recorded. This one names no epoch: the head goes on after the log's.
        const reopen = (seat: PlatformSeat, resume: unknown) => seat.send({ v: V, t: 'session.open', sessionId: 'session_1' as SessionId, environmentId: 'env_a', spec: { agentId: 'agent_1', cwd: dir, system: 's', tools: [], resume } });
        reopen(second.seat, opened.ref);
        const reopened = await expectFrame(second.seat, 'session.opened');
        expect(driver.opened.at(-1)!.spec.resume).toEqual(opened.ref);
        expect(reopened.head).toEqual({ epoch: 1, seq: 0 });
        expect(reopened.ref).toMatchObject({ data: { epoch: 1 } });
        expect(await wholeTurn(second.seat, 'session_1', 2)).toEqual([1, 2, 3, 4, 5].map((seq) => ({ epoch: 1, seq })));

        // Once more, from a ref that names its epoch: the runtime's next one is the head's.
        second.seat.send({ v: V, t: 'session.close', sessionId: 'session_1' as SessionId });
        await expectFrame(second.seat, 'session.closed');
        reopen(second.seat, reopened.ref);
        expect((await expectFrame(second.seat, 'session.opened')).head).toEqual({ epoch: 2, seq: 0 });
        expect((await wholeTurn(second.seat, 'session_1', 3))[0]).toEqual({ epoch: 2, seq: 1 });

        // One log across the three runs, in order.
        second.seat.send({ v: V, t: 'history.request', requestId: 'h1', sessionId: 'session_1' as SessionId, from: { epoch: 0, seq: 0 } });
        const history = await expectFrame(second.seat, 'history.response');
        expect(history.result!.events.map((f) => (f.kind === 'event' ? `${f.epoch}:${f.seq}` : f.kind))).toEqual([0, 1, 2].flatMap((epoch) => [1, 2, 3, 4, 5].map((seq) => `${epoch}:${seq}`)));
    });

    it('a runtime that refuses the resume is answered resume-failed; a failed fresh open carries no code (#363)', async () => {
        const base = scriptedDriver({ events: 1, heartbeatMs: 1_000 });
        const refusing: DaemonDriver = {
            ...base,
            async open(e, spec, ctx) {
                if (spec.resume !== undefined) throw new Error('no conversation with that id');
                if (spec.system === 'broken') throw new Error('the CLI did not start');
                return base.open(e, spec, ctx);
            }
        };
        const { seat } = await start([env('env_a')], [refusing]);
        seat.send({ v: V, t: 'session.open', sessionId: 'session_1' as SessionId, environmentId: 'env_a', spec: { agentId: 'agent_1', cwd: dir, system: 's', tools: [], resume: { agent: 'scripted', v: 1, id: 'gone' } } });
        expect(await expectFrame(seat, 'session.closed')).toEqual({ v: V, t: 'session.closed', sessionId: 'session_1', reason: 'the runtime could not resume the session: no conversation with that id', code: 'resume-failed' });
        seat.send({ v: V, t: 'session.open', sessionId: 'session_2' as SessionId, environmentId: 'env_a', spec: { agentId: 'agent_1', cwd: dir, system: 'broken', tools: [] } });
        expect(await expectFrame(seat, 'session.closed')).toEqual({ v: V, t: 'session.closed', sessionId: 'session_2', reason: 'the runtime could not open a session: the CLI did not start' });
    });

    it('answers history.request from its log — live, bounded, unknown — and after a restart from the file on disk (#397)', async () => {
        const first = await start([env('env_a')]);
        open(first.seat, 'session_1', 'env_a');
        const opened = await expectFrame(first.seat, 'session.opened');
        first.seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: 'c1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'go' }] } });
        const streamed: { epoch: number; seq: number; event: unknown }[] = [];
        for (;;) {
            const frame = await next(first.seat);
            if (frame.t !== 'session.frame' || frame.frame.kind !== 'event') continue;
            streamed.push({ epoch: frame.frame.epoch, seq: frame.frame.seq, event: frame.frame.event });
            if (frame.frame.event.type === 'turn-end') break;
        }
        expect(streamed).toHaveLength(5);
        const ask = async (seat: PlatformSeat, requestId: string, range: Record<string, unknown>, sessionId = 'session_1') => {
            seat.send({ v: V, t: 'history.request', requestId, sessionId: sessionId as SessionId, from: opened.head, ...range });
            const response = await expectFrame(seat, 'history.response');
            expect(response.requestId).toBe(requestId);
            return response;
        };
        // Waits for the log's pending writes: the frames just streamed are on disk when asked for.
        const whole = await ask(first.seat, 'h1', {});
        expect(whole.result?.events).toEqual(streamed.map((f) => ({ v: 1, kind: 'event', ...f })));
        expect(whole.result?.more).toBeUndefined();
        const cut = await ask(first.seat, 'h2', { limit: 2 });
        expect(cut.result).toMatchObject({ more: true });
        expect(cut.result?.events.map((f) => f.kind === 'event' && f.seq)).toEqual([1, 2]);
        expect((await ask(first.seat, 'h3', { to: { epoch: 0, seq: 3 } })).result?.events.map((f) => f.kind === 'event' && f.seq)).toEqual([1, 2, 3]);
        expect((await ask(first.seat, 'h4', {}, 'session_nobody')).error).toEqual({ code: 'unknown-session', message: expect.stringContaining('session_nobody') });

        // The daemon restarts: the session is gone, its log is not.
        await first.daemon.stop();
        daemons.length = 0;
        const daemon = createDaemon({ credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token }, environments: [env('env_a')], drivers: [scriptedDriver({ events: 5, heartbeatMs: 1_000 })], eventLog: ndjsonEventLog(join(dir, 'sessions')), backoff: { initialMs: 5, maxMs: 20 } });
        daemons.push(daemon);
        await daemon.start();
        const seat = await relay.nextSeat();
        await expectFrame(seat, 'hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });
        expect((await ask(seat, 'h5', {})).result?.events).toEqual(whole.result?.events);
    });

    it('trims a session log to the retention budget after a turn ends, and a range before the cut answers a named gap (#397)', async () => {
        const daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments: [env('env_a')],
            drivers: [scriptedDriver({ events: 5, heartbeatMs: 1_000 })],
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 1_000,
            // About one and a half scripted turns of NDJSON: the third turn pushes the first out.
            retention: { maxBytes: 1_100 }
        });
        daemons.push(daemon);
        await daemon.start();
        const seat = await relay.nextSeat();
        await expectFrame(seat, 'hello');
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });
        open(seat, 'session_1', 'env_a');
        const opened = await expectFrame(seat, 'session.opened');
        let head = opened.head;
        for (let n = 1; n <= 3; n++) {
            seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: `c${n}`, type: 'prompt', turnId: `t${n}`, input: [{ type: 'text', text: 'go' }] } });
            for (;;) {
                const frame = await next(seat);
                if (frame.t !== 'session.frame' || frame.frame.kind !== 'event') continue;
                head = { epoch: frame.frame.epoch, seq: frame.frame.seq };
                if (frame.frame.event.type === 'turn-end') break;
            }
        }
        expect(head).toEqual({ epoch: 0, seq: 15 });
        // Retention runs after the turn-end frame went out: poll until the log's start moved.
        const log = ndjsonEventLog(join(dir, 'sessions'));
        const deadline = Date.now() + 5_000;
        let gap: DaemonFrameOf<'history.response'> | undefined;
        for (let n = 0; !gap?.error; n++) {
            if (Date.now() > deadline) throw new Error('the log was not trimmed');
            await new Promise((r) => setTimeout(r, 20));
            seat.send({ v: V, t: 'history.request', requestId: `g${n}`, sessionId: 'session_1' as SessionId, from: opened.head });
            gap = await expectFrame(seat, 'history.response');
        }
        expect(gap.error).toMatchObject({ code: 'gap', earliest: { epoch: 0, seq: expect.any(Number) } });
        const earliest = gap.error!.earliest!;
        expect(earliest.seq).toBeGreaterThan(1);
        // The newest turn is whole on disk; what is left is exactly what a range from the cut answers.
        const left = [];
        for await (const e of log.read('session_1')) left.push(e.seq);
        expect(left[0]).toBe(earliest.seq);
        expect(left.at(-1)).toBe(15);
        seat.send({ v: V, t: 'history.request', requestId: 'kept', sessionId: 'session_1' as SessionId, from: { epoch: 0, seq: earliest.seq - 1 } });
        expect((await expectFrame(seat, 'history.response')).result?.events.map((f) => f.kind === 'event' && f.seq)).toEqual(left);
    });

    it('reports the id the runtime names its session with: session.ref once it changes, nothing while it does not (#389)', async () => {
        const { seat } = await start([env('env_a')], [namingDriver({ events: 3, heartbeatMs: 1_000 })]);
        open(seat, 'session_1', 'env_a');
        const opened = await expectFrame(seat, 'session.opened');
        expect(opened.ref).toEqual({ agent: 'scripted', v: 1, id: 'session_1' });
        /** One turn: every frame in order until its `turn-end`, and the `session.ref` frames among them. */
        const turn = async (n: number) => {
            seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: `c${n}`, type: 'prompt', turnId: `t${n}`, input: [{ type: 'text', text: 'go' }] } });
            const order: string[] = [];
            const refs: DaemonFrameOf<'session.ref'>[] = [];
            for (;;) {
                const frame = await next(seat);
                if (frame.t === 'heartbeat' || frame.t === 'telemetry') continue;
                order.push(frame.t === 'session.frame' && frame.frame.kind === 'event' ? `event:${frame.frame.event.type}` : frame.t);
                if (frame.t === 'session.ref') refs.push(frame);
                if (frame.t === 'session.frame' && frame.frame.kind === 'event' && frame.frame.event.type === 'turn-end') return { order, refs };
            }
        };
        const first = await turn(1);
        expect(first.refs).toEqual([{ v: V, t: 'session.ref', sessionId: 'session_1', ref: { agent: 'scripted', v: 1, id: 'session_1.run' } }]);
        // Sent with the first frame that shows the new id, not held for the turn-end: a turn that errors before ending still named the session.
        expect(first.order.indexOf('session.ref')).toBeLessThan(first.order.indexOf('event:turn-end'));
        // The same identity again is not news.
        expect((await turn(2)).refs).toEqual([]);
    });

    it("reports the runtime's title for the conversation: session.title after the turn that brought it, once more when it moves on, again after a re-probe (#460)", { timeout: 15_000 }, async () => {
        // Probes: after turn 1 nothing (the CLI's background call is still running), the re-probe finds one; after turn 2 and its
        // re-probe the same; after turn 3 a new one.
        const driver = titlingDriver({ events: 3, heartbeatMs: 1_000 }, [undefined, 'Greeting Ada', 'Greeting Ada', 'Greeting Ada', 'Ada, greeted thrice']);
        const { seat } = await start([env('env_a')], [driver], undefined, { titleRecheckMs: 30 });
        open(seat, 'session_1', 'env_a');
        await expectFrame(seat, 'session.opened');
        expect(driver.probes).toEqual([]); // a fresh session is not asked before its first turn
        /** One turn, then whatever the daemon says up to the second heartbeat (≥ 1 s) after its `turn-end`. */
        const turn = async (n: number) => {
            seat.send({ v: V, t: 'session.command', sessionId: 'session_1' as SessionId, command: { v: 1, commandId: `c${n}`, type: 'prompt', turnId: `t${n}`, input: [{ type: 'text', text: 'go' }] } });
            const titles: string[] = [];
            let ended = false;
            let beats = 0;
            while (beats < 2) {
                const frame = await next(seat);
                if (frame.t === 'heartbeat' && ended) beats++;
                if (frame.t === 'session.title') titles.push(frame.title);
                if (frame.t === 'session.frame' && frame.frame.kind === 'event' && frame.frame.event.type === 'turn-end') ended = true;
            }
            return titles;
        };
        // Turn 1: the probe finds nothing; the re-probe (30 ms later) does.
        expect(await turn(1)).toEqual(['Greeting Ada']);
        expect(driver.probes).toEqual([1, 1]);
        // Turn 2: the same title is not news (the re-probe after it reads the same and says nothing).
        expect(await turn(2)).toEqual([]);
        expect(driver.probes).toEqual([1, 1, 2, 2]);
        // Turn 3: it moved on.
        expect(await turn(3)).toEqual(['Ada, greeted thrice']);
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
                if (frame.t !== 'session.frame' && frame.t !== 'heartbeat' && frame.t !== 'telemetry') throw new Error(`expected session.opened, got ${frame.t}`);
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
    it('sameRefIdentity: the id and data.epoch decide, nothing else (#389)', () => {
        const ref = { agent: 'claude-code', v: 1, id: 'a', data: { cwd: '/w', epoch: 1 } };
        expect(sameRefIdentity(ref, { ...ref })).toBe(true);
        expect(sameRefIdentity(ref, { ...ref, data: { cwd: '/elsewhere', epoch: 1 } })).toBe(true);
        expect(sameRefIdentity(ref, { ...ref, id: 'b' })).toBe(false);
        expect(sameRefIdentity(ref, { ...ref, data: { cwd: '/w', epoch: 2 } })).toBe(false);
        expect(sameRefIdentity({ agent: 'x', v: 1, id: 'a' }, { agent: 'x', v: 1, id: 'a', data: 'opaque' })).toBe(true);
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
    it('agentCapabilitiesOf reads the ops a harness reports under their own names (#453): configure reaches the session', () => {
        const report: CapabilityReport = { runtime: 'claude-code', supported: ['session.configure-model', 'session.fork', 'turn.structured-output', 'agent.list-sessions'], unsupported: [], resume: 'portable', cancel: true, steer: true, permissions: 'harness-filtered', tools: 'mcp' };
        expect(agentCapabilitiesOf(report)).toMatchObject({ config: true, fork: true, structuredOutput: true, listSessions: true });
    });
});

describe('builtin drivers', () => {
    it('ship a disposable driver and a quota source per harness runtime', async () => {
        const { builtinRuntimes, isDisposable } = await import('../src/drivers');
        const { drivers, quotaSources } = builtinRuntimes();
        expect(drivers.map((d) => d.runtime)).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
        expect(drivers.every(isDisposable)).toBe(true);
        expect(quotaSources.map((s) => s.runtime)).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
    });
});
