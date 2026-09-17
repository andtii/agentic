/**
 * The seam between the machine daemon and a runtime driver (architecture §5b).
 *
 * The daemon owns transport, logs and reconnects; a driver turns a local
 * environment plus an `OpenSpec` into a live session. Generic over the
 * session type `S` (`AgentSession` from `@sigx/ai-agent`) and the policy
 * type `P`, so this package stays dependency-free.
 */

import type { RuntimeId } from './agent.js';
import type { OpenSpec } from './daemon.js';
import type { AuthStatus, CapabilityReport, DoctorFinding, EnvironmentDescriptor, EnvironmentVerdict, IsolationMechanism } from './environment.js';
import type { EnvironmentId, MachineId, SessionId } from './ids.js';

/** One row of the daemon's `environments.json`; never leaves the machine as-is (EXE-03/04). */
export interface LocalEnvironment {
    readonly id: EnvironmentId;
    readonly name: string;
    readonly runtime: RuntimeId;
    /** The runtime's per-account config dir (`CLAUDE_CONFIG_DIR` for Claude Code). */
    readonly profileDir?: string;
    readonly cwdRoots: readonly string[];
    /** Maximum concurrent sessions in this environment. */
    readonly concurrency: number;
    readonly accountLabel?: string;
}

/** What a driver can tell about an environment without opening a session. */
export interface EnvironmentInspection {
    readonly authStatus: AuthStatus;
    readonly identity?: string;
    readonly isolation: IsolationMechanism;
    readonly capabilities: CapabilityReport;
}

/** `ok` is false when any finding is an error (EXE-07). `DoctorFinding` lives in `environment.ts`. */
export interface DoctorReport {
    readonly ok: boolean;
    readonly findings: readonly DoctorFinding[];
}

/** The verdict on one environment out of a driver's report: the findings naming it, `ok` when none is an error. */
export function environmentVerdict(report: DoctorReport, environmentId: EnvironmentId, checkedAt: number): EnvironmentVerdict {
    const findings = report.findings.filter((f) => f.environmentIds?.includes(environmentId));
    return { ok: !findings.some((f) => f.level === 'error'), findings, checkedAt };
}

/** Calls a platform tool; the daemon bridges it as `tool.call` and resolves on `tool.result`. */
export type PlatformToolCaller = (tool: string, input: unknown) => Promise<unknown>;

export interface RuntimeOpenContext<P = unknown> {
    readonly sessionId: SessionId;
    readonly callTool: PlatformToolCaller;
    /** The agent's compiled approval policy. */
    readonly policy?: P;
}

export interface OpenedRuntimeSession<S = unknown> {
    readonly session: S;
    readonly capabilities: CapabilityReport;
}

export interface RuntimeDriver<S = unknown, P = unknown> {
    readonly runtime: RuntimeId;
    inspect(env: LocalEnvironment): Promise<EnvironmentInspection>;
    open(env: LocalEnvironment, spec: OpenSpec, ctx: RuntimeOpenContext<P>): Promise<OpenedRuntimeSession<S>>;
    doctor(envs: readonly LocalEnvironment[]): Promise<DoctorReport>;
}

/** The platform-facing descriptor of a local environment, as sent in `hello` / `env`. */
export function toEnvironmentDescriptor(
    env: LocalEnvironment,
    machineId: MachineId,
    inspection: EnvironmentInspection,
    active = 0,
    doctor?: EnvironmentVerdict
): EnvironmentDescriptor {
    return {
        id: env.id,
        machineId,
        name: env.name,
        runtime: env.runtime,
        account: {
            label: env.accountLabel ?? env.name,
            authStatus: inspection.authStatus,
            ...(inspection.identity === undefined ? {} : { identity: inspection.identity })
        },
        cwdRoots: [...env.cwdRoots],
        concurrency: { max: env.concurrency, active },
        isolation: inspection.isolation,
        ...(doctor === undefined ? {} : { doctor })
    };
}
