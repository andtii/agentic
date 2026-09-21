/**
 * `inMemoryHarness` — a reference daemon over an in-memory link: the fake
 * pair the conformance suite is proven against, and a stand-in for a real
 * daemon in tests of the platform side (a Machine actor, a relay). It keeps a
 * per-session log so a reconnect replays from the platform's `wanted`
 * cursors, bridges the scripted tool call as `tool.call`, and ignores
 * malformed input the way a daemon must. It reports a build, updates itself
 * (drain, cancel, restart) and installs harnesses without downloading
 * anything (#360). `restart()` loses its live sessions but keeps their logs;
 * a `wanted` session it lost is closed with code `restart`, and a re-open
 * from `spec.resume` continues the log on the next epoch (#363). `faults`
 * breaks it on purpose so a test can check that the suite notices.
 */

import {
    DAEMON_PROTOCOL_VERSION,
    FS_LIST_MAX_ENTRIES,
    FS_LOCATE_MAX_DEPTH,
    FS_LOCATE_MAX_MATCHES,
    HISTORY_LIMIT,
    normalizePath,
    pathWithin,
    sameOrigin,
    type CapabilityReport,
    type Cursor,
    type DaemonBuild,
    type EnvError,
    type EnvironmentDescriptor,
    type EnvironmentId,
    type EnvResult,
    type FsGitInfo,
    type FsOp,
    type FsResult,
    type HarnessPhase,
    type HarnessReport,
    type LifecycleError,
    type MachineId,
    type MachinePolicy,
    type ReleaseAsset,
    type RuntimeId,
    type SessionClosedCode,
    type SessionId,
    type UpdatePhase
} from '@agentic/core';
import type { AgentEvent, SessionRef } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, cursorBefore, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import type { DaemonFrame, EnvRequestFrame, HarnessRequestFrame, HistoryRequestFrame, PlatformFrame, UpdateRequestFrame } from '../frames.js';
import { decodePlatformFrame, encodeFrame } from '../framing/codec.js';
import { drainingReply } from '../lifecycle.js';
import { LIMITS } from '../schema/limits.js';
import type { ConformanceDaemon, ConformanceScript, DaemonConformanceHarness, PlatformSeat } from './harness.js';

export interface InMemoryFaults {
    /** `'duplicate'`: replay from a few frames before `wanted`; `'skip'`: from one after it; `'ignore'`: from the start of the log. */
    readonly replay?: 'duplicate' | 'skip' | 'ignore';
    /** Answer a `ping` from any protocol version. */
    readonly answerAnyVersion?: boolean;
    /** Never announce environment changes. */
    readonly silentEnv?: boolean;
    /** List any folder asked for, inside the working roots or not. */
    readonly browseAnywhere?: boolean;
    /** Report a located checkout wherever it is, inside the working roots or not. */
    readonly locateAnywhere?: boolean;
    /** Accept an environment whose working roots are outside the allowed roots. */
    readonly acceptAnyRoot?: boolean;
    /** Remove an environment that still has running sessions. */
    readonly removeInUse?: boolean;
    /** Manage environments whatever the policy says. */
    readonly ignorePolicy?: boolean;
    /** Report the placeholder id `session.opened` carried as the runtime's own (#388). */
    readonly sameRef?: boolean;
    /** Answer a `history.request` the log no longer reaches with what is left, instead of a named `gap` (#397). */
    readonly historyHole?: boolean;
    /** Start a turn while an update drains, instead of refusing the prompt with `draining` (#360). */
    readonly acceptWhileDraining?: boolean;
    /** Ignore `update.cancel`: the drain goes on to a restart (#360). */
    readonly ignoreCancel?: boolean;
    /** Remove a harness an environment still uses (#360). */
    readonly removeHarnessInUse?: boolean;
    /** Ignore `spec.resume`: a re-open starts over at (0, 0), the way the fake did before #363. */
    readonly ignoreResume?: boolean;
    /** Close a wanted session lost to a restart without a code (#363). */
    readonly uncodedRestart?: boolean;
}

