/** Tasks: the traceable unit of work (COL-04..12, EXE-11/12). */

import type { Limits } from './agent.js';
import type { PromptPart } from './chat.js';
import type { AgentId, ChatId, EnvironmentId, MessageId, ProjectId, SessionId, TaskId } from './ids.js';
import type { Usage } from './usage.js';

export type TaskStatus = 'queued' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/** Why a task is waiting (COL-05: "sufficient detail to explain why"). */
export type WaitReason =
    | { readonly kind: 'approval'; readonly requestId: string; readonly sessionId: SessionId }
    | { readonly kind: 'input'; readonly requestId: string; readonly sessionId?: SessionId }
    | { readonly kind: 'environment-offline'; readonly environmentId: EnvironmentId; readonly policy: 'queue' | 'fail' | 'fallback-api' }
    | { readonly kind: 'child'; readonly childTaskIds: readonly TaskId[] }
    | { readonly kind: 'capacity'; readonly environmentId: EnvironmentId; readonly position: number }
    | { readonly kind: 'budget'; readonly limit: keyof Limits }
    /** A project feature plugin's `beforeSession` threw (#329): parked with its message, never a silent fallback (EXE-12). */
    | { readonly kind: 'project-feature'; readonly pluginId: string; readonly message: string };

/** Where a task came from (COL-04 "originating agent or task"). */
export type TaskOrigin =
    | { readonly kind: 'user'; readonly chatId: ChatId; readonly messageId: MessageId }
    | { readonly kind: 'agent'; readonly agentId: AgentId; readonly taskId: TaskId; readonly sessionId: SessionId; readonly callId: string }
    | { readonly kind: 'schedule'; readonly scheduleId: string }
    | { readonly kind: 'trigger'; readonly triggerId: string }
    | { readonly kind: 'external'; readonly clientId: string };

/** The delegation contract (COL-04). */
export interface TaskContract {
    readonly objective: string;
    readonly origin: TaskOrigin;
    readonly assignee: AgentId;
    readonly context: readonly PromptPart[];
    readonly constraints: Limits;
    /** Free text or a JSON Schema the result must satisfy. */
    readonly expected?: string | JsonSchemaObject;
    readonly environmentId?: EnvironmentId;
    /**
     * The folder the task's session runs in (#185): absolute, machine-native, within
     * the `cwdRoots` of `environmentId` — which it requires. Absent: the router picks
     * (a delegating parent's folder, the agent's `defaultWorkdir`, else the first root).
     */
    readonly workdir?: string;
    /**
     * The project the task belongs to (#330): copied from the chat by the activation
     * contract, inherited by delegated children and carried by a schedule's fired task.
     * Without `workdir`, the router runs the session in the project's folder for the
     * resolved environment (before a parent's folder and the agent's default), merges the
     * project's connectors and runs its enabled feature plugins' `beforeSession`.
     */
    readonly projectId?: ProjectId;
    /**
     * An earlier session this task continues (#285): when the placement allows (same
     * runtime and environment), the router opens the task's session resuming that
     * session's engine conversation; otherwise it opens fresh and `context` carries on.
     */
    readonly resumeFrom?: SessionId;
}

export type JsonSchemaObject = { readonly type: 'object'; readonly [key: string]: unknown };

export interface ArtifactRef {
    readonly id: string;
    readonly name: string;
    readonly mediaType: string;
    readonly bytes?: number;
}

export interface TaskResult {
    readonly output?: unknown;
    readonly text?: string;
    readonly artifacts: readonly ArtifactRef[];
    /** Independently verified, not merely claimed (LRN-03). */
    readonly verified: boolean;
}

export interface TaskError {
    readonly code: string;
    readonly message: string;
    readonly recoverable: boolean;
}

export interface TaskTransition {
    readonly from: TaskStatus | null;
    readonly to: TaskStatus;
    readonly at: number;
    readonly by: string;
    readonly why?: string;
    readonly wait?: WaitReason;
}

/** The AC-05 shape: owner, objective, traceable origin, status, result. */
export interface TaskSnapshot extends TaskContract {
    readonly id: TaskId;
    readonly owner: AgentId;
    readonly depth: number;
    readonly status: TaskStatus;
    readonly wait?: WaitReason;
    readonly sessionId?: SessionId;
    readonly children: readonly TaskId[];
    readonly result?: TaskResult;
    readonly error?: TaskError;
    readonly cancel?: { readonly requestedAt: number; readonly by: string; readonly stopped: boolean };
    readonly usage: Usage;
    readonly costUsd: number;
    readonly configVersion: number;
    readonly transitions: readonly TaskTransition[];
}

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
    queued: ['active', 'waiting', 'failed', 'cancelled'],
    active: ['waiting', 'completed', 'failed', 'cancelled'],
    waiting: ['active', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: []
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TaskStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
}

/** A child task id is a pure function of its parent and the tool call that created it, so a restarted parent re-awaits the same child. */
export function childTaskId(parent: TaskId, callId: string): TaskId {
    return `${parent}.${callId}` as TaskId;
}
