/**
 * `daemonConformance` — the suite every daemon implementation must pass,
 * and the behaviour every platform side may rely on: pair (hello/welcome),
 * env, heartbeat, session open/opened, a stream of session frames, a
 * reconnect that replays from the platform's `wanted` cursors without a
 * gap or a duplicate (OPS-04, OPS-06), and a tool round trip. No test-runner
 * import: consumers wire the cases into theirs, e.g.
 *
 * ```ts
 * for (const c of daemonConformance(inMemoryHarness())) {
 *     it.skipIf(!!c.skip)(c.name, c.run);
 * }
 * ```
 */

import { DAEMON_PROTOCOL_VERSION, type Cursor, type EnvironmentDescriptor, type SessionId } from '@agentic/core';
import { WIRE_PROTOCOL_VERSION, cursorBefore } from '@sigx/ai-agent/wire';
import type { DaemonFrame, DaemonFrameOf, DaemonFrameType, HelloFrame, PlatformFrame, SessionFrameFrame } from '../frames.js';
import { decodeDaemonFrame, parseDaemonFrame } from '../framing/codec.js';
import { LIMITS } from '../schema/limits.js';
import { assert, assertEqual, fail, withTimeout } from './assert.js';
import type { ConformanceDaemon, ConformanceFeature, ConformanceScript, DaemonConformanceHarness, PlatformSeat } from './harness.js';

export interface ConformanceCase {
    readonly name: string;
    /** Why the case does not apply to this harness (a missing feature). */
    readonly skip?: string;
    run(): Promise<void>;
}

export interface DaemonConformanceOptions {
    /** Milliseconds any single expected frame may take to arrive (ignored frames do not reset it). Default 5 000. */
    readonly timeoutMs?: number;
    /** How long the platform stays away after dropping a connection, so the daemon has frames to replay. Default 100. */
    readonly reconnectDelayMs?: number;
    /** Session frames per prompt. Default 100. */
    readonly events?: number;
    /** Heartbeat interval the daemon is asked to use. Default 20. */
    readonly heartbeatMs?: number;
}

const V = DAEMON_PROTOCOL_VERSION;
/** Cases that need an optional harness feature. */
const NEEDS: Record<string, ConformanceFeature> = { env: 'env', gap: 'gap' };

type EventFrame = Extract<SessionFrameFrame['frame'], { readonly kind: 'event' }>;

/** The suite's view of one connection: decodes, validates and waits with a timeout. */
class Peer {
    constructor(
        private readonly seat: PlatformSeat,
        private readonly timeoutMs: number
    ) {}

    send(frame: PlatformFrame): void {
        this.seat.send(frame);
    }

    get raw(): ((text: string) => void) | undefined {
        return this.seat.sendRaw?.bind(this.seat);
    }

    drop(): void {
        this.seat.drop();
    }

    async next(what = 'a daemon frame', ms = this.timeoutMs): Promise<DaemonFrame> {
        const raw = await withTimeout(this.seat.next(), ms, what, this.timeoutMs);
        const result = typeof raw === 'string' ? decodeDaemonFrame(raw) : parseDaemonFrame(raw);
        if (!result.ok) fail(`the daemon sent an invalid frame (${result.error.code}): ${result.error.message}`);
        return result.frame;
    }

    /**
     * The next frame of kind `t` within the timeout; frames in `ignore` are
     * passed over (without extending the deadline — a heartbeat is not
     * progress), anything else fails the case.
     */
    async expect<T extends DaemonFrameType>(t: T, ignore: readonly DaemonFrameType[] = ['heartbeat']): Promise<DaemonFrameOf<T>> {
        const deadline = Date.now() + this.timeoutMs;
        for (;;) {
            const frame = await this.next(t, Math.max(1, deadline - Date.now()));
            if (frame.t === t) return frame as DaemonFrameOf<T>;
            if (!ignore.includes(frame.t)) fail(`expected a ${t} frame, got ${frame.t}`);
        }
    }

