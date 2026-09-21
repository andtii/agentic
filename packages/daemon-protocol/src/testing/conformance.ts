/**
 * `daemonConformance` — the suite every daemon implementation must pass,
 * and the behaviour every platform side may rely on: pair (hello/welcome),
 * env, heartbeat, session open/opened, a stream of session frames, a
 * reconnect that replays from the platform's `wanted` cursors without a
 * gap or a duplicate (OPS-04, OPS-06), a tool round trip, folder
 * browsing that never leaves the environment's `cwdRoots` (#187), a
 * `locate` of an origin's checkouts under those roots (#331), and
 * environments managed from the platform only inside the machine-local
 * policy (#236), the runtime's own session id reported once it is known (#388), and a session's history answered
 * from the daemon's own log — a range it no longer holds as a named gap (#397), and the lifecycle (#360): the build a
 * daemon reports, a session it lost across a restart re-opened from its ref, an update that drains running turns and
 * can be cancelled, and harnesses installed but never removed from under an environment. No test-runner
 * import: consumers wire the cases into theirs, e.g.
 *
 * ```ts
 * for (const c of daemonConformance(inMemoryHarness())) {
 *     it.skipIf(!!c.skip)(c.name, c.run);
 * }
 * ```
 */

import { DAEMON_PROTOCOL_VERSION, normalizePath, pathWithin, sameOrigin, type Cursor, type EnvironmentDescriptor, type EnvironmentInput, type PlatformInfo, type SessionId } from '@agentic/core';
import { WIRE_PROTOCOL_VERSION, cursorBefore } from '@sigx/ai-agent/wire';
import type { DaemonFrame, DaemonFrameOf, DaemonFrameType, EnvFrame, EnvResponseFrame, HarnessesFrame, HarnessStatusFrame, HelloFrame, PlatformFrame, SessionClosedFrame, SessionFrameFrame, SessionRefFrame, UpdateStatusFrame } from '../frames.js';
import { decodeDaemonFrame, parseDaemonFrame } from '../framing/codec.js';
import { HARNESS_PHASES, isDrainingReply, UPDATE_PHASES } from '../lifecycle.js';
import { isVersion } from '../release.js';
import { LIMITS } from '../schema/limits.js';
import { sessionRef } from '../schema/wire.js';
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

/**
 * Frames a daemon may push at any time after `hello`: liveness, an environment's provider limits (#261), a runtime naming
 * its session (#388), and the harnesses when the daemon finds they changed (#359).
 */