export interface InMemoryHarnessOptions {
    readonly machineId?: MachineId;
    readonly environments?: readonly EnvironmentDescriptor[];
    /** The machine-local policy it starts with. Default: web-managed, inside `/work`. */
    readonly policy?: MachinePolicy;
    /**
     * The git checkouts in its otherwise empty tree (#331), by absolute POSIX path: a listing of a folder shows the ones
     * directly below it (and badges the folder itself), and `locate` finds the ones whose `git.origin` matches.
     */
    readonly repos?: readonly { readonly path: string; readonly git: FsGitInfo }[];
    /** How many characters each streamed `part-delta` carries (default: the event's number and a space) — a platform test that needs a session to page out sets it. */
    readonly deltaChars?: number;
    readonly faults?: InMemoryFaults;
}

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;

export const IN_MEMORY_MACHINE = 'machine_inmemory' as MachineId;
export const IN_MEMORY_ENVIRONMENT = 'env_inmemory' as EnvironmentId;
export const IN_MEMORY_POLICY: MachinePolicy = { webManaged: true, allowedRoots: ['/work'] };

export const IN_MEMORY_CAPABILITIES: CapabilityReport = {
    runtime: 'in-memory',
    supported: ['prompt', 'cancel', 'close', 'configure'],
    unsupported: [{ op: 'fork', reason: 'not implemented' }],
    resume: 'local',
    cancel: true,
    steer: false,
    permissions: 'none',
    tools: 'mcp'
};

/** The build the fake reports (#359): a prerelease, so any real release orders above it. */
export const IN_MEMORY_BUILD: DaemonBuild = { version: '0.0.0-fake', commit: '0000000', protocol: V, channel: 'stable', platform: 'linux-x64' };

/** The harness it starts with: its own runtime, installed. */
export const IN_MEMORY_HARNESSES: readonly HarnessReport[] = [{ runtime: 'in-memory', installed: { version: '1.0.0', at: 0 }, status: 'ready', current: true }];

/** A release it "updates" to — nothing is downloaded. */
export const IN_MEMORY_RELEASE: ReleaseAsset = { url: 'https://releases.example.test/agentic-daemon-0.0.1-linux-x64.zip', sha256: 'a'.repeat(64), bytes: 1024, version: '0.0.1' };

/** A harness build it "installs" — nothing is downloaded. */
export const IN_MEMORY_HARNESS_TARGET: { readonly runtime: RuntimeId; readonly asset: ReleaseAsset } = {
    runtime: 'in-memory',
    asset: { url: 'https://releases.example.test/harness-in-memory-1.1.0-linux-x64.zip', sha256: 'b'.repeat(64), bytes: 2048, version: '1.1.0' }
};

export function inMemoryEnvironment(machineId: MachineId = IN_MEMORY_MACHINE, id: EnvironmentId = IN_MEMORY_ENVIRONMENT): EnvironmentDescriptor {
    return {
        id,
        machineId,
        name: 'in-memory',
        runtime: 'in-memory',
        account: { label: 'fake', authStatus: 'ok' },
        cwdRoots: ['/work'],
        concurrency: { max: 4, active: 0 },
        isolation: 'none'
    };
}

/** A one-directional queue with one reader; `drop()` loses what is buffered and fails the reader. */
class Link {
    private readonly buffer: string[] = [];
    private waiter: { resolve(v: string): void; reject(e: Error): void } | undefined;
    dropped = false;
    /** Session traffic waits for `welcome`: replay must go out before anything live. */
    welcomed = false;

    push(text: string): void {
        if (this.dropped) return;
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = undefined;
            w.resolve(text);
        } else this.buffer.push(text);
    }

    next(): Promise<string> {
        if (this.dropped) return Promise.reject(new Error('the link was dropped'));
        const head = this.buffer.shift();
        if (head !== undefined) return Promise.resolve(head);
        return new Promise((resolve, reject) => {
            this.waiter = { resolve, reject };
        });
    }

    drop(): void {
        this.dropped = true;
        this.buffer.length = 0;
        this.waiter?.reject(new Error('the link was dropped'));
        this.waiter = undefined;
    }
}

interface FakeSession {
    readonly id: SessionId;
    readonly environmentId: string;
    readonly epoch: number;
    seq: number;
    /** Every event frame emitted, in order — the daemon's durable log. */
    log: Extract<WireFrame, { readonly kind: 'event' }>[];
    closed: boolean;
    busy: boolean;
    /** The runtime has reported its own id for the session (`session.ref`, #388). */
    named: boolean;
    /** Lost to a `restart()` (#363): a `wanted` cursor for it is answered from the log and then `session.closed { code: 'restart' }`. */
    lost?: boolean;
}

