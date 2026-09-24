/** Machines, environments and capability transparency (EXE-01..12, AGT-09). */

import type { RuntimeId } from './agent.js';
import type { DaemonBuild } from './daemon.js';
import type { EnvironmentId, MachineId } from './ids.js';
import type { HarnessReport } from './release.js';
import type { ModelOption } from './session-options.js';

export type AuthStatus = 'ok' | 'missing' | 'expired' | 'unknown';

/** How accounts on one machine are kept apart; validated per runtime (EXE-07). */
export type IsolationMechanism = 'config-dir' | 'profile' | 'os-user' | 'container' | 'none';

/** One thing a runtime's `doctor` found; `environmentIds` names the environments it is about (EXE-07). */
export interface DoctorFinding {
    readonly level: 'error' | 'warn' | 'info';
    readonly code: string;
    readonly message: string;
    readonly environmentIds?: readonly EnvironmentId[];
}

/**
 * What the runtime's `doctor` concluded about ONE environment: the findings
 * that name it, `ok` when none is an error — the isolation and auth verdict
 * the daemon sends in `hello` / `env` and the Machine keeps (EXE-05/07).
 */
export interface EnvironmentVerdict {
    readonly ok: boolean;
    readonly findings: readonly DoctorFinding[];
    /** When the daemon ran the check (its clock). */
    readonly checkedAt: number;
}

/** A named execution environment on a machine (EXE-03/04). */
export interface EnvironmentDescriptor {
    readonly id: EnvironmentId;
    readonly machineId: MachineId;
    readonly name: string;
    readonly runtime: RuntimeId;
    readonly account: { readonly label: string; readonly authStatus: AuthStatus; readonly identity?: string };
    readonly cwdRoots: readonly string[];
    /** Turns running (`active`) and the environment's limit (`max`); no `max` means no limit (#694). */
    readonly concurrency: { readonly max?: number; readonly active: number };
    readonly isolation: IsolationMechanism;
    /** The runtime's verdict on this environment; absent when the daemon ran no `doctor`. */
    readonly doctor?: EnvironmentVerdict;
    /** The models its account may use, as the runtime reported them (#450); absent until reported. */
    readonly models?: readonly ModelOption[];
    /** Sessions here may run in a mode that asks about nothing (#450); set on the machine, or from the page by an elevated owner (#355). */
    readonly allowBypassPermissions?: boolean;
}

/** The operations an integration supports; unsupported ones are listed, never implied (AGT-09, PLG-09, AC-15). */
export interface CapabilityReport {
    readonly runtime: RuntimeId;
    readonly supported: readonly string[];
    readonly unsupported: readonly { readonly op: string; readonly reason: string }[];
    readonly resume: 'portable' | 'local' | false;
    readonly cancel: boolean;
    readonly steer: boolean;
    readonly permissions: 'every-call' | 'harness-filtered' | 'none';
    readonly tools: 'native' | 'mcp' | 'none';
    /**
     * How an environment of this runtime is signed in (#355, #484): `relay` — the daemon runs the runtime's own login
     * and relays it to the Machine page (`login.request`); `terminal` — only `agentic-daemon env login` on the machine.
     * Absent from a daemon that predates the relay (read as `terminal`).
     */
    readonly login?: 'relay' | 'terminal';
}

export interface MachineInfo {
    readonly id: MachineId;
    readonly name: string;
    readonly os: 'windows' | 'darwin' | 'linux';
    readonly daemonVersion: string;
    readonly online: boolean;
    readonly lastSeenAt: number;
    /** The build its last `hello` reported (#359); absent from a daemon that predates it. */
    readonly build?: DaemonBuild;
    /** A newer release is out on the machine's channel, or the platform no longer serves this build (#359). */
    readonly outdated?: boolean;
    readonly harnesses?: readonly HarnessReport[];
}

