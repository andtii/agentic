/**
 * The part of the `codex app-server` protocol (v2) this driver speaks — trimmed by hand from
 * `codex app-server generate-ts` of **codex-cli 0.155.1** (#320). Only the stable surface:
 * nothing here needs `capabilities.experimentalApi`. Regenerate against a new Codex before
 * widening it; fields the driver does not read are left out.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export interface InitializeParams {
    readonly clientInfo: { readonly name: string; readonly title: string | null; readonly version: string };
    readonly capabilities: { readonly experimentalApi: boolean } | null;
}

export interface InitializeResponse {
    readonly userAgent: string;
    readonly codexHome: string;
    readonly platformFamily: string;
    readonly platformOs: string;
}

export type PlanType = string;

export type Account = { readonly type: 'apiKey' } | { readonly type: 'chatgpt'; readonly email: string | null; readonly planType: PlanType } | { readonly type: 'amazonBedrock'; readonly usesCodexManagedCredentials: boolean };

export interface GetAccountResponse {
    readonly account: Account | null;
    readonly requiresOpenaiAuth: boolean;
}

export interface RateLimitWindow {
    /** 0..100. */
    readonly usedPercent: number;
    readonly windowDurationMins: number | null;
    /** Epoch seconds. */
    readonly resetsAt: number | null;
}

export interface RateLimitSnapshot {
    readonly limitId: string | null;
    readonly limitName: string | null;
    readonly primary: RateLimitWindow | null;
    readonly secondary: RateLimitWindow | null;
    readonly planType: PlanType | null;
    readonly rateLimitReachedType: string | null;
}

export interface GetAccountRateLimitsResponse {
    readonly ordinaryUsageAllowed: boolean | null;
    readonly rateLimits: RateLimitSnapshot;
    readonly rateLimitsByLimitId: { readonly [limitId: string]: RateLimitSnapshot | undefined } | null;
}

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type UserInput = { readonly type: 'text'; readonly text: string; readonly text_elements: readonly never[] } | { readonly type: 'localImage'; readonly path: string };

export interface ThreadStartParams {
    readonly model?: string | null;
    readonly cwd?: string | null;
    readonly approvalPolicy?: AskForApproval | null;
    readonly sandbox?: SandboxMode | null;
    /** Config overrides, as `-c` would set them; nested objects merge into the config tree. */
    readonly config?: { readonly [key: string]: JsonValue } | null;
    readonly developerInstructions?: string | null;
}

export interface ThreadResumeParams extends ThreadStartParams {
    readonly threadId: string;
    readonly excludeTurns?: boolean;
}

export interface Thread {
    readonly id: string;
}

export interface ThreadStartResponse {
    readonly thread: Thread;
    readonly model: string;
}

export interface TurnStartParams {
    readonly threadId: string;
    readonly input: readonly UserInput[];
    readonly outputSchema?: JsonValue | null;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
    readonly message: string;
    readonly additionalDetails?: string | null;
}

export interface Turn {
    readonly id: string;
    readonly status: TurnStatus;
    readonly error: TurnError | null;
}

export interface TurnStartResponse {
    readonly turn: Turn;
}

export interface TurnSteerParams {
    readonly threadId: string;
    readonly input: readonly UserInput[];
    readonly expectedTurnId: string;
}

export interface TurnInterruptParams {
    readonly threadId: string;
    readonly turnId: string;
}

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export type ThreadItem =
    | { readonly type: 'userMessage'; readonly id: string }
    | { readonly type: 'agentMessage'; readonly id: string; readonly text: string }
    | { readonly type: 'reasoning'; readonly id: string }
    | { readonly type: 'commandExecution'; readonly id: string; readonly command: string; readonly cwd: string; readonly status: ItemStatus; readonly aggregatedOutput: string | null; readonly exitCode: number | null }
    | { readonly type: 'fileChange'; readonly id: string; readonly changes: readonly { readonly path: string; readonly kind: unknown; readonly diff: string }[]; readonly status: ItemStatus }
    | {
          readonly type: 'mcpToolCall';
          readonly id: string;
          readonly server: string;
          readonly tool: string;
          readonly status: ItemStatus;
          readonly arguments: JsonValue;
          readonly result: { readonly content: readonly JsonValue[]; readonly structuredContent: JsonValue | null } | null;
          readonly error: { readonly message: string } | null;
      }
    | { readonly type: 'webSearch'; readonly id: string; readonly query: string }
    | { readonly type: string; readonly id: string };

/** Server → client notifications, by method. */
export interface Notifications {
    'turn/started': { readonly threadId: string; readonly turn: Turn };
    'turn/completed': { readonly threadId: string; readonly turn: Turn };
    'item/started': { readonly threadId: string; readonly turnId: string; readonly item: ThreadItem };
    'item/completed': { readonly threadId: string; readonly turnId: string; readonly item: ThreadItem };
    'item/agentMessage/delta': { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly delta: string };
    'item/reasoning/summaryTextDelta': { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly delta: string };
    'item/reasoning/textDelta': { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly delta: string };
    'thread/tokenUsage/updated': { readonly threadId: string; readonly turnId: string; readonly tokenUsage: { readonly total: TokenUsageBreakdown; readonly last: TokenUsageBreakdown } };
    error: { readonly threadId: string; readonly turnId: string; readonly error: TurnError; readonly willRetry: boolean };
    'account/rateLimits/updated': { readonly rateLimits: RateLimitSnapshot };
}

export interface TokenUsageBreakdown {
    readonly totalTokens: number;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CommandExecutionRequestApprovalParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly reason?: string | null;
    readonly command?: string | null;
    readonly cwd?: string | null;
}

export interface FileChangeRequestApprovalParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly reason?: string | null;
    readonly grantRoot?: string | null;
}

export interface PermissionProfile {
    readonly network?: JsonValue;
    readonly fileSystem?: JsonValue;
}

export interface PermissionsRequestApprovalParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly cwd: string;
    readonly reason: string | null;
    readonly permissions: { readonly network: JsonValue | null; readonly fileSystem: JsonValue | null };
}

export interface PermissionsRequestApprovalResponse {
    readonly permissions: PermissionProfile;
    readonly scope: 'turn' | 'session';
}

export interface ToolRequestUserInputQuestion {
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: readonly { readonly label: string; readonly description?: string }[] | null;
}

export interface ToolRequestUserInputParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly questions: readonly ToolRequestUserInputQuestion[];
}

export interface ToolRequestUserInputResponse {
    readonly answers: { readonly [questionId: string]: { readonly answers: readonly string[] } };
}

export interface McpServerElicitationRequestParams {
    readonly threadId: string;
    readonly turnId: string | null;
    readonly serverName: string;
    readonly mode: string;
    readonly message?: string;
}

export interface McpServerElicitationRequestResponse {
    readonly action: 'accept' | 'decline' | 'cancel';
    readonly content: JsonValue | null;
    readonly _meta: JsonValue | null;
}