/** A self-update in flight: its request, its phase, and the timer that ends a drain that takes too long. */
interface FakeUpdate {
    readonly requestId: string;
    phase: UpdatePhase;
    timer?: ReturnType<typeof setTimeout>;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The log reaches back to `from` (exclusive): its oldest frame is at or before it, or is the very next stamp — `from` may be platform-stamped, a fractional seq. */
function reaches(oldest: Cursor, from: Cursor): boolean {
    if (!cursorBefore(from, oldest)) return true;
    return oldest.epoch === from.epoch ? oldest.seq === Math.floor(from.seq) + 1 : oldest.epoch > from.epoch && oldest.seq === 1;
}

export class InMemoryDaemon implements ConformanceDaemon {
    readonly machineId: MachineId;
    readonly environmentId: EnvironmentId;
    private environments: readonly EnvironmentDescriptor[];
    private policy: MachinePolicy;
    private minted = 0;
    private readonly sessions = new Map<string, FakeSession>();
    private readonly pendingTools = new Map<string, (result: { output?: unknown; error?: unknown }) => void>();
    private link: Link | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private calls = 0;
    private harnesses: readonly HarnessReport[] = IN_MEMORY_HARNESSES;
    /** The self-update in flight. */
    private update: FakeUpdate | undefined;
    /** Malformed messages seen — a daemon counts and moves on. */
    rejected = 0;

    constructor(
        private readonly script: ConformanceScript,
        private readonly options: InMemoryHarnessOptions
    ) {
        this.machineId = options.machineId ?? IN_MEMORY_MACHINE;
        this.environments = options.environments ?? [inMemoryEnvironment(this.machineId)];
        this.environmentId = this.environments[0]!.id;
        this.policy = options.policy ?? IN_MEMORY_POLICY;
    }

    dial(): PlatformSeat {
        this.disconnect();
        const link = new Link();
        this.link = link;
        const resume: Record<string, Cursor> = {};
        for (const s of this.sessions.values()) if (!s.closed) resume[s.id] = { epoch: s.epoch, seq: s.seq };
        this.emit({
            v: V,
            t: 'hello',
            machineId: this.machineId,
            daemonVersion: IN_MEMORY_BUILD.version,
            os: 'linux',
            environments: this.environments,
            capabilities: [IN_MEMORY_CAPABILITIES],
            resume,
            policy: this.policy,
            build: IN_MEMORY_BUILD,
            features: ['update', 'harness'],
            harnesses: this.harnesses
        });
        return {
            send: (frame) => this.receive(encodeFrame(frame)),
            sendRaw: (text) => this.receive(text),
            next: () => link.next(),
            drop: () => {
                link.drop();
                if (this.link === link) this.disconnect();
            }
        };
    }

    setEnvironments(environments: readonly EnvironmentDescriptor[]): void {
        this.environments = environments;
        if (!this.options.faults?.silentEnv) this.emit({ v: V, t: 'env', environments, policy: this.policy });
    }

    setPolicy(policy: MachinePolicy): void {
        this.policy = policy;
        if (!this.options.faults?.silentEnv) this.emit({ v: V, t: 'env', environments: this.environments, policy });
    }

    truncateLog(sessionId: SessionId, keepFrom: Cursor): void {
        const s = this.sessions.get(sessionId);
        if (s) s.log = s.log.filter((f) => !cursorBefore({ epoch: f.epoch, seq: f.seq }, keepFrom));
    }

    stop(): void {
        if (this.update?.timer !== undefined) clearTimeout(this.update.timer);
        this.update = undefined;
        this.disconnect();
        for (const resolve of this.pendingTools.values()) resolve({ error: { code: 'closed', message: 'daemon stopped' } });
        this.pendingTools.clear();
    }

    /**
     * A process restart (#363): the connection, the self-update in flight and every live session are lost — nothing is
     * announced — while the logs are kept. The platform dials again; a session it still wants is answered from its log and
     * closed with code `restart`, and a `session.open` with `spec.resume` continues it on the next epoch.
     */
    restart(): void {
        this.stop();
        for (const s of this.sessions.values()) {
            if (s.closed) continue;
            s.closed = true;
            s.lost = true;
        }
    }