/**
 * What the platform may ask a daemon to create or change with `env.request`
 * (#236; decisions 2026-09-19 (c)). There is no `profileDir`: the daemon
 * allocates one per environment and it never crosses the wire, in either
 * direction. `put` is an upsert: `id` absent → the daemon mints one; present →
 * that environment is changed in place and keeps its profile directory, or is
 * created under that id.
 */
export interface EnvironmentInput {
    readonly id?: EnvironmentId;
    readonly name: string;
    readonly runtime: RuntimeId;
    /** Absolute, machine-native; each must lie within the machine's `MachinePolicy.allowedRoots`. */
    readonly cwdRoots: readonly string[];
    /** Turns at once: a number sets the limit, `null` clears it (no limit), absent keeps what the environment has (#694). */
    readonly concurrency?: number | null;
    readonly accountLabel?: string;
    /**
     * Let sessions here run in a mode that asks about nothing (#450, #355): `true` sets it, `false` clears it, absent
     * keeps what the environment has. Turning it on is a security-sensitive change the platform admits only to an
     * elevated owner; the daemon keeps the flag on the row.
     */
    readonly allowBypassPermissions?: boolean;
}

/** What `env.request` asks a daemon to do. */
export type EnvOp =
    /** Create the environment, or change the one `environment.id` names. */
    | { readonly op: 'put'; readonly environment: EnvironmentInput }
    /** Forget the environment; its profile directory stays on the machine (it holds a login). */
    | { readonly op: 'remove'; readonly environmentId: EnvironmentId };

/** What `env.response` answers: the environment that was written or removed. The descriptors themselves travel in an `env` frame, before or after it. */
export interface EnvResult {
    readonly environmentId: EnvironmentId;
}

export type EnvErrorCode =
    /** The machine's policy does not let the web manage environments (the default). */
    | 'policy-disabled'
    /** A working root is not inside `allowedRoots` — after the daemon resolved links. */
    | 'outside-allowed-roots'
    /** The daemon has no driver for the runtime. */
    | 'unknown-runtime'
    /** `remove`: the environment has running sessions. */
    | 'in-use'
    /** `remove`: the daemon has no such environment. */
    | 'unknown-environment'
    /** The daemon's own check of the input failed: a relative root, a name or id it cannot keep. */
    | 'invalid'
    /** Reading or writing the environments file failed. */
    | 'io'
    /** The daemon did not answer in time — set by the platform, never sent by a daemon. */
    | 'timeout';

export interface EnvError {
    readonly code: EnvErrorCode;
    readonly message: string;
}

/**
 * The policy for web-managed environments as a daemon reports it in `hello` /
 * `env`: which folders the web may place working roots in. It is set from the
 * web with `policy.request` (#355; decisions 2026-09-22) or on the machine
 * with `agentic-daemon policy …`, and `locked` on the machine makes it local-only
 * again. Absent → the daemon predates web-managed environments.
 *
 * The platform keeps the roots it *asked for* (`MachinePolicyInput`) and reads
 * `requested` back to tell whether the machine converged (`policyConverged`):
 * a `~` in the request is expanded on the machine and never leaves it.
 */
export interface MachinePolicy {
    readonly webManaged: boolean;
    /** Absolute, machine-native, links resolved; empty when `webManaged` is off. */
    readonly allowedRoots: readonly string[];
    /** Who wrote the policy last: the web (`policy.request`) or a command on the machine. Absent from a daemon that predates #355. */
    readonly source?: 'local' | 'web';
    /** `agentic-daemon policy lock`: the web may read the policy but every `policy.request` is refused `policy-locked`. */
    readonly locked?: boolean;
    /** The roots exactly as the web asked for them, before `~` expansion and link resolution; present when `source` is `web`. */
    readonly requested?: readonly string[];
}

/**
 * What the platform asks a daemon to make its policy (`policy.request { op: 'set' }`, #355): the folders the web may use,
 * each absolute and machine-native or `~` / `~/…` for the daemon user's home. Empty turns web management off.
 */
export interface MachinePolicyInput {
    readonly allowedRoots: readonly string[];
}

