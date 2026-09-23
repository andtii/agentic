/**
 * The daemon <-> platform envelope (architecture §5b). One hibernatable
 * WebSocket per machine carries control verbs, per-session wire traffic and
 * tool callbacks.
 *
 * Generic over the session wire types so this package stays dependency-free:
 * `F` is a served session's frame (`WireFrame` from `@sigx/ai-agent/wire`),
 * `R` its reply, `C` a command. `@agentic/daemon-protocol` instantiates them.
 */

import type { HarnessPhase, HarnessReport, ReleaseAsset, UpdatePhase } from './release.js';
import type { ApprovalRule, CapabilityReport, DaemonLogError, DaemonLogResult, EnvError, EnvironmentDescriptor, EnvironmentId, EnvOp, EnvResult, FsError, FsOp, FsResult, LoginAction, LoginError, LoginPhase, MachineId, MachinePolicy, MachinePolicyError, MachinePolicyOp, MachinePolicyResult, MachineTelemetry, QuotaSnapshot, RuntimeId, SessionId, ToolGrant } from './index.js';

export const DAEMON_PROTOCOL_VERSION = 1 as const;

/** What a daemon build is (#359): its version, the commit it was built from, the protocol it speaks, its release channel and the platform it was packaged for. */
export interface DaemonBuild {
    readonly version: string;
    readonly commit: string;
    readonly protocol: number;
    readonly channel: string;
    /** The release asset key this build was packaged for, `<platform>-<arch>` as Node names them, e.g. `win32-x64`, `darwin-arm64`, `linux-x64`. */
    readonly platform: string;
}

/**
 * Optional frame families a daemon answers (#359). The platform sends `update.*` / `harness.*` only to a daemon whose
 * `hello.features` lists the feature; an older daemon drops a frame it cannot decode and keeps the socket. `policy`
 * (`policy.request`, #355), `log` (`log.request`) and `login` (`login.*`) follow the same rule; a restart from the web
 * is an `update.request { target: 'restart' }` and rides `update`. `files` (#559) is the read-only `fs.request` kinds
 * `tree`, `read` and `changes` over a session's folder.
 */
export type DaemonFeature = 'update' | 'harness' | 'policy' | 'log' | 'login' | 'files';

/**
 * Why the host ended a session (#359), beside the human `reason`: the reason is for people, the code for the platform,
 * which decides from it whether the session is re-opened from its last `session.ref`.
 */
export type SessionClosedCode = 'restart' | 'update' | 'harness-update' | 'draining' | 'harness-missing' | 'resume-failed';

/** How a daemon last stopped, as it reports on `hello`. */
export interface DaemonExit {
    readonly at: number;
    readonly reason: string;
    readonly code?: number;
}

/** The last self-update a daemon attempted, as it reports on `hello`. */
export interface DaemonUpdateOutcome {
    readonly from: string;
    readonly to: string;
    readonly outcome: 'applied' | 'rolled-back';
    readonly at: number;
    readonly error?: string;
}

/** What the platform tells a daemon on `welcome` (#359): its own version, the oldest daemon it serves, and the current releases. */
export interface PlatformInfo {
    readonly version: string;
    readonly minDaemonVersion?: string;
    readonly latest?: { readonly stable?: string; readonly latest?: string };
}

/** Why an update or a harness change failed, named. */
export interface LifecycleError {
    readonly code: string;
    readonly message: string;
}

/** Position in a session's event log; replay is gapless from here. */
export interface Cursor {
    readonly epoch: number;
    readonly seq: number;
}

/**
 * The approval policy a daemon compiles for a session (`sessionPolicy` in
 * `@agentic/runtimes`; OPS-02, COL-10, AC-12): the agent's `approvalPolicy`
 * rules and its tool grants, plus — on a delegated task — the rules of every
 * ancestor's agent as `constraints`, so a child on the daemon path is never
 * wider than the chain above it. Plain JSON: it travels in `session.open`.
 */
export interface OpenSpecPolicy {
    readonly rules: readonly ApprovalRule[];
    readonly grants: readonly ToolGrant[];
    readonly constraints?: readonly ApprovalRule[];
}

