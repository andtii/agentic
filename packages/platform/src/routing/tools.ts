/**
 * The platform tool ports over the actors (architecture §5a/§5b): what
 * `memory_search`, `memory_remember`, `chat_post`, `task_report` and
 * `delegate` do when an agent calls them — on the local path from inside
 * `modelAgent`, on the daemon path from the Machine's `tool.call`. Every hop
 * is a FRESH actor call under the agent principal (`mintAgentPrincipal`),
 * never a `ctx.actor` hop: a tool runs outside any turn (a detached driver,
 * a socket callback), and Memory / Chat / Task authorize the agent, not
 * whoever opened the session.
 *
 * `delegate` (§7, COL-03/07/08/10): the parent agent's collaborators are
 * checked, `Task.delegate` creates the child `(parentTaskId, callId)` under
 * the limits and parks the parent `waiting {child}`, `Routing.run` places
 * the child on ITS runtime and environment (outside any chat — background
 * work whose record is the Task tree), and the port awaits the child's
 * `result` stream. Idempotent across restarts: the same call id finds the
 * same child and re-awaits it. An aborted turn (the parent's stop cascade)
 * answers `cancelled` with what could not be confirmed stopped.
 *
 * `ask_user` (#122, COL-06, CHT-09): the port has no way into the engine's
 * own request flow, so it asks the Session to raise an `input` request for
 * the call (`raiseInput`, idempotent by call id), then tails `resolution`
 * until a person answers through `Session.respond` from any client — the
 * answer is the tool result; a cancel (the turn ended, the session closed) is
 * a `cancelled` error. Without a Session definition it stays `unsupported`
 * and says so; the tool never silently succeeds.
 */

