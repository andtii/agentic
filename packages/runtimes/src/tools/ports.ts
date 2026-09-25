/**
 * The ports the platform tools call. Abstract on purpose: a tool never
 * touches an actor, so it runs — and is tested — with a fake port. The
 * Session actor (architecture §5a) supplies real ones that route into
 * Memory, Task and Chat under the agent's principal.
 */

import type { AgentId, ChatFileRead, ChatId, EnvironmentId, Limits, MachineId, MemoryEntry, MemoryQuery, MessageId, NewMemoryEntry, ProjectId, PromptPart, RankedMemory, TaskError, TaskId, TaskResult, TaskStatus, UsageLimits, UsageLimitsQuery } from '@agentic/core';

/** What every port call learns about the tool call behind it. */
export interface ToolCall {
    /** The model's call id — the idempotency key for anything the port creates (a child task, say). */
    readonly callId: string;
    /** Fires when the turn is cancelled; a long call (delegate, ask) must stop. */
    readonly signal: AbortSignal;
}

export interface MemoryPort {
    /** Runs under the agent's principal against its own scope plus its shared scopes (MEM-11). */
    search(query: MemoryQuery, call: ToolCall): Promise<readonly RankedMemory[]>;
    /** The port stamps provenance `at`, `sessionId` and `taskId`; the tool supplies the rest. */
    remember(entry: NewMemoryEntry, call: ToolCall): Promise<MemoryEntry>;
}

/** What the model asks for when it delegates (COL-04, minus what the platform fills in). */
export interface DelegateSpec {
    readonly assignee: AgentId;
    readonly objective: string;
    readonly context: readonly PromptPart[];
    /** Never wider than the parent's; the port clamps (architecture §7). */
    readonly constraints: Limits;
    readonly expected?: string;
    /** Where the child runs (#190): an environment, and a folder within its roots (which needs the environment). Absent: the child's own defaults, and the parent's folder when it lands in the parent's environment. */
    readonly environmentId?: EnvironmentId;
    /** The machine the child runs on (#414), where its account is resolved. Absent: the parent's. */
    readonly machineId?: MachineId;
    readonly workdir?: string;
    /** The project the child works in (#332). Absent: the parent task's, when it has one. */
    readonly projectId?: ProjectId;
    /**
     * Follow a child an earlier `delegate` answered `running` (#599): wait for THIS task again instead of creating one.
     * The port checks it is a child this agent delegated to `assignee`; nothing new is created or routed.
     */
    readonly follow?: TaskId;
}

/** One environment a delegate's assignee can run in (#599): what a refusal names so the caller's retry can fill `environmentId`. */
export interface DelegateEnvironment {
    readonly id: EnvironmentId;
    readonly machineId: MachineId;
    readonly machineName?: string;
    readonly cwdRoots: readonly string[];
    readonly online: boolean;
}

/** A `delegate` call: the port tells the tool the child's id as soon as it exists, so the parent transcript can show it. */
export interface DelegateCall extends ToolCall {
    readonly onDelegated?: (taskId: TaskId) => void;
}

export type DelegateOutcome =
    | { readonly taskId: TaskId; readonly status: 'completed'; readonly result: TaskResult }
    | { readonly taskId: TaskId; readonly status: 'failed'; readonly error: TaskError }
    /** Cancelled — by the parent's stop cascade or the turn's abort; `notStopped` is the work that could not be confirmed stopped (COL-12). */
    | { readonly taskId: TaskId; readonly status: 'cancelled'; readonly notStopped: readonly TaskId[] }
    /**
     * Still running when the port stopped waiting (#599): its wait window passed — under the engine's own tool-call
     * timeout, so the caller keeps the child's id. The child goes on; `follow` waits for it again.
     */
    | { readonly taskId: TaskId; readonly status: 'running' };

export interface TaskReport {
    readonly status: 'progress' | 'blocked' | 'done';
    readonly summary: string;
    /** A result the task should carry when `done`. */
    readonly output?: unknown;
}

export interface TaskPort {
    /**
     * Create the child `(parentTaskId, callId)`, move the parent to
     * `waiting {child}`, and settle when the child does — idempotent across
     * restarts because the id is deterministic (architecture §7).
     */
    delegate(spec: DelegateSpec, call: DelegateCall): Promise<DelegateOutcome>;
    /** The environments `assignee` can run in (#599), named when a delegate is refused for its environment. Absent: none are named. */
    environments?(assignee: AgentId): Promise<readonly DelegateEnvironment[]>;
    report(report: TaskReport, call: ToolCall): Promise<void>;
}

