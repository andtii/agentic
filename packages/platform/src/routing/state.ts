/**
 * Routing actor state (architecture §7): one `Route` per task the router
 * drives, from `run` until the task settles. Plain JSON saved whole with
 * `ctx.save()` at the end of every mutating turn.
 */

import type { AccountKey, AgentId, ApprovalRule, ChatId, EnvironmentId, FrozenAgentConfig, MachineId, OfflinePolicy, ProjectId, PromptPart, RuntimeId, SessionId, TaskId } from '@agentic/core';
import type { TaskReport } from '@agentic/runtimes';
import type { RegistryGate } from '../registry/types.js';

/**
 * Where a route stands:
 * - `waiting-offline`: the environment's machine is offline and the policy is `queue` — retried on its next `hello`.
 * - `waiting-capacity`: the environment has no free slot (#394) — the machine queued the session's open (prompted when
 *   the daemon acknowledges it), or the session is open and its prompt waits for a turn to end there (`slotFreed`).
 * - `opening`: `session.open` went to the daemon — prompted on `session.opened`.
 * - `waiting-turn`: the session runs another route's turn and its runtime cannot take a message into it (#395) —
 *   nothing was sent; the task waits `{turn, sessionId, turnId}` and the route is prompted when that turn ends.
 * - `running`: the prompt is out; `follow` settles the task at the turn's end.
 * - `waiting-answer`: a chat route's turn ended with its `ask_user` question still open (#396; the call answered
 *   `pending`) — the task stays `waiting {input}` and nothing follows the route until `deliverAnswer` prompts the
 *   session with the answer, under this same task.
 * - `interrupted`: the turn was cut short — by an eviction (OPS-05), or by its machine no longer hosting the session
 *   (#420: a daemon restart) — the task waits `{input, resume:{turnId}}` for a person's `resume`, which re-prompts the
 *   session and puts the route back to `running`; a session the machine lost is re-opened first (`rehosting`).
 */
export type RouteStatus = 'waiting-offline' | 'waiting-capacity' | 'opening' | 'waiting-turn' | 'running' | 'waiting-answer' | 'interrupted';

/** An answer the router holds for a route parked on another turn (#396): what `prompt` sends when that turn ends. */
export interface RouteAnswer {
    /** The platform request it answers (`ask:{callId}`). */
    readonly requestId: string;
    /** The turn it starts, `answerTurnId(taskId, requestId)` — deterministic, so a retried delivery runs once. */
    readonly turnId: string;
    readonly input: readonly PromptPart[];
}

export interface Route {
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    readonly chatId?: ChatId;
    /** The runtime the task runs on — the agent's, or `anthropic-api` after an explicit `fallback-api`. */
    runtime: RuntimeId;
    /** Fixed at the first resolution; a route never changes environment (EXE-12). */
    readonly environmentId?: EnvironmentId;
    /** The machine that reported `environmentId` — bound once a machine reports it (at `run` when the task named it, #414), never rebound. */
    machineId?: MachineId;
    /** The machine the task asked for (#414: the chat's, a delegating parent's, a schedule's), for the record — `machineId` is where it landed. */
    readonly requestedMachineId?: MachineId;
    /** The account the environment was resolved by (#414, `accountKeyOf`): the agent's, or its pinned environment's; absent when the environment was named outright. */
    readonly account?: AccountKey;
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
    /**
     * The turn `follow` waits for: the route's own `{taskId}:turn:1`, or — when the prompt steered into a turn
     * already running on the session (#395, `joined`) — that turn's id, shared with the route that started it.
     */
    turnId?: string;
    /** The prompt joined a running turn (#395): `turnId` is another route's, and this task settles when it ends. */
    joined?: boolean;
    /**
     * How many times the machine refused this route's prompt `busy` (#394): the next one goes out under the command id
     * `{turnId}#{attempt}`, since the Session answers a known command id with what it answered before — the turn id
     * stays, so `follow` keeps waiting for the same `turn-end`.
     */
    attempt?: number;
    /**
     * While `interrupted` (#420): `resume` re-opened the session on its machine — the record's spec, the ref as
     * `spec.resume` — and the prompt goes out when the daemon acknowledges it (`sessionOpened`). A daemon that closes
     * it instead sends the task to a fresh session (`sessionClosed`).
     */
    rehosting?: boolean;
    /** While `waiting-answer` (#396): the platform request the turn left open — the question this task waits an answer to. */
    question?: string;
    /** While `waiting-turn` after a `deliverAnswer` (#396): the answer to send when the turn ends, in place of the task's own input. */
    answer?: RouteAnswer;
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