import { actorKey, isTerminal, type AgentId, type ChatId, type MemoryEntry, type Principal, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import type { DelegateCall, DelegateOutcome, DelegateSpec, PlatformPorts, TaskReport } from '@agentic/runtimes';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { isServerFnError } from '@sigx/server';

import { AgentActor, agentKey, agentMemoryScope } from '../agent/index.js';
import { asPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { ToolCallError } from '../machine/ports.js';
import { Memory, memoryActorKey } from '../memory/index.js';
import type { RequestResolvedEvent } from '../policy/requests.js';
import type { PlatformInputRequest, PlatformRequestRef } from '../session/actor.js';
import { TaskActor, taskKey, type TaskOutcome, type TaskView } from '../task/index.js';
import { routingKey } from './key.js';

export type AgentPrincipal = Extract<Principal, { kind: 'agent' }>;

/** The slice of the Routing actor a tool port calls (`defineRoutingActor`). */
interface RoutingClient {
    report(taskId: TaskId, report: TaskReport): Promise<void>;
    run(taskId: TaskId): Promise<TaskView>;
}

/** The slice of the Session actor `ask_user` uses (`defineSessionActor`). */
interface SessionAskClient {
    raiseInput(input: PlatformInputRequest): Promise<PlatformRequestRef>;
    resolution(requestId: string): AsyncIterable<RequestResolvedEvent>;
}

export interface ActorToolPortsOptions {
    /** Whose tools these are — the session's agent principal (workspace, agent, session, task?). */
    readonly principal: AgentPrincipal;
    /** The chat the session belongs to; without one `chat_post` is refused. */
    readonly chatId?: ChatId;
    /** The Routing actor definition, for `task_report` and `delegate`; without it both are refused. */
    readonly routing?: () => AnyActorDefinition;
    /** The Session actor definition, for `ask_user`; without it the question is refused as unsupported. */
    readonly sessions?: () => AnyActorDefinition;
}

export function agentChatKey(workspaceId: WorkspaceId, chatId: ChatId): string {
    return `${workspaceId}:chat:${chatId}`;
}

/** The Task actor's own errors carry a `code`; map them onto the codes a daemon (and the model) sees. */
function asToolCallError(e: unknown): unknown {
    if (e instanceof ToolCallError) return e;
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    const message = e instanceof Error ? e.message : String(e);
    if (code === 'limit') return new ToolCallError('limit', `delegate: ${message}`);
    if (code === 'not-active' || code === 'wrong-state' || code === 'no-session' || code === 'not-created') return new ToolCallError('invalid', `delegate: ${message}`);
    return e;
}

/** The child's terminal state as the tool sees it (COL-07): its result, its error, or the cancellation and its stragglers. */
function outcomeOf(child: TaskView | TaskOutcome, notStopped: readonly TaskId[] = []): DelegateOutcome {
    switch (child.status) {
        case 'completed':
            return { taskId: child.id, status: 'completed', result: child.result ?? { artifacts: [], verified: false } };
        case 'failed':
            return { taskId: child.id, status: 'failed', error: child.error ?? { code: 'failed', message: 'the task failed', recoverable: false } };
        default:
            return { taskId: child.id, status: 'cancelled', notStopped: [...new Set([...notStopped, ...('notStopped' in child ? child.notStopped : [])])] };
    }
}

/** An input decision's `answers` as the text the model reads: a string as is, a choice list joined, anything else as JSON. */
export function answerText(answers: unknown): string {
    if (typeof answers === 'string') return answers;
    if (Array.isArray(answers) && answers.every((a) => typeof a === 'string')) return answers.join(', ');
    return JSON.stringify(answers) ?? '';
}

/** The tool ports of one agent session, bound to the actors. */
export function createActorToolPorts(options: ActorToolPortsOptions): PlatformPorts {
    const { principal, chatId } = options;
    const { workspaceId, agentId, sessionId, taskId } = principal;
    const as = <D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D> => actor(def, key).with({ context: asPrincipal(principal) }) as ActorClientWith<D>;
    const memory = () => as(Memory, memoryActorKey(workspaceId, agentMemoryScope(agentId)));
    const task = (id: TaskId) => as(TaskActor, taskKey(workspaceId, id));
    const routing = (what: string): RoutingClient => {
        const def = options.routing?.();
        if (!def) throw new ToolCallError('unsupported', `${what}: the router is not wired on this deployment`);
        return actor(def, routingKey(workspaceId)).with({ context: asPrincipal(principal) }) as unknown as RoutingClient;
    };

    /** The decision on a platform-raised request, or `undefined` when the session closed or the turn was aborted before one came. */
    async function awaitResolution(s: SessionAskClient, requestId: string, signal: AbortSignal): Promise<RequestResolvedEvent | undefined> {
        const it = s.resolution(requestId)[Symbol.asyncIterator]();
        const aborted = new Promise<'aborted'>((resolve) => {
            if (signal.aborted) resolve('aborted');
            else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        try {
            const next = await Promise.race([it.next(), aborted]);
            return next !== 'aborted' && !next.done ? next.value : undefined;
        } finally {
            await it.return?.().catch(() => undefined);
        }
    }

    /** Wait for the child's terminal state, or for the parent turn to be aborted — whichever comes first. */
    async function awaitChild(childId: TaskId, signal: AbortSignal): Promise<DelegateOutcome> {
        const it = task(childId).result()[Symbol.asyncIterator]();
        const aborted = new Promise<'aborted'>((resolve) => {
            if (signal.aborted) resolve('aborted');
            else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        try {
            const next = await Promise.race([it.next(), aborted]);
            if (next !== 'aborted' && !next.done) return outcomeOf(next.value);
        } finally {
            await it.return?.().catch(() => undefined);
        }
        // The parent's turn is over (its task was cancelled, or the session went away): report the child as it stands —
        // a child not yet terminal, or cancelled without every stop confirmed, is work that could not be confirmed stopped (COL-12).
        const child = await task(childId).get();
        if (child.status === 'completed' || child.status === 'failed') return outcomeOf(child);
        const straggler = !isTerminal(child.status) || (child.cancel !== undefined && !child.cancel.stopped);
        return outcomeOf({ ...child, status: 'cancelled' }, straggler ? [childId] : []);
    }

    return {
        memory: {
            search: (query) => memory().query(query),
            remember: (entry): Promise<MemoryEntry> =>
                memory().put({
                    ...entry,
                    provenance: { ...entry.provenance, ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) }
                })
        },
        chat: {
            async post(post) {
                if (!chatId) throw new ToolCallError('unsupported', 'chat_post: this session belongs to no chat');
                const result = await as(Chat, agentChatKey(workspaceId, chatId)).post(post.text, post.mentions, taskId ? { taskId } : {});
                return { messageId: result.messageId };
            },
            async ask(question, call) {
                const def = options.sessions?.();
                if (!def) throw new ToolCallError('unsupported', 'ask_user: the Session actor is not wired on this deployment');
                if (!sessionId) throw new ToolCallError('unsupported', 'ask_user: this call belongs to no session');
                const s = as(def, actorKey(workspaceId, 'session', sessionId as SessionId)) as unknown as SessionAskClient;
                const choices = question.choices?.map((c) => ({ id: c, label: c }));
                const { requestId, resolved } = await s.raiseInput({ callId: call.callId, message: question.question, toolName: 'ask_user', ...(choices ? { options: choices } : {}) });
                const decision = resolved ?? (await awaitResolution(s, requestId, call.signal));
                if (!decision) throw new ToolCallError('cancelled', 'ask_user: the turn ended before the user answered');
                if (decision.outcome !== 'input') throw new ToolCallError('cancelled', `ask_user: the question was ${decision.outcome === 'cancel' ? 'cancelled' : decision.outcome}${decision.reason ? ` (${decision.reason})` : ''}`);
                return { answer: answerText(decision.answers) };
            }
        },
        task: {
            async delegate(spec: DelegateSpec, call: DelegateCall): Promise<DelegateOutcome> {
                if (!taskId) throw new ToolCallError('unsupported', 'delegate: this session works no task');
                const router = routing('delegate');
                // Collaborator access (COL-10): the parent agent's config says who it may delegate to.
                const { config } = await as(AgentActor, agentKey(workspaceId, agentId)).get();
                if (config.collaborators !== 'all' && !config.collaborators.includes(spec.assignee)) {
                    throw new ToolCallError('forbidden', `delegate: agent ${agentId} may not delegate to ${spec.assignee} (not a collaborator)`);
                }
                // An id that names no configured agent is the caller's mistake, said before a child task exists — not a
                // failed child with an `agent-unconfigured` the model cannot tell from a platform fault.
                try {
                    await as(AgentActor, agentKey(workspaceId, spec.assignee as AgentId)).snapshotForSession();
                } catch {
                    throw new ToolCallError(
                        'invalid',
                        `delegate: "${spec.assignee}" is not an agent of this workspace. The assignee is a platform agent id (agent_…): take it from "This chat" in your instructions — session or process names on your machine are not agents here.`
                    );
                }
                let childId: TaskId;
                try {
                    childId = await task(taskId).delegate({
                        callId: call.callId,
                        objective: spec.objective,
                        assignee: spec.assignee,
                        context: spec.context,
                        constraints: spec.constraints,
                        ...(spec.expected !== undefined ? { expected: spec.expected } : {}),
                        sessionId
                    });
                } catch (e) {
                    throw asToolCallError(e);
                }
                call.onDelegated?.(childId);
                // Place the child (its own runtime and environment, no chat). A child already routed, or already settled
                // (a restarted parent re-issuing the same call), is left as it stands: `run` only starts a queued task.
                try {
                    await router.run(childId);
                } catch (e) {
                    if (!(isServerFnError(e) && e.status === 409)) throw e;
                }
                return awaitChild(childId, call.signal);
            },
            async report(report) {
                if (!taskId) throw new ToolCallError('unsupported', 'task_report: this session works no task');
                await routing('task_report').report(taskId, report);
            }
        }
    };
}
