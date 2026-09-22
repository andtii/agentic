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
 *   replayed from its log and then reported closed with code `restart`.
 * - Close codes and re-open (#363): `stop({ reason })` closes each live session
 *   with the code the reason maps to (`restart`, `update`, `harness-update`).
 *   A `session.open` carrying `spec.resume` re-opens the runtime conversation
 *   on the same log, its head continuing on the runtime's later epoch; a
 *   runtime that refuses the resume is answered `code: 'resume-failed'`.
 * - `session.command` goes through `ServedSession.handleCommand`
 *   (idempotent by `commandId`) and comes back as `session.reply`.
 * - Capacity counts running turns, not open sessions (#394, EXE-09): a chat
 *   member's session stays open between messages and costs nothing. A
 *   `prompt` is tracked per live session — accepted on its ack, over once
 *   its `turn-end` passes (`watchTurns`) — and `env.concurrency` bounds how
 *   many run at once: `session.open` is refused at capacity, and a `prompt`
 *   that would exceed it is answered with the wire `busy` error, which the
 *   platform parks its task on. Removing an environment is still refused
 *   while any session is hosted in it; the platform closes idle ones first.
 * - A driver's `callTool` becomes `tool.call`; `tool.result` settles it.
 *   Calls still open when the socket drops are sent again after `welcome`.
 * - `session.open` carries the agent's approval policy (`OpenSpec.policy`,
 *   #121): the daemon compiles it with the same `sessionPolicy` a local
 *   session runs under and hands the `Policy` to the driver, so a harness
 *   asks the platform only what the agent's rules say to ask.
 * - `fs.request` lists folders, adds a git worktree or locates the checkouts
 *   of a repo's origin inside the named environment's `cwdRoots` (`./fs.ts`,
 *   #188, #331) and is answered by `fs.response`; `session.open` passes the
 *   same symlink-aware root check.
 * - `env.request` adds, changes or removes an environment when — and only
 *   inside the folders — the machine-local policy allows (`./env-manage.ts`,
 *   #238); the answer is `env.response` plus the `env` frame it caused.
 *   `hello` and `env` carry that policy so the platform can explain a refusal.
 *   The policy changes on the machine (`setPolicy`, from the file watcher) or,
 *   with the `webPolicy` port (#355), on a `policy.request` from the platform —
 *   answered through the port `cli.ts` injects (`./policy-web.ts`), never by
 *   a writer this module can reach; `browse` lists folders for the picker.
 * - `quota` reports each environment's provider limits (`./quota.ts`, #271):
 *   from rate-limit events in the live session streams and, unless
 *   `quota.probe` is off, by probing accounts once welcomed, when idle and
 *   after a turn. An unchanged snapshot is only re-sent after a refresh interval.
 * - `history.request` is answered from the NDJSON log (#397): the machine
 *   owns a session's history, the platform keeps a bounded recent window and
 *   asks here for anything older — a session it no longer has a log for, or a
 *   range retention already forgot, is a named error, never silence. After
 *   every turn the log is trimmed to `retention.maxBytes` of whole turns.
 * - Updates (#364): `hello` carries the build, `features: ['update']` when an update client is configured, and what
 *   the supervisor recorded (`restarts`, `lastExit`, `lastUpdate`). `update.request` / `update.cancel` go to
 *   `./update.ts`; while it drains, a turn-starting `prompt` is answered `drainingReply` and `session.open` still works.
 * - Harnesses (#369, `./harness.ts`): `hello` lists the installed ones (and the
 *   `harness` feature), `harnesses` goes out after every change. `harness.request`
 *   installs or updates one runtime — download, verify, stage, then drain only
 *   that runtime: its turn-starting prompts are answered `draining` and new
 *   sessions on it refused `draining` while its running turns finish (or at once
 *   with `mode: 'now'`, or when the drain times out); its sessions are closed
 *   with code `harness-update` through the stop path, `current.json` switched,
 *   the driver disposed and rebuilt, the old version removed. The platform
 *   re-opens the sessions from `spec.resume`. `remove` is refused `in-use` while
 *   an environment runs on the runtime. A runtime without a harness keeps its
 *   environments, reported `harness-missing`; opening a session on one is
 *   refused with that code. Started with `harnesses.heal`, the daemon installs
 *   the selected harnesses it lacks in the background (the migration from builds
 *   that bundled the runtimes), a `harnesses` frame after each.
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
    type DaemonExit,
    type DaemonFeature,
    type DaemonUpdateOutcome,
    type DoctorReport,
    type EnvironmentDescriptor,
    type EnvironmentId,
    type EnvironmentInspection,
    type EnvironmentVerdict,
    type HarnessPhase,
    type LifecycleError,
    type LocalEnvironment,
    type LoginAction,
    type LoginError,
    type ModelOption,
    type MachineId,
    type DaemonLogError,
    type DaemonLogResult,
    type MachineListing,
    type MachinePolicy,
    type MachinePolicyError,
    type MachinePolicyInput,
    type QuotaSource,
    type RuntimeDriver,
    type SessionClosedCode,
    type SessionId
} from '@agentic/core';
import { decodePlatformFrame, drainingReply, encodeFrame, LIMITS, platformKey, type DaemonFrame, type DaemonFrameOf, type PlatformFrame, type PlatformFrameOf } from '@agentic/daemon-protocol';
import { sessionPolicyOf } from '@agentic/runtimes';
import { capabilities as agentCapabilities, type AgentCapabilities, type AgentSession, type Policy, type SessionRef } from '@sigx/ai-agent';
import { cursorBefore, serveSession, WIRE_PROTOCOL_VERSION, type ServedSession, type WireFrame } from '@sigx/ai-agent/wire';
import { reconnectingConnection, type BackoffOptions, type Connection, type Socket } from './connection.js';
import type { SecureWriteOptions } from './credentials.js';
import { answerEnvRequest } from './env-manage.js';
import type { NdjsonEventLog, RetentionPolicy } from './event-log.js';
import { answerFsRequest, checkWithinRoots } from './fs.js';
import { fetchReleaseManifest, harnessAsset, HarnessError, type HarnessStore } from './harness.js';
import { silentLogger, type Logger } from './logger.js';
import type { LoginRelay } from './login-relay.js';
import { daemonSocketUrl } from './pair.js';
import type { DaemonPaths } from './paths.js';
import { POLICY_OFF, reportedPolicy } from './policy.js';
import { createQuotaMonitor } from './quota.js';
import { createTelemetrySampler, telemetryOff, type Exec } from './telemetry.js';
import { createUpdateClient, type UpdateClientOptions } from './update.js';
import { DAEMON_CHANNEL, DAEMON_COMMIT, DAEMON_VERSION } from './version.js';

const V = DAEMON_PROTOCOL_VERSION;
const W = WIRE_PROTOCOL_VERSION;

/** What a session's log keeps by default (#397): the newest whole turns under 64 MB — weeks of a chat, far past the platform's own window. */
export const DEFAULT_LOG_MAX_BYTES = 64 * 1024 * 1024;
/** About how much event JSON one `history.response` carries — half the frame limit, so the envelope and the frames' own stamps always fit. */
export const HISTORY_RESPONSE_BYTES = Math.floor(LIMITS.frameBytes / 2);
/** How long an environment's model list is trusted before a reconnect asks its account again (#453). */
export const MODELS_REFRESH_MS = 6 * 60 * 60_000;

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
    /** How long after a turn that brought no new title the runtime is asked once more (#460). Default `TITLE_RECHECK_MS`. */
    readonly titleRecheckMs?: number;
    readonly backoff?: BackoffOptions;
    /**
     * How often environments that are not signed in are inspected again, so a
     * `claude /login` shows up without a restart (#235). Default 30 s; 0 turns it off.
     */
    readonly reinspectMs?: number;
    /** How long a platform tool call may take. Default 10 minutes. */
    readonly toolTimeoutMs?: number;
    readonly daemonVersion?: string;
    readonly os?: 'windows' | 'darwin' | 'linux';
    /** Overrides the socket URL derived from `credentials.url`. */
    readonly socketUrl?: string;
    readonly platform?: NodeJS.Platform;
    /** The machine-local policy as loaded from `policy.json` (#238). Default: off. */
    readonly policy?: MachinePolicy;
    /**
     * Where `env.request` reads and writes (`environments.json`, and the folders a
     * working root may never overlap). Without it every `env.request` is refused
     * `policy-disabled` and the policy is reported off.
     */
    readonly manage?: { readonly paths: Pick<DaemonPaths, 'configDir' | 'stateDir' | 'environmentsFile'>; readonly secure?: SecureWriteOptions };
    /**
     * The web-set policy (#355; the `policy` feature): `apply` writes `policy.json` for a `policy.request { op: 'set' }`
     * and answers the policy as applied (which the daemon then runs with and announces), `browse` lists folders for the
     * picker. Without it every `policy.request` is refused `unsupported`.
     */
    readonly webPolicy?: DaemonWebPolicy;
    /** The daemon's own log for `log.request` (#481; the `log` feature): the last `lines` lines, redacted. Without it a request is refused `unsupported`. */
    readonly logTail?: (lines: number) => Promise<{ readonly result: DaemonLogResult } | { readonly error: DaemonLogError }>;
    /**
     * Sign-ins relayed from the web (#484; the `login` feature): `cli.ts` binds `login-relay.ts` over each runtime's own
     * CLI. With it every `CapabilityReport` says `login: 'relay' | 'terminal'`; without it a `login.request` is refused
     * `unsupported` and the reports say nothing (an older daemon).
     */
    readonly login?: DaemonLoginPort;
    /**
     * Provider limits (#271): the `quota` sources by runtime (`builtinQuotaSources()`; none → no `quota` frames),
     * whether to probe accounts (default on; off is the stream only), the idle poll (default 5 min, 0 off), the
     * probe after a turn ends (default 30 s later) and how long an unchanged snapshot is not sent again (default 15 min).
     */
    readonly quota?: { readonly sources?: readonly QuotaSource[]; readonly probe?: boolean; readonly pollMs?: number; readonly turnEndDebounceMs?: number; readonly refreshMs?: number };
    /**
     * What the sessions cost the machine (#400): sampled on the heartbeat cadence and sent as `telemetry`. `enabled`
     * false (`--telemetry off`) sends a `not-reported` snapshot instead; `exec` reads the process table (a fake in tests).
     */
    readonly telemetry?: { readonly enabled?: boolean; readonly exec?: Exec };
    /**
     * How much of a session's history the machine keeps (#397): the newest whole turns under `maxBytes` of NDJSON, trimmed
     * after every turn end. Default `DEFAULT_LOG_MAX_BYTES`; `0` keeps everything. What is trimmed becomes a named `gap`
     * to a `history.request` (and to a reconnect's `wanted` cursor) — never silence.
     */
    readonly retention?: Partial<RetentionPolicy>;
    /** Called after every `welcome` from the platform (the CLI writes the supervisor's `ready` marker on the first, #362). */
    readonly onWelcome?: () => void;
    /** The update client (#364): with it `hello.features` lists `update`; without it (no supervisor) `update.request` is refused `unsupported`. */
    readonly update?: UpdateClientOptions;
    /** What the supervisor recorded, reported on every `hello` (#364). */
    readonly lifecycle?: { readonly restarts?: number; readonly lastExit?: DaemonExit; readonly lastUpdate?: DaemonUpdateOutcome };
    /** `hello.build.platform` is `<platform>-<arch>`; default `process.arch`. */
    readonly arch?: string;
    /** The harness store (#369): with it the daemon reports its harnesses and answers `harness.request` (feature `harness`). */
    readonly harnesses?: DaemonHarnesses;
}

/** What `login.request` runs (#484): `cli.ts` binds `login-relay.ts` per runtime; tests bind a fake. */
export interface DaemonLoginPort {
    /** Whether `runtime`'s sign-in can be relayed on this machine (its CLI is here): `CapabilityReport.login`. */
    relays(runtime: string): boolean;
    /** Start the runtime's login for the environment's profile; `null` when it cannot be relayed. */
    start(environment: LocalEnvironment): LoginRelay | null;
}

/** What `policy.request` is answered through (#355): `cli.ts` binds `policy-web.ts`; tests bind a fake. */
export interface DaemonWebPolicy {
    apply(input: MachinePolicyInput): Promise<{ readonly policy: MachinePolicy } | { readonly error: MachinePolicyError }>;
    browse(path: string | undefined): Promise<{ readonly listing: MachineListing } | { readonly error: MachinePolicyError }>;
}

export interface DaemonHarnesses {
    readonly store: HarnessStore;
    /** `runtime`'s driver built again from where its harness is now (`builtinRuntimes().rebuild`); `undefined` drops the runtime. */
    rebuild(runtime: string): DaemonDriver | undefined;
    /** How long a `drain` waits for the runtime's running turns before closing its sessions anyway. Default 10 minutes. */
    readonly drainTimeoutMs?: number;
    /** How the store downloads (tests). Default the global `fetch`. */
    readonly fetch?: typeof fetch;
    /**
     * Heal on start (#369): install every selected harness (`store.selected()`) that is not ready, in the background, from
     * this release manifest — so a daemon updated from a build that bundled the runtimes gets them back unattended.
     * The CLI passes the daemon's own channel's manifest when it runs under an install root.
     */
    readonly heal?: { readonly manifestUrl: string };
}

/** How long a harness drain waits for running turns by default. */
export const HARNESS_DRAIN_TIMEOUT_MS = 10 * 60_000;

/** The one re-probe for a runtime title after a turn that brought none (#460): a CLI titles from a background call. */
export const TITLE_RECHECK_MS = 10_000;

/**
 * Why the daemon stops (#363): each live session is closed with the matching `session.closed` code, so the platform knows
 * to re-open it — `restart` (SIGINT / SIGTERM, or `update.request { target: 'restart' }` from the web, #481: the supervisor brings the daemon back), `update` (the update client, #364),
 * `harness-update` (the harness store, #369). A plain `stop` closes them without a code.
 */
export type StopReason = 'stop' | 'restart' | 'update' | 'harness-update';

const STOP_CLOSES: Record<StopReason, { readonly reason: string; readonly code?: SessionClosedCode }> = {
    stop: { reason: 'daemon stopping' },
    restart: { reason: 'the daemon is restarting', code: 'restart' },
    update: { reason: 'the daemon is restarting for an update', code: 'update' },
    'harness-update': { reason: 'the harness is being updated', code: 'harness-update' }
};

export interface Daemon {
    start(): Promise<void>;
    /** Close every live session — with the code `reason` maps to, while the socket is up — flush the logs and disconnect. Default reason `stop`. */
    stop(options?: { readonly reason?: StopReason }): Promise<void>;
    /** Replace the environments and announce them with `env`. */
    setEnvironments(environments: readonly LocalEnvironment[]): Promise<void>;
    /** Inspect every environment again now; `env` goes out when a descriptor changed. Resolves to whether one did. */
    reinspect(): Promise<boolean>;
    /** Replace the machine-local policy (its owner edited `policy.json`) and announce it with `env`. Never called for anything from the socket. */
    setPolicy(policy: MachinePolicy): Promise<void>;
    /** What the daemon runs with now. */
    readonly environments: readonly LocalEnvironment[];
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
    /** The runtime it was opened on: what a harness change drains and closes by (#369). */
    readonly runtime: string;
    readonly session: AgentSession;
    readonly served: ServedSession;
    readonly capabilities: CapabilityReport;
    /**
     * Where the session starts (#363): `serveSession`'s own `(0, 0)` for a fresh one and, for one re-opened from
     * `spec.resume`, `(epoch, 0)` of the later epoch the runtime stamps — so `session.opened.head` continues after the
     * log's head instead of going back to `(0, 0)`. `headOf` reads the later of it and the served head.
     */
    readonly base: Cursor;
    /**
     * The ref the platform last heard — `session.opened`'s, then each `session.ref` (#389). A runtime names its session
     * on its own terms (a CLI with its first stream event), so `session.ref` goes out only when the identity moved on.
     */
    sentRef: SessionRef;
    /** The runtime's title for the conversation (#460): the driver's probe, when the runtime keeps one. */
    readonly title?: () => Promise<string | undefined>;
    /** The session's own OS process (#400), when the runtime keeps one per session; what telemetry charges to it. */
    readonly pid?: () => number | undefined;
    /** The title the probe last found, and the one the platform last heard: `session.title` goes out when they differ. */
    knownTitle?: string;
    sentTitle?: string;
    /** One re-probe after a turn that found no new title: the CLI writes its title from a background call. */
    titleRecheck?: ReturnType<typeof setTimeout>;
    /** The last frame this daemon handed to a socket. */
    lastSent: Cursor;
    /** The last event shown to the quota monitor: a replay after a reconnect is not news. */
    tapped: Cursor;
    pump: AbortController | undefined;
    /**
     * A turn is in flight (#394): set when a `prompt` is taken — tentatively while its reply is out, kept on the ack —
     * and cleared by the turn's `turn-end`, seen by `watchTurns` off the served stream rather than the socket pump, so a
     * turn that ends while the platform is away still frees its slot.
     */
    running: boolean;
    /** `watchTurns`: aborted when the session closes. */
    readonly turns: AbortController;
}

/**
 * Whether two refs name the same runtime session (#389): by `id` and, for a harness that stamps generations, `data.epoch`
 * — never by reference, since an adapter's `ref` may be a getter that builds a fresh object per read.
 */
export function sameRefIdentity(a: SessionRef, b: SessionRef): boolean {
    return a.id === b.id && refEpoch(a) === refEpoch(b);
}
const refEpoch = (ref: SessionRef): unknown => (typeof ref.data === 'object' && ref.data !== null ? (ref.data as { epoch?: unknown }).epoch : undefined);

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
        // A harness reports its ops under their own names (`HARNESS_OPS`, #453); the short ones are an in-memory runtime's.
        fork: has('session.fork', 'fork'),
        config: has('session.configure-model', 'configure', 'config'),
        structuredOutput: has('turn.structured-output', 'structured-output', 'structuredOutput'),
        listSessions: has('agent.list-sessions', 'list-sessions', 'listSessions')
    });
}

/** A live session's head: the served head once the runtime emitted, a re-open's `base` before that. */
const headOf = (s: Pick<LiveSession, 'served' | 'base'>): Cursor => (cursorBefore(s.served.head, s.base) ? s.base : s.served.head);

/** `at` is the event right after `last`: the next seq in the epoch, or the first of a later epoch. */
export function follows(at: Cursor, last: Cursor): boolean {
    if (at.epoch === last.epoch) return at.seq === last.seq + 1;
    return at.epoch > last.epoch && at.seq === 1;
}

/** A report for an environment whose driver could not be asked. */
function unavailableReport(runtime: string, reason: string): CapabilityReport {
    return { runtime, supported: [], unsupported: [{ op: '*', reason }], resume: false, cancel: false, steer: false, permissions: 'none', tools: 'none' };
}

/**
 * A driver error travels to the platform in the verdict, and a local path never does (#274): a
 * profile or config dir is the machine's business. Absolute paths — drive, UNC, POSIX — become
 * `<path>`; the local log and `agentic-daemon doctor` keep the original.
 */
export function withoutLocalPaths(text: string): string {
    return text.replace(/(^|[\s'"`(=])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`,;)]*)/g, '$1<path>');
}

export function createDaemon(options: DaemonOptions): Daemon {
    const logger = options.logger ?? silentLogger;
    const platform = options.platform ?? process.platform;
    const machineId = options.credentials.machineId as MachineId;
    const heartbeatMs = options.heartbeatMs ?? 30_000;
    const titleRecheckMs = options.titleRecheckMs ?? TITLE_RECHECK_MS;
    const reinspectMs = options.reinspectMs ?? 30_000;
    const toolTimeoutMs = options.toolTimeoutMs ?? 10 * 60_000;
    const drivers = new Map(options.drivers.map((d) => [d.runtime, d]));
    const log = options.eventLog;
    const retention: RetentionPolicy = { maxBytes: options.retention?.maxBytes ?? DEFAULT_LOG_MAX_BYTES };

    let environments: readonly LocalEnvironment[] = options.environments;
    let policy: MachinePolicy = options.policy ?? POLICY_OFF;
    /** What `hello` / `env` say: off unless this daemon can act on it. */
    const announcedPolicy = (): MachinePolicy => (options.manage ? reportedPolicy(policy) : POLICY_OFF);
    let inspections = new Map<EnvironmentId, EnvironmentInspection>();
    let verdicts = new Map<EnvironmentId, EnvironmentVerdict>();
    /** What each environment's account says it may run (#453, `RuntimeDriver.models`), and when it was asked. */
    const models = new Map<EnvironmentId, { readonly list: readonly ModelOption[]; readonly at: number }>();
    let modelsRunning = false;
    const sessions = new Map<SessionId, LiveSession>();
    const opening = new Map<SessionId, EnvironmentId>();
    const pendingTools = new Map<string, PendingTool>();
    let socket: Socket | undefined;
    let welcomed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let reinspectTimer: ReturnType<typeof setInterval> | undefined;
    // `setEnvironments` and the periodic re-inspect both replace the inspection maps: one at a time, in order.
    let inspecting: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const run = inspecting.then(work, work);
        inspecting = run.catch(() => undefined);
        return run;
    };
    let calls = 0;
    let rejected = 0;
    let connection: Connection | undefined;
    let stopped = false;
    /** Runtimes whose harness is being changed (#369): no new turns and no new sessions on them, by what they wait for. */
    const draining = new Map<string, string>();
    /** Harness requests, one at a time and in order. */
    let harnessWork: Promise<unknown> = Promise.resolve();
    const quota = createQuotaMonitor({
        sources: options.quota?.sources ?? [],
        send: (environmentId, snapshot) => welcomed && send({ v: V, t: 'quota', environmentId, snapshot }),
        environments: () => environments,
        busy: (environmentId) => runningOn(environmentId) > 0,
        logger,
        ...(options.quota?.probe !== undefined ? { probe: options.quota.probe } : {}),
        ...(options.quota?.pollMs !== undefined ? { pollMs: options.quota.pollMs } : {}),
        ...(options.quota?.turnEndDebounceMs !== undefined ? { turnEndDebounceMs: options.quota.turnEndDebounceMs } : {}),
        ...(options.quota?.refreshMs !== undefined ? { refreshMs: options.quota.refreshMs } : {})
    });
    const telemetry = options.telemetry?.enabled === false ? undefined : createTelemetrySampler({ platform, logger, ...(options.telemetry?.exec ? { exec: options.telemetry.exec } : {}) });
    let sampling = false;
    /** One `telemetry` frame per heartbeat (#400): the sample runs off the heartbeat's tick, never two at once. */
    async function tickTelemetry(): Promise<void> {
        if (!welcomed || sampling) return;
        if (!telemetry) {
            send({ v: V, t: 'telemetry', snapshot: telemetryOff(Date.now()) });
            return;
        }
        sampling = true;
        try {
            const snapshot = await telemetry.sample({
                daemonPid: process.pid,
                sessions: [...sessions.values()].map((s) => ({ id: s.id, environmentId: s.environmentId, pid: s.pid?.(), attributable: s.pid !== undefined })),
                environments: environments.map((env) => ({ id: env.id, pids: drivers.get(env.runtime)?.pids?.(env.id) ?? [] }))
            });
            if (welcomed) send({ v: V, t: 'telemetry', snapshot });
        } catch (e) {
            logger.warn('telemetry: sample failed', { error: e instanceof Error ? e.message : String(e) });
        } finally {
            sampling = false;
        }
    }
    const updater = options.update ? createUpdateClient({ send, runningTurns: () => [...sessions.values()].filter((s) => s.running).length, logger }, options.update) : undefined;
    // The optional frame families this daemon answers (#359): each feature adds itself.
    const features: DaemonFeature[] = [...(updater ? (['update'] as const) : []), ...(options.harnesses ? (['harness'] as const) : []), ...(options.webPolicy ? (['policy'] as const) : []), ...(options.logTail ? (['log'] as const) : []), ...(options.login ? (['login'] as const) : [])];
    /** The sign-ins running (#484), one per environment: the request they answer and the relay to feed or end. */
    const logins = new Map<EnvironmentId, { readonly requestId: string; readonly relay: LoginRelay }>();
    const version = options.daemonVersion ?? DAEMON_VERSION;
    const build = { version, commit: DAEMON_COMMIT, protocol: V, channel: DAEMON_CHANNEL, platform: platformKey(platform, options.arch ?? process.arch) };

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
        for (const env of environments) {
            if (!next.has(env.id)) continue;
            const group = byRuntime.get(env.runtime);
            if (group) group.push(env);
            else byRuntime.set(env.runtime, [env]);
        }
        for (const [runtime, envs] of byRuntime) {
            const checkedAt = Date.now();
            let report: DoctorReport;
            try {
                report = await drivers.get(runtime)!.doctor(envs);
            } catch (e) {
                logger.warn('driver doctor failed', { runtime, error: e });
                const reason = withoutLocalPaths(e instanceof Error && e.message ? e.message : String(e));
                report = {
                    ok: false,
                    findings: [{ level: 'error', code: 'driver-doctor-failed', message: `the ${runtime} driver's checks failed: ${reason} — run \`agentic-daemon doctor\` on the machine for details`, environmentIds: envs.map((env) => env.id) }]
                };
            }
            for (const env of envs) nextVerdicts.set(env.id, environmentVerdict(report, env.id, checkedAt));
        }
        inspections = next;
        verdicts = nextVerdicts;
    }

    async function reinspect(): Promise<boolean> {
        // When a check ran is not a change; what it found is.
        const fingerprint = (): string => JSON.stringify(descriptors(), (key, value: unknown) => (key === 'checkedAt' ? undefined : value));
        const before = fingerprint();
        await inspectAll();
        const changed = fingerprint() !== before;
        if (changed && socket) send({ v: V, t: 'env', environments: descriptors(), policy: announcedPolicy() });
        return changed;
    }

    /**
     * Ask each environment's runtime which models its account may use (#453), one environment at a time, for those not
     * asked within `MODELS_REFRESH_MS`: a probe starts the runtime's CLI. A new list goes out as an `env` frame; a
     * failure keeps the last one (the web falls back to the runtime plugin's list without any).
     */
    async function refreshModels(): Promise<void> {
        if (modelsRunning) return;
        modelsRunning = true;
        try {
            let changed = false;
            for (const env of environments) {
                const driver = drivers.get(env.runtime);
                const known = models.get(env.id);
                if (!driver?.models || stopped || (known && Date.now() - known.at < MODELS_REFRESH_MS)) continue;
                let list: readonly ModelOption[] | null;
                try {
                    list = await driver.models(env);
                } catch (e) {
                    logger.warn('environment model list failed', { environment: env.id, error: e });
                    list = null;
                }
                if (!list) continue;
                changed ||= JSON.stringify(list) !== JSON.stringify(known?.list);
                models.set(env.id, { list, at: Date.now() });
            }
            if (changed && socket && !stopped) send({ v: V, t: 'env', environments: descriptors(), policy: announcedPolicy() });
        } finally {
            modelsRunning = false;
        }
    }

    function descriptors(): EnvironmentDescriptor[] {
        const out: EnvironmentDescriptor[] = [];
        for (const env of environments) {
            const inspection = inspections.get(env.id);
            if (!inspection) continue;
            // `concurrency.active` is what the budget counts: turns running, not sessions open (#394).
            out.push(toEnvironmentDescriptor(env, machineId, inspection, runningOn(env.id), verdicts.get(env.id), models.get(env.id)?.list));
        }
        return out;
    }

    function runtimeReports(): CapabilityReport[] {
        const byRuntime = new Map<string, CapabilityReport>();
        for (const inspection of inspections.values()) if (!byRuntime.has(inspection.capabilities.runtime)) byRuntime.set(inspection.capabilities.runtime, inspection.capabilities);
        // With the relay port, every report says whether its sign-in is relayed (#484); without it nothing is claimed.
        const login = options.login;
        return [...byRuntime.values()].map((r) => (login ? { ...r, login: login.relays(r.runtime) ? 'relay' : 'terminal' } : r));
    }

    // ------------------------------------------------------------------ socket

    function onOpen(next: Socket): void {
        socket = next;
        welcomed = false;
        const resume: Record<string, Cursor> = {};
        // The later of the served head and what was last sent: the served head (and the log behind it) advances
        // only as appends reach disk, so it can trail frames already on the wire.
        for (const s of sessions.values()) resume[s.id] = cursorBefore(headOf(s), s.lastSent) ? s.lastSent : headOf(s);
        send({
            v: V,
            t: 'hello',
            machineId,
            daemonVersion: version,
            os: options.os ?? osOf(platform),
            environments: descriptors(),
            capabilities: runtimeReports(),
            resume,
            policy: announcedPolicy(),
            build,
            features,
            ...options.lifecycle,
            ...(options.harnesses ? { harnesses: options.harnesses.store.reports(drivers.keys()) } : {})
        });
    }

    function onClose(): void {
        socket = undefined;
        welcomed = false;
        // A sign-in with nobody to show it to is ended (#484): the code it printed is bound to that child.
        for (const login of logins.values()) login.relay.cancel();
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
            case 'fs.request':
                void fsRequest(frame);
                return;
            case 'env.request':
                void envRequest(frame);
                return;
            case 'history.request':
                void historyRequest(frame);
                return;
            case 'update.request':
                if (updater) updater.request(frame);
                else send({ v: V, t: 'update.status', requestId: frame.requestId, phase: 'failed', error: { code: 'unsupported', message: 'this daemon does not run under the supervisor; reinstall it to update from the platform' } });
                return;
            case 'update.cancel':
                updater?.cancel(frame.requestId);
                return;
            case 'harness.request':
                void harnessRequest(frame);
                return;
            case 'policy.request':
                void policyRequest(frame);
                return;
            case 'log.request':
                void logRequest(frame);
                return;
            case 'login.request':
                void loginRequest(frame);
                return;
            case 'login.answer': {
                const login = [...logins.values()].find((l) => l.requestId === frame.requestId);
                // Never logged, never kept: straight to the runtime.
                login?.relay.answer(frame.text);
                return;
            }
            case 'login.cancel': {
                const login = [...logins.values()].find((l) => l.requestId === frame.requestId);
                login?.relay.cancel();
                return;
            }
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
            heartbeat = setInterval(() => {
                send({ v: V, t: 'heartbeat', at: Date.now(), active: [...sessions.keys()] });
                void tickTelemetry();
            }, heartbeatMs);
        }
        quota.welcomed();
        void refreshModels();
        options.onWelcome?.();
    }

    // ---------------------------------------------------------------- sessions

    function stopPump(s: LiveSession): void {
        s.pump?.abort();
        s.pump = undefined;
    }

    /**
     * The runtime named (or renamed) its session since the platform last heard: `session.ref` (#389). Read after every
     * frame the pump sends — the Claude Code adapter's `ref` is a live getter that takes the CLI's id with the first
     * stream event — and never tied to `turn-end`: a turn that errors before it ends still named the session.
     */
    function reportRef(s: LiveSession): void {
        const ref = s.session.ref;
        if (sameRefIdentity(ref, s.sentRef)) return;
        if (send({ v: V, t: 'session.ref', sessionId: s.id, ref })) s.sentRef = ref;
    }

    /** The runtime's title moved on since the platform last heard: `session.title` (#460). */
    function reportTitle(s: LiveSession): void {
        const title = s.knownTitle;
        if (title === undefined || title === s.sentTitle) return;
        if (send({ v: V, t: 'session.title', sessionId: s.id, title })) s.sentTitle = title;
    }

    /**
     * Ask the driver what the runtime calls the conversation (#460) — after every turn, off the served stream, so a
     * title lands even while the platform is away; and once more `TITLE_RECHECK_MS` later when the turn brought no new
     * one, since a CLI titles from a background call that a short first turn can outrun. Never fails the session.
     */
    async function probeTitle(s: LiveSession, recheck = true): Promise<void> {
        if (!s.title || !sessions.has(s.id)) return;
        // This probe supersedes a re-probe still pending from the last turn.
        clearTimeout(s.titleRecheck);
        s.titleRecheck = undefined;
        let title: string | undefined;
        try {
            title = await s.title();
        } catch (e) {
            logger.warn('session: title probe failed', { session: s.id, error: e });
            return;
        }
        const changed = title !== undefined && title !== s.knownTitle;
        if (changed) s.knownTitle = title;
        reportTitle(s);
        if (!changed && recheck && sessions.has(s.id)) {
            s.titleRecheck = setTimeout(() => void probeTitle(s, false), titleRecheckMs);
            s.titleRecheck.unref?.();
        }
    }

    function startPump(s: LiveSession, from: Cursor): void {
        stopPump(s);
        const controller = new AbortController();
        s.pump = controller;
        void (async () => {
            let last = from;
            try {
                // A pump starts on `welcome`: after a reconnect this is where a ref learned while the socket was down goes out.
                reportRef(s);
                reportTitle(s);
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
                        if (cursorBefore(s.tapped, at)) {
                            s.tapped = at;
                            quota.observe(s.environmentId, frame.event);
                        }
                    } else if (frame.kind === 'gap') last = frame.resumeAt;
                    if (!send({ v: V, t: 'session.frame', sessionId: s.id, frame })) return;
                    s.lastSent = last;
                    reportRef(s);
                    // The turn is on disk whole: apply retention now, when a cut can land on a turn boundary (#397).
                    if (frame.kind === 'event' && frame.event.type === 'turn-end') void retainLog(s.id);
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
            send({ v: V, t: 'session.opened', sessionId, ref: existing.session.ref, capabilities: existing.capabilities, head: headOf(existing) });
            return;
        }
        if (opening.has(sessionId)) return;
        const refuse = (reason: string, code?: SessionClosedCode) => {
            logger.warn('session: open refused', { session: sessionId, environment: environmentId, reason, ...(code ? { code } : {}) });
            send({ v: V, t: 'session.closed', sessionId, reason, ...(code ? { code } : {}) });
        };
        const env = environments.find((e) => e.id === environmentId);
        if (!env) return refuse(`unknown environment ${environmentId}`);
        const driver = drivers.get(env.runtime);
        if (!driver) return refuse(`no driver for runtime ${env.runtime} on this machine`);
        const drainingFor = draining.get(env.runtime);
        if (drainingFor !== undefined) return refuse(drainingFor, 'draining');
        // Turns in flight, never sessions open (#394): a live chat session costs nothing until it is prompted.
        const running = runningOn(env.id);
        if (running >= env.concurrency) return refuse(`environment ${env.name} is at capacity (${env.concurrency}): ${running} turn${running === 1 ? '' : 's'} running`);

        opening.set(sessionId, env.id);
        try {
            // Lexically, then with symlinks resolved: neither `..` nor a link or junction leaves the roots.
            const where = await checkWithinRoots(spec.cwd, env.cwdRoots, platform);
            if (!where.ok) return refuse(where.code === 'not-found' ? `cwd ${spec.cwd} does not exist` : `cwd is outside the environment's cwdRoots`);
            // The agent's rules, grants and the ancestors' constraints, compiled here exactly as the platform compiles them (AC-12).
            const policy = spec.policy ? sessionPolicyOf(spec.policy) : undefined;
            let opened: Awaited<ReturnType<DaemonDriver['open']>>;
            try {
                opened = await driver.open(env, spec, { sessionId, callTool: (tool, input) => callTool(sessionId, tool, input), ...(policy ? { policy } : {}) });
            } catch (e) {
                // No harness for the runtime (#369): named, so the platform can say what to install.
                if ((e as { code?: unknown }).code === 'harness-missing') return refuse((e as Error).message, 'harness-missing');
                // A runtime that cannot take the conversation back says so by code (#363); the platform then starts it fresh (#420).
                if (spec.resume !== undefined) return refuse(`the runtime could not resume the session: ${(e as Error).message}`, 'resume-failed');
                throw e;
            }
            if (stopped) {
                await opened.session.close().catch(() => {});
                return;
            }
            // Logged under the platform's session id: the runtime names its sessions its own way. A re-open appends to the same log.
            const served = serveSession(opened.session, { agentId: spec.agentId, capabilities: agentCapabilitiesOf(opened.capabilities), eventLog: log.forSession(sessionId) });
            // `session.opened` carries whatever the runtime calls the session before its first prompt — a placeholder for a CLI.
            // The platform records none of it; the id a resume needs travels as `session.ref` once the runtime reports it (#389).
            const ref = opened.session.ref;
            const base = spec.resume !== undefined ? await reopenedBase(sessionId, ref) : served.head;
            const live: LiveSession = { id: sessionId, environmentId: env.id, runtime: env.runtime, session: opened.session, served, capabilities: opened.capabilities, base, sentRef: ref, ...(opened.title ? { title: opened.title } : {}), ...(opened.pid ? { pid: opened.pid } : {}), lastSent: base, tapped: base, pump: undefined, running: false, turns: new AbortController() };
            sessions.set(sessionId, live);
            watchTurns(live);
            logger.info('session: opened', { session: sessionId, environment: env.id, runtime: env.runtime, ...(spec.resume !== undefined ? { resumedAt: base } : {}) });
            send({ v: V, t: 'session.opened', sessionId, ref, capabilities: opened.capabilities, head: headOf(live) });
            if (welcomed) startPump(live, served.head);
            // A re-opened conversation may be titled already (#460); a fresh one has nothing to read before its first turn.
            if (spec.resume !== undefined) void probeTitle(live, false);
        } catch (e) {
            refuse(`the runtime could not open a session: ${(e as Error).message}`);
        } finally {
            opening.delete(sessionId);
        }
    }

    /**
     * Where a re-opened session starts (#363). `serveSession` starts every session at `(0, 0)` and offers no seam to seed
     * it, but a resumed runtime stamps a later epoch: the one its ref names (`data.epoch`, which every driver reports), or
     * else the one after the log's. `(epoch, 0)` continues after the log's head, and the runtime's first event follows it.
     */
    async function reopenedBase(sessionId: SessionId, ref: SessionRef): Promise<Cursor> {
        const logged = await log.head(sessionId).catch(() => undefined);
        const epoch = refEpoch(ref);
        if (typeof epoch !== 'number') return { epoch: (logged?.epoch ?? 0) + 1, seq: 0 };
        if (logged && epoch <= logged.epoch) logger.warn('session: resumed on an epoch the log already holds', { session: sessionId, epoch, logged });
        return { epoch, seq: 0 };
    }

    // -------------------------------------------------------------- folders

    async function fsRequest(frame: PlatformFrameOf<'fs.request'>): Promise<void> {
        const outcome = await answerFsRequest(environments, frame.environmentId, frame.op, { platform, logger });
        send({ v: V, t: 'fs.response', requestId: frame.requestId, ...outcome });
    }

    // -------------------------------------------------------------- history

    /**
     * A history slice out of the session's log (#397), live session or not: the log outlives the process, so a daemon
     * restarted since still answers for a session it no longer runs. What the log lost to retention is a named `gap`.
     */
    async function historyRequest(frame: PlatformFrameOf<'history.request'>): Promise<void> {
        let answer: Extract<DaemonFrame, { t: 'history.response' }>;
        try {
            const slice = await log.slice(frame.sessionId, { from: frame.from, ...(frame.to ? { to: frame.to } : {}), ...(frame.limit !== undefined ? { limit: frame.limit } : {}) }, { maxBytes: HISTORY_RESPONSE_BYTES });
            answer =
                'error' in slice
                    ? { v: V, t: 'history.response', requestId: frame.requestId, error: slice.error }
                    : {
                          v: V,
                          t: 'history.response',
                          requestId: frame.requestId,
                          result: { events: slice.result.events.map((event): WireFrame => ({ v: W, kind: 'event', epoch: event.epoch, seq: event.seq, event })), ...(slice.result.more ? { more: true } : {}) }
                      };
        } catch (e) {
            logger.warn('session: history read failed', { session: frame.sessionId, error: e });
            answer = { v: V, t: 'history.response', requestId: frame.requestId, error: { code: 'internal', message: 'the session log could not be read; see the daemon log' } };
        }
        send(answer);
    }

    /** Trim a session's log to the retention policy; a failure is logged, the stream is not touched. */
    async function retainLog(sessionId: SessionId): Promise<void> {
        try {
            const keepFrom = await log.retain(sessionId, retention);
            if (keepFrom) logger.info('session: log trimmed', { session: sessionId, keepFrom, maxBytes: retention.maxBytes });
        } catch (e) {
            logger.warn('session: log retention failed', { session: sessionId, error: e });
        }
    }

    // ---------------------------------------------------------- environments

    /** Sessions hosted or opening on an environment — what removing it is refused over (the platform closes idle ones first, #394). */
    const hostedOn = (environmentId: EnvironmentId): number => [...sessions.values()].filter((s) => s.environmentId === environmentId).length + [...opening.values()].filter((id) => id === environmentId).length;
    /** Turns running on an environment: what `concurrency` bounds (#394), and what makes it busy for the quota probe. */
    const runningOn = (environmentId: EnvironmentId): number => [...sessions.values()].filter((s) => s.environmentId === environmentId && s.running).length;

    /**
     * Keep `running` true to the turn, off the served stream (#394): `turn-start` marks it (a steered or resumed turn
     * included), `turn-end` clears it. Independent of the socket pump, which only runs while the platform is welcomed
     * and restarts from the platform's cursor — a `turn-end` that went out before a drop would never pass it again.
     */
    function watchTurns(s: LiveSession): void {
        void (async () => {
            try {
                for await (const frame of s.served.events(s.served.head, { signal: s.turns.signal })) {
                    if (s.turns.signal.aborted) return;
                    if (frame.kind !== 'event') continue;
                    if (frame.event.type === 'turn-start') s.running = true;
                    else if (frame.event.type === 'turn-end') {
                        s.running = false;
                        void probeTitle(s);
                    }
                }
            } catch (e) {
                if (!s.turns.signal.aborted) logger.warn('session: turn watch failed', { session: s.id, error: e });
            }
        })();
    }

    /**
     * One at a time and in order with every other change to the environments:
     * the answer reads, changes and writes `environments.json`. The `env` frame
     * with the new descriptors goes out before `env.response`.
     */
    function envRequest(frame: PlatformFrameOf<'env.request'>): Promise<void> {
        return serial(async () => {
            const op = frame.op === 'put' ? { op: 'put' as const, environment: frame.environment } : { op: 'remove' as const, environmentId: frame.environmentId };
            const outcome = options.manage
                ? await answerEnvRequest(op, { paths: options.manage.paths, policy, runtimes: new Set(drivers.keys()), activeOn: hostedOn, platform, logger, ...(options.manage.secure ? { secure: options.manage.secure } : {}) })
                : { error: { code: 'policy-disabled' as const, message: 'this daemon does not manage its environments from the platform' } };
            if ('result' in outcome) {
                environments = outcome.environments;
                await inspectAll();
                send({ v: V, t: 'env', environments: descriptors(), policy: announcedPolicy() });
                send({ v: V, t: 'env.response', requestId: frame.requestId, result: outcome.result });
                quota.environmentsChanged();
            } else {
                logger.info('env: request refused', { code: outcome.error.code });
                send({ v: V, t: 'env.response', requestId: frame.requestId, error: outcome.error });
            }
        }).catch((e: unknown) => {
            logger.error('env: request failed', { error: e });
            send({ v: V, t: 'env.response', requestId: frame.requestId, error: { code: 'io', message: 'the machine could not answer; see the daemon log' } });
        });
    }

    /**
     * `policy.request` (#355): a `set` goes through the port one at a time with every other change to the environments
     * and the policy; the `env` frame carrying the policy as applied goes out before `policy.response`. A `browse` reads
     * only and needs no turn.
     */
    function policyRequest(frame: PlatformFrameOf<'policy.request'>): Promise<void> {
        const answer = (outcome: { readonly result?: DaemonFrameOf<'policy.response'>['result']; readonly error?: MachinePolicyError }) => send({ v: V, t: 'policy.response', requestId: frame.requestId, ...outcome });
        const port = options.webPolicy;
        if (!port) {
            answer({ error: { code: 'unsupported', message: 'this daemon does not take its policy from the platform' } });
            return Promise.resolve();
        }
        const run =
            frame.op === 'browse'
                ? async () => {
                      const outcome = await port.browse(frame.path);
                      answer('listing' in outcome ? { result: { listing: outcome.listing } } : { error: outcome.error });
                  }
                : () =>
                      serial(async () => {
                          const outcome = await port.apply(frame.policy);
                          if ('policy' in outcome) {
                              policy = outcome.policy;
                              send({ v: V, t: 'env', environments: descriptors(), policy: announcedPolicy() });
                              answer({ result: { policy: announcedPolicy() } });
                          } else {
                              logger.info('policy: request refused', { code: outcome.error.code });
                              answer({ error: outcome.error });
                          }
                      });
        return run().catch((e: unknown) => {
            logger.error('policy: request failed', { error: e });
            answer({ error: { code: 'io', message: 'the machine could not answer; see the daemon log' } });
        });
    }

    /** `log.request` (#481): the tail of the daemon's own log through the port `cli.ts` injects; reads only, no turn. */
    async function logRequest(frame: PlatformFrameOf<'log.request'>): Promise<void> {
        const answer = (outcome: { readonly result?: DaemonLogResult; readonly error?: DaemonLogError }) => send({ v: V, t: 'log.response', requestId: frame.requestId, ...outcome });
        if (!options.logTail) return void answer({ error: { code: 'unsupported', message: 'this daemon does not serve its log' } });
        try {
            answer(await options.logTail(frame.lines));
        } catch (e) {
            logger.error('log: request failed', { error: e });
            answer({ error: { code: 'io', message: 'the machine could not read its log; see the daemon log' } });
        }
    }

    /**
     * `login.request` (#484): the runtime's own sign-in for the environment's profile, relayed phase by phase —
     * `started`, the `action` the person must take, `waiting`, then `done` (the child exited 0) or `failed`. One per
     * environment at a time (`busy`); an environment the machine lacks is `unknown-environment`; no port, or a runtime
     * the port cannot relay, is `unsupported`. After `done` the environment is inspected again at once and an `env`
     * frame carries the account as it is now.
     */
    async function loginRequest(frame: PlatformFrameOf<'login.request'>): Promise<void> {
        const { requestId, environmentId } = frame;
        const status = (phase: 'started' | 'action' | 'waiting' | 'done' | 'failed', extra: { readonly action?: LoginAction; readonly error?: LoginError } = {}) => send({ v: V, t: 'login.status', requestId, environmentId, phase, ...extra });
        const environment = environments.find((e) => e.id === environmentId);
        if (!environment) return void status('failed', { error: { code: 'unknown-environment', message: `this machine has no environment ${environmentId}` } });
        if (logins.has(environmentId)) return void status('failed', { error: { code: 'busy', message: `a sign-in is already running for ${environment.name}` } });
        const relay = options.login?.start(environment) ?? null;
        if (!relay) return void status('failed', { error: { code: 'unsupported', message: `${environment.runtime} cannot be signed in from the web on this machine; sign in on the machine itself: agentic-daemon env login ${environmentId}` } });
        logins.set(environmentId, { requestId, relay });
        status('started');
        logger.info('login: started', { environment: environmentId, runtime: environment.runtime });
        try {
            for await (const event of relay.events) {
                switch (event.phase) {
                    case 'action':
                        status('action', { action: event.action });
                        break;
                    case 'waiting':
                        status('waiting');
                        break;
                    case 'failed':
                        logger.warn('login: failed', { environment: environmentId, code: event.error.code });
                        status('failed', { error: event.error });
                        break;
                    case 'done':
                        logger.info('login: done', { environment: environmentId });
                        status('done');
                        break;
                }
            }
        } catch (e) {
            logger.error('login: relay failed', { environment: environmentId, error: e });
            status('failed', { error: { code: 'failed', message: 'the sign-in ended unexpectedly; see the daemon log' } });
        } finally {
            if (logins.get(environmentId)?.requestId === requestId) logins.delete(environmentId);
        }
        // Signed in or not, the account is what it is now: inspected again without waiting for the half-minute tick.
        try {
            await inspectAll();
            send({ v: V, t: 'env', environments: descriptors(), policy: announcedPolicy() });
        } catch (e) {
            logger.warn('login: re-inspect failed', { environment: environmentId, error: e });
        }
    }

    async function command(frame: PlatformFrameOf<'session.command'>): Promise<void> {
        const { sessionId } = frame;
        const s = sessions.get(sessionId);
        if (!s) {
            send({ v: V, t: 'session.reply', sessionId, reply: { v: frame.command.v, kind: 'error', commandId: frame.command.commandId, code: 'closed', message: 'no such session on this machine' } });
            return;
        }
        const { command } = frame;
        // A prompt that would start a turn beyond the environment's concurrency is answered `busy` (#394): the platform
        // parks its task and prompts again when a turn ends here. A session already running one is left to the runtime
        // (a steer, or its own `busy`). The slot is taken before the reply is known so two prompts cannot share it.
        const starts = command.type === 'prompt' && !s.running;
        if (starts) {
            // Draining for an update (#364): no new turns; the platform parks the task and prompts again, as for `busy`.
            if (updater?.draining) {
                send({ v: V, t: 'session.reply', sessionId, reply: drainingReply(command.commandId) });
                return;
            }
            // The runtime's harness is being changed (#369): no new turn on it; the platform parks the prompt and sends it again.
            const drainingFor = draining.get(s.runtime);
            if (drainingFor !== undefined) {
                send({ v: V, t: 'session.reply', sessionId, reply: drainingReply(command.commandId, drainingFor) });
                return;
            }
            const env = environments.find((e) => e.id === s.environmentId);
            const running = runningOn(s.environmentId);
            if (env && running >= env.concurrency) {
                send({ v: V, t: 'session.reply', sessionId, reply: { v: command.v, kind: 'error', commandId: command.commandId, code: 'busy', message: `environment ${env.name} is at capacity (${env.concurrency}): ${running} turn${running === 1 ? '' : 's'} running` } });
                return;
            }
            s.running = true;
        }
        const reply = await s.served.handleCommand(command);
        if (starts && reply.kind !== 'ack') s.running = false;
        send({ v: V, t: 'session.reply', sessionId, reply });
        if (command.type === 'close' && reply.kind === 'ack') await closeSession(sessionId, 'closed by command');
    }

    async function closeSession(sessionId: SessionId, reason: string, code?: SessionClosedCode): Promise<void> {
        const s = sessions.get(sessionId);
        if (!s) return;
        sessions.delete(sessionId);
        stopPump(s);
        s.turns.abort();
        clearTimeout(s.titleRecheck);
        s.running = false;
        for (const [callId, pending] of pendingTools) {
            if (pending.frame.sessionId !== sessionId) continue;
            pendingTools.delete(callId);
            clearTimeout(pending.timer);
            pending.reject(new PlatformToolError('closed', 'the session closed'));
        }
        await s.served.close().catch((e: unknown) => logger.warn('session: serve close failed', { session: sessionId, error: e }));
        await s.session.close().catch((e: unknown) => logger.warn('session: close failed', { session: sessionId, error: e }));
        await log.flush(sessionId);
        logger.info('session: closed', { session: sessionId, reason, ...(code ? { code } : {}) });
        send({ v: V, t: 'session.closed', sessionId, reason, ...(code ? { code } : {}) });
    }

    // ------------------------------------------------------------- harnesses

    /**
     * `harness.request` (#369), one at a time. `install` / `update`: the store downloads, verifies and unpacks the target
     * beside the current version (`downloading`, `verifying`, `staged`); then only this runtime drains (`draining`) —
     * `drain` waits for its running turns up to `drainTimeoutMs`, `now` does not — and `applying` closes its sessions with
     * code `harness-update` (the same close as `stop`), disposes its driver, switches `current.json`, rebuilds the driver
     * and removes the old version. `remove` is refused `in-use` while an environment runs on the runtime. Each change ends
     * with `done` and a `harnesses` frame, or `failed` with a named error.
     */
    /**
     * The heal (#369), queued with the harness requests: every selected runtime this daemon has a driver for whose harness
     * is not ready is installed from `heal.manifestUrl` — stage, activate, driver rebuilt — and a `harnesses` frame goes
     * out after each. Until then `session.open` on it is refused `harness-missing`. A failure is logged and recorded in
     * the store (`doctor` shows it), and the next start tries again; it never stops the daemon.
     */
    function heal(manifestUrl: string): Promise<void> {
        const harness = options.harnesses!;
        const run = harnessWork.then(async () => {
            const missing = harness.store.selected().filter((runtime) => drivers.has(runtime) && harness.store.state(runtime).status !== 'ready');
            if (missing.length === 0 || stopped) return;
            logger.info('harness: installing the selected harnesses this machine lacks', { runtimes: missing, manifest: manifestUrl });
            const fail = async (runtime: string, message: string) => {
                logger.warn('harness: install failed; retried on the next start', { runtime, error: message });
                await harness.store.setFailure(runtime, message).catch(() => undefined);
            };
            let manifest: Awaited<ReturnType<typeof fetchReleaseManifest>>;
            try {
                manifest = await fetchReleaseManifest(manifestUrl, harness.fetch ?? fetch);
            } catch (e) {
                for (const runtime of missing) await fail(runtime, (e as Error).message);
                return;
            }
            for (const runtime of missing) {
                if (stopped) return;
                const asset = harnessAsset(manifest, runtime, harness.store.platform);
                if (!asset) {
                    await fail(runtime, `the release ${manifest.version} ships no ${runtime} harness for ${harness.store.platform}`);
                    continue;
                }
                try {
                    const staged = await harness.store.stage(runtime, asset, harness.fetch ? { fetch: harness.fetch } : {});
                    if (!staged.already) await swapDriver(runtime, () => harness.store.activate(runtime, staged.version));
                    await harness.store.setFailure(runtime, undefined).catch(() => undefined);
                    logger.info('harness: installed', { runtime, version: staged.version, healed: true });
                    if (socket) send({ v: V, t: 'harnesses', harnesses: harness.store.reports(drivers.keys()) });
                } catch (e) {
                    await fail(runtime, (e as Error).message);
                }
            }
        });
        harnessWork = run.catch(() => undefined);
        return run;
    }

    function harnessRequest(frame: PlatformFrameOf<'harness.request'>): Promise<void> {
        const run = harnessWork.then(() => changeHarness(frame));
        harnessWork = run.catch(() => undefined);
        return run;
    }

    async function changeHarness(frame: PlatformFrameOf<'harness.request'>): Promise<void> {
        const { requestId, runtime } = frame;
        const status = (phase: HarnessPhase, error?: LifecycleError) => send({ v: V, t: 'harness.status', requestId, phase, ...(error ? { error } : {}) });
        const fail = (code: string, message: string) => {
            logger.warn('harness: request failed', { runtime, op: frame.op, code, message });
            status('failed', { code, message });
        };
        const harness = options.harnesses;
        if (!harness) return fail('unsupported', 'this daemon does not manage harnesses');
        if (!drivers.has(runtime)) return fail('invalid', `this daemon has no driver for runtime ${runtime}`);
        try {
            if (frame.op === 'remove') {
                const users = environments.filter((e) => e.runtime === runtime);
                if (users.length > 0) return fail('in-use', `environment${users.length === 1 ? '' : 's'} ${users.map((e) => e.name).join(', ')} run${users.length === 1 ? 's' : ''} on ${runtime}; remove ${users.length === 1 ? 'it' : 'them'} first`);
                if (harness.store.state(runtime).status !== 'broken' && harness.store.locate(runtime)?.source !== 'store') return fail('not-installed', `${runtime} has no harness installed in ${harness.store.root}`);
                status('applying');
                await swapDriver(runtime, () => harness.store.remove(runtime));
            } else {
                const { target } = frame;
                if (!target) return fail('invalid', `${frame.op} names no target`);
                const staged = await harness.store.stage(runtime, target, { onPhase: (phase) => status(phase), ...(harness.fetch ? { fetch: harness.fetch } : {}) });
                if (!staged.already) {
                    const detail = `the ${runtime} harness is being updated to ${staged.version}`;
                    draining.set(runtime, detail);
                    try {
                        if (liveOn(runtime).length > 0) {
                            status('draining');
                            if (frame.mode === 'drain') await turnsEnded(runtime, harness.drainTimeoutMs ?? HARNESS_DRAIN_TIMEOUT_MS);
                        }
                        status('applying');
                        const { reason, code } = STOP_CLOSES['harness-update'];
                        for (const s of liveOn(runtime)) await closeSession(s.id, reason, code);
                        await swapDriver(runtime, () => harness.store.activate(runtime, staged.version));
                    } finally {
                        draining.delete(runtime);
                    }
                    const leftovers = await harness.store.prune(runtime);
                    if (leftovers.length) logger.warn('harness: old versions could not be removed', { runtime, leftovers });
                }
                logger.info('harness: installed', { runtime, version: staged.version, ...(staged.already ? { already: true } : {}) });
            }
        } catch (e) {
            if (e instanceof HarnessError) return fail(e.code, e.message);
            logger.error('harness: request failed', { runtime, error: e });
            return fail('io', `the harness change failed: ${(e as Error).message}`);
        }
        status('done');
        send({ v: V, t: 'harnesses', harnesses: harness.store.reports(drivers.keys()) });
    }

    /** Live sessions on `runtime`. */
    const liveOn = (runtime: string): LiveSession[] => [...sessions.values()].filter((s) => s.runtime === runtime);

    /** Until no turn runs on `runtime`, or `timeoutMs` passes. */
    async function turnsEnded(runtime: string, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!stopped && liveOn(runtime).some((s) => s.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
    }

    /** Dispose `runtime`'s driver, change the store, build the driver again and announce its environments when what they report changed. */
    async function swapDriver(runtime: string, change: () => Promise<unknown>): Promise<void> {
        const old = drivers.get(runtime) as (DaemonDriver & { dispose?: () => Promise<void> }) | undefined;
        if (typeof old?.dispose === 'function') await old.dispose().catch((e: unknown) => logger.warn('harness: driver dispose failed', { runtime, error: e }));
        try {
            await change();
        } finally {
            const next = options.harnesses!.rebuild(runtime);
            if (next) drivers.set(runtime, next);
            else drivers.delete(runtime);
            await serial(reinspect);
        }
    }

    /**
     * A wanted session this daemon no longer runs: replay what its log holds, then say it is gone — with code `restart`
     * when its log shows this machine ran it (the daemon restarted since, #363), so the platform re-opens it from its ref.
     */
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
        send({ v: V, t: 'session.closed', sessionId, ...(known ? { reason: 'the session is no longer running on this machine (daemon restarted)', code: 'restart' as const } : { reason: 'unknown session' }) });
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
            await updater?.start();
            if (options.harnesses?.heal) void heal(options.harnesses.heal.manifestUrl).catch((e: unknown) => logger.warn('harness: heal failed', { error: e }));
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
            quota.start();
            if (reinspectMs > 0) {
                let pending = false;
                reinspectTimer = setInterval(() => {
                    // Only while something is not signed in (a healthy machine is left alone), and never two queued.
                    if (stopped || pending || ![...inspections.values()].some((i) => i.authStatus !== 'ok')) return;
                    pending = true;
                    void serial(reinspect)
                        .catch((e: unknown) => logger.warn('environment re-inspection failed', { error: e }))
                        .finally(() => (pending = false));
                }, reinspectMs);
                reinspectTimer.unref?.();
            }
        },
        async stop(stopOptions) {
            stopped = true;
            quota.stop();
            updater?.stop();
            for (const login of logins.values()) login.relay.cancel();
            if (reinspectTimer !== undefined) clearInterval(reinspectTimer);
            reinspectTimer = undefined;
            // While the socket is still up: each session closes with the code its reason maps to (#363).
            const { reason, code } = STOP_CLOSES[stopOptions?.reason ?? 'stop'];
            for (const id of sessions.keys()) await closeSession(id, reason, code);
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
        setEnvironments(next) {
            return serial(async () => {
                environments = next;
                await inspectAll();
                if (socket) send({ v: V, t: 'env', environments: descriptors(), policy: announcedPolicy() });
                quota.environmentsChanged();
            });
        },
        setPolicy(next) {
            return serial(async () => {
                policy = next;
                if (socket) send({ v: V, t: 'env', environments: descriptors(), policy: announcedPolicy() });
            });
        },
        reinspect: () => serial(reinspect),
        get environments() {
            return environments;
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
