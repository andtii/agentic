/**
 * The daemon <-> platform envelope (architecture §5b). One hibernatable
 * WebSocket per machine carries control verbs, per-session wire traffic and
 * tool callbacks.
 *
 * Generic over the session wire types so this package stays dependency-free:
 * `F` is a served session's frame (`WireFrame` from `@sigx/ai-agent/wire`),
 * `R` its reply, `C` a command. `@agentic/daemon-protocol` instantiates them.
 */

import type { ApprovalRule, CapabilityReport, EnvironmentDescriptor, MachineId, SessionId, ToolGrant } from './index.js';

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
      }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'env'; readonly environments: readonly EnvironmentDescriptor[] }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'heartbeat'; readonly at: number; readonly active: readonly SessionId[] }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.opened'; readonly sessionId: SessionId; readonly ref: unknown; readonly capabilities: CapabilityReport; readonly head: Cursor }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.frame'; readonly sessionId: SessionId; readonly frame: F }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.reply'; readonly sessionId: SessionId; readonly reply: R }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.closed'; readonly sessionId: SessionId; readonly reason: string }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'tool.call'; readonly callId: string; readonly sessionId: SessionId; readonly tool: string; readonly input: unknown }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'pong'; readonly at: number };

export type PlatformFrame<C = unknown> =
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'welcome'; readonly serverTime: number; readonly wanted: Readonly<Record<string, Cursor>> }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.open'; readonly sessionId: SessionId; readonly environmentId: string; readonly spec: OpenSpec }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.command'; readonly sessionId: SessionId; readonly command: C }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'session.close'; readonly sessionId: SessionId }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'tool.result'; readonly callId: string; readonly output?: unknown; readonly error?: { readonly code: string; readonly message: string } }
    | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly t: 'ping' };

export const DAEMON_FRAME_TYPES = ['hello', 'env', 'heartbeat', 'session.opened', 'session.frame', 'session.reply', 'session.closed', 'tool.call', 'pong'] as const;
export const PLATFORM_FRAME_TYPES = ['welcome', 'session.open', 'session.command', 'session.close', 'tool.result', 'ping'] as const;
