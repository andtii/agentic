/** Task actor state, log entries and method shapes (architecture §4 Task, §7). */

import type {
    AgentId,
    EnvironmentId,
    JsonSchemaObject,
    Limits,
    ProjectId,
    PromptPart,
    SessionId,
    SessionOptions,
    TaskContract,
    MachineId,
    TaskError,
    TaskId,
    TaskOrigin,
    TaskResult,
    TaskSnapshot,
    TaskStatus,
    TaskTransition,
    Usage,
    WaitReason,
    WorkspaceId
} from '@agentic/core';

/** What `create` needs beyond the contract. */
export interface TaskInit {
    /** The agent responsible for the outcome (COL-07): the delegating agent for a child, the assignee for a root task. */
    readonly owner: AgentId;
    readonly depth?: number;
    readonly parentId?: TaskId;
    readonly configVersion?: number;
}

/** `delegate(spec)` — what the DelegateTool hands the parent task (architecture §7). */
export interface DelegateSpec {
    /** The tool call id; the child id is `childTaskId(parentId, callId)`, so a restarted parent re-awaits the same child. */
    readonly callId: string;
    readonly objective: string;
    readonly assignee: AgentId;
    readonly context?: readonly PromptPart[];
    /** Requested limits; clamped to the parent's remaining budget, never widened. */
    readonly constraints?: Limits;
    readonly expected?: string | JsonSchemaObject;
    readonly environmentId?: EnvironmentId;
    /** The machine the child runs on (#414). Absent: the parent's — its task's, else its route's, where the router resolves the child's own account. */
    readonly machineId?: MachineId;
    /** The child's folder (#190), within the roots of its environment (`environmentId`, else the parent's). Absent: the router picks — the parent's folder when the child lands in the parent's environment. */
    readonly workdir?: string;
    /** The child's project (#332). Absent: the parent's, when it has one. */
    readonly projectId?: ProjectId;
    /** The delegating session; defaults to the parent's own. */
    readonly sessionId?: SessionId;
    /** Defaults to the parent's assignee. */
    readonly owner?: AgentId;
}

export interface CancelOptions {
    /** How long the cascade waits for acknowledgements before listing stragglers. Default `DEFAULT_STOP_TIMEOUT_MS`. */
    readonly timeoutMs?: number;
}

/** What `cancel` resolves to (COL-12): `notStopped` is the work that could not be confirmed stopped, this task included. */
export interface StopReport {
    readonly id: TaskId;
    readonly stopped: boolean;
    readonly notStopped: readonly TaskId[];
}

/** One node of `tree()` (COL-09). */
export interface TaskTree {
    readonly id: TaskId;
    readonly status: TaskStatus;
    readonly wait?: WaitReason;
    readonly owner: AgentId;
    readonly assignee: AgentId;
    readonly objective: string;
    readonly depth: number;
    readonly stopped?: boolean;
    readonly children: readonly TaskTree[];
}

/** `get()`: the AC-05 snapshot plus the delegation link and the stop bookkeeping. */
export interface TaskView extends TaskSnapshot {
    readonly parentId?: TaskId;
    readonly notStopped: readonly TaskId[];
}

/** What the `result` stream yields once, on the terminal state. */
export interface TaskOutcome {
    readonly id: TaskId;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly result?: TaskResult;
    readonly error?: TaskError;
    readonly cancel?: TaskSnapshot['cancel'];
}

/** One entry of the append log; `applyTaskEntry` folds it into the state. */
export type TaskEntry =
    | {
          readonly t: 'created';
          readonly at: number;
          readonly contract: TaskContract;
          readonly owner: AgentId;
          readonly depth: number;
          readonly parentId?: TaskId;
          readonly configVersion: number;
      }
    | {
          readonly t: 'transition';
          readonly from: TaskStatus;
          readonly to: TaskStatus;
          readonly at: number;
          readonly by: string;
          readonly why: string;
          readonly wait?: WaitReason;
          readonly sessionId?: SessionId;
          readonly result?: TaskResult;
          readonly error?: TaskError;
      }
    | { readonly t: 'wait'; readonly at: number; readonly wait: WaitReason }
    | { readonly t: 'child'; readonly at: number; readonly id: TaskId; readonly constraints: Limits }
    | { readonly t: 'child-settled'; readonly at: number; readonly id: TaskId; readonly status: TaskStatus }
    | { readonly t: 'cancel'; readonly at: number; readonly by: string; readonly deadline: number }
    | { readonly t: 'cancel-settled'; readonly at: number; readonly stopped: boolean; readonly notStopped: readonly TaskId[] }
    | {
          readonly t: 'child-stopped';
          readonly at: number;
          readonly id: TaskId;
          readonly stopped: boolean;
          readonly notStopped: readonly TaskId[];
      }
    | { readonly t: 'session-stopped'; readonly at: number }
    | { readonly t: 'usage'; readonly at: number; readonly usage: Usage; readonly costUsd: number };

export interface TaskState {
    created: boolean;
    readonly id: TaskId;
    readonly workspaceId: WorkspaceId;
    objective: string;
    origin: TaskOrigin;
    assignee: AgentId;
    context: PromptPart[];
    constraints: Limits;
    expected?: string | JsonSchemaObject;
    environmentId?: EnvironmentId;
    /** The machine the task runs on (#414): the chat's, a delegating parent's or a schedule's. */
    machineId?: MachineId;
    /** The folder the task's session runs in (#190); only with `environmentId`. */
    workdir?: string;
    /** The project the task belongs to (#330/#332): the router resolves its folder for the environment when `workdir` is absent. */
    projectId?: ProjectId;
    /** The earlier session whose engine conversation this task continues (#285). */
    resumeFrom?: SessionId;
    /** The model and permission mode its session runs with (#453), from the contract; the chat member's own win at placement. */
    options?: SessionOptions;
    owner: AgentId;
    depth: number;
    parentId?: TaskId;
    configVersion: number;
    status: TaskStatus;
    wait?: WaitReason;
    sessionId?: SessionId;
    /** The session driver confirmed the running work stopped (`sessionStopped()`), or nothing ever ran. */
    sessionStopped: boolean;
    startedAt?: number;
    children: TaskId[];
    /** Budget reserved by children that have not settled, by child id. */
    live: Record<string, Limits>;
    result?: TaskResult;
    error?: TaskError;
    cancel?: { requestedAt: number; by: string; stopped: boolean; deadline: number; settled: boolean };
    notStopped: TaskId[];
    usage: Usage;
    costUsd: number;
    transitions: TaskTransition[];
}