/**
 * Where a connector's credentials go — secret NAMES only, never values (#280;
 * decisions 2026-09-19 (a)). The daemon asks the platform for the values when
 * it opens the session (`CONNECTOR_CREDENTIALS_TOOL`).
 */
export interface OpenSpecConnectorAuth {
    /** The name of the secret whose value is sent as the bearer token of the `Authorization` header (Streamable HTTP). */
    readonly bearer?: string;
    /** Header name → secret name (Streamable HTTP). */
    readonly headers?: Readonly<Record<string, string>>;
    /** Environment variable → secret name (stdio). */
    readonly env?: Readonly<Record<string, string>>;
}

/**
 * An MCP connector the daemon opens for one session (#280, architecture §9):
 * a ready connector of the agent's, as the platform's gate found it. Its tools
 * reach the runtime as `<namespace>__<tool>`, the namespace being the id made
 * tool-safe (`.` → `_`). Plain JSON with no credential VALUE in it: the
 * platform keeps the spec and re-sends it after a reconnect.
 */
export interface OpenSpecConnector {
    readonly id: string;
    readonly transport: 'streamable-http' | 'stdio';
    /** Streamable HTTP endpoint. */
    readonly url?: string;
    /** Stdio: the executable and its arguments. */
    readonly command?: string;
    readonly args?: readonly string[];
    /** Stdio: where it runs — inside the environment's `cwdRoots`; the session's `cwd` when absent. */
    readonly cwd?: string;
    readonly auth?: OpenSpecConnectorAuth;
}

/**
 * The `tool.call` a daemon makes on its own — never offered to the model — for
 * a connector's credential VALUES while it opens a session (#280; EXE-10).
 * Input `{ connectorId }`, output `ConnectorCredentials`. The platform answers
 * only for a connector the calling session's spec names, opens each secret
 * under the connector plugin's own grants, and records no value; the daemon
 * holds the values in memory for that session only, never logging or writing
 * them.
 */
export const CONNECTOR_CREDENTIALS_TOOL = 'connector_credentials';

/** The answer to `CONNECTOR_CREDENTIALS_TOOL`: the values, keyed as in `OpenSpecConnectorAuth`. */
export interface ConnectorCredentials {
    readonly bearer?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly env?: Readonly<Record<string, string>>;
}

/**
 * The `tool.call` a daemon makes on its own — never offered to the model — while it opens a session, for the tools of
 * the connectors that run on the PLATFORM (#534: conduit connectors, decisions 2026-09-23). Input `{}`, output
 * `PlatformConnectorTools`. The platform answers from the calling session's recorded gate, with declarations only —
 * no credential, no account id. A platform that predates it answers with a `tool.result` error whose `code` is
 * `'unsupported'`; the daemon then serves none (and treats any other error, or an answer of another shape, the same way).
 */
export const CONNECTOR_TOOLS_TOOL = 'connector_tools';

/**
 * The `tool.call` a daemon makes when the model calls one of those tools: input `PlatformConnectorCall`, output the
 * operation's result. The platform runs it on the Worker, under the session's agent principal, only for a connector
 * the calling session's gate names as ready; a failure is a `tool.result` error with a message the agent may read.
 */
export const CONNECTOR_CALL_TOOL = 'connector_call';

/** One platform-run connector tool as the daemon serves it: what the model sees, and the hints approval rules on. */
export interface ConnectorToolDeclaration {
    /** Namespaced `<id>__<operation>`. */
    readonly name: string;
    readonly description: string;
    /** The wire JSON Schema of its input: always an object schema, as a tool's arguments are. */
    readonly inputSchema: { readonly type: 'object'; readonly [keyword: string]: unknown };
    /** `@sigx/ai`'s `ToolAnnotations`: `readOnly` → `read`, `destructive` → `destructive`, neither → `network`. */
    readonly annotations?: { readonly readOnly?: boolean; readonly destructive?: boolean; readonly idempotent?: boolean; readonly openWorld?: boolean };
}

/** The answer to `CONNECTOR_TOOLS_TOOL`: each platform-run connector's tools, and the ones that could not be opened, with why. */
export interface PlatformConnectorTools {
    readonly connectors: readonly { readonly id: string; readonly tools: readonly ConnectorToolDeclaration[] }[];
    readonly unavailable: readonly { readonly id: string; readonly reason: string }[];
}

