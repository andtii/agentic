/** Machines, environments and capability transparency (EXE-01..12, AGT-09). */

import type { RuntimeId } from './agent.js';
import type { EnvironmentId, MachineId } from './ids.js';

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
    readonly concurrency: { readonly max: number; readonly active: number };
    readonly isolation: IsolationMechanism;
    /** The runtime's verdict on this environment; absent when the daemon ran no `doctor`. */
    readonly doctor?: EnvironmentVerdict;
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
}

export interface MachineInfo {
    readonly id: MachineId;
    readonly name: string;
    readonly os: 'windows' | 'darwin' | 'linux';
    readonly daemonVersion: string;
    readonly online: boolean;
    readonly lastSeenAt: number;
}

/**
 * What the platform may ask a daemon to create or change with `env.request`
 * (#236; decisions 2026-09-19 (c)). There is no `profileDir`: the daemon
 * allocates one per environment and it never crosses the wire, in either
 * direction. `id` absent → the daemon mints one; present → that environment is
 * updated in place and keeps its profile directory.
 */
export interface EnvironmentInput {
    readonly id?: EnvironmentId;
    readonly name: string;
    readonly runtime: RuntimeId;
    /** Absolute, machine-native; each must lie within the machine's `MachinePolicy.allowedRoots`. */
    readonly cwdRoots: readonly string[];
    /** Sessions at once; the daemon's default when absent. */
    readonly concurrency?: number;
    readonly accountLabel?: string;
}

/** What `env.request` asks a daemon to do. */
export type EnvOp =
    /** Create the environment, or change the one `environment.id` names. */
    | { readonly op: 'put'; readonly environment: EnvironmentInput }
    /** Forget the environment; its profile directory stays on the machine (it holds a login). */
    | { readonly op: 'remove'; readonly environmentId: EnvironmentId };

/** What `env.response` answers: the environment that was written or removed. The new descriptors follow in an `env` frame. */
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
    /** `remove`, or a `put` with an `id`: the daemon has no such environment. */
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
 * The machine-local policy a daemon reports in `hello` / `env` so the web can
 * explain itself. It is only ever edited on the machine; nothing on the wire
 * changes it. Absent → the daemon predates web-managed environments.
 */
export interface MachinePolicy {
    readonly webManaged: boolean;
    /** Absolute, machine-native; empty when `webManaged` is off. */
    readonly allowedRoots: readonly string[];
}
