/**
 * The slice of `@github/copilot-sdk` the Copilot CLI driver uses, as structural types: tests hand in a
 * scripted client, and the real SDK — which needs Node ^20.19 / >=22.12 and a bundled runtime per
 * platform — is imported only when a daemon actually opens a Copilot environment (`loadCopilotClient`).
 * Shapes as of `@github/copilot-sdk` 1.0.14 / Copilot CLI 1.0.85.
 */

/** A session event: `{ type, data }` — the few `type`s the adapter maps are typed below; the rest pass by. */
export interface CopilotEvent {
    readonly type: string;
    readonly data?: unknown;
    readonly ephemeral?: boolean;
}

export interface CopilotMessageDelta {
    readonly messageId: string;
    readonly deltaContent: string;
    readonly parentToolCallId?: string;
}
export interface CopilotMessage {
    readonly messageId: string;
    readonly content: string;
    readonly parentToolCallId?: string;
}
export interface CopilotReasoningDelta {
    readonly reasoningId: string;
    readonly deltaContent: string;
}
export interface CopilotToolStart {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly arguments?: unknown;
    readonly mcpServerName?: string;
    readonly parentToolCallId?: string;
}
export interface CopilotToolComplete {
    readonly toolCallId: string;
    readonly success: boolean;
    readonly result?: { readonly content: string; readonly structuredContent?: unknown };
    readonly error?: { readonly message: string; readonly code?: string };
    readonly parentToolCallId?: string;
}
export interface CopilotUsage {
    readonly model: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
    readonly cost?: number;
    readonly parentToolCallId?: string;
}
export interface CopilotError {
    readonly errorType: string;
    readonly message: string;
    readonly statusCode?: number;
}

/** What Copilot asks before a native tool runs (`kind`: shell, write, read, mcp, url, custom-tool, …). */
export interface CopilotPermissionRequest {
    readonly kind: string;
    readonly toolCallId?: string;
    readonly intention?: string;
    readonly fullCommandText?: string;
    readonly fileName?: string;
    readonly path?: string;
    readonly url?: string;
    readonly serverName?: string;
    readonly toolName?: string;
    readonly readOnly?: boolean;
    readonly args?: unknown;
    readonly canOfferSessionApproval?: boolean;
    readonly [key: string]: unknown;
}
export type CopilotPermissionResult = { readonly kind: 'approve-once' } | { readonly kind: 'reject'; readonly feedback?: string } | { readonly kind: 'user-not-available' };

export interface CopilotUserInputRequest {
    readonly question: string;
    readonly choices?: readonly string[];
    readonly allowFreeform?: boolean;
}
export interface CopilotUserInputResponse {
    readonly answer: string;
    readonly wasFreeform: boolean;
}

export interface CopilotToolInvocation {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
}
/** A client tool: Copilot runs `handler` in this process when the model calls it. */
export interface CopilotTool {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
    readonly handler: (args: unknown, invocation: CopilotToolInvocation) => Promise<unknown>;
    /** The platform's policy decides, inside `handler`; Copilot is not asked to. */
    readonly skipPermission?: boolean;
}

export interface CopilotSessionConfig {
    readonly workingDirectory?: string;
    readonly model?: string;
    readonly systemMessage?: { readonly mode: 'append'; readonly content: string };
    readonly tools?: readonly CopilotTool[];
    readonly streaming?: boolean;
    /** MEM-10: the platform owns memory; repository instructions and discovered config stay out. */
    readonly skipCustomInstructions?: boolean;
    readonly enableConfigDiscovery?: boolean;
    readonly onPermissionRequest?: (request: CopilotPermissionRequest, invocation: { readonly sessionId: string }) => Promise<CopilotPermissionResult>;
    readonly onUserInputRequest?: (request: CopilotUserInputRequest, invocation: { readonly sessionId: string }) => Promise<CopilotUserInputResponse>;
}

export interface CopilotSessionLike {
    readonly sessionId: string;
    /** Every event; returns the unsubscribe. */
    on(handler: (event: CopilotEvent) => void): () => void;
    send(options: { readonly prompt: string }): Promise<string>;
    abort(): Promise<void>;
    disconnect(): Promise<void>;
}

export interface CopilotQuotaSnapshot {
    readonly isUnlimitedEntitlement: boolean;
    readonly entitlementRequests: number;
    readonly usedRequests: number;
    readonly remainingPercentage: number;
    readonly overage?: number;
    readonly usageAllowedWithExhaustedQuota?: boolean;
    readonly overageAllowedWithExhaustedQuota?: boolean;
    readonly resetDate?: string;
    readonly hasQuota?: boolean;
}

export interface CopilotAuthStatus {
    readonly isAuthenticated: boolean;
    readonly authType?: string;
    readonly login?: string;
    readonly host?: string;
    readonly statusMessage?: string;
}

export interface CopilotClientLike {
    start(): Promise<void>;
    stop(): Promise<readonly Error[]>;
    createSession(config: CopilotSessionConfig): Promise<CopilotSessionLike>;
    resumeSession(sessionId: string, config: CopilotSessionConfig): Promise<CopilotSessionLike>;
    getAuthStatus(): Promise<CopilotAuthStatus>;
    readonly rpc: { readonly account: { getQuota(params: Record<string, never>): Promise<{ readonly quotaSnapshots: Readonly<Record<string, CopilotQuotaSnapshot | undefined>> }> } };
}

/** How the driver gets a client for one profile: `baseDirectory` is `COPILOT_HOME`, `env` the whole child environment. */
export interface CopilotClientInit {
    readonly baseDirectory?: string;
    readonly env: Record<string, string | undefined>;
    readonly logLevel?: 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all';
    /**
     * The Copilot runtime executable (`copilot-runtime[.exe]` of a `@github/copilot-sdk-<os>-<arch>` package) to spawn
     * over stdio (#369: the daemon's harness store). Default: the SDK's own, resolved beside it.
     */
    readonly cliPath?: string;
}
export type CreateCopilotClient = (init: CopilotClientInit) => CopilotClientLike | Promise<CopilotClientLike>;

/** The real SDK, imported on first use. */
export const loadCopilotClient: CreateCopilotClient = async (init) => {
    const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
    return new CopilotClient({
        ...(init.cliPath !== undefined ? { connection: RuntimeConnection.forStdio({ path: init.cliPath }) } : {}),
        ...(init.baseDirectory !== undefined ? { baseDirectory: init.baseDirectory } : {}),
        env: init.env,
        useLoggedInUser: true,
        logLevel: init.logLevel ?? 'error'
    }) as unknown as CopilotClientLike;
};
