/**
 * The daemon <-> platform envelope (architecture §5b). One hibernatable
 * WebSocket per machine carries control verbs, per-session wire traffic and
 * tool callbacks.
 *
 * Generic over the session wire types so this package stays dependency-free:
 * `F` is a served session's frame (`WireFrame` from `@sigx/ai-agent/wire`),
 * `R` its reply, `C` a command. `@agentic/daemon-protocol` instantiates them.
 */

import type { ApprovalRule, CapabilityReport, EnvError, EnvironmentDescriptor, EnvOp, EnvResult, FsError, FsOp, FsResult, MachineId, MachinePolicy, SessionId, ToolGrant } from './index.js';

export const DAEMON_PROTOCOL_VERSION = 1 as const;

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

/** What a daemon needs to open a runtime session. */
export interface OpenSpec {
    readonly agentId: string;
    readonly cwd: string;
    readonly system: string;
    readonly model?: string;
    readonly maxTurns?: number;
    readonly maxBudgetUsd?: number;
    /** Tool names the daemon must serve to the runtime and bridge back as `tool.call`. */
    readonly tools: readonly string[];
    /**
     * The approval policy the session runs under (#121). Without it the harness asks on its
     * own terms (Claude Code: every non-trivial call) and every question reaches the user.
     */
    readonly policy?: OpenSpecPolicy;
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
      }
    /** The environments changed — and, when it is carried, the policy too (it is edited on the machine while the daemon runs). */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'env'; readonly environments: readonly EnvironmentDescriptor[]; readonly policy?: MachinePolicy }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'heartbeat'; readonly at: number; readonly active: readonly SessionId[] }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.opened'; readonly sessionId: SessionId; readonly ref: unknown; readonly capabilities: CapabilityReport; readonly head: Cursor }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.frame'; readonly sessionId: SessionId; readonly frame: F }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.reply'; readonly sessionId: SessionId; readonly reply: R }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.closed'; readonly sessionId: SessionId; readonly reason: string }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'tool.call'; readonly callId: string; readonly sessionId: SessionId; readonly tool: string; readonly input: unknown }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'pong'; readonly at: number }
    /** The answer to `fs.request` (#185): exactly one of `result` / `error`. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'fs.response'; readonly requestId: string; readonly result?: FsResult; readonly error?: FsError }
    /** The answer to `env.request` (#236): exactly one of `result` / `error`. A `result` comes with an `env` frame carrying the new descriptors, before or after it. */
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'env.response'; readonly requestId: string; readonly result?: EnvResult; readonly error?: EnvError };

export type PlatformFrame<C = unknown> =
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'welcome'; readonly serverTime: number; readonly wanted: Readonly<Record<string, Cursor>> }
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
    | ({ readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'env.request'; readonly requestId: string } & EnvOp);

export const DAEMON_FRAME_TYPES = ['hello', 'env', 'heartbeat', 'session.opened', 'session.frame', 'session.reply', 'session.closed', 'tool.call', 'pong', 'fs.response', 'env.response'] as const;
export const PLATFORM_FRAME_TYPES = ['welcome', 'session.open', 'session.command', 'session.close', 'tool.result', 'ping', 'fs.request', 'env.request'] as const;