const UNSOLICITED: readonly DaemonFrameType[] = ['heartbeat', 'quota', 'session.ref', 'harnesses'];
/** Cases that need an optional harness feature. */
const NEEDS: Record<string, ConformanceFeature> = {
    env: 'env',
    gap: 'gap',
    'fs-list': 'fs',
    'fs-locate': 'fs',
    'env-put': 'env-manage',
    'env-remove': 'env-manage',
    'env-policy': 'env-manage',
    'session-ref': 'session-ref',
    history: 'history',
    'hello-build': 'build',
    'session-reopen': 'resume',
    'update-drain': 'update',
    'update-cancel': 'update',
    'harness-install': 'harness',
    'harness-remove-in-use': 'harness'
};

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
    async expect<T extends DaemonFrameType>(t: T, ignore: readonly DaemonFrameType[] = UNSOLICITED): Promise<DaemonFrameOf<T>> {
        const deadline = Date.now() + this.timeoutMs;
        for (;;) {
            const frame = await this.next(t, Math.max(1, deadline - Date.now()));
            if (frame.t === t) return frame as DaemonFrameOf<T>;
            if (!ignore.includes(frame.t)) fail(`expected a ${t} frame, got ${frame.t}`);
        }
    }

    /** `count` event frames for `sessionId` continuing gaplessly from `after` (exclusive); a `gap`, a foreign session, a duplicate or a hole fails the case as soon as it shows. */
    async events(sessionId: SessionId, count: number, after: Cursor, what: string, ignore: readonly DaemonFrameType[] = UNSOLICITED): Promise<EventFrame[]> {
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

/** `seen` passes `order` forwards: a phase may repeat (a download reports progress), never go back. */
function assertPhases(seen: readonly string[], order: readonly string[], what: string): void {
    let at = 0;
    for (const phase of seen) {
        const i = order.indexOf(phase);
        assert(i >= at, `${what}: phase ${phase} came after ${order[at]} (${seen.join(' → ')})`);
        at = i;
    }
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

    /** Dial and complete the handshake: hello in, welcome out (with the platform's own versions when `platform` is given). */
    const handshake = async (daemon: ConformanceDaemon, wanted: Readonly<Record<string, Cursor>> = {}, platform?: PlatformInfo): Promise<{ peer: Peer; hello: HelloFrame }> => {
        const peer = new Peer(await daemon.dial(), timeoutMs);
        const hello = await peer.expect('hello', []);
        assertEqual(hello.machineId, daemon.machineId, 'hello.machineId is the paired machine (USR-04)');
        assert(
            hello.environments.some((e) => e.id === daemon.environmentId),
            `hello.environments lists the environment the suite was given (${daemon.environmentId})`
        );
        for (const e of hello.environments) assertEqual(e.machineId, daemon.machineId, `environment ${e.id} belongs to the machine`);
        peer.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted, ...(platform ? { platform } : {}) });
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
    const S2 = 'session_conformance_2' as SessionId;

    /**
     * One whole turn from a prompt sent by hand: its ack, its events after `after` up to `turn-end`, and the last
     * `session.ref` the runtime sent while it ran — that may come before, between or after the turn's frames.
     */
    const turn = async (peer: Peer, sessionId: SessionId, n: number, after: Cursor): Promise<{ events: EventFrame[]; ref?: SessionRefFrame }> => {
        const commandId = `cmd_${n}`;
        peer.send({ v: V, t: 'session.command', sessionId, command: { v: WIRE_PROTOCOL_VERSION, commandId, type: 'prompt', turnId: `turn_${n}`, input: [{ type: 'text', text: `Prompt ${n}.` }] } });
        let acked = false;
        let ref: SessionRefFrame | undefined;
        const events: EventFrame[] = [];
        let last = after;
        let deadline = Date.now() + timeoutMs;
        while (!acked || events[events.length - 1]?.event.type !== 'turn-end') {
            const frame = await peer.next(acked ? `the rest of turn ${n}` : `the ack of prompt ${n}`, Math.max(1, deadline - Date.now()));
            if (!UNSOLICITED.includes(frame.t)) deadline = Date.now() + timeoutMs;
            if (frame.t === 'session.ref' && frame.sessionId === sessionId) ref = frame;
            else if (frame.t === 'session.reply') {
                assertEqual([frame.sessionId, frame.reply.commandId], [sessionId, commandId], 'session.reply answers the prompt it was sent');
                assert(frame.reply.kind === 'ack', `prompt ${n} was acknowledged, not refused (${frame.reply.kind === 'error' ? frame.reply.message : ''})`);
                acked = true;
            } else if (frame.t === 'session.frame') {
                assertEqual(frame.sessionId, sessionId, 'session.frame.sessionId');
                if (frame.frame.kind === 'gap') fail(`turn ${n}: the daemon reported a gap on a live stream`);
                if (frame.frame.kind !== 'event') continue;
                assertFollows(frame.frame, last, `turn ${n}`);
                last = cursorOf(frame.frame);
                events.push(frame.frame);
            } else if (!UNSOLICITED.includes(frame.t)) fail(`expected the ack or the events of prompt ${n}, got ${frame.t}`);
        }
        return { events, ...(ref ? { ref } : {}) };
    };

    /**
     * Take the `frameType` status frames of `requestId` until `stop` says the last one ends it; any other frame goes to
     * `other`, which by default passes over the unsolicited ones and fails on the rest.
     */
    const statuses = async <T extends 'update.status' | 'harness.status'>(
        peer: Peer,
        frameType: T,
        requestId: string,
        stop: (phase: DaemonFrameOf<T>['phase']) => boolean,
        other: (frame: DaemonFrame) => void = (f) => {
            if (!UNSOLICITED.includes(f.t)) fail(`expected a ${frameType} frame, got ${f.t}`);
        }
    ): Promise<{ phases: DaemonFrameOf<T>['phase'][]; last: DaemonFrameOf<T> }> => {
        const phases: DaemonFrameOf<T>['phase'][] = [];
        let deadline = Date.now() + timeoutMs;
        for (;;) {
            const frame = await peer.next(frameType, Math.max(1, deadline - Date.now()));
            if (!UNSOLICITED.includes(frame.t)) deadline = Date.now() + timeoutMs;
            if (frame.t !== frameType) {
                other(frame);
                continue;
            }
            const status = frame as UpdateStatusFrame | HarnessStatusFrame;
            const phase = status.phase as DaemonFrameOf<T>['phase'];
            assertEqual(status.requestId, requestId, `${frameType} answers the request it was sent`);
            phases.push(phase);
            if (stop(phase)) return { phases, last: status as DaemonFrameOf<T> };
        }
    };

    /** Send one `env.request` and take its answer, plus the `env` frame that came with it — before or after, whichever the daemon chose. */
    const manage = async (peer: Peer, requestId: string, op: { op: 'put'; environment: EnvironmentInput } | { op: 'remove'; environmentId: EnvironmentDescriptor['id'] }) => {
        peer.send({ v: V, t: 'env.request', requestId, ...op });
        let response: EnvResponseFrame | undefined;
        let announced: EnvFrame | undefined;
        const deadline = Date.now() + timeoutMs;
        while (!response || (response.result && !announced)) {
            const frame = await peer.next(response ? 'env' : 'env.response', Math.max(1, deadline - Date.now()));
            if (frame.t === 'env.response') response = frame;
            else if (frame.t === 'env') announced = frame;
            else if (!UNSOLICITED.includes(frame.t)) fail(`expected an env.response or env frame, got ${frame.t}`);
        }
        assertEqual(response.requestId, requestId, 'env.response answers the request it was sent');
        return { response, announced };
    };

    /** The policy a harness with `'env-manage'` starts under, and a runtime the daemon has a driver for. */
    const managed = (hello: HelloFrame, daemon: ConformanceDaemon) => {
        assert(hello.policy?.webManaged === true, 'hello.policy says the web may manage environments (the harness declared "env-manage")');
        const root = hello.policy.allowedRoots[0];
        assert(root !== undefined, 'hello.policy names at least one allowed root');
        return { root, allowedRoots: hello.policy.allowedRoots, runtime: hello.environments.find((e) => e.id === daemon.environmentId)!.runtime };
    };

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
                    const idle = await peer.expect('heartbeat', ['quota']);
                    assertEqual(idle.active, [], 'an idle daemon heartbeats with no active sessions');
                    assert(idle.at <= Date.now() + 1, 'heartbeat.at is a time');
                    await open(peer, hello, daemon, S1);
                    const busy = await peer.expect('heartbeat', ['quota']);
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
            name: 'session-ref',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1);
                    const placeholder = sessionRef.parse(opened.ref);
                    // The prompt is sent by hand, not through `prompt()`: that helper passes over unsolicited frames while it waits for
                    // the ack, and here the one frame the case is about may come before it. The runtime names the session somewhere
                    // in its first turn — with the first stream event, like a CLI — so the ref may come before the ack, between or
                    // after the turn's frames; the turn itself must still be whole.
                    const commandId = 'cmd_ref';
                    peer.send({ v: V, t: 'session.command', sessionId: S1, command: { v: WIRE_PROTOCOL_VERSION, commandId, type: 'prompt', turnId: 'turn_ref', input: [{ type: 'text', text: 'Prompt 1.' }] } });
                    let acked = false;
                    let named: SessionRefFrame | undefined;
                    const turn: EventFrame[] = [];
                    let last = opened.head;
                    const deadline = Date.now() + timeoutMs;
                    while (!acked || !named || turn[turn.length - 1]?.event.type !== 'turn-end') {
                        const frame = await peer.next(!acked ? 'the prompt ack' : named ? 'the rest of the first turn' : 'session.ref', Math.max(1, deadline - Date.now()));
                        if (frame.t === 'session.ref') {
                            assertEqual(frame.sessionId, S1, 'session.ref.sessionId');
                            named = frame;
                        } else if (frame.t === 'session.reply') {
                            assertEqual(frame.sessionId, S1, 'session.reply.sessionId');
                            assertEqual(frame.reply.commandId, commandId, 'session.reply answers the command it was sent');
                            assert(frame.reply.kind === 'ack', `the prompt was acknowledged, not refused (${frame.reply.kind === 'error' ? frame.reply.message : ''})`);
                            acked = true;
                        } else if (frame.t === 'session.frame') {
                            assertEqual(frame.sessionId, S1, 'session.frame.sessionId');
                            if (frame.frame.kind !== 'event') continue;
                            assertFollows(frame.frame, last, 'the first turn');
                            last = cursorOf(frame.frame);
                            turn.push(frame.frame);
                        } else if (!UNSOLICITED.includes(frame.t)) fail(`expected the prompt ack, session.ref or a session.frame, got ${frame.t}`);
                    }
                    const reported = sessionRef.parse(named.ref);
                    assertEqual(reported.agent, placeholder.agent, 'session.ref names the same runtime as session.opened');
                    assert(reported.id !== placeholder.id, `session.ref carries the id the runtime reported, not the placeholder session.opened carried (${placeholder.id})`);
                })
        },
        {
            name: 'hello-build',
            run: () =>
                withDaemon(script, async (daemon) => {
                    // The platform tells a daemon its own versions on welcome (#359); the daemon keeps the socket and answers on.
                    const { peer, hello } = await handshake(daemon, {}, { version: '9.9.9', minDaemonVersion: '0.0.0', latest: { stable: '9.9.9', latest: '9.9.10-main.abc1234' } });
                    const build = hello.build;
                    assert(build !== undefined, 'hello.build reports the build (the harness declared "build")');
                    assert(isVersion(build.version), `hello.build.version ${build.version} is a semver version compareVersions can order`);
                    assertEqual(hello.daemonVersion, build.version, 'hello.daemonVersion is the build version');
                    assertEqual(build.protocol, V, 'hello.build.protocol is the protocol the daemon speaks');
                    assert(/^[a-z0-9]+-[a-z0-9]+$/.test(build.platform), `hello.build.platform ${build.platform} is a release asset key, <platform>-<arch> (platformKey)`);
                    assert(hello.features !== undefined, 'hello.features lists the optional frame families the daemon answers');
                    for (const f of ['update', 'harness'] as const) if (features.has(f)) assert(hello.features.includes(f), `hello.features lists "${f}" (the harness declared it)`);
                    if (features.has('harness')) assert(hello.harnesses !== undefined, 'hello.harnesses reports the installed harnesses (the harness declared "harness")');
                    peer.send({ v: V, t: 'ping' });
                    await peer.expect('pong');
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
            name: 'session-reopen',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1);
                    // A re-open resumes from the last ref the daemon named (#388), or else from the one the open carried.
                    const first = await turn(peer, S1, 1, opened.head);
                    const ref = first.ref?.ref ?? opened.ref;
                    const head = cursorOf(first.events[first.events.length - 1]!);
                    assert(daemon.restart !== undefined, 'the harness implements restart (it declared "resume")');
                    peer.drop();
                    await daemon.restart();

                    // The platform still wants the session; the restarted daemon no longer hosts it and says so, by code.
                    const again = await handshake(daemon, { [S1]: head });
                    assertEqual(again.hello.resume[S1], undefined, 'a session the daemon lost is not offered in hello.resume');
                    const closed = await again.peer.expect('session.closed');
                    assertEqual(closed.sessionId, S1, 'session.closed names the session the platform wanted');
                    assertEqual(closed.code, 'restart', 'a wanted session lost to a restart is closed with code restart, so the platform re-opens it');

                    again.peer.send({ v: V, t: 'session.open', sessionId: S1, environmentId: daemon.environmentId, spec: { ...openSpec(again.hello, daemon, []), resume: ref } });
                    const reopened = await again.peer.expect('session.opened');
                    assertEqual(reopened.sessionId, S1, 'session.opened.sessionId');
                    assert(reopened.head.epoch > head.epoch, `a re-opened session starts a new epoch (${reopened.head.epoch} after ${head.epoch})`);
                    assert(cursorBefore(head, reopened.head), 'the re-opened head continues after the old one');
                    assertTurn((await turn(again.peer, S1, 2, reopened.head)).events, 'the turn after the re-open');
                })
        },
        {
            name: 'fs-list',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const env = hello.environments.find((e) => e.id === daemon.environmentId)!;
                    const root = env.cwdRoots[0];
                    assert(root !== undefined, `environment ${env.id} has a working root to browse`);
                    const ask = async (requestId: string, environmentId: string, path: string) => {
                        peer.send({ v: V, t: 'fs.request', requestId, environmentId, op: { kind: 'list', path } });
                        const response = await peer.expect('fs.response');
                        assertEqual(response.requestId, requestId, 'fs.response answers the request it was sent');
                        return response;
                    };

                    const listed = await ask('fs_root', env.id, root);
                    assert(listed.result?.kind === 'list', `listing a working root yields a listing (${listed.error?.code ?? ''} ${listed.error?.message ?? ''})`);
                    assertEqual(normalizePath(listed.result.path, hello.os), normalizePath(root, hello.os), 'the listing names the folder it lists');
                    assertEqual(listed.result.parent, undefined, 'nothing above a working root is offered');
                    for (const e of listed.result.entries) assert(pathWithin(e.path, env.cwdRoots, hello.os), `listed folder ${e.path} is inside the working roots`);

                    // A sibling of the root: outside every root unless another root covers it.
                    const outside = normalizePath(`${root}/../__agentic_conformance_outside__`, hello.os);
                    if (outside && !pathWithin(outside, env.cwdRoots, hello.os)) {
                        const refused = await ask('fs_outside', env.id, outside);
                        assertEqual(refused.error?.code, 'outside-roots', 'a folder outside the working roots is refused, not listed (OPS-01)');
                    }
                    const unknown = await ask('fs_unknown', 'env_conformance_unknown', root);
                    assertEqual(unknown.error?.code, 'unknown-environment', 'an environment the daemon does not have is refused');
                })
        },
        {
            name: 'fs-locate',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const env = hello.environments.find((e) => e.id === daemon.environmentId)!;
                    const ask = async (requestId: string, environmentId: string, origin: string) => {
                        peer.send({ v: V, t: 'fs.request', requestId, environmentId, op: { kind: 'locate', origin } });
                        const response = await peer.expect('fs.response');
                        assertEqual(response.requestId, requestId, 'fs.response answers the request it was sent');
                        return response;
                    };

                    const nobody = 'https://example.invalid/nobody/nothing';
                    const none = await ask('fs_locate_none', env.id, nobody);
                    assert(none.result?.kind === 'locate', `locating an origin yields a locate result (${none.error?.code ?? ''} ${none.error?.message ?? ''})`);
                    assertEqual(none.result.origin, nobody, 'the result names the origin it was asked for');
                    assertEqual(none.result.matches, [], 'an origin nobody has is found nowhere');
                    assertEqual(none.result.truncated, false, 'an empty answer is not truncated');

                    const known = harness.knownOrigin;
                    if (known !== undefined) {
                        const found = await ask('fs_locate_known', env.id, known);
                        assert(found.result?.kind === 'locate', `locating a known origin yields a locate result (${found.error?.code ?? ''} ${found.error?.message ?? ''})`);
                        assert(found.result.matches.length > 0, `the harness's known origin ${known} is found under the working roots`);
                        for (const m of found.result.matches) {
                            assert(pathWithin(m.path, env.cwdRoots, hello.os), `located checkout ${m.path} is inside the working roots (OPS-01)`);
                            assert(m.git.origin !== undefined && sameOrigin(m.git.origin, known), `located checkout ${m.path} carries the origin it was matched by`);
                        }
                    }
                    const unknown = await ask('fs_locate_unknown', 'env_conformance_unknown', nobody);
                    assertEqual(unknown.error?.code, 'unknown-environment', 'an environment the daemon does not have is refused');
                })
        },
        {
            name: 'env-put',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const { root, allowedRoots, runtime } = managed(hello, daemon);

                    const made = await manage(peer, 'env_put', { op: 'put', environment: { name: 'conformance put', runtime, cwdRoots: [root] } });
                    const id = made.response.result?.environmentId;
                    assert(id !== undefined, `an environment inside the allowed roots is created (${made.response.error?.code ?? ''} ${made.response.error?.message ?? ''})`);
                    const created = made.announced!.environments.find((e) => e.id === id);
                    assert(created !== undefined, 'env lists the environment env.response names');
                    assertEqual(created.machineId, daemon.machineId, 'the new environment belongs to the machine');
                    assertEqual([created.name, created.runtime], ['conformance put', runtime], 'the new environment is what was asked for');
                    assertEqual(created.cwdRoots.map((r) => normalizePath(r, hello.os)), [normalizePath(root, hello.os)], 'the new environment has the roots that were asked for');
                    assert(
                        made.announced!.environments.some((e) => e.id === daemon.environmentId),
                        'the environments that were there are still there'
                    );

                    const changed = await manage(peer, 'env_change', { op: 'put', environment: { id, name: 'conformance put', runtime, cwdRoots: [root], concurrency: 3 } });
                    assertEqual(changed.response.result?.environmentId, id, 'a put with an id changes that environment');
                    assertEqual(changed.announced!.environments.filter((e) => e.id === id).map((e) => e.concurrency.max), [3], 'the change is announced, once');

                    // A sibling of the allowed root: outside every one of them unless another covers it.
                    const outside = normalizePath(`${root}/../__agentic_conformance_outside__`, hello.os);
                    if (outside && !pathWithin(outside, allowedRoots, hello.os)) {
                        const refused = await manage(peer, 'env_outside', { op: 'put', environment: { name: 'outside', runtime, cwdRoots: [root, outside] } });
                        assertEqual(refused.response.error?.code, 'outside-allowed-roots', 'a working root outside the allowed roots is refused, even beside one inside (OPS-01)');
                    }
                    const unknown = await manage(peer, 'env_runtime', { op: 'put', environment: { name: 'no driver', runtime: 'conformance-no-such-runtime', cwdRoots: [root] } });
                    assertEqual(unknown.response.error?.code, 'unknown-runtime', 'a runtime the daemon has no driver for is refused');
                })
        },
        {
            name: 'env-remove',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const { root, runtime } = managed(hello, daemon);
                    await open(peer, hello, daemon, S1);

                    const busy = await manage(peer, 'env_busy', { op: 'remove', environmentId: daemon.environmentId });
                    assertEqual(busy.response.error?.code, 'in-use', 'an environment with a running session is not removed');

                    const made = await manage(peer, 'env_put', { op: 'put', environment: { name: 'conformance remove', runtime, cwdRoots: [root] } });
                    const id = made.response.result?.environmentId;
                    assert(id !== undefined, `an environment to remove is created (${made.response.error?.code ?? ''})`);
                    const removed = await manage(peer, 'env_remove', { op: 'remove', environmentId: id });
                    assertEqual(removed.response.result?.environmentId, id, 'an idle environment is removed');
                    assert(!removed.announced!.environments.some((e) => e.id === id), 'env no longer lists it');
                    assert(
                        removed.announced!.environments.some((e) => e.id === daemon.environmentId),
                        'the environment in use is still there'
                    );

                    const gone = await manage(peer, 'env_gone', { op: 'remove', environmentId: id });
                    assertEqual(gone.response.error?.code, 'unknown-environment', 'an environment the daemon does not have is refused');
                })
        },
        {
            name: 'env-policy',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const { root, runtime } = managed(hello, daemon);
                    await daemon.setPolicy!({ webManaged: false, allowedRoots: [] });
                    const env = await peer.expect('env');
                    assertEqual(env.policy, { webManaged: false, allowedRoots: [] }, 'a policy changed on the machine is announced with env');

                    const put = await manage(peer, 'env_off_put', { op: 'put', environment: { name: 'policy off', runtime, cwdRoots: [root] } });
                    assertEqual(put.response.error?.code, 'policy-disabled', 'with the policy off nothing is created');
                    const remove = await manage(peer, 'env_off_remove', { op: 'remove', environmentId: daemon.environmentId });
                    assertEqual(remove.response.error?.code, 'policy-disabled', 'with the policy off nothing is removed');
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
        },
        {
            name: 'update-drain',
            run: () =>
                // The first session's turn is held on its tool call, so it runs for as long as the case needs it to.
                withDaemon({ ...script, tool: { name: 'echo', input: { x: 1 } } }, async (daemon) => {
                    const target = harness.updateTarget;
                    assert(target !== undefined, 'the harness names an updateTarget (it declared "update")');
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1, ['echo']);
                    await prompt(peer, S1, 1);
                    const call = await peer.expect('tool.call');
                    const requestId = 'update_drain';
                    peer.send({ v: V, t: 'update.request', requestId, target, mode: 'drain', drainTimeoutMs: 10 * timeoutMs });

                    const phases: UpdateStatusFrame['phase'][] = [];
                    const closed = new Map<string, SessionClosedFrame>();
                    let draining = false;
                    let opened2 = false;
                    let refused = false;
                    let ended = false;
                    let last = opened.head;
                    // Heartbeats are not progress: the deadline moves only with a frame the case is waiting for.
                    let deadline = Date.now() + timeoutMs;
                    while (!phases.includes('restarting') || !closed.has(S1) || (draining && !closed.has(S2))) {
                        const frame = await peer.next(phases.includes('restarting') ? 'session.closed { code: update }' : 'update.status', Math.max(1, deadline - Date.now()));
                        if (!UNSOLICITED.includes(frame.t)) deadline = Date.now() + timeoutMs;
                        if (frame.t === 'update.status') {
                            assertEqual(frame.requestId, requestId, 'update.status answers the request it was sent');
                            assert(frame.phase !== 'failed', `the update did not fail (${frame.error?.code ?? ''}: ${frame.error?.message ?? ''})`);
                            if (frame.phase === 'restarting') {
                                assert(refused, 'while draining, a turn-starting prompt was refused before the daemon restarted');
                                assert(ended, 'a drain lets the running turn finish before the daemon restarts');
                            }
                            // Draining: a session still opens, but its first prompt would start a turn and is refused.
                            if (frame.phase === 'draining' && !draining) {
                                draining = true;
                                peer.send({ v: V, t: 'session.open', sessionId: S2, environmentId: daemon.environmentId, spec: openSpec(hello, daemon, []) });
                            }
                            phases.push(frame.phase);
                        } else if (frame.t === 'session.opened') {
                            assertEqual(frame.sessionId, S2, 'session.opened while draining is the session the suite opened');
                            opened2 = true;
                            peer.send({ v: V, t: 'session.command', sessionId: S2, command: { v: WIRE_PROTOCOL_VERSION, commandId: 'cmd_drain', type: 'prompt', turnId: 'turn_drain', input: [{ type: 'text', text: 'Prompt while draining.' }] } });
                        } else if (frame.t === 'session.reply') {
                            assertEqual([frame.sessionId, frame.reply.commandId], [S2, 'cmd_drain'], 'session.reply answers the prompt sent while draining');
                            assert(isDrainingReply(frame.reply), `a turn-starting prompt while draining is refused with the wire error draining, not ${frame.reply.kind === 'error' ? `${frame.reply.code} (${frame.reply.message})` : 'an ack'}`);
                            refused = true;
                            // Now let the running turn end: the drain waits for it.
                            peer.send({ v: V, t: 'tool.result', callId: call.callId, output: { x: 1 } });
                        } else if (frame.t === 'session.frame') {
                            assertEqual(frame.sessionId, S1, 'only the running session streams while draining');
                            if (frame.frame.kind !== 'event') fail(`the running turn streams events, not a ${frame.frame.kind}`);
                            assertFollows(frame.frame, last, 'the turn running through the drain');
                            last = cursorOf(frame.frame);
                            if (frame.frame.event.type === 'turn-end') ended = true;
                        } else if (frame.t === 'session.closed') {
                            assert(!closed.has(frame.sessionId), `session ${frame.sessionId} is closed once`);
                            assertEqual(frame.code, 'update', `session ${frame.sessionId} is closed with code update, so the platform re-opens it after the restart`);
                            closed.set(frame.sessionId, frame);
                        } else if (!UNSOLICITED.includes(frame.t)) fail(`expected update.status or the traffic of a draining daemon, got ${frame.t}`);
                    }
                    assert(draining && opened2, 'a session.open while draining is accepted');
                    assertPhases(phases, UPDATE_PHASES, 'update.status');
                })
        },
        {
            name: 'update-cancel',
            run: () =>
                withDaemon({ ...script, tool: { name: 'echo', input: { x: 1 } } }, async (daemon) => {
                    const target = harness.updateTarget;
                    assert(target !== undefined, 'the harness names an updateTarget (it declared "update")');
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1, ['echo']);
                    await prompt(peer, S1, 1);
                    const call = await peer.expect('tool.call');
                    const requestId = 'update_cancel';
                    peer.send({ v: V, t: 'update.request', requestId, target, mode: 'drain', drainTimeoutMs: 10 * timeoutMs });
                    const drained = await statuses(peer, 'update.status', requestId, (p) => p === 'draining' || p === 'failed' || p === 'restarting');
                    assertEqual(drained.last.phase, 'draining', `a drain-mode update with a turn running waits in draining (${drained.phases.join(' → ')})`);

                    peer.send({ v: V, t: 'update.cancel', requestId });
                    const cancelled = await statuses(peer, 'update.status', requestId, (p) => p === 'failed' || p === 'restarting');
                    assertEqual(cancelled.last.phase, 'failed', 'a cancelled update ends failed, it does not restart');
                    assertEqual(cancelled.last.error?.code, 'cancelled', 'a cancelled update names the cancel');

                    // Nothing restarts: the running turn ends normally, and a new turn is accepted again.
                    peer.send({ v: V, t: 'tool.result', callId: call.callId, output: { x: 1 } });
                    assertTurn(await peer.events(S1, events, opened.head, 'the turn that ran through the cancelled drain'), 'the turn that ran through the cancelled drain');
                    const next = await open(peer, hello, daemon, S2, ['echo']);
                    await prompt(peer, S2, 2);
                    const second = await peer.expect('tool.call');
                    peer.send({ v: V, t: 'tool.result', callId: second.callId, output: { x: 1 } });
                    assertTurn(await peer.events(S2, events, next.head, 'a turn after the cancel'), 'a turn after the cancel');
                })
        },
        {
            name: 'harness-install',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const target = harness.harnessTarget;
                    assert(target !== undefined, 'the harness names a harnessTarget (it declared "harness")');
                    const { peer } = await handshake(daemon);
                    const requestId = 'harness_install';
                    peer.send({ v: V, t: 'harness.request', requestId, op: 'install', runtime: target.runtime, target: target.asset, mode: 'drain' });
                    const installed = (f: HarnessesFrame) => f.harnesses.find((h) => h.runtime === target.runtime && h.installed?.version === target.asset.version);
                    // The `harnesses` frame may come before `done` or after it.
                    let reported: HarnessesFrame | undefined;
                    const done = await statuses(
                        peer,
                        'harness.status',
                        requestId,
                        (p) => p === 'done' || p === 'failed',
                        (f) => {
                            if (f.t === 'harnesses') {
                                if (installed(f)) reported = f;
                            } else if (!UNSOLICITED.includes(f.t)) fail(`expected harness.status or harnesses, got ${f.t}`);
                        }
                    );
                    assert(done.last.phase === 'done', `the install is done, not failed (${done.last.error?.code ?? ''}: ${done.last.error?.message ?? ''})`);
                    assertPhases(done.phases, HARNESS_PHASES, 'harness.status');
                    while (!reported) {
                        const f = await peer.expect('harnesses');
                        if (installed(f)) reported = f;
                    }
                    assertEqual(installed(reported)!.status, 'ready', `a harnesses frame reports ${target.runtime} ${target.asset.version} ready`);
                })
        },
        {
            name: 'harness-remove-in-use',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const runtime = hello.environments.find((e) => e.id === daemon.environmentId)!.runtime;
                    const opened = await open(peer, hello, daemon, S1);
                    const requestId = 'harness_remove';
                    peer.send({ v: V, t: 'harness.request', requestId, op: 'remove', runtime, mode: 'now' });
                    const answer = await statuses(peer, 'harness.status', requestId, (p) => p === 'done' || p === 'failed');
                    assertEqual(answer.last.phase, 'failed', `a harness an environment uses is not removed, even with mode now (${answer.phases.join(' → ')})`);
                    assertEqual(answer.last.error?.code, 'in-use', 'the refusal names in-use');
                    // The session on it still runs.
                    await prompt(peer, S1, 1);
                    assertTurn(await peer.events(S1, events, opened.head, 'a turn after the refused removal'), 'a turn after the refused removal');
                })
        },
        {
            name: 'history',
            run: () =>
                withDaemon(script, async (daemon) => {
                    const { peer, hello } = await handshake(daemon);
                    const opened = await open(peer, hello, daemon, S1);
                    await prompt(peer, S1, 1);
                    const all = await peer.events(S1, events, opened.head, 'the turn');
                    const head = cursorOf(all[all.length - 1]!);
                    /** One `history.request`, its answer. */
                    const ask = async (requestId: string, range: { from: Cursor; to?: Cursor; limit?: number }, sessionId: SessionId = S1) => {
                        peer.send({ v: V, t: 'history.request', requestId, sessionId, ...range });
                        const response = await peer.expect('history.response');
                        assertEqual(response.requestId, requestId, 'history.response answers the request it was sent');
                        return response;
                    };
                    const answered = (r: DaemonFrameOf<'history.response'>, what: string) => {
                        assert(r.result !== undefined, `${what}: the range is answered with events, not ${r.error?.code ?? 'nothing'} (${r.error?.message ?? ''})`);
                        for (const f of r.result.events) assert(f.kind === 'event', `${what}: history carries event frames only, not a ${f.kind}`);
                        return r.result as { readonly events: readonly EventFrame[]; readonly more?: boolean };
                    };

                    // The whole turn, again, out of the log: the same frames the session streamed.
                    const whole = answered(await ask('history_all', { from: opened.head }), 'the whole turn');
                    assertEqual(whole.events, all, 'history answers the event frames the session streamed, in cursor order, from the cursor asked for (exclusive)');
                    assert(!whole.more, 'a range the answer covers whole says no more');

                    // Bounded: `to` is inclusive, `limit` cuts and says `more`, and the next request continues from the last frame.
                    const half = Math.floor(events / 2);
                    const upTo = answered(await ask('history_to', { from: opened.head, to: cursorOf(all[half]!) }), 'a range with an end');
                    assertEqual(upTo.events, all.slice(0, half + 1), 'history.request.to is inclusive');
                    const cut = answered(await ask('history_limit', { from: opened.head, limit: 3 }), 'a limited range');
                    assertEqual(cut.events, all.slice(0, 3), 'limit caps the answer, oldest first');
                    assertEqual(cut.more, true, 'a slice cut by limit says more');
                    const next = answered(await ask('history_next', { from: cursorOf(cut.events[2]!), limit: 3 }), 'the slice after a cut');
                    assertEqual(next.events, all.slice(3, 6), 'asking again from the last frame continues the range without a duplicate or a hole');
                    assertEqual(answered(await ask('history_after_head', { from: head }), 'a range after the head').events, [], 'nothing after the head is an empty answer, not an error');

                    // A session this machine has no log for.
                    const unknown = await ask('history_unknown', { from: { epoch: 0, seq: 0 } }, 'session_conformance_nobody' as SessionId);
                    assertEqual(unknown.error?.code, 'unknown-session', 'a session without a log answers unknown-session (OPS-04: never an empty result that looks like history)');

                    // Retention forgot the start of the log: a range that reaches into it answers a named gap, one after it is still answered.
                    if (!daemon.truncateLog) return;
                    const keepFrom: Cursor = { epoch: head.epoch, seq: Math.max(2, head.seq - 10) };
                    await daemon.truncateLog(S1, keepFrom);
                    const gap = await ask('history_gap', { from: opened.head });
                    assertEqual(gap.error?.code, 'gap', `a range the log no longer reaches answers a gap, not ${gap.result ? `${gap.result.events.length} events` : gap.error?.code} (OPS-04: lost events are named, not hidden)`);
                    assert(gap.error?.earliest !== undefined && !cursorBefore(gap.error.earliest, keepFrom) && !cursorBefore(head, gap.error.earliest), 'gap.earliest is the oldest cursor the log still holds');
                    const kept = answered(await ask('history_kept', { from: keepFrom }), 'the range the log still holds');
                    assertEqual(
                        kept.events,
                        all.filter((f) => cursorBefore(keepFrom, cursorOf(f))),
                        'a range inside what the log still holds is answered'
                    );
                })
        }
    ];

    return cases.map((c) => {
        const feature = NEEDS[c.name];
        return feature && !features.has(feature) ? { ...c, skip: `the harness does not declare the "${feature}" feature` } : c;
    });
}