export interface ChatPost {
    readonly text: string;
    readonly mentions: readonly AgentId[];
    /** `agentic-file:` URIs of files the agent can see, attached to the post (#203). */
    readonly attachments?: readonly string[];
}

export interface UserQuestion {
    readonly question: string;
    readonly choices?: readonly string[];
}

/**
 * What `ask_user` answers (#285): the user's answer, or `pending` when none came within the quick window —
 * the question outlives the call, and the answer re-activates the asking agent in its chat.
 */
export type AskOutcome = { readonly answer: string } | { readonly status: 'pending'; readonly questionId: string; readonly note: string };

/** What a post did (#222): the message, the members its mentions started a task for, and those it could not. */
export interface ChatPostResult {
    readonly messageId: MessageId;
    /** One task per mentioned member that was activated; its reply comes back into the chat when its turn ends. */
    readonly activated?: readonly { readonly agentId: AgentId; readonly taskId: TaskId; readonly status: TaskStatus }[];
    /** Mentioned members that were not activated, and why (not a collaborator, depth limit, failed to start). */
    readonly notActivated?: readonly { readonly agentId: AgentId; readonly reason: string }[];
}

export interface ChatPort {
    /** Post a message into the task's chat, attributed to the agent; a mentioned collaborator is activated (CHT-06, COL-06, #222). */
    post(post: ChatPost, call: ToolCall): Promise<ChatPostResult>;
    /**
     * Ask the user (COL-06, #285): the answer when it comes within a short window, else `pending` — the question
     * stays open, the agent ends its turn, and the answer starts it again in the chat.
     */
    ask(question: UserQuestion, call: ToolCall): Promise<AskOutcome>;
}

/** Chat attachments (#203): read a file of the task's chat under the agent's principal. */
export interface ChatFilesPort {
    /** Throws when the URI is malformed, the file is missing, or the agent may not see the message it was posted in. */
    read(uri: string, call: ToolCall): Promise<ChatFileRead>;
}

/** Provider limits per account (#272): the machines' latest quota snapshots, read under the agent's principal. */
export interface UsagePort {
    limits(query: UsageLimitsQuery, call: ToolCall): Promise<UsageLimits>;
}

/** A project as the `projects` tool lists it (#334): the catalogue entry, with the machines and environments it has folders on (#702). */
export interface ProjectSummary {
    readonly id: ProjectId;
    readonly name: string;
    readonly description?: string;
    /** The machines the project has a folder on, shared or for one environment (#702). */
    readonly machines: readonly MachineId[];
    /** The environments with a folder of their own: an override on a machine, or a pre-#702 folder by environment id. */
    readonly environments: readonly EnvironmentId[];
}

/** The project a chat is in, as `Chat.get()` reports it; `name` is absent when the Workspace no longer has the project. */
export interface ChatProject {
    readonly id: ProjectId;
    readonly name?: string;
}

/**
 * Projects for the coordinator (#334, COL-02/04): the registered projects are listed and one is set on a chat;
 * matching a project to what the user wrote is the model's job, never the port's.
 */
export interface ProjectPort {
    /** The workspace's projects, read as the workspace's user (the Workspace admits its owner only). */
    list(call: ToolCall): Promise<readonly ProjectSummary[]>;
    /** The chat's current project, under the agent's principal; `null` when it is in none. */
    current(chatId: ChatId, call: ToolCall): Promise<ChatProject | null>;
    /** `Chat.setProject` under the agent's principal (a member of the chat, else forbidden); `null` leaves the project. Audited by the chat as `chat.project-set`. */
    set(chatId: ChatId, projectId: ProjectId | null, call: ToolCall): Promise<void>;
}

export interface PlatformPorts {
    readonly memory: MemoryPort;
    readonly task: TaskPort;
    readonly chat: ChatPort;
    /** Absent on hosts without a file store — `chat_file_read` then reports it unavailable. */
    readonly files?: ChatFilesPort;
    /** Absent on hosts without machines — `usage_limits` then reports it unavailable. */
    readonly usage?: UsagePort;
    /** Absent on hosts without a Workspace — `projects` then reports it unavailable. */
    readonly projects?: ProjectPort;

    /** Absent where the session's project has no Plan (#751) — the `plan_*` tools then report it unavailable. */
    readonly plan?: import('./plan.js').PlanPort;

    /** Absent where the session is in no project or the host has no Requests actor (#759) — the `requests_*` tools and `projects_request` then report it unavailable. */
    readonly requests?: import('./requests.js').RequestsPort;
}
