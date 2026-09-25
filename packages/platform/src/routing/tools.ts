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
 *
 * Projects (#334, COL-02/04): `projects.list` reads `Workspace.projects` as
 * the workspace's user (the root actor admits its owner only, as the machine
 * index for `usage_limits`); `current` and `set` go to the Chat under the
 * agent's own principal, so `Chat.setProject` admits a member only (403 →
 * `forbidden`), refuses an unknown project (400 → `invalid`) and records
 * `chat.project-set` under the agent. Matching a project to the message is
 * the model's job; the tool's own guard (a chat already in a project) runs
 * in `@agentic/runtimes`.
 *
 * Plan (#816, PRJ-11/12): `plan` is the Plan actor of the session's project
 * (the current task's, else the chat's) under the agent's principal, mapped
 * by `createPlanPort`. The project record is read as the workspace's user
 * (like `projects.list`); the actor's refusals come back as tool errors with
 * its words unchanged. A file ref is pinned through the session's machine
 * (`fs` `pin`, #752) when its daemon has the `pin` feature, else stored
 * unpinned. After each call the agent's notices go to the session's chat.
 */

import { actorKey, chatFileUri, createId, isTerminal, MODEL_IMAGE_TYPES, parseChatFileUri, projectFolderPlaces, type AgentId, type ChatFile, type ChatFileStore, type ChatId, type EnvironmentId, type FileRef, type FsResult, type MachineId, type MemoryEntry, type MemoryStore, type MessageId, type Principal, type ProjectId, type PromptPart, type SessionId, type TaskId, type TaskStatus, type WorkspaceAnswer, type WorkspaceId } from '@agentic/core';
import { describeEnvironments, type ChatPost, type ChatPostResult, type DelegateCall, type DelegateEnvironment, type DelegateOutcome, type DelegateSpec, type PlatformPorts, type PlanPort, type ProjectSummary, type TaskReport, type ToolCall } from '@agentic/runtimes';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { isServerFnError } from '@sigx/server';

import { AgentActor, agentKey, agentMemoryScope } from '../agent/index.js';
import { asPrincipal, mintAgentPrincipal, userPrincipal, workspaceKey } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import type { MachineView } from '../machine/actor.js';
import { ToolCallError } from '../machine/ports.js';
import { machineKey } from '../machine/state.js';
import { usageLimitsOf } from '../machine/usage.js';
import { Memory, memoryActorKey } from '../memory/index.js';
import { definePlanActor } from '../plan/actor.js';
import { planKey } from '../plan/key.js';
import { createPlanPort, type PlanActorClient } from '../plan/port.js';
import type { PlanNotice } from '../plan/rules.js';
import { answerText, type RequestResolvedEvent } from '../policy/requests.js';
import type { DetachedInput, PlatformInputRequest, PlatformRequestRef } from '../session/actor.js';
import { checkDepth, TaskActor, taskKey, type TaskOutcome, type TaskView } from '../task/index.js';
import type { SessionMemory } from '../task/driver.js';
import { Workspace } from '../workspace/index.js';
import { readChatFile } from './files.js';
import { MENTION_CONTEXT_WINDOW, mentionContract } from './mentions.js';
import { routingKey } from './key.js';
import { pullsKey } from '../pulls/key.js';
import type { PullLink, PullsView } from '../pulls/actor.js';

export type AgentPrincipal = Extract<Principal, { kind: 'agent' }>;

/** The slice of the Routing actor a tool port calls (`defineRoutingActor`). */
interface RoutingClient {
    report(taskId: TaskId, report: TaskReport): Promise<void>;
    run(taskId: TaskId): Promise<TaskView>;
    get(): Promise<{ readonly routes: readonly { readonly taskId: TaskId; readonly environmentId?: EnvironmentId }[] }>;
}

/** The slice of the Pulls actor `pull_report` calls (`definePullsActor`). */
interface PullsClient {
    report(number: number, link: PullLink): Promise<PullsView>;
}

/** The slice of the Session actor `ask_user` uses (`defineSessionActor`). */
interface SessionAskClient {
    raiseInput(input: PlatformInputRequest): Promise<PlatformRequestRef>;
    resolution(requestId: string): AsyncIterable<RequestResolvedEvent>;
    detachInput(requestId: string): Promise<DetachedInput>;
}

/**
 * The Plan actor as a client handle (#816): only its `type` addresses the object; the host runs its own definition.
 * Made on first use — `plan/actor` reaches this module back through the Workspace, so it is not ready at import.
 */
let planStore: ReturnType<typeof definePlanActor> | undefined;
const PlanStore = () => (planStore ??= definePlanActor());

/** The slice of the Machine actor `plan_ref` pins a file ref through (#752). */
interface PinMachineClient {
    get(): Promise<Pick<MachineView, 'online' | 'features'>>;
    fsRequest(environmentId: EnvironmentId, op: { readonly kind: 'pin'; readonly root: string; readonly path: string; readonly from: number; readonly to: number }): Promise<{ readonly requestId: string }>;
    fsAnswer(requestId: string): AsyncIterable<WorkspaceAnswer<FsResult>>;
}

/** A Plan refusal as the code a daemon (and the model) sees — the rule's own (`blocked`, `taken`, …) — with the actor's words unchanged. */
function asPlanToolError(e: unknown): unknown {
    if (e instanceof ToolCallError || !isServerFnError(e)) return e;
    const code = (e.data as { code?: unknown } | null | undefined)?.code;
    return new ToolCallError(typeof code === 'string' ? code : e.status === 403 ? 'forbidden' : e.status === 404 ? 'not-found' : 'invalid', e.message);
}

/**
 * How long `ask_user` in a chat waits for a quick answer before it answers `pending` (#285) — safely under an
 * engine's MCP tool-call timeout, so a fast answer still comes back inside the call.
 */
export const ASK_QUICK_WAIT_MS = 25_000;

/**
 * How long a daemon's `delegate` waits for its child before it answers `running` with the child's id (#599) — under
 * the engines' MCP tool-call timeout (60 s by default), which would otherwise throw the id away with the call. The
 * child goes on; `delegate({ follow })` waits for it again. The local path waits for the child however long it runs.
 */
export const DELEGATE_WAIT_MS = 45_000;

export interface ActorToolPortsOptions {
    /** Whose tools these are — the session's agent principal (workspace, agent, session, task?). */
    readonly principal: AgentPrincipal;
    /**
     * The task the session works RIGHT NOW (#390), read per call — `SessionFactoryContext.currentTaskId` on the local
     * path. A session serves many tasks, so `principal.taskId` (the task it opened with) is only the fallback when this
     * answers none: `delegate`'s parent, `task_report`'s task, a memory's provenance and a post's task all come from here.
     */
    readonly taskId?: () => TaskId | undefined;
    /** The chat the session belongs to; without one `chat_post` is refused. */
    readonly chatId?: ChatId;
    /** The Routing actor definition, for `task_report` and `delegate`; without it both are refused. */
    readonly routing?: () => AnyActorDefinition;
    /** The Session actor definition, for `ask_user`; without it the question is refused as unsupported. */
    readonly sessions?: () => AnyActorDefinition;
    /** Where chat attachment bytes live (#203); without it there is no `files` port and `chat_file_read` reports it unavailable. */
    readonly files?: ChatFileStore;
    /**
     * The session's memory (#242): the workspace's active memory plugin (`memoryAccess` over the spec's gate). `{ off }`
     * → `memory_search` / `memory_remember` stay listed and answer why, so the agent learns memory is off. Absent → the
     * Memory actor of the agent's own scope, as before the catalogue.
     */
    readonly memory?: SessionMemory;
    /** The Machine actor definition, for `usage_limits` (#272); without it there is no `usage` port and the tool reports it unavailable. */
    readonly machines?: () => AnyActorDefinition;
    /** The Pulls actor definition, for `pull_report` (#793); without it there is no `pulls` port and the tool reports it unavailable. */
    readonly pulls?: () => AnyActorDefinition;
    /** `ask_user`'s quick-answer window in a chat (#285); default `ASK_QUICK_WAIT_MS`. */
    readonly askQuickWaitMs?: number;
    /**
     * How long one `delegate` call waits for its child before it answers `running` (#599). Absent → until the child
     * settles; the daemon path passes `DELEGATE_WAIT_MS`, under the engine's tool-call timeout.
     */
    readonly delegateWaitMs?: number;
}

export function agentChatKey(workspaceId: WorkspaceId, chatId: ChatId): string {
    return `${workspaceId}:chat:${chatId}`;
}

/** The Task actor's own errors carry a `code` (in `data` once over the wire); map them onto the codes a daemon (and the model) sees. */
function asToolCallError(e: unknown): unknown {
    if (e instanceof ToolCallError) return e;
    const shaped = typeof e === 'object' && e !== null ? (e as { code?: unknown; data?: { code?: unknown } | null }) : undefined;
    const code = shaped?.code ?? shaped?.data?.code;
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

export { answerText };

/** The tool ports of one agent session, bound to the actors. */
export function createActorToolPorts(options: ActorToolPortsOptions): PlatformPorts {
    const { principal, chatId } = options;
    const { workspaceId, agentId, sessionId } = principal;
    /**
     * The principal AS OF THIS CALL (#390): the identity as minted, under the task the session works right now —
     * `options.taskId()` when it answers, else the task the principal was minted with. Never destructured once:
     * a session serves many tasks, and every hop, parent and provenance below must name the current one.
     */
    const principalNow = (): AgentPrincipal => {
        const taskId = options.taskId?.() ?? principal.taskId;
        return taskId === principal.taskId ? principal : (mintAgentPrincipal({ workspaceId, agentId, sessionId, ...(taskId ? { taskId } : {}) }) as AgentPrincipal);
    };
    const as = <D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D> => actor(def, key).with({ context: asPrincipal(principalNow()) }) as ActorClientWith<D>;
    const memory = (): Pick<MemoryStore, 'query' | 'put'> => {
        const access = options.memory;
        if (!access) return as(Memory, memoryActorKey(workspaceId, agentMemoryScope(agentId)));
        if ('off' in access) throw new ToolCallError('unsupported', access.off);
        return access.open(agentMemoryScope(agentId), principalNow());
    };
    const task = (id: TaskId) => as(TaskActor, taskKey(workspaceId, id));
    const routing = (what: string): RoutingClient => {
        const def = options.routing?.();
        if (!def) throw new ToolCallError('unsupported', `${what}: the router is not wired on this deployment`);
        return actor(def, routingKey(workspaceId)).with({ context: asPrincipal(principalNow()) }) as unknown as RoutingClient;
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

    /**
     * Wait for the child's terminal state, for the parent turn to be aborted, or for the wait window (`delegateWaitMs`,
     * #599) to pass — whichever comes first. A window that passes answers `running` with the child's id: the child goes on.
     */
    async function awaitChild(childId: TaskId, signal: AbortSignal): Promise<DelegateOutcome> {
        const it = task(childId).result()[Symbol.asyncIterator]();
        const aborted = new Promise<'aborted'>((resolve) => {
            if (signal.aborted) resolve('aborted');
            else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const windowMs = options.delegateWaitMs;
        const window = windowMs === undefined ? undefined : new Promise<'window'>((resolve) => (timer = setTimeout(() => resolve('window'), windowMs)));
        try {
            const next = await Promise.race([it.next(), aborted, ...(window ? [window] : [])]);
            if (next === 'window') {
                // Settled just as the window closed: the result, not a handle.
                const child = await task(childId).get();
                return isTerminal(child.status) ? outcomeOf(child) : { taskId: childId, status: 'running' };
            }
            if (next !== 'aborted' && !next.done) return outcomeOf(next.value);
        } finally {
            clearTimeout(timer);
            await it.return?.().catch(() => undefined);
        }
        // The parent's turn is over (its task was cancelled, or the session went away): report the child as it stands —
        // a child not yet terminal, or cancelled without every stop confirmed, is work that could not be confirmed stopped (COL-12).
        const child = await task(childId).get();
        if (child.status === 'completed' || child.status === 'failed') return outcomeOf(child);
        const straggler = !isTerminal(child.status) || (child.cancel !== undefined && !child.cancel.stopped);
        return outcomeOf({ ...child, status: 'cancelled' }, straggler ? [childId] : []);
    }

    /** The paired machines' views (#599): the index is the workspace user's to read, each machine the agent's (as `usage`). */
    async function machineViews(): Promise<MachineView[]> {
        const def = options.machines;
        if (!def) return [];
        const listed = await actor(Workspace, workspaceKey(workspaceId))
            .with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)) })
            .listMachines();
        const views: MachineView[] = [];
        for (const entry of listed) {
            if (entry.status !== 'paired') continue;
            const m = (await as(def(), machineKey(workspaceId, entry.id as MachineId)).get()) as MachineView;
            if (!m.revoked) views.push(m);
        }
        return views;
    }

    /** The environments on `views` that run `assignee`'s runtime (#599). */
    async function usableBy(assignee: AgentId, views: readonly MachineView[]): Promise<DelegateEnvironment[]> {
        const { config } = await as(AgentActor, agentKey(workspaceId, assignee)).get();
        const runtime = config.execution.runtime;
        return views.flatMap((m) =>
            m.environments
                .filter((e) => e.runtime === runtime)
                .map((e) => ({ id: e.id, machineId: m.machineId, ...(m.name ? { machineName: m.name } : {}), cwdRoots: e.cwdRoots, online: m.online }))
        );
    }

    /** `TaskPort.environments`: where `assignee` can run — none named without the Machine definition, or for an unknown agent. */
    async function assigneeEnvironments(assignee: AgentId): Promise<readonly DelegateEnvironment[]> {
        if (!options.machines) return [];
        return usableBy(assignee, await machineViews());
    }

    /**
     * `delegate({ follow })` (#599): wait again for a child an earlier call answered `running` — only one this agent
     * delegated, to that assignee. Nothing is created or routed; the call's card links to the same child.
     */
    async function followChild(childId: TaskId, assignee: AgentId, call: DelegateCall): Promise<DelegateOutcome> {
        const child = await task(childId)
            .get()
            .catch(() => null);
        if (!child || child.origin.kind !== 'agent' || child.origin.agentId !== agentId) {
            throw new ToolCallError('invalid', `delegate: ${childId} is not a task agent ${agentId} delegated; \`follow\` takes the taskId an earlier delegate answered`);
        }
        if (child.assignee !== assignee) {
            throw new ToolCallError('invalid', `delegate: ${childId} was delegated to ${child.assignee}, not ${assignee}; pass the assignee of the original call with \`follow\``);
        }
        call.onDelegated?.(childId);
        return awaitChild(childId, call.signal);
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
     * is stored, and what could not be started is said in `notActivated` — every mention, the poster's own included, is
     * in one of the two lists (#599).
     */
    async function activateMentions(chatId: ChatId, messageId: MessageId, post: ChatPost, addressed: readonly AgentId[]): Promise<Pick<ChatPostResult, 'activated' | 'notActivated'>> {
        // The poster's task as of this post (#390): each mention's task is one level below it, in its environment.
        const taskId = principalNow().taskId;
        // `addressed` is Chat.post's answer: the mentions that are members, less the poster. A mention it left out is said, not dropped.
        // Every mention gets an answer (#599): a non-empty `mentions` never comes back with neither `activated` nor `notActivated`.
        const unique = [...new Set(post.mentions)];
        const mentioned = unique.filter((id) => id !== agentId);
        const targets = mentioned.filter((id) => addressed.includes(id));
        const activated: { agentId: AgentId; taskId: TaskId; status: TaskStatus }[] = [];
        const notActivated: { agentId: AgentId; reason: string }[] = [
            ...(unique.includes(agentId) ? [{ agentId, reason: 'the poster itself: an agent never starts itself by a mention' }] : []),
            ...mentioned.filter((id) => !addressed.includes(id)).map((id) => ({ agentId: id, reason: 'not a member of this chat' }))
        ];
        if (targets.length === 0) return notActivated.length ? { notActivated } : {};
        const skip = (reason: string) => ({ notActivated: [...notActivated, ...targets.map((id) => ({ agentId: id, reason }))] });
        const def = options.routing?.();
        if (!def) return skip('the router is not wired on this deployment');
        const router = actor(def, routingKey(workspaceId)).with({ context: asPrincipal(principalNow()) }) as unknown as RoutingClient;
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
                // The poster's environment is only for an assignee that names nothing of its own (#220) — an account-bound one resolves on the chat's machine (#414).
                const fallback = member.workdir || assignee.config.execution.defaultEnvironmentId || assignee.config.execution.account ? undefined : await posterEnv();
                const contract = mentionContract({ assignee: target, chatId, messageId, text: post.text, posterName: poster.config.name, member, entries, nameOf, ...(summary.machineId ? { machineId: summary.machineId } : {}), ...(fallback ? { fallbackEnvironmentId: fallback } : {}) });
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

    // Provider limits (#272): the machine index is the workspace user's to read (as the router scans it, `locate.ts`); each
    // machine is then read under the agent's own principal, which the Machine's reader rule admits.
    const machineDef = options.machines;
    const usage: PlatformPorts['usage'] = machineDef
        ? {
              async limits(query) {
                  const listed = await actor(Workspace, workspaceKey(workspaceId))
                      .with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)) })
                      .listMachines();
                  const views: MachineView[] = [];
                  for (const entry of listed) {
                      if (entry.status !== 'paired' || (query.machineId !== undefined && entry.id !== query.machineId)) continue;
                      views.push((await as(machineDef(), machineKey(workspaceId, entry.id as MachineId)).get()) as MachineView);
                  }
                  return usageLimitsOf(views, query, Date.now());
              }
          }
        : undefined;

    /** The Chat's own refusals as the codes a daemon (and the model) sees: a non-member is `forbidden`, an unknown project `invalid`. */
    const asChatToolError = (tool: string, e: unknown): unknown => {
        if (e instanceof ToolCallError) return e;
        if (isServerFnError(e) && e.status === 403) return new ToolCallError('forbidden', `${tool}: ${e.message}`);
        if (isServerFnError(e) && (e.status === 400 || e.status === 404)) return new ToolCallError('invalid', `${tool}: ${e.message}`);
        return e;
    };
    const projects: PlatformPorts['projects'] = {
        async list(): Promise<readonly ProjectSummary[]> {
            const listed = await actor(Workspace, workspaceKey(workspaceId))
                .with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)) })
                .projects();
            return listed.map((p) => ({
                id: p.id,
                name: p.name,
                ...(p.description !== undefined ? { description: p.description } : {}),
                ...projectFolderPlaces(p.folders)
            }));
        },
        async current(chatId) {
            try {
                const summary = await as(Chat, agentChatKey(workspaceId, chatId)).get();
                if (summary.projectId === undefined) return null;
                return summary.project ?? { id: summary.projectId };
            } catch (e) {
                throw asChatToolError('projects', e);
            }
        },
        async set(chatId, projectId) {
            try {
                await as(Chat, agentChatKey(workspaceId, chatId)).setProject(projectId);
            } catch (e) {
                throw asChatToolError('projects', e);
            }
        }
    };

    const plan = planPort();

    /**
     * The `plan_*` port (#816): the Plan actor of the session's project under the agent. The project is the current
     * task's, else the chat's, looked up on every call — a chat can be moved into a project mid-session.
     */
    function planPort(): PlanPort {
        const workspaceUser = () => asPrincipal(userPrincipal(workspaceId, workspaceId));
        async function projectOf(): Promise<ProjectId | undefined> {
            const { taskId } = principalNow();
            if (taskId) {
                const view = await task(taskId)
                    .get()
                    .catch(() => undefined);
                if (view?.projectId !== undefined) return view.projectId;
            }
            if (!chatId) return undefined;
            const summary = await as(Chat, agentChatKey(workspaceId, chatId))
                .get()
                .catch(() => undefined);
            return summary?.projectId;
        }
        const port = createPlanPort({
            me: agentId,
            taskId: () => principalNow().taskId,
            async scope() {
                const projectId = await projectOf();
                if (projectId === undefined) throw new ToolCallError('unsupported', 'plan: this session is in no project, and a plan belongs to a project');
                const project = (await actor(Workspace, workspaceKey(workspaceId)).with({ context: workspaceUser() }).projects()).find((p) => p.id === projectId);
                if (!project) throw new ToolCallError('unsupported', `plan: project ${projectId} no longer exists`);
                const names = new Map<AgentId, string>();
                await Promise.all(
                    project.members.agentIds.map(async (id) => {
                        const name = await as(AgentActor, agentKey(workspaceId, id))
                            .get()
                            .then((a) => a.config.name, () => undefined);
                        if (name) names.set(id, name);
                    })
                );
                return { plan: as(PlanStore(), planKey(workspaceId, projectId)) as unknown as PlanActorClient, project, names, users: [workspaceId] };
            },
            pin: pinFileRef,
            ...(chatId ? { deliver: (notices: readonly PlanNotice[]) => deliverNotices(chatId, notices) } : {})
        });
        // The actor's refusals keep their words; the daemon sees the rule's code (`blocked`, `taken`, …).
        const wrap =
            <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
            async (...args: A): Promise<R> => {
                try {
                    return await fn(...args);
                } catch (e) {
                    throw asPlanToolError(e);
                }
            };
        return { board: wrap(port.board), claim: wrap(port.claim), assign: wrap(port.assign), update: wrap(port.update), ref: wrap(port.ref), add: wrap(port.add), handoff: wrap(port.handoff) };
    }

    /**
     * `plan_ref` on a file (#752): the lines pinned to the HEAD commit of the session's folder, through its machine —
     * only when the session runs in a folder on a machine whose daemon has the `pin` feature. `undefined`: unpinned.
     */
    async function pinFileRef(ref: FileRef, call: ToolCall): Promise<FileRef | undefined> {
        const sessionDef = options.sessions?.();
        const machineDef = options.machines?.();
        if (!sessionDef || !machineDef || !sessionId) return undefined;
        const info = (await as(sessionDef, actorKey(workspaceId, 'session', sessionId as SessionId)).get()) as { readonly spec?: { readonly machineId?: MachineId; readonly environmentId?: EnvironmentId; readonly cwd?: string } };
        const spec = info.spec;
        if (!spec?.machineId || !spec.environmentId || !spec.cwd) return undefined;
        const machine = as(machineDef, machineKey(workspaceId, spec.machineId)) as unknown as PinMachineClient;
        const view = await machine.get();
        if (!view.online || !view.features?.includes('pin')) return undefined;
        const { requestId } = await machine.fsRequest(spec.environmentId, { kind: 'pin', root: spec.cwd, path: ref.path, from: ref.from, to: ref.to });
        const answers = machine.fsAnswer(requestId)[Symbol.asyncIterator]();
        try {
            const next = await answers.next();
            if (call.signal.aborted || next.done || next.value.error) return undefined;
            const result = next.value.result;
            return result.kind === 'pin' ? { kind: 'file', path: ref.path, from: result.from, to: result.to, sha: result.sha } : undefined;
        } finally {
            await answers.return?.().catch(() => undefined);
        }
    }

    /** The agent's plan notices, as one post in the session's chat — best effort, and waking nobody. */
    async function deliverNotices(chatId: ChatId, notices: readonly PlanNotice[]): Promise<void> {
        const text = ['Plan notices:', ...notices.map((n) => `- #${n.itemId}: ${n.text}`)].join('\n');
        await as(Chat, agentChatKey(workspaceId, chatId)).post(text, []);
    }

    // Pull requests (#793): the PR the agent opened goes to the Pulls actor of the chat's project, under the agent's own
    // principal, linked to the task it works right now, the chat and the session.
    const pullsDef = options.pulls;
    const pulls: PlatformPorts['pulls'] = pullsDef
        ? {
              async report(number) {
                  if (!chatId) throw new ToolCallError('unsupported', 'pull_report: this session belongs to no chat, so no project to report the pull request in');
                  let projectId: ProjectId | undefined;
                  try {
                      projectId = (await as(Chat, agentChatKey(workspaceId, chatId)).get()).projectId;
                  } catch (e) {
                      throw asChatToolError('pull_report', e);
                  }
                  if (!projectId) throw new ToolCallError('unsupported', 'pull_report: this chat is in no project');
                  const { taskId } = principalNow();
                  const client = actor(pullsDef(), pullsKey(workspaceId, projectId)).with({ context: asPrincipal(principalNow()) }) as unknown as PullsClient;
                  let view: PullsView;
                  try {
                      view = await client.report(number, { chatId, sessionId, ...(taskId ? { taskId } : {}) });
                  } catch (e) {
                      if (isServerFnError(e) && e.status === 400) throw new ToolCallError('invalid', `pull_report: ${e.message}`);
                      throw e;
                  }
                  const pr = view.pulls.find((p) => p.number === number);
                  const note = pr ? undefined : (view.error ?? (view.repo ? 'not read yet; it is read on the next poll' : "the project's repo is not watched yet; the report is kept for when it is"));
                  return {
                      number,
                      ...(view.repo ? { repo: view.repo.repo } : {}),
                      ...(pr ? { state: pr.state, title: pr.title, url: pr.url } : {}),
                      ...(note ? { note } : {})
                  };
              }
          }
        : undefined;

    return {
        ...(files ? { files } : {}),
        ...(usage ? { usage } : {}),
        ...(pulls ? { pulls } : {}),
        projects,
        plan,
        memory: {
            search: async (query) => memory().query(query),
            remember: async (entry): Promise<MemoryEntry> => {
                const { taskId } = principalNow();
                return memory().put({
                    ...entry,
                    provenance: { ...entry.provenance, ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) }
                });
            }
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
                const { taskId } = principalNow();
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
                let decision = resolved;
                if (!decision && !chatId) {
                    // No chat to start the asker again in: the call itself waits (#285 keeps chatless asks blocking).
                    decision = await awaitResolution(s, requestId, call.signal);
                } else if (!decision) {
                    // In a chat the question outlives the call (#285): a quick answer comes back here, else `pending`.
                    const window = new AbortController();
                    const timer = setTimeout(() => window.abort(), options.askQuickWaitMs ?? ASK_QUICK_WAIT_MS);
                    const stop = () => window.abort();
                    call.signal.addEventListener('abort', stop, { once: true });
                    try {
                        decision = await awaitResolution(s, requestId, window.signal);
                    } finally {
                        clearTimeout(timer);
                        call.signal.removeEventListener('abort', stop);
                    }
                    // Detaching is atomic with `respond`: an answer that beat it is handed back here, never lost.
                    decision ??= (await s.detachInput(requestId)).resolved;
                    if (!decision) {
                        return {
                            status: 'pending',
                            questionId: requestId,
                            note: 'The user has not answered yet. End your turn now, saying you are waiting on this question; the answer will reach you as a new message in this chat, in this same session.'
                        };
                    }
                }
                if (!decision) throw new ToolCallError('cancelled', 'ask_user: the turn ended before the user answered');
                if (decision.outcome !== 'input') throw new ToolCallError('cancelled', `ask_user: the question was ${decision.outcome === 'cancel' ? 'cancelled' : decision.outcome}${decision.reason ? ` (${decision.reason})` : ''}`);
                return { answer: answerText(decision.answers) };
            }
        },
        task: {
            environments: assigneeEnvironments,
            async delegate(spec: DelegateSpec, call: DelegateCall): Promise<DelegateOutcome> {
                if (spec.follow !== undefined) return followChild(spec.follow, spec.assignee, call);
                // The parent is the task of THIS turn (#390): on a reused session the task it opened with may be long settled.
                const { taskId } = principalNow();
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
                // An environment no machine reports would leave the child queued for a machine that never comes: refused
                // before any child exists, naming where the assignee can run so the retry can fill it in (#599).
                // One reported for another runtime is refused the same way — unless the assignee runs in none at all (a
                // platform-hosted runtime, which ignores the environment). A `machineId` that does not report it is the router's
                // to leave aside and record (EXE-12), as before.
                if (spec.environmentId !== undefined && options.machines) {
                    const views = await machineViews();
                    const usable = await usableBy(spec.assignee, views);
                    const reported = views.some((m) => m.environments.some((e) => e.id === spec.environmentId));
                    if (!reported || (usable.length > 0 && !usable.some((e) => e.id === spec.environmentId))) {
                        const why = reported ? `environment ${spec.environmentId} does not run agent ${spec.assignee}'s runtime` : `no machine of this workspace reports environment ${spec.environmentId}`;
                        throw new ToolCallError('invalid', `delegate: ${why}. ${describeEnvironments(spec.assignee, usable)}`);
                    }
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
                        ...(spec.machineId !== undefined ? { machineId: spec.machineId } : {}),
                        ...(spec.workdir !== undefined ? { workdir: spec.workdir } : {}),
                        ...(spec.projectId !== undefined ? { projectId: spec.projectId } : {}),
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
                const { taskId } = principalNow();
                if (!taskId) throw new ToolCallError('unsupported', 'task_report: this session works no task');
                await routing('task_report').report(taskId, report);
            }
        }
    };
}
