/**
 * The machine daemon (architecture §5b, EXE-02/03/08): one reconnecting
 * socket to the machine's platform endpoint, the local environments behind
 * it, and one served runtime session per `session.open`.
 *
 * - `hello` reports the environments (through each driver's `inspect`, plus
 *   the per-environment verdict of its `doctor` — isolation and auth, EXE-05/07),
 *   the capabilities per runtime and a resume cursor per live session.
 * - Session traffic waits for `welcome`; its `wanted` cursors restart every
 *   session pump, so a reconnect replays gaplessly — from `serveSession`'s
 *   buffer, then from the log on disk, or as a `gap` when neither reaches.
 *   A wanted session that is no longer live (the daemon restarted) is
 *   replayed from its log and then reported closed.
 * - `session.command` goes through `ServedSession.handleCommand`
 *   (idempotent by `commandId`) and comes back as `session.reply`.
 * - A driver's `callTool` becomes `tool.call`; `tool.result` settles it.
 *   Calls still open when the socket drops are sent again after `welcome`.
 *
 * The daemon never branches on a runtime id: it picks the driver whose
 * `runtime` matches the environment row.
 */

import {
    DAEMON_PROTOCOL_VERSION,
    environmentVerdict,
    toEnvironmentDescriptor,
    type CapabilityReport,
    type Cursor,
    type DoctorReport,
    type EnvironmentDescriptor,
    type EnvironmentId,
    type EnvironmentInspection,
    type EnvironmentVerdict,
    type LocalEnvironment,
    type MachineId,
    type RuntimeDriver,
    type SessionId
} from '@agentic/core';
import { decodePlatformFrame, encodeFrame, type DaemonFrame, type PlatformFrame, type PlatformFrameOf } from '@agentic/daemon-protocol';
import { capabilities as agentCapabilities, type AgentCapabilities, type AgentSession, type Policy } from '@sigx/ai-agent';
import { cursorBefore, serveSession, type ServedSession } from '@sigx/ai-agent/wire';
import { isAbsolute, relative, resolve } from 'node:path';
import { reconnectingConnection, type BackoffOptions, type Connection, type Socket } from './connection.js';
import type { NdjsonEventLog } from './event-log.js';
import { silentLogger, type Logger } from './logger.js';
import { daemonSocketUrl } from './pair.js';
import { DAEMON_VERSION } from './version.js';

const V = DAEMON_PROTOCOL_VERSION;

export type DaemonDriver = RuntimeDriver<AgentSession, Policy>;

export interface DaemonOptions {
    /** The paired machine: platform URL, machine id and token. */
    readonly credentials: { readonly url: string; readonly machineId: string; readonly token: string };
    readonly environments: readonly LocalEnvironment[];
    readonly drivers: readonly DaemonDriver[];
    readonly eventLog: NdjsonEventLog;
    readonly logger?: Logger;
    /** Default 30 s. */
    readonly heartbeatMs?: number;
    readonly backoff?: BackoffOptions;
    /** How long a platform tool call may take. Default 10 minutes. */
    readonly toolTimeoutMs?: number;
    readonly daemonVersion?: string;
    readonly os?: 'windows' | 'darwin' | 'linux';
    /** Overrides the socket URL derived from `credentials.url`. */
    readonly socketUrl?: string;
    readonly platform?: NodeJS.Platform;
}

export interface Daemon {
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Replace the environments and announce them with `env`. */
    setEnvironments(environments: readonly LocalEnvironment[]): Promise<void>;
    readonly connected: boolean;
    readonly activeSessions: readonly SessionId[];
    /** Malformed platform messages dropped so far. */
    readonly rejected: number;
}

export class PlatformToolError extends Error {
    override readonly name = 'PlatformToolError';
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
    }
}

interface LiveSession {
    readonly id: SessionId;
    readonly environmentId: EnvironmentId;
    readonly session: AgentSession;
    readonly served: ServedSession;
    readonly capabilities: CapabilityReport;
    /** The last frame this daemon handed to a socket. */
    lastSent: Cursor;
    pump: AbortController | undefined;
}