    private disconnect(): void {
        if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.link?.drop();
        this.link = undefined;
    }

    private emit(frame: DaemonFrame): void {
        if (frame.t === 'session.frame') {
            if (frame.frame.kind === 'event') this.sessions.get(frame.sessionId)?.log.push(frame.frame);
            if (!this.link?.welcomed) return;
        }
        this.link?.push(encodeFrame(frame));
    }

    private receive(text: string): void {
        const result = decodePlatformFrame(text);
        if (!result.ok) {
            this.rejected++;
            if (this.options.faults?.answerAnyVersion && result.error.code === 'unsupported-version' && text.includes('"ping"')) this.emit({ v: V, t: 'pong', at: Date.now() });
            return;
        }
        this.handle(result.frame);
    }

    private handle(frame: PlatformFrame): void {
        switch (frame.t) {
            case 'welcome': {
                if (this.link) this.link.welcomed = true;
                for (const [sessionId, cursor] of Object.entries(frame.wanted)) {
                    this.replay(sessionId, cursor);
                    // A session lost to a restart is gone once its log is replayed; the code tells the platform to re-open it (#363).
                    const lost = this.sessions.get(sessionId);
                    if (lost?.lost) this.close(lost, 'the session is no longer running on this machine (daemon restarted)', this.options.faults?.uncodedRestart ? undefined : 'restart');
                }
                if (this.heartbeat === undefined) this.heartbeat = setInterval(() => this.emit({ v: V, t: 'heartbeat', at: Date.now(), active: this.active() }), this.script.heartbeatMs);
                // A daemon probes provider limits once welcomed (#261); the suite must pass over the unsolicited frame.
                this.emit({ v: V, t: 'quota', environmentId: this.environmentId, snapshot: { sourceId: 'in-memory', runtime: 'in-memory', environmentId: this.environmentId, availability: 'not-reported', reason: 'the in-memory runtime has no provider limits', windows: [], observedAt: Date.now(), via: 'probe' } });
                return;
            }
            case 'ping':
                this.emit({ v: V, t: 'pong', at: Date.now() });
                return;
            case 'session.open': {
                // A re-open from `spec.resume` (#363) continues the session's log on the next epoch, so its head follows the old one.
                const previous = frame.spec.resume !== undefined && !this.options.faults?.ignoreResume ? this.sessions.get(frame.sessionId) : undefined;
                const session: FakeSession = { id: frame.sessionId, environmentId: frame.environmentId, epoch: previous ? previous.epoch + 1 : 0, seq: 0, log: previous?.log ?? [], closed: false, busy: false, named: false };
                this.sessions.set(frame.sessionId, session);
                const ref: SessionRef = { agent: 'in-memory', v: 1, id: frame.sessionId };
                this.emit({ v: V, t: 'session.opened', sessionId: frame.sessionId, ref, capabilities: IN_MEMORY_CAPABILITIES, head: { epoch: session.epoch, seq: session.seq } });
                return;
            }
            case 'session.command': {
                const session = this.sessions.get(frame.sessionId);
                const reply = (r: WireReply) => this.emit({ v: V, t: 'session.reply', sessionId: frame.sessionId, reply: r });
                const { commandId } = frame.command;
                if (!session || session.closed) return reply({ v: W, kind: 'error', commandId, code: 'closed', message: 'no such session' });
                if (frame.command.type === 'prompt') {
                    if (session.busy) return reply({ v: W, kind: 'error', commandId, code: 'busy', message: 'a turn is running' });
                    if (this.update?.phase === 'draining' && !this.options.faults?.acceptWhileDraining) return reply(drainingReply(commandId, `update ${this.update.requestId} waits for the running turns`));
                    reply({ v: W, kind: 'ack', commandId, turnId: frame.command.turnId });
                    void this.turn(session, frame.command.turnId);
                    return;
                }
                reply({ v: W, kind: 'ack', commandId });
                if (frame.command.type === 'close') this.close(session, 'closed by command');
                return;
            }
            case 'session.close': {
                const session = this.sessions.get(frame.sessionId);
                if (session) this.close(session, 'closed');
                return;
            }
            case 'tool.result': {
                const resolve = this.pendingTools.get(frame.callId);
                this.pendingTools.delete(frame.callId);
                resolve?.({ output: frame.output, error: frame.error });
                return;
            }
            case 'fs.request': {
                // A tree holding only `repos`: every folder inside the roots exists; worktrees are not faked.
                const answer = (r: Pick<Extract<DaemonFrame, { t: 'fs.response' }>, 'result' | 'error'>) => this.emit({ v: V, t: 'fs.response', requestId: frame.requestId, ...r });
                const env = this.environments.find((e) => e.id === frame.environmentId);
                if (!env) return answer({ error: { code: 'unknown-environment', message: `no environment ${frame.environmentId}` } });
                if (frame.op.kind === 'locate') return answer({ result: this.locate(env, frame.op) });
                if (frame.op.kind !== 'list') return answer({ error: { code: 'unsupported', message: `the in-memory daemon does not answer ${frame.op.kind}` } });
                const path = normalizePath(frame.op.path, 'linux');
                if (!path || (!this.options.faults?.browseAnywhere && !pathWithin(path, env.cwdRoots, 'linux'))) return answer({ error: { code: 'outside-roots', message: `${frame.op.path} is outside the working roots` } });
                const isRoot = env.cwdRoots.some((r) => normalizePath(r, 'linux') === path);
                const parent = isRoot ? undefined : normalizePath(`${path}/..`, 'linux')!;
                const own = this.repos().find((r) => r.path === path);
                const below = this.repos()
                    .filter((r) => r.path !== path && normalizePath(`${r.path}/..`, 'linux') === path)
                    .map((r) => ({ name: r.path.slice(r.path.lastIndexOf('/') + 1), path: r.path, git: r.git }));
                const entries = below.slice(0, FS_LIST_MAX_ENTRIES);
                return answer({ result: { kind: 'list', path, ...(parent ? { parent } : {}), ...(own ? { git: own.git } : {}), entries, truncated: below.length > entries.length } });
            }
            case 'env.request': {
                const outcome = this.manage(frame);
                // The descriptors first, then the answer: whoever reads the answer already has the list it is about.
                if ('result' in outcome) this.setEnvironments(this.environments);
                this.emit({ v: V, t: 'env.response', requestId: frame.requestId, ...outcome });
                return;
            }
            case 'history.request':
                this.emit({ v: V, t: 'history.response', requestId: frame.requestId, ...this.history(frame) });
                return;
            case 'update.request':
                void this.selfUpdate(frame);
                return;
            case 'update.cancel': {
                const update = this.update;
                if (!update || update.requestId !== frame.requestId || update.phase === 'restarting' || this.options.faults?.ignoreCancel) return;
                if (update.timer !== undefined) clearTimeout(update.timer);
                this.update = undefined;
                this.emit({ v: V, t: 'update.status', requestId: update.requestId, phase: 'failed', error: { code: 'cancelled', message: 'the update was cancelled' } });
                return;
            }
            case 'harness.request':
                void this.changeHarness(frame);
                return;
        }
    }