/** The input of `CONNECTOR_CALL_TOOL`: which connector, which of its tools (by its namespaced name), and the model's arguments. */
export interface PlatformConnectorCall {
    readonly connectorId: string;
    readonly tool: string;
    readonly input: unknown;
}

/**
 * A slice of a session's history the platform asks its machine for (#397): the events strictly after `from`,
 * up to and including `to` when given, at most `limit` of them (default `HISTORY_LIMIT`). The daemon answers
 * from its NDJSON log — the copy that outlives the platform's bounded pages — and may answer fewer than the
 * range holds, saying `more`; the caller asks again from the last event it got.
 */
export interface HistoryRange {
    readonly from: Cursor;
    readonly to?: Cursor;
    readonly limit?: number;
}

/** How many events a `history.response` carries at most when the request names no `limit`. */
export const HISTORY_LIMIT = 500;

/** A `history.request` answered: event frames in cursor order; `more` when the log holds more of the range after the last one. */
export interface HistoryResult<F = unknown> {
    readonly events: readonly F[];
    readonly more?: boolean;
}

/**
 * Why a `history.request` was not answered with events: `unknown-session` (no log for it on this machine), `gap` (the
 * log no longer reaches back to `from` — retention forgot it; `earliest` is the oldest cursor still held, so the hole
 * is named, never silent), `internal` (the log could not be read).
 */
export interface HistoryError {
    readonly code: 'unknown-session' | 'gap' | 'internal';
    readonly message: string;
    readonly earliest?: Cursor;
}

/** What a daemon needs to open a runtime session. */
export interface OpenSpec {
    readonly agentId: string;
    readonly cwd: string;
    readonly system: string;
    readonly model?: string;
    /** The runtime's permission mode (#450); the runtime's own default without it. */
    readonly permissionMode?: string;
    readonly maxTurns?: number;
    readonly maxBudgetUsd?: number;
    /** Tool names the daemon must serve to the runtime and bridge back as `tool.call`. */
    readonly tools: readonly string[];
    /**
     * The approval policy the session runs under (#121). Without it the harness asks on its
     * own terms (Claude Code: every non-trivial call) and every question reaches the user.
     */
    readonly policy?: OpenSpecPolicy;
    /** The agent's ready MCP connectors (#280); a daemon that predates them ignores the field. */
    readonly connectors?: readonly OpenSpecConnector[];
    /** The ref the runtime reported through `session.ref`; a daemon re-opens the runtime conversation with it. */
    readonly resume?: unknown;
}

