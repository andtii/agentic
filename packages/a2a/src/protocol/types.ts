/**
 * A2A 1.0 wire types — the JSON-RPC binding's shapes, as the specification
 * serialises them (camelCase fields, SCREAMING_SNAKE enums, ISO timestamps).
 * Only what this package speaks: SendMessage / SendStreamingMessage / GetTask /
 * ListTasks / CancelTask and the Agent Card. Push notifications, extended
 * cards and Subscribe are named so they can be refused by name.
 */

export const A2A_PROTOCOL_VERSION = '1.0';

/** The well-known path a card is discovered at (spec §8.2). */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

export const A2A_METHODS = {
    sendMessage: 'SendMessage',
    sendStreamingMessage: 'SendStreamingMessage',
    getTask: 'GetTask',
    listTasks: 'ListTasks',
    cancelTask: 'CancelTask',
    subscribeToTask: 'SubscribeToTask',
    createTaskPushNotificationConfig: 'CreateTaskPushNotificationConfig',
    getTaskPushNotificationConfig: 'GetTaskPushNotificationConfig',
    listTaskPushNotificationConfigs: 'ListTaskPushNotificationConfigs',
    deleteTaskPushNotificationConfig: 'DeleteTaskPushNotificationConfig',
    getExtendedAgentCard: 'GetExtendedAgentCard'
} as const;

export type A2aMethod = (typeof A2A_METHODS)[keyof typeof A2A_METHODS];

/** The 0.3 method names, accepted as aliases of their 1.0 counterparts (responses are always 1.0 shapes). */
export const A2A_LEGACY_METHODS: Readonly<Record<string, A2aMethod>> = {
    'message/send': 'SendMessage',
    'message/stream': 'SendStreamingMessage',
    'tasks/get': 'GetTask',
    'tasks/list': 'ListTasks',
    'tasks/cancel': 'CancelTask',
    'tasks/resubscribe': 'SubscribeToTask',
    'tasks/pushNotificationConfig/set': 'CreateTaskPushNotificationConfig',
    'tasks/pushNotificationConfig/get': 'GetTaskPushNotificationConfig',
    'tasks/pushNotificationConfig/list': 'ListTaskPushNotificationConfigs',
    'tasks/pushNotificationConfig/delete': 'DeleteTaskPushNotificationConfig',
    'agent/getAuthenticatedExtendedCard': 'GetExtendedAgentCard'
};

export type TaskState =
    | 'TASK_STATE_UNSPECIFIED'
    | 'TASK_STATE_SUBMITTED'
    | 'TASK_STATE_WORKING'
    | 'TASK_STATE_COMPLETED'
    | 'TASK_STATE_FAILED'
    | 'TASK_STATE_CANCELED'
    | 'TASK_STATE_INPUT_REQUIRED'
    | 'TASK_STATE_REJECTED'
    | 'TASK_STATE_AUTH_REQUIRED';

export const TASK_STATES: readonly TaskState[] = [
    'TASK_STATE_UNSPECIFIED',
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_REJECTED',
    'TASK_STATE_AUTH_REQUIRED'
];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);

export function isTerminalState(state: TaskState): boolean {
    return TERMINAL_STATES.has(state);
}
export function isInterruptedState(state: TaskState): boolean {
    return INTERRUPTED_STATES.has(state);
}

export type Role = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

/** Exactly one of `text` / `raw` / `url` / `data`. */
export interface A2aPart {
    readonly text?: string;
    /** Base64. */
    readonly raw?: string;
    readonly url?: string;
    readonly data?: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly filename?: string;
    readonly mediaType?: string;
}

export interface A2aMessage {
    readonly messageId: string;
    readonly contextId?: string;
    readonly taskId?: string;
    readonly role: Role;
    readonly parts: readonly A2aPart[];
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly extensions?: readonly string[];
    readonly referenceTaskIds?: readonly string[];
}

export interface A2aArtifact {
    readonly artifactId: string;
    readonly name?: string;
    readonly description?: string;
    readonly parts: readonly A2aPart[];
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly extensions?: readonly string[];
}

export interface A2aTaskStatus {
    readonly state: TaskState;
    readonly message?: A2aMessage;
    /** ISO 8601, UTC. */
    readonly timestamp?: string;
}