    /**
     * A self-update (#364's phases, faked): download, verify and stage one tick apart, then — `drain` — refuse new turns until
     * none runs or `drainTimeoutMs` passes, or — `now` — restart at once. A second request while one runs fails `busy`.
     */
    private async selfUpdate(frame: UpdateRequestFrame): Promise<void> {
        const status = (phase: UpdatePhase, extra: { progress?: { bytes: number; total: number }; error?: LifecycleError } = {}) => this.emit({ v: V, t: 'update.status', requestId: frame.requestId, phase, ...extra });
        if (this.update) return status('failed', { error: { code: 'busy', message: `update ${this.update.requestId} is in progress` } });
        const update: FakeUpdate = { requestId: frame.requestId, phase: 'staged' };
        this.update = update;
        const { target } = frame;
        const steps: readonly UpdatePhase[] = target === 'previous' ? ['staged'] : ['downloading', 'verifying', 'staged'];
        for (const phase of steps) {
            if (this.update !== update) return;
            update.phase = phase;
            status(phase, phase === 'downloading' && target !== 'previous' ? { progress: { bytes: target.bytes, total: target.bytes } } : {});
            await tick();
        }
        if (this.update !== update) return;
        if (frame.mode === 'now') return this.restartFor(update);
        update.phase = 'draining';
        status('draining');
        update.timer = setTimeout(() => this.restartFor(update), frame.drainTimeoutMs);
        this.drained();
    }

