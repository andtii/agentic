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
import type { ModelOption } from './session-options.js';

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
    /**
     * Sessions here may run in a mode that asks about nothing (#450: Claude Code's `bypassPermissions`). Set on the
     * machine only — never through `env.request` — and reported so the web offers the mode only where it is allowed.
     */
    readonly allowBypassPermissions?: boolean;
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
    /**
     * The runtime's current title for the conversation (#460), when the runtime keeps one (Claude Code's own
     * auto-title, Copilot's `session.title_changed`): read by the daemon after every turn and sent as
     * `session.title` when it changes. Resolves `undefined` while the runtime has not titled it yet; absent when
     * the runtime never does — the platform then titles the chat itself.
     */
    readonly title?: () => Promise<string | undefined>;
    /**
     * The OS process this session runs in (#400), when the runtime keeps one per session (Claude Code's CLI):
     * read by the daemon at every telemetry sample, which charges the process and everything under it to the
     * session. `undefined` while the runtime has not started it or after it exited; absent when the runtime has
     * no per-session process — the session's cost is then unknown, never zero.
     */
    readonly pid?: () => number | undefined;
}

export interface RuntimeDriver<S = unknown, P = unknown> {
    readonly runtime: RuntimeId;
    inspect(env: LocalEnvironment): Promise<EnvironmentInspection>;
    /**
     * The runtime's capabilities without an environment (#541): what the daemon's `hello` reports for a runtime no
     * environment runs on yet, so the platform can offer it for the first one. An environment's own `inspect` report
     * wins for its runtime. A driver that cannot run (a harness that is not installed), or whose capabilities depend
     * on the environment, does not implement it; its runtime is then reported only once an environment runs on it.
     */
    report?(): CapabilityReport;
    open(env: LocalEnvironment, spec: OpenSpec, ctx: RuntimeOpenContext<P>): Promise<OpenedRuntimeSession<S>>;
    doctor(envs: readonly LocalEnvironment[]): Promise<DoctorReport>;
    /** The models the environment's account may use (#450), as it reports them; `null` when it cannot say. */
    models?(env: LocalEnvironment): Promise<readonly ModelOption[] | null>;
    /**
     * The OS processes the driver keeps for an environment as a whole (#400) — Codex's one app-server per
     * environment — so telemetry can charge them to the environment when its sessions have no process of their
     * own. Absent when the driver keeps none it can name.
     */
    pids?(environmentId: EnvironmentId): readonly number[];
}

/** The platform-facing descriptor of a local environment, as sent in `hello` / `env`. */
export function toEnvironmentDescriptor(
    env: LocalEnvironment,
    machineId: MachineId,
    inspection: EnvironmentInspection,
    active = 0,
    doctor?: EnvironmentVerdict,
    models?: readonly ModelOption[]
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
        ...(doctor === undefined ? {} : { doctor }),
        ...(models === undefined ? {} : { models: [...models] }),
        ...(env.allowBypassPermissions ? { allowBypassPermissions: true } : {})
    };
}
