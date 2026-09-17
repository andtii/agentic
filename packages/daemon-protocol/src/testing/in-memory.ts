/**
 * `inMemoryHarness` — a reference daemon over an in-memory link: the fake
 * pair the conformance suite is proven against, and a stand-in for a real
 * daemon in tests of the platform side (a Machine actor, a relay). It keeps a
 * per-session log so a reconnect replays from the platform's `wanted`
 * cursors, bridges the scripted tool call as `tool.call`, and ignores
 * malformed input the way a daemon must. `faults` breaks it on purpose so a
 * test can check that the suite notices.
 */

import { DAEMON_PROTOCOL_VERSION, type CapabilityReport, type Cursor, type EnvironmentDescriptor, type EnvironmentId, type MachineId, type SessionId } from '@agentic/core';
import type { AgentEvent, SessionRef } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, cursorBefore, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import type { DaemonFrame, PlatformFrame } from '../frames.js';
import { decodePlatformFrame, encodeFrame } from '../framing/codec.js';
import type { ConformanceDaemon, ConformanceScript, DaemonConformanceHarness, PlatformSeat } from './harness.js';

export interface InMemoryFaults {
    /** `'duplicate'`: replay from a few frames before `wanted`; `'skip'`: from one after it; `'ignore'`: from the start of the log. */
    readonly replay?: 'duplicate' | 'skip' | 'ignore';
    /** Answer a `ping` from any protocol version. */
    readonly answerAnyVersion?: boolean;
    /** Never announce environment changes. */
    readonly silentEnv?: boolean;
}

export interface InMemoryHarnessOptions {
    readonly machineId?: MachineId;
    readonly environments?: readonly EnvironmentDescriptor[];
    readonly faults?: InMemoryFaults;
}

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;

export const IN_MEMORY_MACHINE = 'machine_inmemory' as MachineId;
export const IN_MEMORY_ENVIRONMENT = 'env_inmemory' as EnvironmentId;

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
    }

    dial(): PlatformSeat {
        this.disconnect();
        const link = new Link();
        this.link = link;
        const resume: Record<string, Cursor> = {};
        for (const s of this.sessions.values()) if (!s.closed) resume[s.id] = { epoch: s.epoch, seq: s.seq };
        this.emit({ v: V, t: 'hello', machineId: this.machineId, daemonVersion: '0.0.0-fake', os: 'linux', environments: this.environments, capabilities: [IN_MEMORY_CAPABILITIES], resume });
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
        if (!this.options.faults?.silentEnv) this.emit({ v: V, t: 'env', environments });
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
                return;
            }
            case 'ping':
                this.emit({ v: V, t: 'pong', at: Date.now() });
                return;
            case 'session.open': {
                const session: FakeSession = { id: frame.sessionId, epoch: 0, seq: 0, log: [], closed: false, busy: false };
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
        }
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
    return {
        features: ['env', 'gap', 'raw'],
        start: (script) => new InMemoryDaemon(script, options)
    };
}