    /** `count` event frames for `sessionId` continuing gaplessly from `after` (exclusive); a `gap`, a foreign session, a duplicate or a hole fails the case as soon as it shows. */
    async events(sessionId: SessionId, count: number, after: Cursor, what: string, ignore: readonly DaemonFrameType[] = ['heartbeat']): Promise<EventFrame[]> {
        const out: EventFrame[] = [];
        let last = after;
        while (out.length < count) {
            const frame = await this.expect('session.frame', ignore);
            assertEqual(frame.sessionId, sessionId, 'session.frame.sessionId');
            if (frame.frame.kind === 'gap') fail(`${what}: the daemon reported a gap (${frame.frame.from.epoch}, ${frame.frame.from.seq}) → (${frame.frame.resumeAt.epoch}, ${frame.frame.resumeAt.seq}) where a gapless replay was possible`);
            if (frame.frame.kind !== 'event') continue;
            assertFollows(frame.frame, last, what);
            last = cursorOf(frame.frame);
            out.push(frame.frame);
        }
        return out;
    }
}

const cursorOf = (f: EventFrame): Cursor => ({ epoch: f.epoch, seq: f.seq });

/** `f` is the frame right after `last` in the same epoch, stamped consistently. */
function assertFollows(f: EventFrame, last: Cursor, what: string): void {
    assertEqual(f.v, WIRE_PROTOCOL_VERSION, `${what}: wire protocol version`);
    assert(f.epoch === last.epoch, `${what}: epoch changed mid-stream (${last.epoch} → ${f.epoch})`);
    if (f.seq <= last.seq) fail(`${what}: seq ${f.seq} after ${last.seq} — a duplicate or an out-of-order frame (OPS-06)`);
    if (f.seq !== last.seq + 1) fail(`${what}: seq ${f.seq} after ${last.seq} — a gap`);
    assertEqual({ epoch: f.event.epoch, seq: f.event.seq }, cursorOf(f), `${what}: the event stamp matches the frame`);
}

/** A whole turn: the last frame ends it. */
function assertTurn(frames: readonly EventFrame[], what: string): void {
    assert(frames.length > 0 && frames[frames.length - 1]!.event.type === 'turn-end', `${what}: the last event ends the turn`);
}

