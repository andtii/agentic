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
import type { AgentId, ChangeScope, ChangeSet, ChatFile, ChatId, EnvironmentDescriptor, EnvironmentId, FsReadResult, FsReadRev, FsTreeResult, MachineId, MemoryEntry, MemoryQuery, MemoryScope, NewMemoryEntry, Principal, ProjectId, PromptPart, RankedMemory, ScheduleId, SessionId, TaskId, TaskStatus, UsageLimits, UsageLimitsQuery, WaitReason, WorkspaceAnswer } from '@agentic/core';

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
    /** The folder the session runs in (#190): within the environment's `cwdRoots` by the machine's path rules; it becomes the task's `workdir`. */
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
    /** The machine to run on (#414): the agent's account is resolved there, unless `environmentId` names one that machine reports. */
    readonly machineId?: MachineId;
    readonly context?: readonly PromptPart[];
    readonly constraints?: { readonly maxTurns?: number; readonly maxCostUsd?: number; readonly maxWallMs?: number };
}

export interface DelegateTaskInput {
    /** The parent task (must be active — a task the client opened or created). */
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    readonly objective: string;
    readonly context?: readonly PromptPart[];
    readonly constraints?: { readonly maxTurns?: number; readonly maxCostUsd?: number; readonly maxWallMs?: number };
    readonly environmentId?: EnvironmentId;
    /** The machine the child runs on (#414). Default: the parent's. */
    readonly machineId?: MachineId;
    /** Idempotency key: the same call id finds the same child (`childTaskId(parent, callId)`). Default: a fresh id. */
    readonly callId?: string;
}

/** One environment's doctor verdict as the machine last reported it; `verdict` absent = the daemon sent none. */
export interface DoctorReport {
    readonly machineId: MachineId;
    readonly online: boolean;
    readonly ok: boolean;
    readonly unverified: readonly EnvironmentId[];
    readonly environments: readonly {
        readonly environmentId: EnvironmentId;
        readonly name: string;
        readonly runtime: string;
        readonly verdict?: { readonly ok: boolean; readonly findings: readonly unknown[]; readonly checkedAt: number };
    }[];
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
    /** The machine a fired task runs on (#414); exclusive with `environmentId`. */
    readonly machineId?: MachineId;
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

/** A project as an external client sees it (#334): the catalogue entry, with the machines and environments it has folders on (#702). */
export interface ProjectSummary {
    readonly id: ProjectId;
    readonly name: string;
    readonly description?: string;
    /** The machines the project has a folder on, shared or for one environment (#702). */
    readonly machines: readonly MachineId[];
    /** The environments with a folder of their own: an override on a machine, or a pre-#702 folder by environment id. */
    readonly environments: readonly EnvironmentId[];
}

/** The port, one per authenticated request. */
export interface PlatformPort {
    readonly machines: {
        list(): Promise<readonly MachineSummary[]>;
    };
    readonly environments: {
        /** Every environment the workspace's machines report; narrowed to one machine when given. */
        list(machineId?: MachineId): Promise<readonly EnvironmentDescriptor[]>;
        /** The daemon's per-environment doctor verdicts as last reported on one machine (`Machine.doctor`, EXE-05/07). */
        doctor(machineId: MachineId, environmentId?: EnvironmentId): Promise<DoctorReport>;
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
        /**
         * The session's folder, read-only (#566) — the same `WorkspaceSource` calls the Changes and Files views make:
         * paths relative to the folder, `/`-separated, `''` the folder itself. A session with no folder on a machine (an
         * API runtime) throws; what the machine refuses (`outside-roots`, `not-found`, `not-a-repo`, `too-large`,
         * `unsupported`, …) comes back as the answer's `error`.
         */
        tree(sessionId: SessionId, path: string): Promise<WorkspaceAnswer<FsTreeResult>>;
        read(sessionId: SessionId, path: string, rev?: FsReadRev): Promise<WorkspaceAnswer<FsReadResult>>;
        changes(sessionId: SessionId, scope: ChangeScope): Promise<WorkspaceAnswer<ChangeSet>>;
    };
    readonly tasks: {
        create(input: CreateTaskInput): Promise<TaskSummary>;
        /** `Task.delegate` on the parent + `Routing.run` on the child; resolves with the child as created (the client polls `get` / `tree`). */
        delegate(input: DelegateTaskInput): Promise<TaskSummary>;
        get(taskId: TaskId): Promise<TaskSummary>;
        tree(taskId: TaskId): Promise<TaskTreeNode>;
        cancel(taskId: TaskId): Promise<{ readonly taskId: TaskId; readonly stopped: boolean; readonly notStopped: readonly TaskId[] }>;
    };
    readonly chats: {
        post(input: ChatPostInput): Promise<{ readonly messageId: string }>;
        history(chatId: ChatId, cursor: number | null, limit: number): Promise<ChatHistoryPage>;
        /**
         * `Chat.fileAccess` under this client (#209, CHT-04): the file's record
         * when the client may read it (every posted file, its own pending
         * uploads), `null` when it is missing or not visible. Absent: this host
         * cannot resolve chat files, and `chats_file_get` says so.
         */
        fileAccess?(chatId: ChatId, fileId: string): Promise<ChatFile | null>;
    };
    readonly memory: {
        search(scope: MemoryScope, query: MemoryQuery): Promise<readonly RankedMemory[]>;
        remember(scope: MemoryScope, entry: NewMemoryEntry): Promise<MemoryEntry>;
    };
    readonly schedules: {
        create(input: CreateScheduleInput): Promise<ScheduleSummary>;
    };
    readonly projects: {
        /** The workspace's projects (#334, `Workspace.projects`, read as the workspace's user like the machine index). */
        list(): Promise<readonly ProjectSummary[]>;
        /** `Chat.setProject` under this client: put the chat in a project, or in none with `null`; an unknown project is a 400. */
        setChatProject(chatId: ChatId, projectId: ProjectId | null): Promise<void>;
        /** `Chat.setMachine` under this client (#414): run the chat on a paired machine, or on none with `null`; an unknown machine is a 400. */
        setChatMachine(chatId: ChatId, machineId: MachineId | null): Promise<void>;
    };
    readonly usage: {
        /** Every account's provider limits as its machine last reported them (#272, OPS-07): machines → environments → `Machine.quota`. */
        limits(query: UsageLimitsQuery): Promise<UsageLimits>;
    };

    /** A project's plans (#751, the Plan actor under this client). Absent: this host has no Plan, and the surface declares no `plan_*` tool. */
    readonly plan?: import('./plan.js').PlanMcpPort;

    // slot #759 requests port — replace this line
}

/** The port for one authenticated client — the app binds it to the actors under this principal. */
export type PlatformPortFactory = (principal: ExternalPrincipal) => PlatformPort;
