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
 * `ask_user` stays `unsupported` until input requests land (#40) — the error
 * says so, the tool never silently succeeds.
 */

import { isTerminal, type ChatId, type MemoryEntry, type Principal, type TaskId, type WorkspaceId } from '@agentic/core';
import type { DelegateCall, DelegateOutcome, DelegateSpec, PlatformPorts, TaskReport } from '@agentic/runtimes';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { isServerFnError } from '@sigx/server';

import { AgentActor, agentKey, agentMemoryScope } from '../agent/index.js';
import { asPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { ToolCallError } from '../machine/ports.js';
import { Memory, memoryActorKey } from '../memory/index.js';
import { TaskActor, taskKey, type TaskOutcome, type TaskView } from '../task/index.js';
import { routingKey } from './key.js';

export type AgentPrincipal = Extract<Principal, { kind: 'agent' }>;

/** The slice of the Routing actor a tool port calls (`defineRoutingActor`). */
interface RoutingClient {
    report(taskId: TaskId, report: TaskReport): Promise<void>;
    run(taskId: TaskId): Promise<TaskView>;
}

export interface ActorToolPortsOptions {
    /** Whose tools these are — the session's agent principal (workspace, agent, session, task?). */
    readonly principal: AgentPrincipal;
    /** The chat the session belongs to; without one `chat_post` is refused. */
    readonly chatId?: ChatId;
    /** The Routing actor definition, for `task_report` and `delegate`; without it both are refused. */
    readonly routing?: () => AnyActorDefinition;
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
            ask() {
                return Promise.reject(new ToolCallError('unsupported', 'ask_user: not available until input requests land (#40)'));
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