interface PendingTool {
    readonly frame: Extract<DaemonFrame, { readonly t: 'tool.call' }>;
    resolve(output: unknown): void;
    reject(error: Error): void;
    readonly timer: ReturnType<typeof setTimeout>;
}

function osOf(platform: NodeJS.Platform): 'windows' | 'darwin' | 'linux' {
    return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
}

/**
 * `AgentCapabilities` for `serveSession` from a driver's report. Only the
 * command handling reads them — the wire `hello` they feed is not forwarded
 * (`session.opened` carries the report itself).
 */
export function agentCapabilitiesOf(report: CapabilityReport): AgentCapabilities {
    const has = (...ops: string[]) => ops.some((op) => report.supported.includes(op));
    return agentCapabilities({
        resume: report.resume,
        cancel: report.cancel,
        steer: report.steer,
        permissions: report.permissions,
        tools: report.tools,
        fork: has('fork'),
        config: has('configure', 'config'),
        structuredOutput: has('structured-output', 'structuredOutput'),
        listSessions: has('list-sessions', 'listSessions')
    });
}

/** `at` is the event right after `last`: the next seq in the epoch, or the first of a later epoch. */
export function follows(at: Cursor, last: Cursor): boolean {
    if (at.epoch === last.epoch) return at.seq === last.seq + 1;
    return at.epoch > last.epoch && at.seq === 1;
}

/** A report for an environment whose driver could not be asked. */
function unavailableReport(runtime: string, reason: string): CapabilityReport {
    return { runtime, supported: [], unsupported: [{ op: '*', reason }], resume: false, cancel: false, steer: false, permissions: 'none', tools: 'none' };
}

