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