export type DaemonFrame<F = unknown, R = unknown> =
    | {
          readonly v: typeof DAEMON_PROTOCOL_VERSION;
          readonly t: 'hello';
          readonly machineId: MachineId;
          readonly daemonVersion: string;
          readonly os: 'windows' | 'darwin' | 'linux';
          readonly environments: readonly EnvironmentDescriptor[];
          readonly capabilities: readonly CapabilityReport[];
          readonly resume: Readonly<Record<string, Cursor>>;
          /** The machine-local policy for web-managed environments (#236); absent from a daemon that predates it. */
          readonly policy?: MachinePolicy;
          /** The build (#359). `daemonVersion` stays: a daemon that predates this sends only that. */
          readonly build?: DaemonBuild;
          /** The optional frame families this daemon answers (#359). */
          readonly features?: readonly DaemonFeature[];
          /** How often the daemon was restarted, how it last stopped and its last self-update (#359). */
          readonly restarts?: number;
          readonly lastExit?: DaemonExit;
          readonly lastUpdate?: DaemonUpdateOutcome;
          readonly harnesses?: readonly HarnessReport[];
      }
    /** The environments changed — and, when it is carried, the policy too (a `policy.request` applied, or a command on the machine). */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'env'; readonly environments: readonly EnvironmentDescriptor[]; readonly policy?: MachinePolicy }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'heartbeat'; readonly at: number; readonly active: readonly SessionId[] }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.opened'; readonly sessionId: SessionId; readonly ref: unknown; readonly capabilities: CapabilityReport; readonly head: Cursor }
    /**
     * The runtime's own id for a session (#388): sent as soon as the runtime names it and again whenever that name changes.
     * `session.opened` cannot carry it — it goes out before the first prompt, when a harness has only a placeholder — so a
     * record resumes from this ref, never from the one the open carried. Opaque to the platform, like `OpenSpec.resume`.
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.ref'; readonly sessionId: SessionId; readonly ref: unknown }
    /**
     * The runtime's own title for a session's conversation (#460): sent once the runtime titles it and again whenever
     * that title changes — read from the driver after every turn (`OpenedRuntimeSession.title`). A runtime that keeps no
     * title never sends it; the platform then titles the chat itself.
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.title'; readonly sessionId: SessionId; readonly title: string }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.frame'; readonly sessionId: SessionId; readonly frame: F }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.reply'; readonly sessionId: SessionId; readonly reply: R }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.closed'; readonly sessionId: SessionId; readonly reason: string; readonly code?: SessionClosedCode }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'tool.call'; readonly callId: string; readonly sessionId: SessionId; readonly tool: string; readonly input: unknown }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'pong'; readonly at: number }
    /** The answer to `fs.request` (#185): exactly one of `result` / `error`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'fs.response'; readonly requestId: string; readonly result?: FsResult; readonly error?: FsError }
    /** The answer to `env.request` (#236): exactly one of `result` / `error`. A `result` comes with an `env` frame carrying the new descriptors, before or after it. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'env.response'; readonly requestId: string; readonly result?: EnvResult; readonly error?: EnvError }
    /**
     * An environment's provider limits changed (#261): pushed unsolicited, from a probe or a streamed rate-limit
     * signal. A stream snapshot carries only the windows it saw; the platform merges it (`mergeQuota`).
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'quota'; readonly environmentId: EnvironmentId; readonly snapshot: QuotaSnapshot }
    /**
     * What the machine's sessions cost it (#400): pushed unsolicited on the heartbeat cadence, a full snapshot
     * that replaces the previous one. A session the daemon cannot attribute a process to reads `null`.
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'telemetry'; readonly snapshot: MachineTelemetry }
    /** The answer to `history.request` (#397): exactly one of `result` (event frames, `F` = the wire `event` frame) / `error`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'history.response'; readonly requestId: string; readonly result?: HistoryResult<F>; readonly error?: HistoryError }
    /** Progress of an `update.request` (#359): `progress` while downloading, `error` when `failed`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'update.status'; readonly requestId: string; readonly phase: UpdatePhase; readonly progress?: { readonly bytes: number; readonly total: number }; readonly error?: LifecycleError }
    /** Progress of a `harness.request` (#359). */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'harness.status'; readonly requestId: string; readonly phase: HarnessPhase; readonly error?: LifecycleError }
    /** The harnesses changed (#359): pushed unsolicited, after a harness request or when the daemon finds a change. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'harnesses'; readonly harnesses: readonly HarnessReport[] }
    /**
     * The answer to `policy.request` (#355; the `policy` feature): exactly one of `result` / `error`. A `set` result comes
     * with an `env` frame carrying the policy as applied, before or after it; a `browse` result is the listing.
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'policy.response'; readonly requestId: string; readonly result?: MachinePolicyResult; readonly error?: MachinePolicyError }
    /** The answer to `log.request` (#355; the `log` feature): exactly one of `result` / `error`. Every line is redacted before it leaves the machine. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'log.response'; readonly requestId: string; readonly result?: DaemonLogResult; readonly error?: DaemonLogError }
    /**
     * Progress of a `login.request` (#355; the `login` feature): `action` comes with the `action` phase, `error` with
     * `failed` and only then. `done` means the runtime signed the environment in; an `env` frame with its new
     * `authStatus` follows once the daemon has re-inspected it.
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'login.status'; readonly requestId: string; readonly environmentId: EnvironmentId; readonly phase: LoginPhase; readonly action?: LoginAction; readonly error?: LoginError };

export type PlatformFrame<C = unknown> =
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'welcome'; readonly serverTime: number; readonly wanted: Readonly<Record<string, Cursor>>; readonly platform?: PlatformInfo }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.open'; readonly sessionId: SessionId; readonly environmentId: string; readonly spec: OpenSpec }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.command'; readonly sessionId: SessionId; readonly command: C }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.close'; readonly sessionId: SessionId }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'tool.result'; readonly callId: string; readonly output?: unknown; readonly error?: { readonly code: string; readonly message: string } }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'ping' }
    /** Browse a folder or create a git worktree inside an environment's `cwdRoots` (#185); answered by `fs.response`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'fs.request'; readonly requestId: string; readonly environmentId: string; readonly op: FsOp }
    /**
     * Create, change or remove an environment under the machine-local policy (#236; decisions 2026-09-19 (c)); answered by
     * `env.response`. The `EnvOp` fields sit on the frame: `op: 'put'` carries `environment`, `op: 'remove'` carries `environmentId`.
     */
    | ({ readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'env.request'; readonly requestId: string } & EnvOp)
    /**
     * The events of a session in a cursor range, from the daemon's own log (#397): the machine owns the history and the
     * platform keeps only a bounded recent window, so anything older is read this way. Answered by `history.response`.
     * `from` may be a platform-stamped cursor (a fractional `seq`, `platformCursor`): the log's next integer follows it.
     */
    | ({ readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'history.request'; readonly requestId: string; readonly sessionId: SessionId } & HistoryRange)
    /**
     * Update the daemon itself (#359; the `update` feature): to a release asset, back to the `previous` build, or — `restart`
     * (#355) — the same build again: nothing is downloaded or staged, the daemon drains and exits for its supervisor to
     * relaunch it. `drain` lets running turns end, for at most `drainTimeoutMs`; `now` does not wait. Progress comes back
     * as `update.status` (a restart reports no `downloading` / `verifying` / `staged` phase).
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'update.request'; readonly requestId: string; readonly target: ReleaseAsset | 'previous' | 'restart'; readonly mode: 'drain' | 'now'; readonly drainTimeoutMs: number }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'update.cancel'; readonly requestId: string }
    /** Install, update or remove a runtime harness (#359; the `harness` feature); progress comes back as `harness.status`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'harness.request'; readonly requestId: string; readonly op: 'install' | 'update' | 'remove'; readonly runtime: RuntimeId; readonly target?: ReleaseAsset; readonly mode: 'drain' | 'now' }
    /**
     * Set the machine's policy for web-managed environments, or browse its folders to pick one (#355; the `policy`
     * feature; decisions 2026-09-22). Owner-only on the platform, elevated; the daemon still refuses its own folders and
     * anything that is not a local folder, and everything when its owner locked the policy. Answered by `policy.response`.
     */
    | ({ readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'policy.request'; readonly requestId: string } & MachinePolicyOp)
    /** The last `lines` lines of the daemon's own log (#355; the `log` feature), for the Machine page; answered by `log.response`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'log.request'; readonly requestId: string; readonly lines: number }
    /**
     * Sign an environment's account in from the web (#355; the `login` feature): the daemon runs the runtime's own login
     * for that environment's profile and reports `login.status`. One login per environment at a time.
     */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'login.request'; readonly requestId: string; readonly environmentId: EnvironmentId }
    /** What the person pasted back for a login that `expectsPaste` (#355): handed to the runtime once, never stored or logged. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'login.answer'; readonly requestId: string; readonly text: string }
    /** Abandon a login in flight (#355): the daemon ends the runtime's login and answers `failed { cancelled }`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'login.cancel'; readonly requestId: string };

export const DAEMON_FRAME_TYPES = ['hello', 'env', 'heartbeat', 'session.opened', 'session.ref', 'session.title', 'session.frame', 'session.reply', 'session.closed', 'tool.call', 'pong', 'fs.response', 'env.response', 'quota', 'telemetry', 'history.response', 'update.status', 'harness.status', 'harnesses', 'policy.response', 'log.response', 'login.status'] as const;
export const PLATFORM_FRAME_TYPES = ['welcome', 'session.open', 'session.command', 'session.close', 'tool.result', 'ping', 'fs.request', 'env.request', 'history.request', 'update.request', 'update.cancel', 'harness.request', 'policy.request', 'log.request', 'login.request', 'login.answer', 'login.cancel'] as const;
