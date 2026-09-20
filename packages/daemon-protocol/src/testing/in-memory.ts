/**
 * `inMemoryHarness` — a reference daemon over an in-memory link: the fake
 * pair the conformance suite is proven against, and a stand-in for a real
 * daemon in tests of the platform side (a Machine actor, a relay). It keeps a
 * per-session log so a reconnect replays from the platform's `wanted`
 * cursors, bridges the scripted tool call as `tool.call`, and ignores
 * malformed input the way a daemon must. `faults` breaks it on purpose so a
 * test can check that the suite notices.
 */

import {
    DAEMON_PROTOCOL_VERSION,
    FS_LOCATE_MAX_DEPTH,
    FS_LOCATE_MAX_MATCHES,
    normalizePath,
    pathWithin,
    sameOrigin,
    type CapabilityReport,
    type Cursor,
    type EnvError,
    type EnvironmentDescriptor,
    type EnvironmentId,
    type EnvResult,
    type FsGitInfo,
    type FsOp,
    type FsResult,
    type MachineId,
    type MachinePolicy,
    type SessionId
} from '@agentic/core';
import type { AgentEvent, SessionRef } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, cursorBefore, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import type { DaemonFrame, EnvRequestFrame, PlatformFrame } from '../frames.js';
import { decodePlatformFrame, encodeFrame } from '../framing/codec.js';
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
    readonly faults?: InMemoryFaults;
}

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;

export const IN_MEMORY_MACHINE = 'machine_inmemory' as MachineId;
export const IN_MEMORY_ENVIRONMENT = 'env_inmemory' as EnvironmentId;
export const IN_MEMORY_POLICY: MachinePolicy = { webManaged: true, allowedRoots: ['/work'] };

export const IN_MEMORY_CAPABILITIES: CapabilityReport = {
    runtime: 'in-memory',
    supported: ['prompt', 'cancel', 'close'],
    unsupported: [{ op: 'fork', reason: 'not implemented' }],
    resume: 'local',
    cancel: true,
    steer: false,
    permissions: 'none',
    tools: 'mcp'
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
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
        this.emit({ v: V, t: 'hello', machineId: this.machineId, daemonVersion: '0.0.0-fake', os: 'linux', environments: this.environments, capabilities: [IN_MEMORY_CAPABILITIES], resume, policy: this.policy });
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
        this.disconnect();
        for (const resolve of this.pendingTools.values()) resolve({ error: { code: 'closed', message: 'daemon stopped' } });
        this.pendingTools.clear();
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
                for (const [sessionId, cursor] of Object.entries(frame.wanted)) this.replay(sessionId, cursor);
                if (this.heartbeat === undefined) this.heartbeat = setInterval(() => this.emit({ v: V, t: 'heartbeat', at: Date.now(), active: this.active() }), this.script.heartbeatMs);
                // A daemon probes provider limits once welcomed (#261); the suite must pass over the unsolicited frame.
                this.emit({ v: V, t: 'quota', environmentId: this.environmentId, snapshot: { sourceId: 'in-memory', runtime: 'in-memory', environmentId: this.environmentId, availability: 'not-reported', reason: 'the in-memory runtime has no provider limits', windows: [], observedAt: Date.now(), via: 'probe' } });
                return;
            }
            case 'ping':
                this.emit({ v: V, t: 'pong', at: Date.now() });
                return;
            case 'session.open': {
                const session: FakeSession = { id: frame.sessionId, environmentId: frame.environmentId, epoch: 0, seq: 0, log: [], closed: false, busy: false };
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
                const entries = this.repos()
                    .filter((r) => r.path !== path && normalizePath(`${r.path}/..`, 'linux') === path)
                    .map((r) => ({ name: r.path.slice(r.path.lastIndexOf('/') + 1), path: r.path, git: r.git }));
                return answer({ result: { kind: 'list', path, ...(parent ? { parent } : {}), ...(own ? { git: own.git } : {}), entries, truncated: false } });
            }
            case 'env.request': {
                const outcome = this.manage(frame);
                // The descriptors first, then the answer: whoever reads the answer already has the list it is about.
                if ('result' in outcome) this.setEnvironments(this.environments);
                this.emit({ v: V, t: 'env.response', requestId: frame.requestId, ...outcome });
                return;
            }
        }
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

    private close(session: FakeSession, reason: string): void {
        session.closed = true;
        this.emit({ v: V, t: 'session.closed', sessionId: session.id, reason });
    }

    private async turn(session: FakeSession, turnId: string): Promise<void> {
        session.busy = true;
        try {
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
                    : { type: 'part-delta', partId: 'part_1', delta: `${i} `, turnId, sessionId: session.id, epoch: session.epoch, seq: session.seq + 1 };
                session.seq++;
                this.emit({ v: V, t: 'session.frame', sessionId: session.id, frame: { v: W, kind: 'event', epoch: session.epoch, seq: session.seq, event } });
                if (!last) await tick();
            }
        } finally {
            session.busy = false;
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
        features: ['env', 'gap', 'raw', 'fs', 'env-manage'],
        ...(knownOrigin !== undefined ? { knownOrigin } : {}),
        start: (script) => new InMemoryDaemon(script, options)
    };
}
