/**
 * `daemonConformance` — the suite every daemon implementation must pass,
 * and the behaviour every platform side may rely on: pair (hello/welcome),
 * env, heartbeat, session open/opened, a stream of session frames, a
 * reconnect that replays from the platform's `wanted` cursors without a
 * gap or a duplicate (OPS-04, OPS-06), a tool round trip, folder
 * browsing that never leaves the environment's `cwdRoots` (#187), a
 * `locate` of an origin's checkouts under those roots (#331), and
 * environments managed from the platform only inside the machine-local
 * policy (#236), and the runtime's own session id reported once it is known (#388). No test-runner
 * import: consumers wire the cases into theirs, e.g.
 *
 * ```ts
 * for (const c of daemonConformance(inMemoryHarness())) {
 *     it.skipIf(!!c.skip)(c.name, c.run);
 * }
 * ```
 */

import { DAEMON_PROTOCOL_VERSION, normalizePath, pathWithin, sameOrigin, type Cursor, type EnvironmentDescriptor, type EnvironmentInput, type SessionId } from '@agentic/core';
import { WIRE_PROTOCOL_VERSION, cursorBefore } from '@sigx/ai-agent/wire';
import type { DaemonFrame, DaemonFrameOf, DaemonFrameType, EnvFrame, EnvResponseFrame, HelloFrame, PlatformFrame, SessionFrameFrame, SessionRefFrame } from '../frames.js';
import { decodeDaemonFrame, parseDaemonFrame } from '../framing/codec.js';
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

/** Frames a daemon may push at any time after `hello`: liveness, an environment's provider limits (#261), and a runtime naming its session (#388). */
const UNSOLICITED: readonly DaemonFrameType[] = ['heartbeat', 'quota', 'session.ref'];
/** Cases that need an optional harness feature. */
const NEEDS: Record<string, ConformanceFeature> = { env: 'env', gap: 'gap', 'fs-list': 'fs', 'fs-locate': 'fs', 'env-put': 'env-manage', 'env-remove': 'env-manage', 'env-policy': 'env-manage', 'session-ref': 'session-ref' };

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
                    await prompt(peer, S1, 1);
                    // The runtime names the session somewhere in its first turn — with the first stream event, like a CLI — so the
                    // ref may come before, between or after the turn's frames; the turn itself must still be whole.
                    let named: SessionRefFrame | undefined;
                    const turn: EventFrame[] = [];
                    let last = opened.head;
                    const deadline = Date.now() + timeoutMs;
                    while (!named || turn[turn.length - 1]?.event.type !== 'turn-end') {
                        const frame = await peer.next(named ? 'the rest of the first turn' : 'session.ref', Math.max(1, deadline - Date.now()));
                        if (frame.t === 'session.ref') {
                            assertEqual(frame.sessionId, S1, 'session.ref.sessionId');
                            named = frame;
                        } else if (frame.t === 'session.frame') {
                            assertEqual(frame.sessionId, S1, 'session.frame.sessionId');
                            if (frame.frame.kind !== 'event') continue;
                            assertFollows(frame.frame, last, 'the first turn');
                            last = cursorOf(frame.frame);
                            turn.push(frame.frame);
                        } else if (!UNSOLICITED.includes(frame.t)) fail(`expected session.ref or a session.frame, got ${frame.t}`);
                    }
                    const reported = sessionRef.parse(named.ref);
                    assertEqual(reported.agent, placeholder.agent, 'session.ref names the same runtime as session.opened');
                    assert(reported.id !== placeholder.id, `session.ref carries the id the runtime reported, not the placeholder session.opened carried (${placeholder.id})`);
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
        }
    ];

    return cases.map((c) => {
        const feature = NEEDS[c.name];
        return feature && !features.has(feature) ? { ...c, skip: `the harness does not declare the "${feature}" feature` } : c;
    });
}
