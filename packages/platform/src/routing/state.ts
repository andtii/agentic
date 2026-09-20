/**
 * Routing actor state (architecture §7): one `Route` per task the router
 * drives, from `run` until the task settles. Plain JSON saved whole with
 * `ctx.save()` at the end of every mutating turn.
 */

import type { AgentId, ApprovalRule, ChatId, EnvironmentId, FrozenAgentConfig, MachineId, OfflinePolicy, ProjectId, RuntimeId, SessionId, TaskId } from '@agentic/core';
import type { TaskReport } from '@agentic/runtimes';
import type { RegistryGate } from '../registry/types.js';

/**
 * Where a route stands:
 * - `waiting-offline`: the environment's machine is offline and the policy is `queue` — retried on its next `hello`.
 * - `waiting-capacity`: the machine queued the session — prompted when the daemon acknowledges it.
 * - `opening`: `session.open` went to the daemon — prompted on `session.opened`.
 * - `running`: the prompt is out; `follow` settles the task at the turn's end.
 * - `interrupted`: the turn was cut short by an eviction (OPS-05) — the task waits `{input, resume:{turnId}}`
 *   for a person's `resume`, which re-prompts the session and puts the route back to `running`.
 */
export type RouteStatus = 'waiting-offline' | 'waiting-capacity' | 'opening' | 'running' | 'interrupted';

export interface Route {
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    readonly chatId?: ChatId;
    /** The runtime the task runs on — the agent's, or `anthropic-api` after an explicit `fallback-api`. */
    runtime: RuntimeId;
    /** Fixed at the first resolution; a route never changes environment (EXE-12). */
    readonly environmentId?: EnvironmentId;
    /** The machine that reported `environmentId` — bound once a machine reports it, never rebound. */
    machineId?: MachineId;
    /**
     * The folder the session runs in (#190, #332), resolved once (EXE-12): the task's `workdir`, the project's
     * folder for the environment, a delegating parent's folder in the same environment, the agent's
     * `defaultWorkdir` in its default environment, else the environment's first `cwdRoots` entry — the last filled
     * in at placement when no machine reported the environment at `run`. A project feature plugin's `beforeSession`
     * may replace it at placement (a worktree, say). Always within the roots (`pathWithin`) before a session opens.
     */
    cwd?: string;
    /** The project the task belongs to (#332), from its contract; the record is read from the Workspace at `run` and at every placement. */
    readonly projectId?: ProjectId;
    /** `projectFolderFor(project, environmentId)` as resolved at `run` (EXE-12): the project's folder on this environment, when it has one. */
    readonly projectFolder?: string;
    readonly policy: OfflinePolicy;
    /** The configuration the session runs with (AGT-06/07), taken once at `run`. */
    readonly config: FrozenAgentConfig;
    /** For a delegated task: the approval rules of every ancestor's agent (the parent route's chain plus the parent's own) — the child session's policy never widens them. */
    readonly constraints?: readonly ApprovalRule[];
    /** What `Registry.gate()` answered for this route's runtime (§9) — asked once at `run`, again only when `fallback-api` changes the runtime; copied onto the session spec. */
    plugins?: RegistryGate;
    /**
     * Bound at placement (#393): a chat route takes the member's live session from the chat's binding
     * (`ChatSummary.sessions[agentId]`) when it can go on, else — and always for a chatless route — a fresh id is
     * minted. The same id is retried so `Machine.openSession` stays idempotent.
     */
    sessionId?: SessionId;
    /**
     * Set when the route reuses the chat's session (#393): the chat's `seenSeq` for the member at binding — the
     * entries after it are what its engine has not seen, so the prompt carries them instead of the task's context.
     * `0` means nothing seen in this session: the prompt carries everything from the member's `historyFrom`.
     */
    seenSeq?: number;
    /** The session's head as `open()` returned it at placement: `follow` tails from here, never from the start of a log that outlives the turn. */
    head?: { readonly epoch: number; readonly seq: number };
    status: RouteStatus;
    /** The turn `follow` waits for. */
    turnId?: string;
    readonly createdAt: number;
    updatedAt: number;
}

export interface RoutingState {
    v: 1;
    routes: Record<string, Route>;
    /** The latest `task_report` per task, used for the result when the turn ends `done`. */
    reports: Record<string, TaskReport>;
}

export function initialRoutingState(): RoutingState {
    return { v: 1, routes: {}, reports: {} };
}