export function daemonConformance(harness: DaemonConformanceHarness, options: DaemonConformanceOptions = {}): readonly ConformanceCase[] {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const reconnectDelayMs = options.reconnectDelayMs ?? 100;
    const events = options.events ?? 100;
    const away = (): Promise<void> => new Promise((r) => setTimeout(r, reconnectDelayMs));
    const heartbeatMs = options.heartbeatMs ?? 20;
    const features = new Set(harness.features ?? []);
    const script: ConformanceScript = { events, heartbeatMs };

    /** Start a daemon for `script`, run `body` against it, stop it whatever happens. */
    const withDaemon = async (s: ConformanceScript, body: (daemon: ConformanceDaemon) => Promise<void>): Promise<void> => {
        const daemon = await harness.start(s);
        try {
            await body(daemon);
        } finally {
            await daemon.stop();
        }
    };

    /** Dial and complete the handshake: hello in, welcome out. */
    const handshake = async (daemon: ConformanceDaemon, wanted: Readonly<Record<string, Cursor>> = {}): Promise<{ peer: Peer; hello: HelloFrame }> => {
        const peer = new Peer(await daemon.dial(), timeoutMs);
        const hello = await peer.expect('hello', []);
        assertEqual(hello.machineId, daemon.machineId, 'hello.machineId is the paired machine (USR-04)');
        assert(
            hello.environments.some((e) => e.id === daemon.environmentId),
            `hello.environments lists the environment the suite was given (${daemon.environmentId})`
        );
        for (const e of hello.environments) assertEqual(e.machineId, daemon.machineId, `environment ${e.id} belongs to the machine`);
        peer.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted });
        return { peer, hello };
    };

    const openSpec = (hello: HelloFrame, daemon: ConformanceDaemon, tools: readonly string[]) => {
        const env = hello.environments.find((e) => e.id === daemon.environmentId)!;
        return { agentId: 'agent_conformance', cwd: env.cwdRoots[0] ?? '.', system: 'You are the conformance agent.', tools };
    };

    const open = async (peer: Peer, hello: HelloFrame, daemon: ConformanceDaemon, sessionId: SessionId, tools: readonly string[] = []) => {
        peer.send({ v: V, t: 'session.open', sessionId, environmentId: daemon.environmentId, spec: openSpec(hello, daemon, tools) });
        const opened = await peer.expect('session.opened');
        assertEqual(opened.sessionId, sessionId, 'session.opened.sessionId');
        return opened;
    };

    const prompt = async (peer: Peer, sessionId: SessionId, n: number) => {
        const commandId = `cmd_${n}`;
        peer.send({ v: V, t: 'session.command', sessionId, command: { v: WIRE_PROTOCOL_VERSION, commandId, type: 'prompt', turnId: `turn_${n}`, input: [{ type: 'text', text: `Prompt ${n}.` }] } });
        const reply = await peer.expect('session.reply');
        assertEqual(reply.sessionId, sessionId, 'session.reply.sessionId');
        assertEqual(reply.reply.commandId, commandId, 'session.reply answers the command it was sent');
        assert(reply.reply.kind === 'ack', `the prompt was acknowledged, not refused (${reply.reply.kind === 'error' ? reply.reply.message : ''})`);
    };

    const S1 = 'session_conformance_1' as SessionId;

    const cases: ConformanceCase[] = [
        {
            name: 'hello-welcome',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    assertEqual(hello.v, V, 'hello.v');
                    assertEqual(hello.resume, {}, 'a fresh daemon has nothing to resume');
                    assert(hello.capabilities.length > 0, 'hello.capabilities reports at least one runtime (EXE-08)');
                    peer.send({ v: V, t: 'ping' });
                    const pong = await peer.expect('pong');
                    assert(pong.at <= Date.now() + 1, 'pong.at is a time');
                })
        },
        {
            name: 'malformed-input',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const raw = peer.raw;
                    if (raw) {
                        raw('{not json');
                        raw('[]');
                        raw(JSON.stringify({ v: V, t: 'no.such.frame' }));
                        raw(JSON.stringify({ v: V, t: 'session.close' }));
                        raw(`{"v":${V},"t":"ping","pad":"${'x'.repeat(LIMITS.frameBytes)}"}`);
                    }
                    // A frame from another protocol version is dropped, never answered.
                    peer.send({ v: V + 1, t: 'ping' } as unknown as PlatformFrame);
                    // The connection survives: the next valid frame is answered, and nothing was answered in between.
                    await open(peer, hello, daemon, S1);
                })
        },
        {
            name: 'env',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const extra: EnvironmentDescriptor = {
                        ...hello.environments[0]!,
                        id: 'env_conformance_extra' as EnvironmentDescriptor['id'],
                        name: 'conformance extra',
                        account: { label: 'extra', authStatus: 'missing' }
                    };
                    const next = [...hello.environments, extra];
                    await daemon.setEnvironments!(next);
                    const env = await peer.expect('env');
                    assertEqual(
                        env.environments.map((e) => e.id),
                        next.map((e) => e.id),
                        'env announces the new environment list'
                    );
                    assertEqual(env.environments.find((e) => e.id === extra.id)?.account.authStatus, 'missing', 'env carries auth status per environment (EXE-06, EXE-08)');
                })
        },
        {
            name: 'heartbeat',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const idle = await peer.expect('heartbeat', []);
                    assertEqual(idle.active, [], 'an idle daemon heartbeats with no active sessions');
                    assert(idle.at <= Date.now() + 1, 'heartbeat.at is a time');
                    await open(peer, hello, daemon, S1);
                    const busy = await peer.expect('heartbeat', []);
                    assert(busy.active.includes(S1), 'a heartbeat lists the open session as active (EXE-08)');
                })
        },
        {
            name: 'session',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1);
                    assertEqual(opened.capabilities.runtime, hello.capabilities[0]!.runtime, 'session.opened reports the runtime it runs on');
                    await prompt(peer, S1, 1);
                    assertTurn(await peer.events(S1, events, opened.head, 'the first turn'), 'the first turn');
                    peer.send({ v: V, t: 'session.close', sessionId: S1 });
                    const closed = await peer.expect('session.closed');
                    assertEqual(closed.sessionId, S1, 'session.closed.sessionId');
                })
        },
        {
            name: 'reconnect-replay',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1);
                    await prompt(peer, S1, 1);
                    const seen = Math.floor(events / 3);
                    const before = await peer.events(S1, seen, opened.head, 'the turn before the drop');
                    const last = cursorOf(before[before.length - 1]!);
                    peer.drop();
                    await away();

                    const again = await handshake(daemon, { [S1]: last });
                    const resume = again.hello.resume[S1];
                    assert(resume !== undefined, 'after a reconnect hello.resume names the open session');
                    assert(!cursorBefore(resume, last), `hello.resume[${S1}] (${resume.epoch}, ${resume.seq}) is not behind what the platform already has (${last.epoch}, ${last.seq})`);
                    const after = await again.peer.events(S1, events - seen, last, 'the replay after the reconnect');
                    assertTurn([...before, ...after], 'the turn across a reconnect');
                    assertEqual(after[0]!.seq, last.seq + 1, 'replay starts right after the wanted cursor (OPS-06: nothing the platform had is sent twice)');
                })
        },
        {
            name: 'gap',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1);
                    await prompt(peer, S1, 1);
                    const all = await peer.events(S1, events, opened.head, 'the turn');
                    const head = cursorOf(all[all.length - 1]!);
                    peer.drop();
                    await away();

                    const keepFrom: Cursor = { epoch: head.epoch, seq: Math.max(2, head.seq - 10) };
                    await daemon.truncateLog!(S1, keepFrom);
                    const wanted: Cursor = { epoch: opened.head.epoch, seq: opened.head.seq };
                    const again = await handshake(daemon, { [S1]: wanted });
                    const frame = await again.peer.expect('session.frame');
                    assertEqual(frame.sessionId, S1, 'the gap is reported on the session');
                    assert(frame.frame.kind === 'gap', `a wanted cursor older than the log yields a gap frame, not ${frame.frame.kind} (OPS-04: lost events are named, not hidden)`);
                    assertEqual(frame.frame.from, wanted, 'gap.from is the cursor the platform asked for');
                    assert(cursorBefore(frame.frame.from, frame.frame.resumeAt), 'gap.resumeAt is after gap.from');
                    assert(!cursorBefore(head, frame.frame.resumeAt), 'gap.resumeAt is not beyond the head');
                })
        },
        {
            name: 'tool-round-trip',
            run: () =>
                withDaemon({ ...script, tool: { name: 'echo', input: { x: 1 } } }, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1, ['echo']);

                    await prompt(peer, S1, 1);
                    const call = await peer.expect('tool.call');
                    assertEqual(call.sessionId, S1, 'tool.call.sessionId');
                    assertEqual(call.tool, 'echo', 'tool.call names the tool');
                    assertEqual(call.input, { x: 1 }, 'tool.call carries the input as JSON');
                    peer.send({ v: V, t: 'tool.result', callId: call.callId, output: { x: 1, echoed: true } });
                    const first = await peer.events(S1, events, opened.head, 'the turn after a tool result');
                    assertTurn(first, 'the turn after a tool result');

                    await prompt(peer, S1, 2);
                    const failing = await peer.expect('tool.call');
                    assert(failing.callId !== call.callId, 'every tool call has its own callId');
                    peer.send({ v: V, t: 'tool.result', callId: failing.callId, error: { code: 'boom', message: 'the tool failed on purpose' } });
                    assertTurn(await peer.events(S1, events, cursorOf(first[first.length - 1]!), 'the turn after a tool error'), 'the turn after a tool error');
                })
        }
    ];

    return cases.map((c) => {
        const feature = NEEDS[c.name];
        return feature && !features.has(feature) ? { ...c, skip: `the harness does not declare the "${feature}" feature` } : c;
    });
}