/** `cwd` lies inside one of `roots` (case-insensitive on Windows). */
export function withinRoots(cwd: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
    const norm = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const target = norm(cwd);
    return roots.some((root) => {
        const rel = relative(norm(root), target);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
}

export function createDaemon(options: DaemonOptions): Daemon {
    const logger = options.logger ?? silentLogger;
    const platform = options.platform ?? process.platform;
    const machineId = options.credentials.machineId as MachineId;
    const heartbeatMs = options.heartbeatMs ?? 30_000;
    const toolTimeoutMs = options.toolTimeoutMs ?? 10 * 60_000;
    const drivers = new Map(options.drivers.map((d) => [d.runtime, d]));
    const log = options.eventLog;

    let environments: readonly LocalEnvironment[] = options.environments;
    let inspections = new Map<EnvironmentId, EnvironmentInspection>();
    let verdicts = new Map<EnvironmentId, EnvironmentVerdict>();
    const sessions = new Map<SessionId, LiveSession>();
    const opening = new Map<SessionId, EnvironmentId>();
    const pendingTools = new Map<string, PendingTool>();
    let socket: Socket | undefined;
    let welcomed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let calls = 0;
    let rejected = 0;
    let connection: Connection | undefined;
    let stopped = false;

    function send(frame: DaemonFrame): boolean {
        if (!socket) return false;
        let text: string;
        try {
            text = encodeFrame(frame);
        } catch (e) {
            logger.error('platform: frame not sent', { t: frame.t, error: e });
            return false;
        }
        socket.send(text);
        return true;
    }

    async function inspectAll(): Promise<void> {
        const next = new Map<EnvironmentId, EnvironmentInspection>();
        for (const env of environments) {
            const driver = drivers.get(env.runtime);
            if (!driver) {
                logger.warn('environment has no driver for its runtime; not reported', { environment: env.id, runtime: env.runtime });
                continue;
            }
            try {
                next.set(env.id, await driver.inspect(env));
            } catch (e) {
                logger.warn('environment inspection failed', { environment: env.id, error: e });
                next.set(env.id, { authStatus: 'unknown', isolation: 'none', capabilities: unavailableReport(env.runtime, (e as Error).message) });
            }
        }
        // Each driver's `doctor` over its environments: the isolation / auth verdict per environment that
        // travels with the descriptor (EXE-05/07). A driver whose checks throw leaves every one of its
        // environments with an error verdict, never a silent "ok".
        const nextVerdicts = new Map<EnvironmentId, EnvironmentVerdict>();
        const byRuntime = new Map<string, LocalEnvironment[]>();
        for (const env of environments) if (next.has(env.id)) byRuntime.set(env.runtime, [...(byRuntime.get(env.runtime) ?? []), env]);
        for (const [runtime, envs] of byRuntime) {
            const checkedAt = Date.now();
            let report: DoctorReport;
            try {
                report = await drivers.get(runtime)!.doctor(envs);
            } catch (e) {
                logger.warn('driver doctor failed', { runtime, error: e });
                report = { ok: false, findings: [{ level: 'error', code: 'driver-doctor-failed', message: `the ${runtime} driver's checks failed: ${(e as Error).message}`, environmentIds: envs.map((env) => env.id) }] };
            }
            for (const env of envs) nextVerdicts.set(env.id, environmentVerdict(report, env.id, checkedAt));
        }
        inspections = next;
        verdicts = nextVerdicts;
    }

    function descriptors(): EnvironmentDescriptor[] {
        const out: EnvironmentDescriptor[] = [];
        for (const env of environments) {
            const inspection = inspections.get(env.id);
            if (!inspection) continue;
            const active = [...sessions.values()].filter((s) => s.environmentId === env.id).length;
            out.push(toEnvironmentDescriptor(env, machineId, inspection, active, verdicts.get(env.id)));
        }
        return out;
    }

    function runtimeReports(): CapabilityReport[] {
        const byRuntime = new Map<string, CapabilityReport>();
        for (const inspection of inspections.values()) if (!byRuntime.has(inspection.capabilities.runtime)) byRuntime.set(inspection.capabilities.runtime, inspection.capabilities);
        return [...byRuntime.values()];
    }

    // ------------------------------------------------------------------ socket

    function onOpen(next: Socket): void {
        socket = next;
        welcomed = false;
        const resume: Record<string, Cursor> = {};
        // The later of the served head and what was last sent: the served head (and the log behind it) advances
        // only as appends reach disk, so it can trail frames already on the wire.
        for (const s of sessions.values()) resume[s.id] = cursorBefore(s.served.head, s.lastSent) ? s.lastSent : s.served.head;
        send({ v: V, t: 'hello', machineId, daemonVersion: options.daemonVersion ?? DAEMON_VERSION, os: options.os ?? osOf(platform), environments: descriptors(), capabilities: runtimeReports(), resume });
    }

    function onClose(): void {
        socket = undefined;
        welcomed = false;
        for (const s of sessions.values()) stopPump(s);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        heartbeat = undefined;
    }

    function onMessage(text: string): void {
        const result = decodePlatformFrame(text);
        if (!result.ok) {
            rejected++;
            logger.debug('platform: message dropped', { code: result.error.code });
            return;
        }
        handle(result.frame);
    }

    function handle(frame: PlatformFrame): void {
        switch (frame.t) {
            case 'welcome':
                return welcome(frame);
            case 'ping':
                send({ v: V, t: 'pong', at: Date.now() });
                return;
            case 'session.open':
                void openSession(frame);
                return;
            case 'session.command':
                void command(frame);
                return;
            case 'session.close':
                void closeSession(frame.sessionId, 'closed');
                return;
            case 'tool.result': {
                const pending = pendingTools.get(frame.callId);
                if (!pending) return;
                pendingTools.delete(frame.callId);
                clearTimeout(pending.timer);
                if (frame.error) pending.reject(new PlatformToolError(frame.error.code, frame.error.message));
                else pending.resolve(frame.output);
                return;
            }
        }
    }

    function welcome(frame: PlatformFrameOf<'welcome'>): void {
        welcomed = true;
        const wanted = frame.wanted;
        for (const s of sessions.values()) startPump(s, wanted[s.id] ?? s.lastSent);
        for (const [id, cursor] of Object.entries(wanted)) if (!sessions.has(id as SessionId)) void replayArchived(id as SessionId, cursor);
        for (const pending of pendingTools.values()) send(pending.frame);
        if (heartbeat === undefined) {
            heartbeat = setInterval(() => send({ v: V, t: 'heartbeat', at: Date.now(), active: [...sessions.keys()] }), heartbeatMs);
        }
    }

    // ---------------------------------------------------------------- sessions

    function stopPump(s: LiveSession): void {
        s.pump?.abort();
        s.pump = undefined;
    }

    function startPump(s: LiveSession, from: Cursor): void {
        stopPump(s);
        const controller = new AbortController();
        s.pump = controller;
        void (async () => {
            let last = from;
            try {
                for await (const frame of s.served.events(from, { signal: controller.signal })) {
                    if (controller.signal.aborted) return;
                    // `session.opened` already told the platform what the wire hello would.
                    if (frame.kind === 'hello') continue;
                    if (!welcomed) return;
                    if (frame.kind === 'event') {
                        const at: Cursor = { epoch: frame.epoch, seq: frame.seq };
                        // A store that no longer reaches back to `from` replays from where it starts: name the hole (OPS-04).
                        if (!follows(at, last) && !send({ v: V, t: 'session.frame', sessionId: s.id, frame: { v: frame.v, kind: 'gap', from, resumeAt: { epoch: at.epoch, seq: at.seq - 1 } } })) return;
                        last = at;
                    } else if (frame.kind === 'gap') last = frame.resumeAt;
                    if (!send({ v: V, t: 'session.frame', sessionId: s.id, frame })) return;
                    s.lastSent = last;
                }
            } catch (e) {
                if (!controller.signal.aborted) logger.warn('session: event stream failed', { session: s.id, error: e });
            }
        })();
    }

    async function openSession(frame: PlatformFrameOf<'session.open'>): Promise<void> {
        const { sessionId, environmentId, spec } = frame;
        const existing = sessions.get(sessionId);
        if (existing) {
            send({ v: V, t: 'session.opened', sessionId, ref: existing.session.ref, capabilities: existing.capabilities, head: existing.served.head });
            return;
        }
        if (opening.has(sessionId)) return;
        const refuse = (reason: string) => {
            logger.warn('session: open refused', { session: sessionId, environment: environmentId, reason });
            send({ v: V, t: 'session.closed', sessionId, reason });
        };
        const env = environments.find((e) => e.id === environmentId);
        if (!env) return refuse(`unknown environment ${environmentId}`);
        const driver = drivers.get(env.runtime);
        if (!driver) return refuse(`no driver for runtime ${env.runtime} on this machine`);
        const busy = [...sessions.values()].filter((s) => s.environmentId === env.id).length + [...opening.values()].filter((id) => id === env.id).length;
        if (busy >= env.concurrency) return refuse(`environment ${env.name} is at capacity (${env.concurrency})`);
        if (!withinRoots(spec.cwd, env.cwdRoots, platform)) return refuse(`cwd is outside the environment's cwdRoots`);

        opening.set(sessionId, env.id);
        try {
            const opened = await driver.open(env, spec, { sessionId, callTool: (tool, input) => callTool(sessionId, tool, input) });
            if (stopped) {
                await opened.session.close().catch(() => {});
                return;
            }
            // Logged under the platform's session id: the runtime names its sessions its own way.
            const served = serveSession(opened.session, { agentId: spec.agentId, capabilities: agentCapabilitiesOf(opened.capabilities), eventLog: log.forSession(sessionId) });
            const live: LiveSession = { id: sessionId, environmentId: env.id, session: opened.session, served, capabilities: opened.capabilities, lastSent: served.head, pump: undefined };
            sessions.set(sessionId, live);
            logger.info('session: opened', { session: sessionId, environment: env.id, runtime: env.runtime });
            send({ v: V, t: 'session.opened', sessionId, ref: opened.session.ref, capabilities: opened.capabilities, head: served.head });
            if (welcomed) startPump(live, served.head);
        } catch (e) {
            refuse(`the runtime could not open a session: ${(e as Error).message}`);
        } finally {
            opening.delete(sessionId);
        }
    }

    async function command(frame: PlatformFrameOf<'session.command'>): Promise<void> {
        const { sessionId } = frame;
        const s = sessions.get(sessionId);
        if (!s) {
            send({ v: V, t: 'session.reply', sessionId, reply: { v: frame.command.v, kind: 'error', commandId: frame.command.commandId, code: 'closed', message: 'no such session on this machine' } });
            return;
        }
        const reply = await s.served.handleCommand(frame.command);
        send({ v: V, t: 'session.reply', sessionId, reply });
        if (frame.command.type === 'close' && reply.kind === 'ack') await closeSession(sessionId, 'closed by command');
    }

    async function closeSession(sessionId: SessionId, reason: string): Promise<void> {
        const s = sessions.get(sessionId);
        if (!s) return;
        sessions.delete(sessionId);
        stopPump(s);
        for (const [callId, pending] of pendingTools) {
            if (pending.frame.sessionId !== sessionId) continue;
            pendingTools.delete(callId);
            clearTimeout(pending.timer);
            pending.reject(new PlatformToolError('closed', 'the session closed'));
        }
        await s.served.close().catch((e: unknown) => logger.warn('session: serve close failed', { session: sessionId, error: e }));
        await s.session.close().catch((e: unknown) => logger.warn('session: close failed', { session: sessionId, error: e }));
        await log.flush(sessionId);
        logger.info('session: closed', { session: sessionId, reason });
        send({ v: V, t: 'session.closed', sessionId, reason });
    }

    /** A wanted session this daemon no longer runs: replay what its log holds, then say it is gone. */
    async function replayArchived(sessionId: SessionId, wanted: Cursor): Promise<void> {
        let next: Cursor = wanted;
        let any = false;
        try {
            for await (const event of log.read(sessionId, wanted)) {
                if (!socket || !welcomed) return;
                const at: Cursor = { epoch: event.epoch, seq: event.seq };
                if (!follows(at, next)) {
                    send({ v: V, t: 'session.frame', sessionId, frame: { v: 1, kind: 'gap', from: wanted, resumeAt: { epoch: at.epoch, seq: at.seq - 1 } } });
                }
                send({ v: V, t: 'session.frame', sessionId, frame: { v: 1, kind: 'event', epoch: at.epoch, seq: at.seq, event } });
                next = at;
                any = true;
            }
        } catch (e) {
            logger.warn('session: archived replay failed', { session: sessionId, error: e });
        }
        const known = any || (await log.head(sessionId)) !== undefined;
        send({ v: V, t: 'session.closed', sessionId, reason: known ? 'the session is no longer running on this machine (daemon restarted)' : 'unknown session' });
    }

    function callTool(sessionId: SessionId, tool: string, input: unknown): Promise<unknown> {
        const callId = `call_${Date.now().toString(36)}_${++calls}`;
        return new Promise((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                pendingTools.delete(callId);
                rejectPromise(new PlatformToolError('timeout', `platform tool ${tool} did not answer within ${toolTimeoutMs} ms`));
            }, toolTimeoutMs);
            const frame = { v: V, t: 'tool.call', callId, sessionId, tool, input } as const;
            pendingTools.set(callId, { frame, resolve: resolvePromise, reject: rejectPromise, timer });
            if (welcomed) send(frame);
        });
    }

    return {
        async start() {
            stopped = false;
            await inspectAll();
            const url = options.socketUrl ?? daemonSocketUrl(options.credentials.url, options.credentials.machineId);
            connection = reconnectingConnection({
                url,
                token: options.credentials.token,
                logger,
                ...(options.backoff ? { backoff: options.backoff } : {}),
                handlers: {
                    onOpen,
                    onMessage,
                    onClose
                }
            });
            logger.info('daemon: starting', { machine: machineId, environments: environments.length });
            connection.start();
        },
        async stop() {
            stopped = true;
            for (const id of sessions.keys()) await closeSession(id, 'daemon stopping');
            await connection?.stop();
            onClose();
            for (const pending of pendingTools.values()) {
                clearTimeout(pending.timer);
                pending.reject(new PlatformToolError('closed', 'the daemon stopped'));
            }
            pendingTools.clear();
            await log.flush();
            logger.info('daemon: stopped');
        },
        async setEnvironments(next) {
            environments = next;
            await inspectAll();
            if (socket) send({ v: V, t: 'env', environments: descriptors() });
        },
        get connected() {
            return connection?.connected ?? false;
        },
        get activeSessions() {
            return [...sessions.keys()];
        },
        get rejected() {
            return rejected;
        }
    };
}
