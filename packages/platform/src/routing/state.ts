/**
 * Routing actor state (architecture §7): one `Route` per task the router
 * drives, from `run` until the task settles. Plain JSON saved whole with
 * `ctx.save()` at the end of every mutating turn.
 */

import type { AgentId, ApprovalRule, ChatId, EnvironmentId, FrozenAgentConfig, MachineId, OfflinePolicy, RuntimeId, SessionId, TaskId } from '@agentic/core';
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
     * The folder the session runs in (#190), resolved once (EXE-12): the task's `workdir`, a delegating parent's
     * folder in the same environment, the agent's `defaultWorkdir` in its default environment, else the
     * environment's first `cwdRoots` entry — the last filled in at placement when no machine reported the
     * environment at `run`. Always within the roots (`pathWithin`) before a session opens.
     */
    cwd?: string;
    readonly policy: OfflinePolicy;
    /** The configuration the session runs with (AGT-06/07), taken once at `run`. */
    readonly config: FrozenAgentConfig;
    /** For a delegated task: the approval rules of every ancestor's agent (the parent route's chain plus the parent's own) — the child session's policy never widens them. */
    readonly constraints?: readonly ApprovalRule[];
    /** What `Registry.gate()` answered for this route's runtime (§9) — asked once at `run`, again only when `fallback-api` changes the runtime; copied onto the session spec. */
    plugins?: RegistryGate;
    /** Allocated at placement; the same id is retried so `Machine.openSession` stays idempotent. */
    sessionId?: SessionId;
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
