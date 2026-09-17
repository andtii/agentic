/**
 * `PlatformPort` — what the orchestration surface calls into (architecture
 * §9). Every platform capability is an actor method; this port is the thin
 * projection the MCP tools speak to, built PER PRINCIPAL so the actors'
 * own `authorize` chains run under the external client's identity. Tests
 * hand in fakes; `apps/web` binds it to `actor()` over the registry.
 *
 * The shapes are deliberately plain (JSON-serializable, no branded ids on
 * the wire beyond strings) — they are what an external client sees.
 */
import type { AgentId, ChatId, EnvironmentDescriptor, EnvironmentId, MachineId, MemoryEntry, MemoryQuery, MemoryScope, NewMemoryEntry, Principal, PromptPart, RankedMemory, ScheduleId, SessionId, TaskId, TaskStatus, WaitReason } from '@agentic/core';

export type ExternalPrincipal = Extract<Principal, { kind: 'external' }>;

export interface MachineSummary {
    readonly machineId: MachineId;
    readonly name: string;
    readonly online: boolean;
    readonly os?: string;
    readonly lastSeen?: number;
    readonly daemonVersion?: string;
    readonly environments: readonly EnvironmentDescriptor[];
}

export interface AgentSummary {
    readonly agentId: AgentId;
    readonly name: string;
    readonly runtime: string;
    readonly defaultEnvironmentId?: EnvironmentId;
    readonly exposeA2A?: boolean;
}

export interface OpenSessionInput {
    readonly agentId: AgentId;
    /** Explicit, always (EXE-12): the machine that must host the session. */
    readonly machineId: MachineId;
    readonly environmentId: EnvironmentId;
    readonly cwd?: string;
    /** The task objective; the first prompt when given. Default: a generic "interactive session" objective. */
    readonly objective?: string;
}

export interface TaskSummary {
    readonly taskId: TaskId;
    readonly status: TaskStatus;
    readonly assignee: AgentId;
    readonly owner: AgentId;
    readonly objective: string;
    readonly environmentId?: EnvironmentId;
    readonly sessionId?: SessionId;
    readonly wait?: WaitReason;
    readonly result?: unknown;
    readonly error?: { readonly code: string; readonly message: string };
    readonly children: readonly TaskId[];
    readonly parentId?: TaskId;
    readonly createdAt?: number;
}

export interface TaskTreeNode {
    readonly taskId: TaskId;
    readonly status: TaskStatus;
    readonly assignee: AgentId;
    readonly objective: string;
    readonly depth: number;
    readonly wait?: WaitReason;
    readonly children: readonly TaskTreeNode[];
}

export interface CreateTaskInput {
    readonly agentId: AgentId;
    readonly objective: string;
    readonly environmentId?: EnvironmentId;
    readonly context?: readonly PromptPart[];
    readonly constraints?: { readonly maxTurns?: number; readonly maxCostUsd?: number; readonly maxWallMs?: number };
}

export interface EventCursor {
    readonly epoch: number;
    readonly seq: number;
}

export interface SessionEventsPage {
    readonly sessionId: SessionId;
    readonly status: string;
    readonly events: readonly unknown[];
    /** Where to continue from — pass as `from` on the next call. */
    readonly next: EventCursor;
    /** More events were available than `limit` allowed. */
    readonly truncated: boolean;
}

export type RespondDecision =
    | { readonly type: 'permission'; readonly outcome: 'allow' | 'deny'; readonly scope?: 'once' | 'session'; readonly message?: string }
    | { readonly type: 'input'; readonly answers: unknown };

export interface CommandOutcome {
    readonly commandId: string;
    /** `ack` (done), `pending` (a daemon has yet to answer), or `error`. */
    readonly kind: string;
    readonly code?: string;
    readonly message?: string;
}

export interface ChatPostInput {
    readonly chatId: ChatId;
    readonly text: string;
    readonly mentions?: readonly AgentId[] | 'all';
}

export interface ChatHistoryPage {
    readonly entries: readonly unknown[];
    readonly next: number | null;
}

export interface CreateScheduleInput {
    readonly title: string;
    readonly kind: 'reminder' | 'recurring' | 'agent-task';
    readonly recurrence: { readonly kind: 'at'; readonly at: number } | { readonly kind: 'cron'; readonly cron: string; readonly tz: string };
    readonly agentId?: AgentId;
    readonly environmentId?: EnvironmentId;
    readonly prompt?: string;
    readonly offlinePolicy?: 'queue' | 'fail' | 'fallback-api';
}

export interface ScheduleSummary {
    readonly scheduleId: ScheduleId;
    readonly title: string;
    readonly kind: string;
    readonly enabled: boolean;
    readonly next: number | null;
}

/** The port, one per authenticated request. */
export interface PlatformPort {
    readonly machines: {
        list(): Promise<readonly MachineSummary[]>;
    };
    readonly environments: {
        /** Every environment the workspace's machines report; narrowed to one machine when given. */
        list(machineId?: MachineId): Promise<readonly EnvironmentDescriptor[]>;
    };
    readonly agents: {
        list(): Promise<readonly AgentSummary[]>;
        get(agentId: AgentId): Promise<unknown>;
    };
    readonly sessions: {
        /** Task.create + Routing.run on the named machine/environment; resolves with the task and, once routed, its session. */
        open(input: OpenSessionInput): Promise<TaskSummary>;
        prompt(sessionId: SessionId, text: string): Promise<CommandOutcome & { readonly turnId: string }>;
        respond(sessionId: SessionId, requestId: string, decision: RespondDecision): Promise<CommandOutcome>;
        cancel(sessionId: SessionId): Promise<CommandOutcome>;
        tail(sessionId: SessionId, from: EventCursor | undefined, limit: number): Promise<SessionEventsPage>;
    };
    readonly tasks: {
        create(input: CreateTaskInput): Promise<TaskSummary>;
        get(taskId: TaskId): Promise<TaskSummary>;
        tree(taskId: TaskId): Promise<TaskTreeNode>;
        cancel(taskId: TaskId): Promise<{ readonly taskId: TaskId; readonly stopped: boolean; readonly notStopped: readonly TaskId[] }>;
    };
    readonly chats: {
        post(input: ChatPostInput): Promise<{ readonly messageId: string }>;
        history(chatId: ChatId, cursor: number | null, limit: number): Promise<ChatHistoryPage>;
    };
    readonly memory: {
        search(scope: MemoryScope, query: MemoryQuery): Promise<readonly RankedMemory[]>;
        remember(scope: MemoryScope, entry: NewMemoryEntry): Promise<MemoryEntry>;
    };
    readonly schedules: {
        create(input: CreateScheduleInput): Promise<ScheduleSummary>;
    };
}

/** The port for one authenticated client — the app binds it to the actors under this principal. */
export type PlatformPortFactory = (principal: ExternalPrincipal) => PlatformPort;
