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
 *
 * Attachments (#203, #205): `files.read` (`chat_file_read`) asks
 * `Chat.fileAccess` as the agent — a file is readable exactly when the
 * message it was posted in is (CHT-04, MEM-11) — then reads the bytes from
 * the `ChatFileStore`: text for a text-like file, the record alone for any
 * other. `chat.post` turns `attachments` into file parts the same way, so an
 * agent can re-share only what it can see. Without a store there is no
 * `files` port.
 */

import { actorKey, chatFileUri, createId, isTerminal, MODEL_IMAGE_TYPES, parseChatFileUri, type AgentId, type ChatFile, type ChatFileStore, type ChatId, type EnvironmentId, type MemoryEntry, type MessageId, type Principal, type PromptPart, type SessionId, type TaskId, type TaskStatus, type WorkspaceId } from '@agentic/core';
import type { ChatPost, ChatPostResult, DelegateCall, DelegateOutcome, DelegateSpec, PlatformPorts, TaskReport } from '@agentic/runtimes';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { isServerFnError } from '@sigx/server';

import { AgentActor, agentKey, agentMemoryScope } from '../agent/index.js';
import { asPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { ToolCallError } from '../machine/ports.js';
import { Memory, memoryActorKey } from '../memory/index.js';
import type { RequestResolvedEvent } from '../policy/requests.js';
import type { PlatformInputRequest, PlatformRequestRef } from '../session/actor.js';
import { checkDepth, TaskActor, taskKey, type TaskOutcome, type TaskView } from '../task/index.js';
import { readChatFile } from './files.js';
import { MENTION_CONTEXT_WINDOW, mentionContract } from './mentions.js';
import { routingKey } from './key.js';

export type AgentPrincipal = Extract<Principal, { kind: 'agent' }>;

/** The slice of the Routing actor a tool port calls (`defineRoutingActor`). */
interface RoutingClient {
    report(taskId: TaskId, report: TaskReport): Promise<void>;
    run(taskId: TaskId): Promise<TaskView>;
    get(): Promise<{ readonly routes: readonly { readonly taskId: TaskId; readonly environmentId?: EnvironmentId }[] }>;
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
    /** Where chat attachment bytes live (#203); without it there is no `files` port and `chat_file_read` reports it unavailable. */
    readonly files?: ChatFileStore;
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

    /** The chat's word on a file for this agent — `null` when it is missing or the agent may not see it. */
    const access = (chatId: ChatId, fileId: string): Promise<ChatFile | null> => as(Chat, agentChatKey(workspaceId, chatId)).fileAccess(fileId);

    /** A file the agent may see, by its URI, or the tool error saying why not. */
    async function visibleFile(uri: string, tool: string): Promise<ChatFile> {
        const ref = parseChatFileUri(uri);
        if (!ref) throw new ToolCallError('invalid', `${tool}: "${uri}" is not an agentic-file: URI`);
        const file = await access(ref.chatId, ref.fileId);
        if (!file) throw new ToolCallError('forbidden', `${tool}: no file ${uri} that agent ${agentId} may see`);
        return file;
    }

    /**
     * Start a task for every member the post MENTIONS (#222, CHT-06, COL-06) — never the coordinator fallback, so an
     * agent's post without mentions wakes nobody. The poster's collaborators gate it as they gate `delegate` (COL-10);
     * each task is one level deeper than the poster's, so agents mentioning each other stop at `maxDepth`. An assignee
     * with neither a folder in this chat nor a default environment runs in the poster's (#220). Never throws: the post
     * is stored, and what could not be started is said in `notActivated`.
     */
    async function activateMentions(chatId: ChatId, messageId: MessageId, post: ChatPost, addressed: readonly AgentId[]): Promise<Pick<ChatPostResult, 'activated' | 'notActivated'>> {
        // `addressed` is Chat.post's answer: the mentions that are members, less the poster. A mention it left out is said, not dropped.
        const mentioned = [...new Set(post.mentions)].filter((id) => id !== agentId);
        const targets = mentioned.filter((id) => addressed.includes(id));
        const activated: { agentId: AgentId; taskId: TaskId; status: TaskStatus }[] = [];
        const notActivated: { agentId: AgentId; reason: string }[] = mentioned.filter((id) => !addressed.includes(id)).map((id) => ({ agentId: id, reason: 'not a member of this chat' }));
        if (targets.length === 0) return notActivated.length ? { notActivated } : {};
        const skip = (reason: string) => ({ notActivated: [...notActivated, ...targets.map((id) => ({ agentId: id, reason }))] });
        const def = options.routing?.();
        if (!def) return skip('the router is not wired on this deployment');
        const router = actor(def, routingKey(workspaceId)).with({ context: asPrincipal(principal) }) as unknown as RoutingClient;
        const poster = await as(AgentActor, agentKey(workspaceId, agentId)).get();
        const postingTask = taskId ? await task(taskId).get() : undefined;
        let depth: number;
        try {
            depth = checkDepth(postingTask?.depth ?? 0, postingTask?.constraints ?? {});
        } catch (e) {
            return skip(`depth limit: ${e instanceof Error ? e.message : String(e)}`);
        }
        const chat = as(Chat, agentChatKey(workspaceId, chatId));
        const summary = await chat.get();
        const { entries } = await chat.history(null, MENTION_CONTEXT_WINDOW + 1);
        const names = new Map<AgentId, string>([[agentId, poster.config.name]]);
        const nameOf = (id: AgentId): string => names.get(id) ?? id;
        const authors = new Set(entries.flatMap((e) => (e.entry.t === 'msg' && e.entry.author.kind === 'agent' && !names.has(e.entry.author.agentId) ? [e.entry.author.agentId] : [])));
        await Promise.all(
            [...authors].map(async (id) => {
                names.set(id, await as(AgentActor, agentKey(workspaceId, id)).get().then((a) => a.config.name, () => id));
            })
        );
        let posterEnvironment: EnvironmentId | null | undefined;
        const posterEnv = async (): Promise<EnvironmentId | undefined> => {
            if (posterEnvironment === undefined) posterEnvironment = (await router.get().then((r) => r.routes.find((x) => x.taskId === taskId)?.environmentId, () => undefined)) ?? null;
            return posterEnvironment ?? undefined;
        };
        for (const target of targets) {
            if (poster.config.collaborators !== 'all' && !poster.config.collaborators.includes(target)) {
                notActivated.push({ agentId: target, reason: `not a collaborator of ${agentId}` });
                continue;
            }
            const member = summary.members[target];
            if (!member) {
                notActivated.push({ agentId: target, reason: 'not a member of this chat' });
                continue;
            }
            try {
                const assignee = await as(AgentActor, agentKey(workspaceId, target)).get();
                const fallback = member.workdir || assignee.config.execution.defaultEnvironmentId ? undefined : await posterEnv();
                const contract = mentionContract({ assignee: target, chatId, messageId, text: post.text, posterName: poster.config.name, member, entries, nameOf, ...(fallback ? { fallbackEnvironmentId: fallback } : {}) });
                const id = createId('task') as TaskId;
                await task(id).create(contract, { owner: target, depth });
                const view = await router.run(id);
                activated.push({ agentId: target, taskId: id, status: view.status });
                if (view.status === 'failed') notActivated.push({ agentId: target, reason: `its task failed to start: ${view.error?.code ?? 'failed'}: ${view.error?.message ?? ''}` });
            } catch (e) {
                notActivated.push({ agentId: target, reason: `could not start: ${e instanceof Error ? e.message : String(e)}` });
            }
        }
        return { ...(activated.length ? { activated } : {}), ...(notActivated.length ? { notActivated } : {}) };
    }

    const store = options.files;
    const files: PlatformPorts['files'] = store
        ? {
              async read(uri: string) {
                  const file = await visibleFile(uri, 'chat_file_read');
                  const read = await readChatFile(file, workspaceId, store);
                  if (!read) throw new ToolCallError('not-found', `chat_file_read: the bytes of ${uri} are gone`);
                  return read;
              }
          }
        : undefined;

    return {
        ...(files ? { files } : {}),
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
                // Attachments go in as file parts named by the chat's own record, so a re-share carries the file's real type (#205).
                const attached: PromptPart[] = [];
                for (const uri of post.attachments ?? []) {
                    const file = await visibleFile(uri, 'chat_post');
                    const url = chatFileUri(file.chatId, file.id);
                    attached.push(MODEL_IMAGE_TYPES.includes(file.mediaType) ? { type: 'image', mediaType: file.mediaType, url } : { type: 'file', mediaType: file.mediaType, name: file.name, url });
                }
                const input: string | PromptPart[] = attached.length === 0 ? post.text : [...(post.text ? [{ type: 'text' as const, text: post.text }] : []), ...attached];
                const result = await as(Chat, agentChatKey(workspaceId, chatId)).post(input, post.mentions, taskId ? { taskId } : {});
                return { messageId: result.messageId, ...(await activateMentions(chatId, result.messageId, post, result.activated)) };
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
                        ...(spec.environmentId !== undefined ? { environmentId: spec.environmentId } : {}),
                        ...(spec.workdir !== undefined ? { workdir: spec.workdir } : {}),
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
