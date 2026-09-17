/**
 * The Machine actor — `{ws}:machine:{id}` (architecture §4 Machine, §5b).
 *
 * One paired daemon, one record: its token hash, what it reported
 * (`hello` / `env` / `heartbeat`), the sessions it hosts and those waiting
 * for capacity, and the commands whose replies are still out. The host
 * accepts the daemon's hibernatable WebSocket and hands every message to
 * `socketMessage`; the actor answers through the `MachineSocketPort`.
 *
 * Routing (§5b): `session.frame` → `Session.forwardFrames`, `session.reply`
 * → `Session.commandReplied`, `tool.call` → the `ToolCallPort` under the
 * agent principal. Every mutation ends in `ctx.save()` inside the turn.
 */

import { actorKey, hasScope, type AgentId, type CapabilityReport, type EnvironmentDescriptor, type EnvironmentId, type MachineId, type OpenSpec, type Principal, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION, decodeDaemonFrame, encodeFrame, type DaemonFrame, type DaemonFrameOf, type PlatformFrame } from '@agentic/daemon-protocol';
import { actor, defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { capabilities as agentCapabilities, type AgentCapabilities, type SessionRef } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { ServerFnError } from '@sigx/server';

import { asPrincipal, issueMachineToken, machinePrincipal, mintAgentPrincipal, sameWorkspace, workspaceKey, type MachineTokenRecord } from '../auth/index.js';
import { Workspace } from '../workspace/index.js';
import type { MachinePorts } from './ports.js';
import { ToolCallError } from './ports.js';
import { advances, freeSlots, initialMachineState, MAX_CLOSURES, parseMachineKey, type HostedSession, type MachineOs, type MachineState, type PendingCommand, type QueuedSession, type SessionClosure } from './state.js';

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;

/** The reminder that watches the heartbeat window and the pending-reply deadlines. */
export const LIVENESS = 'liveness';
export const DEFAULT_HEARTBEAT_WINDOW_MS = 90_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** The reminder floor (architecture §2): nothing is checked more often. */
const REMINDER_FLOOR_MS = 60_000;

export interface PairInfo {
    readonly name?: string;
    readonly os?: MachineOs;
    readonly daemonVersion?: string;
}

export interface PairedMachine {
    readonly token: string;
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
}

/** What `openSession` says: the daemon was told, or the session waits for a slot (EXE-09). */
export type OpenSessionResult = 'opened' | 'queued';

export interface OpenSessionOptions {
    readonly taskId?: TaskId;
}

/** What `socketMessage` reports back to the host, for its logs. */
export type SocketMessageResult = { readonly ok: true; readonly t: DaemonFrame['t'] } | { readonly ok: false; readonly code: string; readonly message: string };

/** `Machine.get()` — the record without the token hash. */
export interface MachineView {
    readonly key: string;
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
    readonly name: string;
    readonly os?: MachineOs;
    readonly paired: boolean;
    readonly pairedAt?: number;
    readonly revoked: boolean;
    readonly revokedAt?: number;
    readonly online: boolean;
    readonly lastSeen?: number;
    readonly connectedAt?: number;
    readonly daemonVersion?: string;
    readonly capabilities: readonly CapabilityReport[];
    readonly environments: readonly EnvironmentDescriptor[];
    readonly activeSessions: readonly HostedSession[];
    readonly queued: readonly QueuedSession[];
    readonly pending: readonly PendingCommand[];
    readonly closures: readonly SessionClosure[];
    readonly rejected: number;
}

/** Only the machine the key names — the daemon's own socket. */
const selfMachine: ActorPolicy = (principal: Principal | null, _rq, op) => {
    if (!op.resource || principal?.kind !== 'machine') return false;
    return parseMachineKey(op.resource.key)?.machineId === principal.machineId;
};
/** The workspace's user (v1: its owner, `sameWorkspace` already ran). */
const owner: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user';
const ownerOrSelf: ActorPolicy = (principal, rq, op) => owner(principal, rq, op) || selfMachine(principal, rq, op);
/** Whoever drives sessions: a user, an agent, or an external client with the `sessions` scope — never a machine. */
const sessionDriver: ActorPolicy = (principal: Principal | null) => !!principal && principal.kind !== 'machine' && hasScope(principal, 'sessions');
const machinesReader: ActorPolicy = (principal: Principal | null) => !!principal && hasScope(principal, 'machines');

/** The wire `AgentCapabilities` a `CapabilityReport` implies — what the daemon's `serveSession` runs with. */
export function toAgentCapabilities(report: CapabilityReport): AgentCapabilities {
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

interface SessionClient {
    forwardFrames(frames: readonly WireFrame[]): Promise<void>;
    commandReplied(reply: WireReply): Promise<void>;
}

/** Build the Machine actor definition over its ports. One call per app — the actor `type` is `'machine'`. */
export function defineMachineActor(ports: MachinePorts) {
    const now = ports.now ?? Date.now;
    const heartbeatWindowMs = ports.heartbeatWindowMs ?? DEFAULT_HEARTBEAT_WINDOW_MS;
    const commandTimeoutMs = ports.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

    function view(c: ActorContext<MachineState>): MachineView {
        const s = c.snapshot();
        const ids = parseMachineKey(c.key)!;
        const { tokenHash: _hash, ...rest } = s;
        return {
            key: c.key,
            workspaceId: ids.workspaceId,
            machineId: ids.machineId,
            name: rest.name,
            ...(rest.os ? { os: rest.os } : {}),
            paired: !!s.tokenHash,
            ...(rest.pairedAt !== undefined ? { pairedAt: rest.pairedAt } : {}),
            revoked: rest.revokedAt !== undefined && rest.revokedAt !== null,
            ...(rest.revokedAt !== undefined && rest.revokedAt !== null ? { revokedAt: rest.revokedAt } : {}),
            online: rest.online,
            ...(rest.lastSeen !== undefined ? { lastSeen: rest.lastSeen } : {}),
            ...(rest.connectedAt !== undefined ? { connectedAt: rest.connectedAt } : {}),
            ...(rest.daemonVersion !== undefined ? { daemonVersion: rest.daemonVersion } : {}),
            capabilities: rest.capabilities,
            environments: rest.environments,
            activeSessions: Object.values(rest.activeSessions),
            queued: rest.queued,
            pending: Object.values(rest.pending),
            closures: rest.closures,
            rejected: rest.rejected
        };
    }

    return defineActor({
        type: 'machine',
        authorize: [sameWorkspace, machinesReader],
        methodAuthorize: {
            pair: ownerOrSelf,
            tokenRecord: ownerOrSelf,
            revoke: owner,
            rename: owner,
            socketMessage: selfMachine,
            socketClosed: selfMachine,
            heartbeat: selfMachine,
            openSession: sessionDriver,
            closeSession: sessionDriver,
            sendCommand: sessionDriver
        },
        state: (): MachineState => initialMachineState(),
        methods: (ctx) => {
            const ids = parseMachineKey(ctx.key);
            if (!ids) throw new ServerFnError(404, `machine: "${ctx.key}" is not a {ws}:machine:{id} key`);
            const { workspaceId, machineId } = ids;
            const self = machinePrincipal(workspaceId, machineId);

            const send = (frame: PlatformFrame): boolean => ports.socket.send(ctx.key, encodeFrame(frame));

            /**
             * The Session actor for `sessionId`, called as this machine through a
             * FRESH call rather than a `ctx.actor` hop: the daemon path's entry
             * points admit only the hosting machine, and the turn this runs in
             * may belong to a user (`closeSession`), to nobody (the reminder) or
             * to the Session itself (`sendCommand` from its `CommandSink`) — a
             * hop would inherit that caller, or wait on the turn that is waiting
             * on us. `oneWay` queues the call instead of awaiting it.
             */
            function session(sessionId: SessionId, options: { oneWay?: boolean } = {}): SessionClient | null {
                const def = ports.sessions?.();
                if (!def) return null;
                const client = actor(def, actorKey(workspaceId, 'session', sessionId));
                return (options.oneWay ? client.with({ context: asPrincipal(self), oneWay: true }) : client.with({ context: asPrincipal(self) })) as unknown as SessionClient;
            }

            async function replied(sessionId: SessionId, reply: WireReply, options?: { oneWay?: boolean }): Promise<void> {
                await session(sessionId, options)?.commandReplied(reply);
            }

            const errorReply = (commandId: string, code: Extract<WireReply, { kind: 'error' }>['code'], message: string): WireReply => ({ v: W, kind: 'error', commandId, code, message });
            /** `commandId` is unique per Session, not per machine: pending replies are keyed by both. */
            const pendingKey = (sessionId: SessionId, commandId: string): string => `${sessionId}:${commandId}`;

            async function armLiveness(): Promise<void> {
                const s = ctx.state;
                if (s.online || Object.keys(s.pending).length > 0) await ctx.reminders.set(LIVENESS, { due: Math.max(REMINDER_FLOOR_MS, Math.min(heartbeatWindowMs, commandTimeoutMs)) });
                else await ctx.reminders.clear(LIVENESS);
            }

            function record(closure: SessionClosure): void {
                const s = ctx.state;
                s.closures.push(closure);
                if (s.closures.length > MAX_CLOSURES) s.closures.splice(0, s.closures.length - MAX_CLOSURES);
            }

            function openFrame(h: { sessionId: SessionId; environmentId: EnvironmentId; spec: OpenSpec }): PlatformFrame {
                return { v: V, t: 'session.open', sessionId: h.sessionId, environmentId: h.environmentId, spec: ctx.snapshot(h.spec) };
            }

            /** Move queued sessions into environments that have room, sending `session.open` for each. */
            function dequeue(): void {
                const s = ctx.state;
                if (!s.online) return;
                const keep: QueuedSession[] = [];
                for (const q of s.queued) {
                    if (freeSlots(s, q.environmentId) > 0) {
                        const hosted: HostedSession = { sessionId: q.sessionId, environmentId: q.environmentId, agentId: q.agentId, ...(q.taskId ? { taskId: q.taskId } : {}), spec: q.spec, status: 'opening', requestedAt: now() };
                        s.activeSessions[q.sessionId] = hosted;
                        send(openFrame(hosted));
                    } else keep.push(q);
                }
                s.queued = keep;
            }

            /** Forget a hosted or queued session; answer its open commands with `closed`. */
            async function sessionGone(sessionId: SessionId, reason: string): Promise<void> {
                const s = ctx.state;
                const wasHosted = sessionId in s.activeSessions;
                delete s.activeSessions[sessionId];
                const before = s.queued.length;
                s.queued = s.queued.filter((q) => q.sessionId !== sessionId);
                if (wasHosted || s.queued.length !== before) record({ sessionId, reason, at: now() });
                for (const [key, p] of Object.entries(s.pending)) {
                    if (p.sessionId !== sessionId) continue;
                    delete s.pending[key];
                    await replied(sessionId, errorReply(p.command.commandId, 'closed', reason));
                }
                dequeue();
            }

            async function onHello(frame: DaemonFrameOf<'hello'>): Promise<void> {
                const s = ctx.state;
                if (frame.machineId !== machineId) {
                    ports.socket.close(ctx.key, 1008, `hello names machine ${frame.machineId}; this socket belongs to ${machineId}`);
                    return;
                }
                const at = now();
                s.online = true;
                s.lastSeen = at;
                s.connectedAt = at;
                s.os = frame.os;
                s.daemonVersion = frame.daemonVersion;
                s.environments = ctx.snapshot(frame.environments) as EnvironmentDescriptor[];
                s.capabilities = ctx.snapshot(frame.capabilities) as CapabilityReport[];
                // Sessions the daemon still runs, or once ran, replay from the last cursor this machine holds;
                // ones it never heard of (a restart before `session.opened`) are opened again.
                const wanted: Record<string, { epoch: number; seq: number }> = {};
                const reopen: HostedSession[] = [];
                for (const h of Object.values(s.activeSessions)) {
                    if (h.status === 'opening' && !(h.sessionId in frame.resume)) reopen.push(h);
                    else wanted[h.sessionId] = h.cursor ? { epoch: h.cursor.epoch, seq: h.cursor.seq } : { epoch: 0, seq: 0 };
                }
                send({ v: V, t: 'welcome', serverTime: at, wanted });
                for (const h of reopen) send(openFrame(h));
                // Replies are idempotent by commandId on the daemon: what is still pending is asked again.
                for (const p of Object.values(s.pending)) if (p.deadline > at) send({ v: V, t: 'session.command', sessionId: p.sessionId, command: ctx.snapshot(p.command) });
                dequeue();
                await armLiveness();
            }

            async function onSessionOpened(frame: DaemonFrameOf<'session.opened'>): Promise<void> {
                const h = ctx.state.activeSessions[frame.sessionId];
                if (!h) return; // not ours (a session this record never opened): nothing to bind it to
                h.status = 'open';
                h.openedAt = now();
                h.ref = frame.ref;
                h.capabilities = frame.capabilities;
                if (!h.cursor || advances(h.cursor, frame.head)) h.cursor = { epoch: frame.head.epoch, seq: frame.head.seq };
                // The daemon's pump skips the wire `hello`; this is where the Session learns its ref and capabilities.
                const hello: WireFrame = { v: W, kind: 'hello', agentId: h.agentId, sessionId: frame.sessionId, sessionRef: frame.ref as SessionRef, capabilities: toAgentCapabilities(frame.capabilities), head: frame.head };
                await session(frame.sessionId)?.forwardFrames([hello]);
            }

            async function onSessionFrame(frame: DaemonFrameOf<'session.frame'>): Promise<void> {
                const h = ctx.state.activeSessions[frame.sessionId];
                const wire = frame.frame;
                if (h) {
                    if (wire.kind === 'event' && advances(h.cursor, { epoch: wire.epoch, seq: wire.seq })) h.cursor = { epoch: wire.epoch, seq: wire.seq };
                    else if (wire.kind === 'gap') h.cursor = { epoch: wire.resumeAt.epoch, seq: wire.resumeAt.seq };
                }
                await session(frame.sessionId)?.forwardFrames([wire]);
            }

            async function onSessionReply(frame: DaemonFrameOf<'session.reply'>): Promise<void> {
                const s = ctx.state;
                const key = pendingKey(frame.sessionId, frame.reply.commandId);
                const pending = s.pending[key];
                delete s.pending[key];
                await replied(frame.sessionId, frame.reply);
                if (pending?.command.type === 'close' && frame.reply.kind === 'ack') await sessionGone(frame.sessionId, 'closed by command');
            }

            function onToolCall(frame: DaemonFrameOf<'tool.call'>): void {
                const h = ctx.state.activeSessions[frame.sessionId];
                const result = (r: { output?: unknown; error?: { code: string; message: string } }) => send({ v: V, t: 'tool.result', callId: frame.callId, ...r });
                if (!h) {
                    result({ error: { code: 'closed', message: `session ${frame.sessionId} is not hosted by this machine` } });
                    return;
                }
                const tools = ports.tools;
                if (!tools) {
                    result({ error: { code: 'unsupported', message: 'platform tools are not wired on this deployment' } });
                    return;
                }
                const principal = mintAgentPrincipal({ workspaceId, agentId: h.agentId as AgentId, sessionId: frame.sessionId, ...(h.taskId ? { taskId: h.taskId } : {}) });
                // Detached on purpose: a tool may take minutes and must not hold the socket's turn. Nothing here touches state.
                void tools
                    .call({ callId: frame.callId, sessionId: frame.sessionId, tool: frame.tool, input: frame.input }, principal)
                    .then((output) => result({ output }))
                    .catch((e: unknown) => result({ error: e instanceof ToolCallError ? { code: e.code, message: e.message } : { code: 'internal', message: e instanceof Error ? e.message : String(e) } }));
            }

            async function handle(frame: DaemonFrame): Promise<void> {
                const s = ctx.state;
                switch (frame.t) {
                    case 'hello':
                        return onHello(frame);
                    case 'env':
                        s.environments = ctx.snapshot(frame.environments) as EnvironmentDescriptor[];
                        s.lastSeen = now();
                        dequeue();
                        return;
                    case 'heartbeat':
                        s.lastSeen = now();
                        s.online = true;
                        return;
                    case 'pong':
                        s.lastSeen = now();
                        return;
                    case 'session.opened':
                        return onSessionOpened(frame);
                    case 'session.frame':
                        return onSessionFrame(frame);
                    case 'session.reply':
                        return onSessionReply(frame);
                    case 'session.closed':
                        return sessionGone(frame.sessionId, frame.reason);
                    case 'tool.call':
                        return onToolCall(frame);
                }
            }

            return {
                /**
                 * Redeem a pairing code for this machine (USR-04): the Workspace
                 * consumes it over a hop, a token is minted and only its hash kept.
                 * The token is returned once, to the daemon.
                 */
                async pair(code: string, info: PairInfo = {}): Promise<PairedMachine> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (s.tokenHash) throw new ServerFnError(409, `machine "${machineId}" is already paired`);
                    const claimed = await ctx.actor(Workspace, workspaceKey(workspaceId)).claimPairing(code);
                    if (!claimed || claimed.machineId !== machineId) throw new ServerFnError(401, 'pairing code refused');
                    const issued = await issueMachineToken({ workspaceId, machineId });
                    s.tokenHash = issued.tokenHash;
                    s.pairedAt = now();
                    if (info.name?.trim()) s.name = info.name.trim();
                    if (info.os) s.os = info.os;
                    if (info.daemonVersion) s.daemonVersion = info.daemonVersion;
                    await ctx.save();
                    return { token: issued.token, workspaceId, machineId };
                },

                /** The stored hash and revocation — what `authenticate` and the socket handshake verify a token against. `null` until paired. */
                tokenRecord(): MachineTokenRecord | null {
                    const s = ctx.state;
                    if (!s.tokenHash) return null;
                    return { tokenHash: s.tokenHash, revokedAt: s.revokedAt ?? null };
                },

                /** Refuse the token from now on and drop the daemon (USR-04). */
                async revoke(): Promise<MachineView> {
                    const s = ctx.state;
                    if (s.revokedAt === undefined || s.revokedAt === null) s.revokedAt = now();
                    s.online = false;
                    ports.socket.close(ctx.key, 1008, 'revoked');
                    await ctx.reminders.clear(LIVENESS);
                    await ctx.save();
                    return view(ctx);
                },

                async rename(name: string): Promise<MachineView> {
                    if (!name.trim()) throw new ServerFnError(400, 'machine: name is required');
                    ctx.state.name = name.trim();
                    await ctx.save();
                    return view(ctx);
                },

                get(): MachineView {
                    return view(ctx);
                },

                /** The daemon says it is alive (also folded from the `heartbeat` frame). */
                async heartbeat(active: readonly SessionId[] = []): Promise<void> {
                    const s = ctx.state;
                    s.lastSeen = now();
                    s.online = true;
                    void active;
                    await armLiveness();
                    await ctx.save();
                },

                /**
                 * One WebSocket text message from the daemon. Malformed input is
                 * counted and dropped — the socket stays (§5b envelope contract).
                 */
                async socketMessage(raw: string): Promise<SocketMessageResult> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) {
                        ports.socket.close(ctx.key, 1008, 'revoked');
                        return { ok: false, code: 'revoked', message: 'the machine is revoked' };
                    }
                    const decoded = decodeDaemonFrame(raw);
                    if (!decoded.ok) {
                        s.rejected++;
                        await ctx.save();
                        return { ok: false, code: decoded.error.code, message: decoded.error.message };
                    }
                    await handle(decoded.frame);
                    await ctx.save();
                    return { ok: true, t: decoded.frame.t };
                },

                /** The daemon socket closed or failed: offline at once, before any heartbeat window (acceptance). */
                async socketClosed(): Promise<void> {
                    const s = ctx.state;
                    s.online = false;
                    await armLiveness();
                    await ctx.save();
                },

                /**
                 * Host `sessionId` in `environmentId`: `session.open` goes out when
                 * the environment has a free slot, otherwise the request queues
                 * until one closes (EXE-09). Idempotent by session id.
                 */
                async openSession(sessionId: SessionId, environmentId: EnvironmentId, spec: OpenSpec, options: OpenSessionOptions = {}): Promise<OpenSessionResult> {
                    const s = ctx.state;
                    if (s.revokedAt !== undefined && s.revokedAt !== null) throw new ServerFnError(403, `machine "${machineId}" is revoked`);
                    if (sessionId in s.activeSessions) return 'opened';
                    if (s.queued.some((q) => q.sessionId === sessionId)) return 'queued';
                    if (!s.environments.some((e) => e.id === environmentId)) throw new ServerFnError(404, `machine "${machineId}" has no environment "${environmentId}"`);
                    if (!s.online) throw new ServerFnError(503, `machine "${machineId}" is offline`);
                    const at = now();
                    const base = { sessionId, environmentId, agentId: spec.agentId, ...(options.taskId ? { taskId: options.taskId } : {}), spec: structuredClone(spec) };
                    if (freeSlots(s, environmentId) > 0) {
                        const hosted: HostedSession = { ...base, status: 'opening', requestedAt: at };
                        s.activeSessions[sessionId] = hosted;
                        send(openFrame(hosted));
                        await ctx.save();
                        return 'opened';
                    }
                    s.queued.push({ ...base, queuedAt: at });
                    await ctx.save();
                    return 'queued';
                },

                /** Tell the daemon to close the session (or drop it from the queue). The daemon's `session.closed` frees the slot. */
                async closeSession(sessionId: SessionId): Promise<void> {
                    const s = ctx.state;
                    if (sessionId in s.activeSessions) send({ v: V, t: 'session.close', sessionId });
                    else if (s.queued.some((q) => q.sessionId === sessionId)) await sessionGone(sessionId, 'closed while queued');
                    await ctx.save();
                },

                /**
                 * The `CommandSink` end: record the command as pending with a
                 * deadline, send it now if the daemon is connected — otherwise
                 * the next `hello` re-sends it (replies are idempotent by
                 * `commandId`). The Session is told `closed` at once for a
                 * session this machine does not host.
                 */
                async sendCommand(sessionId: SessionId, command: WireCommand): Promise<void> {
                    const s = ctx.state;
                    const hosted = sessionId in s.activeSessions;
                    const queued = s.queued.some((q) => q.sessionId === sessionId);
                    if (!hosted && !queued) {
                        await replied(sessionId, errorReply(command.commandId, 'closed', `session ${sessionId} is not hosted by machine ${machineId}`), { oneWay: true });
                        return;
                    }
                    const key = pendingKey(sessionId, command.commandId);
                    if (key in s.pending) return;
                    const at = now();
                    s.pending[key] = { sessionId, command: structuredClone(command), sentAt: at, deadline: at + commandTimeoutMs };
                    if (hosted && s.online) send({ v: V, t: 'session.command', sessionId, command });
                    await armLiveness();
                    await ctx.save();
                }
            };
        },
        /** The liveness reminder: a silent daemon goes offline, an unanswered command answers `internal`. */
        onReminder: async (ctx, name) => {
            if (name !== LIVENESS) return;
            const s = ctx.state;
            const at = now();
            const ids = parseMachineKey(ctx.key);
            if (s.online && (s.lastSeen ?? 0) + heartbeatWindowMs <= at) s.online = false;
            const def = ports.sessions?.();
            for (const [key, p] of Object.entries(s.pending)) {
                if (p.deadline > at) continue;
                delete s.pending[key];
                if (def && ids) {
                    const client = actor(def, actorKey(ids.workspaceId, 'session', p.sessionId)).with({ context: asPrincipal(machinePrincipal(ids.workspaceId, ids.machineId)) }) as unknown as SessionClient;
                    await client.commandReplied({ v: W, kind: 'error', commandId: p.command.commandId, code: 'internal', message: `no reply from machine ${ids.machineId} within ${commandTimeoutMs} ms` });
                }
            }
            if (s.online || Object.keys(s.pending).length > 0) await ctx.reminders.set(LIVENESS, { due: Math.max(REMINDER_FLOOR_MS, Math.min(heartbeatWindowMs, commandTimeoutMs)) });
            await ctx.save();
        }
    });
}

export type MachineActor = ReturnType<typeof defineMachineActor>;