export interface A2aTask {
    readonly id: string;
    readonly contextId?: string;
    readonly status: A2aTaskStatus;
    readonly artifacts?: readonly A2aArtifact[];
    readonly history?: readonly A2aMessage[];
    readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskStatusUpdateEvent {
    readonly taskId: string;
    readonly contextId: string;
    readonly status: A2aTaskStatus;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskArtifactUpdateEvent {
    readonly taskId: string;
    readonly contextId: string;
    readonly artifact: A2aArtifact;
    readonly append?: boolean;
    readonly lastChunk?: boolean;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

/** One SSE frame's `result` (spec §3.2.3) — exactly one member set. */
export type StreamResponse =
    | { readonly task: A2aTask }
    | { readonly message: A2aMessage }
    | { readonly statusUpdate: TaskStatusUpdateEvent }
    | { readonly artifactUpdate: TaskArtifactUpdateEvent };

export type SendMessageResponse = { readonly task: A2aTask } | { readonly message: A2aMessage };

export interface SendMessageConfiguration {
    readonly acceptedOutputModes?: readonly string[];
    readonly historyLength?: number;
    readonly returnImmediately?: boolean;
    /** Declared unsupported: its presence is refused with PushNotificationNotSupportedError. */
    readonly taskPushNotificationConfig?: unknown;
}

export interface SendMessageRequest {
    readonly tenant?: string;
    readonly message: A2aMessage;
    readonly configuration?: SendMessageConfiguration;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GetTaskRequest {
    readonly tenant?: string;
    readonly id: string;
    readonly historyLength?: number;
}

export interface ListTasksRequest {
    readonly tenant?: string;
    readonly contextId?: string;
    readonly status?: TaskState;
    readonly pageSize?: number;
    readonly pageToken?: string;
    readonly historyLength?: number;
    readonly statusTimestampAfter?: string;
    readonly includeArtifacts?: boolean;
}

export interface ListTasksResponse {
    readonly tasks: readonly A2aTask[];
    /** Empty string on the last page. */
    readonly nextPageToken: string;
    readonly pageSize: number;
    readonly totalSize: number;
}

export interface CancelTaskRequest {
    readonly tenant?: string;
    readonly id: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---- Agent Card -----------------------------------------------------------

export interface AgentProvider {
    readonly url: string;
    readonly organization: string;
}

export interface AgentExtension {
    readonly uri?: string;
    readonly description?: string;
    readonly required?: boolean;
    readonly params?: Readonly<Record<string, unknown>>;
}

/** The card's capability block — `A2a`-prefixed to keep clear of `@sigx/ai-agent`'s `AgentCapabilities`. */
export interface A2aAgentCapabilities {
    readonly streaming?: boolean;
    readonly pushNotifications?: boolean;
    readonly extensions?: readonly AgentExtension[];
    readonly extendedAgentCard?: boolean;
}

export interface AgentSkill {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly examples?: readonly string[];
    readonly inputModes?: readonly string[];
    readonly outputModes?: readonly string[];
    readonly securityRequirements?: readonly unknown[];
}

export interface AgentInterface {
    readonly url: string;
    /** `JSONRPC` | `GRPC` | `HTTP+JSON` | a URI for a custom binding. */
    readonly protocolBinding: string;
    readonly protocolVersion: string;
    readonly tenant?: string;
}

export interface AgentCard {
    readonly name: string;
    readonly description: string;
    readonly supportedInterfaces: readonly AgentInterface[];
    readonly provider?: AgentProvider;
    readonly version: string;
    readonly documentationUrl?: string;
    readonly capabilities: A2aAgentCapabilities;
    readonly securitySchemes?: Readonly<Record<string, unknown>>;
    readonly securityRequirements?: readonly unknown[];
    readonly defaultInputModes: readonly string[];
    readonly defaultOutputModes: readonly string[];
    readonly skills: readonly AgentSkill[];
    readonly signatures?: readonly unknown[];
    readonly iconUrl?: string;
}

// ---- JSON-RPC 2.0 ---------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly id?: JsonRpcId;
    readonly method: string;
    readonly params?: unknown;
}

export interface JsonRpcErrorObject {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
}

export type JsonRpcResponse =
    | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly result: unknown }
    | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly error: JsonRpcErrorObject };
