/** Agent identity and configuration (requirements AGT-01..09, COL-10/11). */

import type { AccountRef } from './account.js';
import type { AgentId, EnvironmentId } from './ids.js';

/** The runtime that executes an agent's sessions. Extended by runtime plugins. */
export type RuntimeId = 'anthropic-api' | 'claude-code' | 'copilot-cli' | 'codex-cli' | (string & {});

/** Reusable instructions or procedures. A skill never grants authority (AGT-04). */
export interface SkillRef {
    readonly id: string;
    readonly version?: string;
}

/** How a tool call is let through: at once, after an approval, or never. */
export type ToolMode = 'allow' | 'ask' | 'deny';

/** A tool the agent may call; the only thing a policy is compiled from. */
export interface ToolGrant {
    readonly name: string;
    /** `'ask'` routes every call through the approval flow. Default `'allow'`. */
    readonly mode?: ToolMode;
}

/**
 * The mode a tool starts in when nothing chose one, from its MCP-style hints:
 * read-only is allowed, an explicit `destructiveHint: false` is allowed, and
 * anything else asks — MCP defaults `destructiveHint` to true when a tool is
 * not read-only, so an unannotated tool is treated as destructive (PLG-09).
 */
export function defaultToolMode(annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean }): ToolMode {
    if (annotations?.readOnlyHint) return 'allow';
    return annotations?.destructiveHint === false ? 'allow' : 'ask';
}

export interface ConnectorRef {
    readonly id: string;
}

/** One approval rule; rules are evaluated first-match. */
export interface ApprovalRule {
    readonly id: string;
    readonly match: {
        readonly tools?: readonly string[];
        readonly categories?: readonly ('read' | 'write' | 'execute' | 'network' | 'destructive')[];
        readonly source?: 'client' | 'native' | 'mcp';
    };
    readonly outcome: 'allow' | 'deny' | 'ask';
    readonly scope?: 'once' | 'session';
}

export interface MemoryPolicy {
    /** Every agent has a private scope; `shared` lists the shared scopes it may read. */
    readonly shared: readonly string[];
    readonly autoLearn: 'lessons' | 'off';
}

/** Hard limits on a session or a task (COL-11, OPS-08). */
export interface Limits {
    readonly maxTurns?: number;
    readonly maxSteps?: number;
    readonly maxTokens?: number;
    readonly maxCostUsd?: number;
    readonly maxWallMs?: number;
    readonly maxDepth?: number;
    readonly maxConcurrentChildren?: number;
}

export type OfflinePolicy = 'queue' | 'fail' | 'fallback-api';

export interface ExecutionDefaults {
    readonly runtime: RuntimeId;
    /**
     * The account the agent runs as, on whichever machine the chat or task names (#414): the
     * router resolves `(machine, account)` to that machine's environment once per task. Absent,
     * the agent is pinned to `defaultEnvironmentId` — which also supplies the account when a
     * task names a machine but the agent names no account.
     */
    readonly account?: AccountRef;
    readonly defaultEnvironmentId?: EnvironmentId;
    /** The folder work runs in when it runs in `defaultEnvironmentId` (#185); within that environment's `cwdRoots`. */
    readonly defaultWorkdir?: string;
    readonly model?: string;
    readonly limits: Limits;
    readonly offlinePolicy: OfflinePolicy;
    /**
     * A turn the machine dropped mid-way (#359; EXE-08): `ask` (the default) parks the task for the user, `auto`
     * resumes it once the machine is back.
     */
    readonly onInterrupt?: 'ask' | 'auto';
}

/** What the user configures (AGT-02). */
export interface AgentConfig {
    readonly name: string;
    readonly description: string;
    readonly role: string;
    readonly instructions: string;
    readonly skills: readonly SkillRef[];
    readonly tools: readonly ToolGrant[];
    readonly connectors: readonly ConnectorRef[];
    readonly approvalPolicy: readonly ApprovalRule[];
    readonly memoryPolicy: MemoryPolicy;
    readonly execution: ExecutionDefaults;
    /** Who this agent may delegate to. Default `'all'` within the workspace (decision 2026-09-17). */
    readonly collaborators: 'all' | readonly AgentId[];
}

/**
 * An agent as the lists draw it (#1125): what the Workspace index keeps per agent, so the agent directory reads
 * names, roles and default environments from `Workspace.get` instead of a live `Agent.get` per agent. The Agent
 * actor writes it in the same turn as every new config version. A subset of `AgentView`'s shape (same field
 * paths), so a full view passes wherever a summary is read.
 */
export interface AgentSummary {
    readonly id: AgentId;
    /** The config version this summary was taken from; a later version replaces it, never an earlier one. */
    readonly configVersion: number;
    readonly config: {
        readonly name: string;
        readonly role: string;
        readonly description: string;
        readonly execution: Pick<ExecutionDefaults, 'runtime' | 'account' | 'defaultEnvironmentId' | 'model'>;
    };
}

/** The summary of agent `id` at config version `configVersion` — a new plain object; absent optional fields stay absent. */
export function agentSummaryOf(id: AgentId, configVersion: number, config: AgentConfig): AgentSummary {
    const { runtime, account, defaultEnvironmentId, model } = config.execution;
    return {
        id,
        configVersion,
        config: {
            name: config.name,
            role: config.role,
            description: config.description,
            execution: {
                runtime,
                ...(account === undefined ? {} : { account: { ...account } }),
                ...(defaultEnvironmentId === undefined ? {} : { defaultEnvironmentId }),
                ...(model === undefined ? {} : { model })
            }
        }
    };
}

/** One durable config version (AGT-06). */
export interface AgentConfigVersion {
    readonly version: number;
    readonly at: number;
    readonly by: string;
    readonly reason: string;
}

/** The configuration a session ran with, recorded on the session (AGT-06/07). */
export interface FrozenAgentConfig extends AgentConfig {
    readonly agentId: AgentId;
    readonly configVersion: number;
}