    /** A drain ends when no turn runs any more. */
    private drained(): void {
        const update = this.update;
        if (update?.phase === 'draining' && ![...this.sessions.values()].some((s) => !s.closed && s.busy)) this.restartFor(update);
    }

    /** `restarting`: every live session is closed with code `update` — the platform re-opens them — and the fake carries on as the new build. */
    private restartFor(update: FakeUpdate): void {
        if (this.update !== update) return;
        if (update.timer !== undefined) clearTimeout(update.timer);
        update.phase = 'restarting';
        this.emit({ v: V, t: 'update.status', requestId: update.requestId, phase: 'restarting' });
        for (const s of this.sessions.values()) if (!s.closed) this.close(s, 'the daemon is restarting for an update', 'update');
        this.update = undefined;
    }

    /** `harness.request` (#369's phases, faked): install or update one tick per phase, remove at once — never under an environment that uses it. */
    private async changeHarness(frame: HarnessRequestFrame): Promise<void> {
        const status = (phase: HarnessPhase, error?: LifecycleError) => this.emit({ v: V, t: 'harness.status', requestId: frame.requestId, phase, ...(error ? { error } : {}) });
        const { runtime } = frame;
        if (frame.op === 'remove') {
            if (this.environments.some((e) => e.runtime === runtime) && !this.options.faults?.removeHarnessInUse) return status('failed', { code: 'in-use', message: `an environment runs on ${runtime}` });
            if (!this.harnesses.some((h) => h.runtime === runtime && h.installed)) return status('failed', { code: 'not-installed', message: `${runtime} is not installed` });
            this.harnesses = this.harnesses.map((h) => (h.runtime === runtime ? { runtime, status: 'missing' } : h));
        } else {
            const { target } = frame;
            if (!target) return status('failed', { code: 'invalid', message: `${frame.op} names a target` });
            for (const phase of ['downloading', 'verifying', 'staged', 'applying'] as const) {
                status(phase);
                await tick();
            }
            this.harnesses = [...this.harnesses.filter((h) => h.runtime !== runtime), { runtime, installed: { version: target.version, at: Date.now() }, status: 'ready', current: true }];
        }
        status('done');
        this.emit({ v: V, t: 'harnesses', harnesses: this.harnesses });
    }

    /**
     * A history slice out of the session's log (#397): the frames after `from` up to `to`, at most `limit`, `more` when cut.
     * A log that no longer reaches back to `from` answers `gap` naming its oldest cursor — unless the `historyHole` fault.
     */
    private history(frame: HistoryRequestFrame): Pick<Extract<DaemonFrame, { t: 'history.response' }>, 'result' | 'error'> {
        const session = this.sessions.get(frame.sessionId);
        if (!session) return { error: { code: 'unknown-session', message: `no log for session ${frame.sessionId} on this machine` } };
        const oldest = session.log[0];
        if (oldest && !reaches(oldest, frame.from) && !this.options.faults?.historyHole) {
            const earliest: Cursor = { epoch: oldest.epoch, seq: oldest.seq };
            return { error: { code: 'gap', message: `the log of ${frame.sessionId} starts at (${earliest.epoch}, ${earliest.seq})`, earliest } };
        }
        const limit = Math.min(frame.limit ?? HISTORY_LIMIT, LIMITS.list);
        const inRange = session.log.filter((f) => cursorBefore(frame.from, f) && (!frame.to || !cursorBefore(frame.to, f)));
        // Bounded like a real daemon's answer: by count, and by about half a frame of JSON — the rest is `more`.
        const events: typeof inRange = [];
        let bytes = 0;
        for (const f of inRange) {
            const size = JSON.stringify(f).length;
            if (events.length >= limit || (events.length > 0 && bytes + size > LIMITS.frameBytes / 2)) break;
            events.push(f);
            bytes += size;
        }
        return { result: { events, ...(inRange.length > events.length ? { more: true } : {}) } };
    }

