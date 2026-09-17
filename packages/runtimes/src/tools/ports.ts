/**
 * The ports the platform tools call. Abstract on purpose: a tool never
 * touches an actor, so it runs — and is tested — with a fake port. The
 * Session actor (architecture §5a) supplies real ones that route into
 * Memory, Task and Chat under the agent's principal.
 */

import type { AgentId, Limits, MemoryEntry, MemoryQuery, MessageId, NewMemoryEntry, PromptPart, RankedMemory, TaskError, TaskId, TaskResult } from '@agentic/core';

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
}

/** A `delegate` call: the port tells the tool the child's id as soon as it exists, so the parent transcript can show it. */
export interface DelegateCall extends ToolCall {
    readonly onDelegated?: (taskId: TaskId) => void;
}

export type DelegateOutcome =
    | { readonly taskId: TaskId; readonly status: 'completed'; readonly result: TaskResult }
    | { readonly taskId: TaskId; readonly status: 'failed'; readonly error: TaskError }
    /** Cancelled — by the parent's stop cascade or the turn's abort; `notStopped` is the work that could not be confirmed stopped (COL-12). */
    | { readonly taskId: TaskId; readonly status: 'cancelled'; readonly notStopped: readonly TaskId[] };

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
    report(report: TaskReport, call: ToolCall): Promise<void>;
}

export interface ChatPost {
    readonly text: string;
    readonly mentions: readonly AgentId[];
}

export interface UserQuestion {
    readonly question: string;
    readonly choices?: readonly string[];
}

export interface ChatPort {
    /** Post a final message into the task's chat, attributed to the agent (CHT-08, COL-06). */
    post(post: ChatPost, call: ToolCall): Promise<{ readonly messageId: MessageId }>;
    /** Ask the user and wait; the platform parks the Task `waiting {input}` meanwhile (COL-06). */
    ask(question: UserQuestion, call: ToolCall): Promise<{ readonly answer: string }>;
}

export interface PlatformPorts {
    readonly memory: MemoryPort;
    readonly task: TaskPort;
    readonly chat: ChatPort;
}
