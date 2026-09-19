/** Agent identity and configuration (requirements AGT-01..09, COL-10/11). */

import type { AgentId, EnvironmentId } from './ids.js';

/** The runtime that executes an agent's sessions. Extended by runtime plugins. */
export type RuntimeId = 'anthropic-api' | 'claude-code' | 'copilot-cli' | 'codex-cli' | (string & {});

/** Reusable instructions or procedures. A skill never grants authority (AGT-04). */
export interface SkillRef {
    readonly id: string;
    readonly version?: string;
}

/** A tool the agent may call; the only thing a policy is compiled from. */
export interface ToolGrant {
    readonly name: string;
    /** `'ask'` routes every call through the approval flow. Default `'allow'`. */
    readonly mode?: 'allow' | 'ask' | 'deny';
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
    readonly defaultEnvironmentId?: EnvironmentId;
    /** The folder work runs in when it runs in `defaultEnvironmentId` (#185); within that environment's `cwdRoots`. */
    readonly defaultWorkdir?: string;
    readonly model?: string;
    readonly limits: Limits;
    readonly offlinePolicy: OfflinePolicy;
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