    /** `env.request` under the policy: an upsert inside the allowed roots, a removal of an idle environment. No profile directory anywhere. */
    private manage(frame: EnvRequestFrame): { result: EnvResult } | { error: EnvError } {
        const faults = this.options.faults;
        const refuse = (code: EnvError['code'], message: string) => ({ error: { code, message } });
        if (!this.policy.webManaged && !faults?.ignorePolicy) return refuse('policy-disabled', 'this machine does not let the web manage its environments');
        if (frame.op === 'remove') {
            if (!this.environments.some((e) => e.id === frame.environmentId)) return refuse('unknown-environment', `no environment ${frame.environmentId}`);
            const busy = [...this.sessions.values()].some((x) => !x.closed && x.environmentId === frame.environmentId);
            if (busy && !faults?.removeInUse) return refuse('in-use', `environment ${frame.environmentId} has running sessions`);
            this.environments = this.environments.filter((e) => e.id !== frame.environmentId);
            return { result: { environmentId: frame.environmentId } };
        }
        const input = frame.environment;
        if (input.runtime !== IN_MEMORY_CAPABILITIES.runtime) return refuse('unknown-runtime', `no driver for ${input.runtime}`);
        const roots = input.cwdRoots.map((r) => normalizePath(r, 'linux'));
        if (roots.some((r) => r === null)) return refuse('invalid', 'a working root must be an absolute path');
        if (!faults?.acceptAnyRoot && !roots.every((r) => pathWithin(r!, this.policy.allowedRoots, 'linux'))) return refuse('outside-allowed-roots', 'a working root is outside the allowed roots');
        const existing = input.id === undefined ? undefined : this.environments.find((e) => e.id === input.id);
        const next: EnvironmentDescriptor = {
            id: input.id ?? (`env_put_${++this.minted}` as EnvironmentId),
            machineId: this.machineId,
            name: input.name,
            runtime: input.runtime,
            account: { label: input.accountLabel ?? existing?.account.label ?? input.name, authStatus: existing?.account.authStatus ?? 'missing' },
            cwdRoots: roots as string[],
            concurrency: { max: input.concurrency ?? existing?.concurrency.max ?? 1, active: existing?.concurrency.active ?? 0 },
            isolation: 'none'
        };
        this.environments = existing ? this.environments.map((e) => (e.id === next.id ? next : e)) : [...this.environments, next];
        return { result: { environmentId: next.id } };
    }

    /** The faked checkouts with their paths normalized; one with a relative path is dropped. */
    private repos(): { readonly path: string; readonly git: FsGitInfo }[] {
        const out: { path: string; git: FsGitInfo }[] = [];
        for (const r of this.options.repos ?? []) {
            const path = normalizePath(r.path, 'linux');
            if (path) out.push({ path, git: r.git });
        }
        return out;
    }