/** A policy names at most this many folders. */
export const POLICY_MAX_ROOTS = 32;

export type MachinePolicyErrorCode =
    /** The machine's owner locked the policy on the machine; only `agentic-daemon policy unlock` there lets the web set it again. */
    | 'policy-locked'
    /** A root is not an absolute local path, or a browse path is malformed. */
    | 'invalid'
    /** A root does not exist on the machine. */
    | 'not-found'
    /** A root exists but is not a folder. */
    | 'not-a-directory'
    /** A root is a network share or a device path — never a working root. */
    | 'remote-path'
    /** A root is inside the daemon's own folders (its configuration, state or an account profile). */
    | 'protected'
    /** Reading or writing `policy.json` failed, or a folder could not be read. */
    | 'io'
    /** The daemon did not answer in time — set by the platform, never sent by a daemon. */
    | 'timeout'
    /** The daemon does not answer the request (no port for it). */
    | 'unsupported';

export interface MachinePolicyError {
    readonly code: MachinePolicyErrorCode;
    readonly message: string;
}

/**
 * What `policy.request { op: 'browse' }` answers (#355): the immediate subfolders of a folder anywhere on the machine —
 * or, without a path, the machine's roots (drives, `/`, the home folder) — for picking allowed folders. Folders only,
 * no git badges, never the daemon's own folders.
 */
export interface MachineListing {
    /** The listed folder, absolute and machine-native; empty for the roots listing. */
    readonly path: string;
    /** Its parent — absent for a root of the machine and for the roots listing. */
    readonly parent?: string;
    readonly entries: readonly { readonly name: string; readonly path: string }[];
    /** More than `FS_LIST_MAX_ENTRIES` subfolders: only the first ones are listed. */
    readonly truncated: boolean;
}

/** What `policy.response` answers: the policy as applied, a listing, or nothing more than success for an op that changes nothing. */
export type MachinePolicyResult = { readonly policy: MachinePolicy; readonly listing?: undefined } | { readonly listing: MachineListing; readonly policy?: undefined };

/** What `policy.request` asks a daemon to do. */
export type MachinePolicyOp =
    /** Replace the policy: web-managed inside these roots, or off when empty. */
    | { readonly op: 'set'; readonly policy: MachinePolicyInput }
    /** List a folder's subfolders (or the machine's roots without a path) for the folder picker. */
    | { readonly op: 'browse'; readonly path?: string };

/** The log tail a daemon answers `log.request` with (#355): the last lines of its own log, every one redacted. */
export interface DaemonLogResult {
    readonly lines: readonly string[];
    /** The file holds more than what was read. */
    readonly truncated: boolean;
}

export interface DaemonLogError {
    /** `no-log`: the daemon runs without a log file (a foreground `run`). */
    readonly code: 'no-log' | 'io' | 'timeout' | 'unsupported';
    readonly message: string;
}

/** `log.request` asks for at most this many lines. */
export const DAEMON_LOG_MAX_LINES = 500;

/**
 * A sign-in relayed from the web (#355, the `login` feature): what the daemon reports about a login it runs for an
 * environment. `action` is what the person must do — open a URL (and paste a code back when `expectsPaste`), or enter
 * a device code at a URL. The pasted text travels in `login.answer` and is stored nowhere.
 */
export type LoginPhase = 'started' | 'action' | 'waiting' | 'done' | 'failed';

export interface LoginAction {
    readonly kind: 'open-url' | 'device-code';
    readonly url: string;
    /** The device code to enter, for `device-code`. */
    readonly code?: string;
    /** The runtime wants a code pasted back once the browser flow ends. */
    readonly expectsPaste: boolean;
}

export interface LoginError {
    readonly code: 'busy' | 'unknown-environment' | 'unsupported' | 'cancelled' | 'timeout' | 'failed';
    readonly message: string;
}

/** `login.answer.text` is at most this long. */
export const LOGIN_ANSWER_MAX_CHARS = 2048;