    /** `locate` over the faked checkouts: same origin, inside the roots, at most `depth` levels below the root that holds it — roots first, shallowest first. */
    private locate(env: EnvironmentDescriptor, op: Extract<FsOp, { kind: 'locate' }>): FsResult {
        const depth = Math.min(op.depth ?? FS_LOCATE_MAX_DEPTH, FS_LOCATE_MAX_DEPTH);
        const roots = env.cwdRoots.map((r) => normalizePath(r, 'linux')).filter((r): r is string => r !== null);
        const levels = (p: string) => p.split('/').filter(Boolean).length;
        const found: { rootIndex: number; below: number; path: string; git: FsGitInfo }[] = [];
        for (const r of this.repos()) {
            if (r.git.origin === undefined || !sameOrigin(r.git.origin, op.origin)) continue;
            const rootIndex = roots.findIndex((root) => pathWithin(r.path, [root], 'linux'));
            if (rootIndex < 0) {
                if (this.options.faults?.locateAnywhere) found.push({ rootIndex: roots.length, below: 0, path: r.path, git: r.git });
                continue;
            }
            const below = levels(r.path) - levels(roots[rootIndex]!);
            if (below <= depth) found.push({ rootIndex, below, path: r.path, git: r.git });
        }
        found.sort((a, b) => a.rootIndex - b.rootIndex || a.below - b.below || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const matches = found.slice(0, FS_LOCATE_MAX_MATCHES).map(({ path, git }) => ({ path, git }));
        return { kind: 'locate', origin: op.origin, matches, truncated: found.length > matches.length };
    }

    private active(): SessionId[] {
        return [...this.sessions.values()].filter((s) => !s.closed).map((s) => s.id);
    }

    private close(session: FakeSession, reason: string, code?: SessionClosedCode): void {
        session.closed = true;
        this.emit({ v: V, t: 'session.closed', sessionId: session.id, reason, ...(code ? { code } : {}) });
    }

    private async turn(session: FakeSession, turnId: string): Promise<void> {
        session.busy = true;
        try {
            if (!session.named) {
                // The runtime names the session with its first turn (#388), the way a CLI reports its id with the first stream
                // event: `session.opened` carried a placeholder, this is the id a resume needs.
                session.named = true;
                const id = this.options.faults?.sameRef ? session.id : `${session.id}.run`;
                this.emit({ v: V, t: 'session.ref', sessionId: session.id, ref: { agent: 'in-memory', v: 1, id } satisfies SessionRef });
            }
            if (this.script.tool) {
                const callId = `call_${++this.calls}`;
                const result = new Promise<{ output?: unknown; error?: unknown }>((resolve) => this.pendingTools.set(callId, resolve));
                this.emit({ v: V, t: 'tool.call', callId, sessionId: session.id, tool: this.script.tool.name, input: this.script.tool.input });
                await result;
            }
            for (let i = 1; i <= this.script.events; i++) {
                if (session.closed) return;
                const last = i === this.script.events;
                const event: AgentEvent = last
                    ? { type: 'turn-end', stopReason: 'end_turn', turnId, sessionId: session.id, epoch: session.epoch, seq: session.seq + 1 }
                    : { type: 'part-delta', partId: 'part_1', delta: this.options.deltaChars ? `${i} `.padEnd(this.options.deltaChars, 'x') : `${i} `, turnId, sessionId: session.id, epoch: session.epoch, seq: session.seq + 1 };
                session.seq++;
                this.emit({ v: V, t: 'session.frame', sessionId: session.id, frame: { v: W, kind: 'event', epoch: session.epoch, seq: session.seq, event } });
                if (!last) await tick();
            }
        } finally {
            session.busy = false;
            this.drained();
        }
    }

    /** Replay the log after `wanted` — or report a gap when the log no longer reaches back that far. */
    private replay(sessionId: string, wanted: Cursor): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        const fault = this.options.faults?.replay;
        const from: Cursor = fault === 'duplicate' ? { ...wanted, seq: Math.max(0, wanted.seq - 3) } : fault === 'skip' ? { ...wanted, seq: wanted.seq + 1 } : fault === 'ignore' ? { epoch: 0, seq: 0 } : wanted;
        const oldest = session.log[0];
        const head: Cursor = { epoch: session.epoch, seq: session.seq };
        if (oldest && cursorBefore(from, { epoch: oldest.epoch, seq: oldest.seq - 1 })) {
            this.emit({ v: V, t: 'session.frame', sessionId: session.id, frame: { v: W, kind: 'gap', from: wanted, resumeAt: head } });
            return;
        }
        for (const f of session.log) if (cursorBefore(from, { epoch: f.epoch, seq: f.seq })) this.link?.push(encodeFrame({ v: V, t: 'session.frame', sessionId: session.id, frame: f }));
    }
}

/** A conformance harness over the fake daemon; also usable directly to exercise a platform implementation. */
export function inMemoryHarness(options: InMemoryHarnessOptions = {}): DaemonConformanceHarness & { start(script: ConformanceScript): InMemoryDaemon } {
    const knownOrigin = options.repos?.find((r) => r.git.origin !== undefined)?.git.origin;
    return {
        features: ['env', 'gap', 'raw', 'fs', 'env-manage', 'session-ref', 'history', 'build', 'resume', 'update', 'harness'],
        ...(knownOrigin !== undefined ? { knownOrigin } : {}),
        updateTarget: IN_MEMORY_RELEASE,
        harnessTarget: IN_MEMORY_HARNESS_TARGET,
        start: (script) => new InMemoryDaemon(script, options)
    };
}
