/**
 * The Routing actor — `{ws}:routing:main` (architecture §7 "Driver"; EXE-09,
 * EXE-11, EXE-12, AST-05). A task always runs where it was told to, or
 * waits / fails with a visible reason:
 *
 * - `run(taskId)` asks the Registry ONE question before anything is written
 *   (`gate({ runtime })`, §9): a runtime plugin that is missing or turned off
 *   fails the task `plugin-disabled` and opens nothing (AC-13) — so does a
 *   `fallback-api` that would land on a turned-off `anthropic-api`. The answer
 *   rides on the route and on the session spec (`plugins`); the plugin's
 *   `defaultModel` fills in where the agent names no model.
 * - `run(taskId)` resolves the runtime, the environment and the folder ONCE —
 *   the task's `environmentId`, else the agent's default, else a delegating
 *   task's, else the workspace's default (AGT-05); the task's
 *   `workdir`, else a delegating parent's folder in the same environment,
 *   else the agent's `defaultWorkdir` in its default environment, else the
 *   environment's first root (#190) — and records them on the route; nothing
 *   later changes them (EXE-12). A folder outside the environment's
 *   `cwdRoots` fails the task `workdir-outside-roots` before any session opens.
 * - a runtime the build hosts in-process (`RoutingPorts.runtimes`; `anthropic-api`)
 *   opens a local Session (the `SessionFactory`) and prompts.
 * - a daemon runtime opens the Session on the environment's machine through
 *   `Machine.openSession`: `opened` → prompted when the daemon acknowledges
 *   (`sessionOpened`), `queued` → Task `waiting {capacity, position}` until
 *   then. Capacity counts running turns, not open sessions (#394): a
 *   daemon route is prompted only when its environment has a free slot
 *   (`freeSlots` over the machine's view), else parked `waiting-capacity`
 *   until the machine reports `slotFreed` (a turn ended there); a daemon
 *   `busy` reply (`promptRefused`) parks it the same way. An offline
 *   machine → Task `waiting {environment-offline, policy}`
 *   and the agent's policy: `queue` retries on the machine's next `hello`
 *   (`machineOnline`), `fail` fails the task, `fallback-api` — only when the
 *   config says so — runs the task on `anthropic-api` through a transition
 *   whose `why` names the environment and the policy. Never silently.
 * - `follow` (a detached actor task, restarted after an eviction) tails the
 *   Session and settles the Task at the turn's end: completed with the final
 *   text (and a `task_report` output when one was given), failed on an
 *   error, `waiting {input}` on an interrupted turn ("Resume?"). It is also
 *   the Task's session driver for the stop cascade (COL-12): a task settled
 *   from outside while its turn runs (cancelled, or failed on budget) has
 *   its session cancelled, and `Task.sessionStopped` is the word that the
 *   running work has stopped once the turn actually ends.
 * - a delegated task (`origin.kind === 'agent'`, #39) runs outside any chat;
 *   its session opens with the approval rules of every ancestor's agent as
 *   `approvalConstraints`, so the child's policy is never wider (AC-12); on
 *   the daemon path the same rules, grants and constraints travel as
 *   `OpenSpec.policy` for the daemon to compile (#121). A
 *   `request` it raises reaches the Inbox through the Session itself (#40).
 * - a chat task (`route.chatId`, #393; CHT-01, CHT-11, EXE-12) runs in the
 *   member's ONE live session — the chat's binding (`ChatSummary.sessions`)
 *   names it — re-opened with the current placement and prompted with what
 *   the engine has not seen; the session is not closed when the task settles.
 *   A binding that cannot go on (closed, moved, or never named by its
 *   runtime) is ended and a fresh session takes its place. Chatless work
 *   (a delegated child, a schedule, a trigger, an external client) keeps one
 *   session per task, closed at the turn's end.
 * - a message that arrives while the member's session runs a turn (#395;
 *   CHT-09) steers into it when the runtime can take it (`steerOrPrompt`):
 *   the ack names the running turn, the route binds to it (`joined`) and
 *   settles with it, beside the task that started it; a runtime that cannot
 *   parks the route `waiting-turn` — nothing sent — and `follow` prompts it
 *   (`turnEnded`) when that turn ends.
 * - a chat member's session ends when someone means it to (`endSession`, #399; CHT-04,
 *   OPS-10): "New session" from the chat, or the member's removal (`Chat.removeAgent`
 *   through its routing port). The routes on it fail `session-reset`, the Session is
 *   closed, the binding dropped, and the record and its pages purged through
 *   `RoutingPorts.store`. A person's call, never an agent's.
 * - a chat task whose turn ends with its `ask_user` question still open
 *   (#396; CHT-09, COL-06) stays `waiting {input}` on a route parked
 *   `waiting-answer`; the Session hands the late answer to `deliverAnswer`,
 *   which prompts the same session under that task through the same seam —
 *   no new task. Only when no route waits on the question does the answer
 *   start the asker again with a follow-up task (`routing/answers.ts`).
 * - a machine that goes offline under running turns (#366; OPS-04) parks their tasks `waiting {machine-offline}`
 *   (`machineOffline`) until its next `hello` (`machineOnline`), or fails them `machine-lost` (recoverable) past
 *   `MACHINE_LOST_MS` (`expireOffline`, the `machine-lost` reminder). An interrupted turn whose agent's
 *   `onInterrupt` is `auto` is resumed once on its own; every resume is audited `session.resumed`.
 *
 * Every mutation ends in `ctx.save()` inside the turn. Calls into Task,
 * Session, Machine and Agent are fresh `actor()` calls under the driver
 * principal, never `ctx.actor` hops: a notification turn belongs to a
 * machine, and the machine may not drive sessions.
 */

import { accountKeyFor, accountRefOf, actorKey, BYPASS_PERMISSIONS_MODE, createId, environmentsForAccount, hasScope, isChatFilePart, isTerminal, pathWithin, projectFolderFor, SESSION_EVENTS_TOPIC, type AccountKey, type AccountRef, type AgentId, type ApprovalRule, type Author, type ChatEntry, type ChatFilePart, type ChatId, type ChatRoster, type EnvironmentDescriptor, type EnvironmentId, type FrozenAgentConfig, type FsOp, type SessionOptions, type HostOs, type MachineId, type OpenSpec, type OpenSpecPolicy, type Principal, type ProjectRecord, type PromptPart, type RuntimeId, type SessionClosedCode, type SessionEvent, type SessionId, type TaskError, type TaskId, type WaitReason, type WorkdirRef, type WorkspaceId } from '@agentic/core';
import { buildSystemPrompt, type TaskReport } from '@agentic/runtimes';
import { actor, defineActor, topic, type ActorClientWith, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import type { AgentEvent, AgentTranscript } from '@sigx/ai-agent';
import { isServerFnError, ServerFnError } from '@sigx/server';

import { AgentActor, agentKey, principalLabel } from '../agent/index.js';
import type { EnvironmentChosenData } from '../audit/events.js';
import { auditPort } from '../audit/port.js';
import { Chat } from '../chat/index.js';
import { asPrincipal, mintAgentPrincipal, sameWorkspace, userPrincipal, workspaceKey } from '../auth/index.js';
import { freeSlots, machineKey, runningIn, type FsResultView, type MachineView, type OpenSessionResult } from '../machine/index.js';
import { isInterruptedTurnEnd, resumeTurnId, SESSION_PAGE_TYPE, SESSION_TRANSCRIPT_PAGE_TYPE, sessionPageKey, transcriptPageKey, type SessionCommandResult, type SessionInfo, type SessionOpenSpec, type SessionRequestView } from '../session/index.js';
import { TaskActor, taskKey, type TaskOutcome, type TaskView } from '../task/index.js';
import { Workspace } from '../workspace/index.js';
import { FALLBACK_RUNTIME } from '../registry/dependents.js';
import { registryKey } from '../registry/key.js';
import type { RegistryGate } from '../registry/types.js';
import { daemonConnectors } from './connectors.js';
import { PLUGIN_DISABLED_CODE, resolveRuntime, UNKNOWN_RUNTIME_CODE } from './factory.js';
import { machineFs, noDaemonFs, runFeatureHooks, type FeatureHooksOutcome } from './features.js';
import { hydrateChatFiles, withChatFileRead } from './files.js';
import { parseRoutingKey, ROUTING_TYPE } from './key.js';
import { locateEnvironment, readMachine, type LocatedEnvironment } from './locate.js';
import type { RoutingPorts } from './ports.js';
import { initialRoutingState, type Route, type RoutingState } from './state.js';

/** How far back (entries) the router looks for a chat task's triggering message, for its attachments. */
const TRIGGER_LOOKBACK = 50;

/** The `by` the router signs its transitions with. */
export const ROUTER = 'system:routing';

/**
 * A chat-originated task that failed is told to its chat as a `task-failed`
 * status (#128, OPS-04): the thread shows a named failure where the answer
 * would have been, never silence. Best effort, one-way — a chat that cannot
 * be reached never fails the route. A route that never got a session id
 * (an offline environment under `fail`, a mismatch) is stamped with the id
 * it would have used: the chat's contract wants one, and the address is
 * all it is.
 */
async function tellChat(c: ActorContext<RoutingState>, workspaceId: WorkspaceId, route: Route, error: TaskError, now: () => number = Date.now, newSessionId: () => SessionId = () => createId('session') as SessionId): Promise<void> {
    if (!route.chatId) return;
    const payload: SessionEvent = { kind: 'status', agentId: route.agentId, sessionId: route.sessionId ?? newSessionId(), status: 'task-failed', ref: route.taskId, error, at: now() };
    try {
        await c.publish(topic<SessionEvent>(SESSION_EVENTS_TOPIC, actorKey(workspaceId, 'chat', route.chatId)), payload);
    } catch {
        // A chat that cannot be reached never fails the route.
    }
}

/**
 * A session ended on purpose (#399): "New session" from the chat, or the member's removal. Told to the chat once
 * for every route the ended session was working — the driver publishes it as the session would, so the chat's
 * binding is dropped even when the runtime never acknowledged the close (an offline machine).
 */
async function tellChatEnded(c: ActorContext<RoutingState>, workspaceId: WorkspaceId, chatId: ChatId, agentId: AgentId, sessionId: SessionId, now: () => number = Date.now): Promise<void> {
    const payload: SessionEvent = { kind: 'status', agentId, sessionId, status: 'session-ended', at: now() };
    try {
        await c.publish(topic<SessionEvent>(SESSION_EVENTS_TOPIC, actorKey(workspaceId, 'chat', chatId)), payload);
    } catch {
        // A chat that cannot be reached never fails the reset.
    }
}

/** The slice of the Session actor the router drives (`defineSessionActor`). */
interface SessionClient {
    open(spec: SessionOpenSpec): Promise<SessionInfo>;
    prompt(input: readonly PromptPart[], turnId: string, output?: undefined, commandId?: string, opts?: { readonly taskId?: TaskId }): Promise<SessionCommandResult>;
    resume(): Promise<SessionCommandResult>;
    get(): Promise<SessionInfo>;
    transcript(): Promise<AgentTranscript | undefined>;
    tail(from?: { epoch: number; seq: number }): AsyncIterable<AgentEvent>;
    request(requestId: string): Promise<SessionRequestView | null>;
    cancel(): Promise<SessionCommandResult>;
    configure(patch: Readonly<Record<string, string>>, commandId?: string): Promise<SessionCommandResult>;
    close(): Promise<SessionCommandResult>;
}

/**
 * The turn a late `ask_user` answer starts under the asking task (#396): deterministic per question, so a delivery
 * retried after an eviction runs once (the Session's `prompt` is idempotent by turn id).
 */
export function answerTurnId(taskId: TaskId, requestId: string): string {
    return `${taskId}:turn:answer:${requestId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** What `Routing.deliverAnswer` answers (#396). */
export type AnswerDelivery =
    /** The answer is the router's now: prompted into the asking task's turn (`turnId`), or held for it until the session's running turn ends (`parked`). */
    | { readonly delivered: true; readonly taskId?: TaskId; readonly turnId?: string; readonly parked?: true }
    /** No route waits an answer to this question on this session (the task settled, or the session was ended): the caller starts the asker again. */
    | { readonly delivered: false; readonly reason: 'no-route' }
    /** The session refused the prompt (closed, unsupported, …); the asking task failed with the reply, so — as with `no-route` — the caller starts the asker again: the answer never reached it. */
    | { readonly delivered: false; readonly reason: 'refused'; readonly code: string; readonly message: string };

/** The slice of the Machine actor the router drives (`defineMachineActor`). */
interface MachineClient {
    get(): Promise<MachineView>;
    openSession(sessionId: SessionId, environmentId: EnvironmentId, spec: OpenSpec, options?: { taskId?: TaskId }): Promise<OpenSessionResult>;
    fsRequest(environmentId: EnvironmentId, op: FsOp): Promise<{ readonly requestId: string }>;
    fsResult(requestId: string): Promise<FsResultView>;
    closeSession(sessionId: SessionId): Promise<void>;
}

/** The `TaskError` a task in a project the Workspace no longer has fails with (#332): visible, never a guessed folder. */
export const PROJECT_MISSING_CODE = 'project-missing';

/** The `TaskError` a task fails with when its session is ended under it (#399): "New session", or the member's removal. Recoverable — the next message opens a fresh one. */
export const SESSION_RESET_CODE = 'session-reset';

/**
 * The close codes of a host that goes away and comes back (#359, #433): a session closed with one of them — or with none,
 * its record left `idle` with its ref — is re-opened for a message parked on it. `resume-failed` and `harness-missing`
 * (and `draining`, a refused open) are not.
 */
const HOST_CLOSE_CODES: ReadonlySet<SessionClosedCode> = new Set<SessionClosedCode>(['restart', 'update', 'harness-update']);

/** How many of an ended session's pages `endSession` purges at once (#399): a long session has many, and one turn should not wait on them one by one. */
const PURGE_BATCH = 8;

/** How long a running route's machine may stay offline before its task fails `machine-lost` (#366; OPS-04): 24 h. */
export const MACHINE_LOST_MS = 24 * 60 * 60 * 1000;

/** The `TaskError` a task fails with when its machine stayed offline past `MACHINE_LOST_MS` (#366). Recoverable — the next message re-opens the session wherever the machine comes back. */
export const MACHINE_LOST_CODE = 'machine-lost';

/** The reminder that watches the routes waiting `machine-offline` (#366). */
export const MACHINE_LOST_REMINDER = 'machine-lost';

/** The reminder floor (architecture §2): nothing is checked more often. */
const REMINDER_FLOOR_MS = 60_000;

/** The turn a resume turn goes back to (`resumeTurnId` appends `:resume`): what `onInterrupt: 'auto'` counts once (#366). */
const baseTurnId = (turnId: string): string => turnId.replace(/(?::resume)+$/, '');

/** `Routing.get()`. */
export interface RoutingView {
    readonly key: string;
    readonly routes: readonly Route[];
    /** The latest `task_report` per task still in flight. */
    readonly reports: Readonly<Record<string, TaskReport>>;
}

/** Whoever drives tasks: a user, an agent, or an external client with the `tasks` scope — never a machine. */
const taskDriver: ActorPolicy = (principal: Principal | null) => !!principal && principal.kind !== 'machine' && hasScope(principal, 'tasks');
/** The machine-facing entry points: only a Machine actor's own principal. */
const machineOnly: ActorPolicy = (principal: Principal | null) => principal?.kind === 'machine';
/** `report(taskId, …)`: an agent working a task (its principal carries the task id; the method checks it is THAT task). */
const ownTask: ActorPolicy = (principal: Principal | null) => principal?.kind === 'agent' && principal.taskId !== undefined;
/** `endSession`: a person, or an external client acting for one — never an agent, which must not wipe its own or another's conversation (#399). */
const userOrExternal: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user' || principal?.kind === 'external';

/** The final assistant text of one turn (sub-agent output stays nested under its call). */
function finalText(transcript: AgentTranscript | undefined, turnId: string): string {
    if (!transcript) return '';
    let text = '';
    for (const m of transcript.messages) {
        if (m.role !== 'assistant' || m.turnId !== turnId || m.parentCallId) continue;
        for (const p of m.parts) if (p.type === 'text' && p.text) text += (text ? '\n' : '') + p.text;
    }
    return text;
}

/** The machine's path rules (`hello.os`); a daemon that never said is taken for Windows, the first platform (decision 2). */
const osOf = (m: MachineView): HostOs => m.os ?? 'windows';

/** The connectors an agent names — and its task's project adds (#332) — for `gate()` to answer for (#240), one per id. */
const connectorIds = (config: Pick<FrozenAgentConfig, 'connectors'>, project?: Pick<ProjectRecord, 'connectors'>): readonly string[] => [...new Set([...config.connectors.map((c) => c.id), ...(project?.connectors.map((c) => c.id) ?? [])])];

/** The slice of the Registry actor the router asks (`defineRegistry`). */
interface RegistryClient {
    gate(input: { readonly runtime: string; readonly connectors?: readonly string[] }): Promise<RegistryGate>;
}

/**
 * The model and permission mode a session runs with (#453): `over` (the chat member's, else the task's), else the
 * agent's config, else the runtime plugin's `defaultModel` / `defaultPermissionMode` (§9). The plugin's only when the
 * gate answered for the route's current runtime — after a `fallback-api` that is `anthropic-api`.
 */
function sessionOptionsOf(config: FrozenAgentConfig, plugins: RegistryGate | undefined, over: SessionOptions = {}): SessionOptions {
    const plugin = (key: string): string | undefined => {
        const value = plugins?.runtime?.config[key];
        return typeof value === 'string' && value ? value : undefined;
    };
    const model = over.model ?? config.execution.model ?? plugin('defaultModel');
    const permissionMode = over.permissionMode ?? plugin('defaultPermissionMode');
    return { ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}) };
}

/** The config a session opens with: the agent's own, on the model its options settled (#453). */
function withModel(config: FrozenAgentConfig, options: SessionOptions | undefined): FrozenAgentConfig {
    if (!options?.model || options.model === config.execution.model) return config;
    return { ...config, execution: { ...config.execution, model: options.model } };
}

/**
 * What a runtime takes to go back to its own choice (#453): Claude Code's alias for its default model and its default
 * permission mode. Only sent to a session that was set to something and should now run with nothing named.
 */
const RUNTIME_DEFAULT = 'default';

/**
 * The keys a session running with `has` must change to run with `want` (#453): what `Session.configure` sets. A key
 * `want` leaves out (an override cleared, nothing in the config or the plugin) resets a session that was set to
 * something back to the runtime's default — a clear never leaves the old value running.
 */
function optionsDrift(has: SessionOptions | undefined, want: SessionOptions | undefined): Record<string, string> {
    const patch: Record<string, string> = {};
    for (const key of ['model', 'permissionMode'] as const) {
        const target = want?.[key] ?? (has?.[key] !== undefined ? RUNTIME_DEFAULT : undefined);
        if (target !== undefined && target !== has?.[key]) patch[key] = target;
    }
    return patch;
}

const grantedToolNames = (route: Route): string[] => route.config.tools.filter((g) => g.mode !== 'deny').map((g) => g.name);

/** What the daemon compiles the session policy from (#121): the agent's rules and grants, and the ancestors' rules on a delegated task (AC-12) — the same input `sessionPolicy` takes on the local path. */
const openSpecPolicy = (route: Route): OpenSpecPolicy => ({ rules: route.config.approvalPolicy, grants: route.config.tools, ...(route.constraints?.length ? { constraints: route.constraints } : {}) });

/** How many caught-up messages a reused session's prompt carries at most (#393) — the activation's own window. */
const CATCH_UP_WINDOW = 50;

type ChatMessage = Extract<ChatEntry, { readonly t: 'msg' }>;

/** A part as one line of a caught-up message: its text, or a note naming the attachment (the part itself follows, for `hydrateChatFiles`). */
function partText(p: PromptPart): string {
    const url = 'url' in p && p.url && !p.url.startsWith('data:') ? ` ${p.url}` : '';
    switch (p.type) {
        case 'text':
            return p.text;
        case 'image':
            return `[image${url}]`;
        case 'file':
            return `[file${p.name ? ` "${p.name}"` : ''}${url}]`;
        case 'resource':
            return `[${p.uri}]`;
    }
}

/**
 * What a reused session is told beside the objective (#393): the chat's messages its engine has not seen — after the
 * member's last answer, the triggering message left out since it is the objective — each attributed, oldest first,
 * then their chat-file parts once each for `hydrateChatFiles`. Nothing when there is nothing new.
 */
function catchUp(messages: readonly ChatMessage[], nameOf: (author: Author) => string): PromptPart[] {
    const lines = messages.map((m) => `${nameOf(m.author)}: ${m.parts.map(partText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()}`);
    if (!lines.length) return [];
    const parts: PromptPart[] = [{ type: 'text', text: `In the chat since your last message:\n${lines.join('\n')}` }];
    const seen = new Set<string>();
    for (const part of messages.flatMap((m) => m.parts)) {
        if (!isChatFilePart(part) || seen.has(part.url)) continue;
        seen.add(part.url);
        parts.push(part);
    }
    return parts;
}

/** Build the Routing actor definition over its ports. One call per app — the actor `type` is `'routing'`. */
export function defineRoutingActor(ports: RoutingPorts) {
    const now = ports.now ?? Date.now;
    const newSessionId = ports.newSessionId ?? ((): SessionId => createId('session') as SessionId);
    const driverOf = ports.driver ?? ((ws: WorkspaceId): Principal => userPrincipal(ws, ws));
    const audit = ports.audit ?? auditPort();
    const projectFeatures = ports.projectFeatures ?? {};
    /** Per activation (by actor key): what `prompt` pokes so the `follow` supervisor rescans the routes. */
    const wakers = new Map<string, () => void>();
    /** The definition itself, once built: the follower re-enters through it (`turnEnded`, a method turn of its own). */
    let self: AnyActorDefinition | undefined;
    /**
     * Routes (`{key}:{taskId}`) whose turn will never start (#394: the daemon refused the prompt): `followOne` is tailing for
     * a `turn-end` that never comes, and leaves when the task settles instead of cancelling the session and waiting on.
     */
    const abandoned = new Set<string>();

    const definition = defineActor({
        type: ROUTING_TYPE,
        authorize: [sameWorkspace],
        methodAuthorize: { run: taskDriver, turnEnded: taskDriver, deliverAnswer: taskDriver, questionCancelled: taskDriver, machineOnline: machineOnly, machineOffline: machineOnly, autoResume: taskDriver, expireOffline: taskDriver, sessionOpened: machineOnly, sessionClosed: machineOnly, slotFreed: machineOnly, promptRefused: machineOnly, report: ownTask, endSession: userOrExternal },
        state: (): RoutingState => initialRoutingState(),
        /** The machine-lost reminder (#366): `expireOffline` runs as its own turn under the driver, one-way. */
        onReminder: async (ctx, name) => {
            if (name !== MACHINE_LOST_REMINDER) return;
            const ids = parseRoutingKey(ctx.key);
            if (!ids) return;
            const client = actor(self!, ctx.key).with({ context: asPrincipal(driverOf(ids.workspaceId)), oneWay: true }) as unknown as { expireOffline(): Promise<void> };
            await client.expireOffline().catch(() => undefined);
        },
        methods: (ctx) => {
            const ids = parseRoutingKey(ctx.key);
            if (!ids) throw new ServerFnError(404, `routing: "${ctx.key}" is not a {ws}:routing:main key`);
            const { workspaceId } = ids;
            const driver = driverOf(workspaceId);
            const context = asPrincipal(driver);

            const as = <D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D> => actor(def, key).with({ context }) as ActorClientWith<D>;
            const task = (id: TaskId) => as(TaskActor, taskKey(workspaceId, id));
            const agent = (id: AgentId) => as(AgentActor, agentKey(workspaceId, id));
            const chat = (id: ChatId) => as(Chat, actorKey(workspaceId, 'chat', id));
            const session = (id: SessionId): SessionClient => actor(ports.sessions(), `${workspaceId}:session:${id}`).with({ context }) as unknown as SessionClient;
            const machine = (id: MachineId): MachineClient => actor(ports.machines(), machineKey(workspaceId, id)).with({ context }) as unknown as MachineClient;

            const touch = (route: Route): void => void (route.updatedAt = now());
            const drop = (taskId: TaskId): void => {
                delete ctx.state.routes[taskId];
                delete ctx.state.reports[taskId];
            };

            /** Fail the task with a reason, tell its chat, and forget the route. A task already settled is left alone. */
            async function fail(route: Route, error: TaskError): Promise<void> {
                const t = await task(route.taskId).get();
                if (!isTerminal(t.status)) {
                    await task(route.taskId).fail(error, ROUTER);
                    await tellChat(ctx, workspaceId, route, error, now, newSessionId);
                }
                drop(route.taskId);
            }

            /** The Task's `waiting → active` or `queued → active` edge, whichever applies. */
            async function activate(route: Route, why: string, sessionId: SessionId): Promise<void> {
                const t = await task(route.taskId).get();
                if (t.status === 'queued') await task(route.taskId).start(ROUTER, sessionId);
                else if (t.status === 'waiting') await task(route.taskId).resolveWaiting(ROUTER, why, sessionId);
            }

            /** `Task.reportWaiting` from `queued`, or from `waiting` through an `active` step (the state machine has no waiting → waiting edge). */
            async function park(route: Route, reason: WaitReason, via: string, sessionId?: SessionId): Promise<void> {
                const t = await task(route.taskId).get();
                if (isTerminal(t.status)) return;
                if (t.status === 'waiting') {
                    if (t.wait?.kind === reason.kind && JSON.stringify(t.wait) === JSON.stringify(reason)) return;
                    await task(route.taskId).resolveWaiting(ROUTER, via, sessionId);
                }
                await task(route.taskId).reportWaiting(reason, ROUTER, sessionId);
            }

            /**
             * Whether the route's environment can take a turn now (#394): `freeSlots` over the machine's view —
             * `concurrency.max` minus the sessions running a turn or with a prompt out, never minus the sessions merely
             * open. A local route (no machine) always can.
             */
            async function slot(route: Route): Promise<{ free: boolean; m?: MachineView }> {
                if (!route.machineId || !route.environmentId) return { free: true };
                const m = await machine(route.machineId).get();
                // A turn on this route's own session holds its slot already: the prompt joins it or waits for it (#395), never for a second one.
                const own = runningIn(m, route.environmentId).some((h) => h.sessionId === route.sessionId);
                return { free: own || freeSlots(m, route.environmentId) > 0, m };
            }

            /**
             * Park the route on its environment's capacity (#394): the task waits `{capacity, position}` — its place behind
             * the machine's queued opens and the routes already parked here — and the route is `waiting-capacity` until the
             * machine reports `slotFreed` (an open session's prompt) or `sessionOpened` (a queued open).
             */
            async function parkOnCapacity(route: Route, m: MachineView): Promise<void> {
                const environmentId = route.environmentId!;
                const ahead = m.queued.filter((q) => q.environmentId === environmentId && q.sessionId !== route.sessionId).length + Object.values(ctx.state.routes).filter((r) => r !== route && r.status === 'waiting-capacity' && r.machineId === route.machineId && r.environmentId === environmentId).length;
                await park(route, { kind: 'capacity', environmentId, position: ahead + 1 }, `environment ${environmentId} on machine ${route.machineId} is at capacity; waiting for a turn to end`, route.sessionId);
                route.status = 'waiting-capacity';
                touch(route);
            }

            /** The chat as the route's agent sees it — `fileAccess` and `history` answer for that agent (CHT-04, MEM-11). */
            const chatAsAgent = (route: Route, chatId: ChatId) =>
                actor(Chat, actorKey(workspaceId, 'chat', chatId)).with({
                    context: asPrincipal(mintAgentPrincipal({ workspaceId, agentId: route.agentId, sessionId: route.sessionId!, taskId: route.taskId }))
                });

            /** The chat-file parts of the message that started a chat task — best effort: a chat that cannot be read gives none. */
            async function triggerFiles(route: Route, t: TaskView): Promise<ChatFilePart[]> {
                if (t.origin.kind !== 'user' || !route.sessionId) return [];
                const { chatId, messageId } = t.origin;
                try {
                    const { entries } = await chatAsAgent(route, chatId).history(null, TRIGGER_LOOKBACK);
                    const entry = entries.find((e) => e.entry.t === 'msg' && e.entry.id === messageId)?.entry;
                    return entry?.t === 'msg' ? entry.parts.filter(isChatFilePart) : [];
                } catch {
                    return [];
                }
            }

            /**
             * The chat's messages a reused session's engine has not seen (#393): those after the route's `seenSeq`
             * that its agent may read — `Chat.history` as the agent applies `historyFrom`, which is where `seenSeq: 0`
             * starts — oldest first, the triggering message left out, at most `CATCH_UP_WINDOW`; rendered by
             * `catchUp` with every author named. Best effort: a chat that cannot be read gives nothing.
             */
            async function unseen(route: Route, t: TaskView): Promise<PromptPart[]> {
                const { chatId, seenSeq } = route;
                if (!chatId || seenSeq === undefined || !route.sessionId) return [];
                const trigger = t.origin.kind === 'user' ? t.origin.messageId : undefined;
                try {
                    const room = chatAsAgent(route, chatId);
                    const messages: ChatMessage[] = [];
                    let cursor: number | null = null;
                    for (;;) {
                        const page = await room.history(cursor, CATCH_UP_WINDOW);
                        const fresh = page.entries.filter((e): e is typeof e & { entry: ChatMessage } => e.seq > seenSeq && e.entry.t === 'msg' && e.entry.id !== trigger);
                        messages.unshift(...fresh.map((e) => e.entry));
                        const oldest = page.entries[0]?.seq;
                        if (page.next === null || oldest === undefined || oldest <= seenSeq || messages.length >= CATCH_UP_WINDOW) break;
                        cursor = page.next;
                    }
                    const window = messages.slice(-CATCH_UP_WINDOW);
                    const names = new Map<string, string>([[route.agentId, `${route.config.name || route.agentId} (you)`]]);
                    for (const m of window) {
                        if (m.author.kind !== 'agent' || names.has(m.author.agentId)) continue;
                        const id = m.author.agentId;
                        names.set(id, await agent(id).snapshotForSession().then((c) => c.name || id, () => id));
                    }
                    return catchUp(window, (author) => (author.kind === 'user' ? 'User' : (names.get(author.agentId) ?? author.agentId)));
                } catch {
                    return [];
                }
            }

            /**
             * The turn's input: the objective, the triggering message's attachments the rest does not already
             * carry, then the rest — the task's context on a fresh session, the chat's unseen messages on a
             * reused one (#393: its engine keeps its own conversation, so the pre-rendered chat is not sent
             * again) — every attachment resolved for the route's agent (#205): images inlined within
             * `CHAT_FILE_INLINE_BUDGET` (the trigger's first, then the newest), everything else a note
             * (`hydrateChatFiles`).
             */
            async function promptInput(route: Route, t: TaskView): Promise<PromptPart[]> {
                const trigger = await triggerFiles(route, t);
                const rest = route.seenSeq === undefined ? t.context : await unseen(route, t);
                const inRest = new Set(rest.filter(isChatFilePart).map((p) => p.url));
                const parts: PromptPart[] = [{ type: 'text', text: t.objective }, ...trigger.filter((p) => !inRest.has(p.url)), ...rest];
                if (!parts.some(isChatFilePart)) return parts;
                return hydrateChatFiles(parts, {
                    workspaceId,
                    access: (chatId, fileId) => chatAsAgent(route, chatId).fileAccess(fileId),
                    ...(ports.files ? { store: ports.files } : {}),
                    first: trigger.map((p) => p.url)
                });
            }

            /**
             * Send a route's prompt, under its own task (#390), idempotent by the requested turn id `{taskId}:turn:1`
             * (a retry after an eviction runs once). The seam a message into a live session goes through (#395, S7;
             * CHT-09): decided from the Session record BEFORE anything is sent —
             * - the session is idle: the prompt starts the route's own turn;
             * - it runs another turn and its runtime reports `steer`: the prompt is sent into it and the ack names that
             *   turn — the route binds to it (`turnId`, `joined`) and settles with it, the task record saying so
             *   (`waiting {turn}` resolved `joined running turn …`);
             * - it runs another turn its runtime cannot take a message into: nothing is sent, the route parks
             *   `waiting-turn` and the task waits `{turn, sessionId, turnId}` until that turn ends (`turnEnded`), when
             *   it is prompted again.
             * A `busy` the wire answers after that is the environment's (#394), not this session's, and is left to the
             * caller with every other refusal. `requested` is the turn the prompt starts when the session is idle: the
             * route's own `{taskId}:turn:1`, or a later turn of the same task (a late `ask_user` answer, #396).
             */
            async function steerOrPrompt(route: Route, input: readonly PromptPart[], requested = `${route.taskId}:turn:1`): Promise<{ readonly turnId: string } | 'busy' | Extract<SessionCommandResult, { kind: 'error' }>> {
                const sessionId = route.sessionId!;
                const info = await session(sessionId).get();
                // A record already running THIS route's turn is a retry: `dispatch` answers with the remembered ack.
                const running = info.running && info.running.turnId !== requested ? info.running : undefined;
                if (running) {
                    await park(route, { kind: 'turn', sessionId, turnId: running.turnId }, `session ${sessionId} runs turn ${running.turnId}`, sessionId);
                    if (!info.capabilities?.steer) {
                        route.status = 'waiting-turn';
                        touch(route);
                        return 'busy';
                    }
                }
                // Between turns only (#453, AGT-07): a reused session takes the member's model / mode before its next prompt; a
                // turn running now keeps what it runs with, and a steered prompt joins it as it is.
                const drift = running ? {} : optionsDrift(info.options, route.options);
                if (Object.keys(drift).length) {
                    const commandId = `${requested}:configure${route.attempt ? `#${route.attempt}` : ''}`;
                    if (!info.capabilities?.config) {
                        return { v: 1, kind: 'error', commandId, code: 'unsupported', message: `session ${sessionId} cannot switch ${Object.keys(drift).join(' and ')} while it lives: start a new session for the member` } as Extract<SessionCommandResult, { kind: 'error' }>;
                    }
                    const configured = await session(sessionId).configure(drift, commandId);
                    if (configured.kind === 'error') return configured;
                }
                // After a `busy` the machine answered (#394) the prompt goes out again under a fresh command id: `dispatch` would answer a known one with the refusal it remembers.
                const reply = await session(sessionId).prompt(input, requested, undefined, route.attempt ? `${requested}#${route.attempt}` : undefined, { taskId: route.taskId });
                if (reply.kind === 'error') return reply;
                // The turn the route is bound to: the one the ack names (local: the running turn on a steer, `serveSession`
                // answers with its id), or — the daemon's ack comes later, this reply is `pending` — the turn the record runs,
                // which is the id a steering runtime answers, provided it still runs now that the prompt is out (one that
                // ended in between left the prompt to start the route's own turn); a refusal the daemon sends after that
                // stays on the Session's command.
                const still = reply.kind === 'pending' && running ? (await session(sessionId).get()).running : undefined;
                route.turnId = (reply.kind === 'ack' ? reply.turnId : still && still.turnId === running?.turnId ? still.turnId : undefined) ?? requested;
                route.joined = route.turnId !== requested;
                if (running) await activate(route, route.joined ? `joined running turn ${route.turnId}` : `turn ${running.turnId} ended before the prompt; started turn ${route.turnId}`, sessionId);
                return { turnId: route.turnId };
            }

            /**
             * The one prompt of a route: `steerOrPrompt`, then `follow` picks the turn up; a refusal fails the task. A
             * route holding an answer (#396: handed over while its session ran another turn) sends that, into the
             * answer's own turn, instead of the task's input.
             */
            async function prompt(route: Route): Promise<void> {
                if (!route.sessionId) return;
                const t = await task(route.taskId).get();
                if (isTerminal(t.status)) {
                    drop(route.taskId);
                    return;
                }
                // The environment's capacity (#394): another session's turn in the way parks this one until `slotFreed`. A turn
                // on this route's OWN session already holds its slot — `steerOrPrompt` joins it or waits for it (#395), below.
                const { free, m } = await slot(route);
                if (!free) {
                    await parkOnCapacity(route, m!);
                    return;
                }
                const answer = route.answer ? ctx.snapshot(route.answer) : undefined;
                const input = answer ? answer.input : await promptInput(route, t);
                const sent = await steerOrPrompt(route, input, answer?.turnId);
                if (sent === 'busy') {
                    // Parked `waiting-turn`: `follow` watches the turn in the way when no route of ours follows it (#510).
                    await ctx.tasks.start('follow');
                    wakers.get(ctx.key)?.();
                    return;
                }
                if ('kind' in sent) {
                    // The environment is busy after all (#394): wait for a turn to end there. A local route's `busy` is its own session's (#395).
                    if (sent.code === 'busy' && m) {
                        route.attempt = (route.attempt ?? 0) + 1;
                        await parkOnCapacity(route, m);
                        return;
                    }
                    await fail(route, { code: `prompt-${sent.code}`, message: sent.message, recoverable: sent.code === 'busy' });
                    return;
                }
                delete route.answer;
                route.status = 'running';
                touch(route);
                if (answer) await joinAnswerTurn(route, answer.requestId);
                await ctx.tasks.start('follow');
                wakers.get(ctx.key)?.();
            }

            /**
             * The answer to `requestId` just went out under `route` (#396): every other route still waiting on that
             * question — a task that shared the asking turn (#395) — joins the answer's turn, whenever it went out (at
             * once, or after the route was parked on a running turn or on capacity with the answer on it).
             */
            async function joinAnswerTurn(route: Route, requestId: string): Promise<void> {
                for (const other of Object.values(ctx.state.routes)) {
                    if (other === route || other.sessionId !== route.sessionId || other.status !== 'waiting-answer' || other.question !== requestId) continue;
                    await activate(other, `request ${requestId}: input; joined turn ${route.turnId}`, route.sessionId!);
                    delete other.question;
                    if (route.head) other.head = route.head;
                    other.turnId = route.turnId;
                    other.joined = true;
                    other.status = 'running';
                    touch(other);
                }
            }

            /**
             * The work the session opens on: the task's objective and context — fixed at
             * the task's creation — so the Session's memory retrieval ranks on the task and
             * a lesson learned from it names the task (architecture §8; MEM-07, LRN-05).
             * `run` passes the view it already read; a retry reads the task once.
             */
            async function work(route: Route, t?: Pick<TaskView, 'objective' | 'context' | 'resumeFrom'>): Promise<Pick<SessionOpenSpec, 'objective' | 'context' | 'roster' | 'resume'>> {
                const { objective, context, resumeFrom } = t ?? (await task(route.taskId).get());
                const roster = await rosterOf(route);
                const resume = resumeFrom ? await resumable(route, resumeFrom) : undefined;
                return { objective, context, ...(roster ? { roster } : {}), ...(resume !== undefined ? { resume } : {}) };
            }

            /**
             * The engine conversation a task continues (#285, `TaskContract.resumeFrom`): the earlier session's `ref`,
             * when a daemon ran it for the same agent on the same runtime, environment and machine as this placement —
             * the engine keeps its conversation where it ran. A local (API) session's transcript lives in its own
             * Session record, so it is never resumed from another. Otherwise nothing: the session opens fresh and the
             * contract's context (the question, the answer, the chat) carries on.
             */
            async function resumable(route: Route, from: SessionId): Promise<SessionOpenSpec['resume']> {
                try {
                    const earlier = await session(from).get();
                    const spec = earlier.spec;
                    if (!earlier.ref || !spec?.machineId || spec.machineId !== route.machineId) return undefined;
                    if (spec.agentId !== route.agentId || spec.runtime !== route.runtime || spec.environmentId !== route.environmentId) return undefined;
                    return ctx.snapshot(earlier.ref);
                } catch {
                    return undefined;
                }
            }

            /**
             * The chat the task came from, as the session's prompt names it (CHT-07): every member by
             * name and role, the coordinator, and which member this session runs as — so an agent reaches
             * the others through `delegate` / `chat_post`, never through a runtime's own agent messaging.
             * Best effort: a chat or member that cannot be read leaves the prompt without the section or
             * the member by its id, and never fails the placement.
             */
            async function rosterOf(route: Route): Promise<ChatRoster | undefined> {
                if (!route.chatId) return undefined;
                try {
                    const summary = await chat(route.chatId).get();
                    const members = await Promise.all(
                        Object.keys(summary.members).map(async (id) => {
                            const config = id === route.agentId ? route.config : await agent(id as AgentId).snapshotForSession().catch(() => null);
                            const role = config?.role.trim();
                            return { agentId: id as AgentId, name: config?.name || id, ...(role ? { role } : {}) };
                        })
                    );
                    return {
                        chatId: route.chatId,
                        ...(summary.title ? { title: summary.title } : {}),
                        self: route.agentId,
                        ...(summary.coordinator ? { coordinator: summary.coordinator } : {}),
                        members,
                        ...(summary.project ? { project: summary.project } : {})
                    };
                } catch {
                    return undefined;
                }
            }

            /**
             * The task's project as the Workspace has it now (#332): read at `run` and again at every placement, so a
             * project removed meanwhile fails the task `project-missing` rather than running in a folder nobody chose.
             */
            async function projectOf(route: Pick<Route, 'projectId'>): Promise<{ project?: ProjectRecord; error?: TaskError }> {
                if (!route.projectId) return {};
                let projects: readonly ProjectRecord[];
                try {
                    projects = await as(Workspace, workspaceKey(workspaceId)).projects();
                } catch (e) {
                    return { error: { code: 'workspace-unavailable', message: `the workspace could not be asked about project ${route.projectId}: ${e instanceof Error ? e.message : String(e)}`, recoverable: true } };
                }
                const project = projects.find((p) => p.id === route.projectId);
                if (!project) return { error: { code: PROJECT_MISSING_CODE, message: `project ${route.projectId} no longer exists`, recoverable: false } };
                return { project: ctx.snapshot(project) };
            }

            /**
             * The project's feature plugins for this placement (#332): `beforeSession` over the environment's daemon
             * (`fs`), and every plugin's `instructions()`. `undefined` when the placement goes on — with the folder and
             * instructions to use — else the route was failed or parked here and the caller returns.
             */
            async function projectHooks(route: Route, fs: 'daemon' | 'local'): Promise<{ cwd?: string; instructions?: string } | undefined> {
                const { project, error } = await projectOf(route);
                if (error) {
                    await fail(route, error);
                    return undefined;
                }
                if (!project) return {};
                const outcome: FeatureHooksOutcome = await runFeatureHooks({
                    project,
                    plugins: projectFeatures,
                    taskId: route.taskId,
                    ...(route.chatId ? { chatId: route.chatId } : {}),
                    ...(route.environmentId ? { environmentId: route.environmentId } : {}),
                    ...(route.cwd !== undefined ? { cwd: route.cwd } : {}),
                    fs: fs === 'daemon' && route.machineId && route.environmentId ? machineFs(machine(route.machineId), route.environmentId, { now }) : noDaemonFs
                });
                if (!outcome.ok) {
                    // The plugin said why; the task waits with its words, and the next `run` starts the hooks over (EXE-12: never a silent fallback).
                    await park(route, { kind: 'project-feature', pluginId: outcome.pluginId, message: outcome.message }, `project feature ${outcome.pluginId}: ${outcome.message}`);
                    return undefined;
                }
                return { ...(outcome.cwd !== undefined ? { cwd: outcome.cwd } : {}), ...(outcome.instructions !== undefined ? { instructions: outcome.instructions } : {}) };
            }

            /**
             * Whether the chat's session for the route's member can carry on with THIS placement (#393). Refused — never
             * migrated (EXE-12/13) — when the record is closed or was never opened, when the placement moved (runtime,
             * environment, machine or folder differ from the record's spec), or when a daemon-path record has no ref:
             * its runtime never named it, so nothing could be resumed. A record that cannot be read is not reused.
             */
            async function reusable(route: Route, sessionId: SessionId): Promise<boolean> {
                let earlier: SessionInfo;
                try {
                    earlier = await session(sessionId).get();
                } catch {
                    return false;
                }
                const spec = earlier.spec;
                if (!earlier.opened || !spec || earlier.status === 'closed') return false;
                if (spec.runtime !== route.runtime || spec.environmentId !== route.environmentId || spec.machineId !== route.machineId || spec.cwd !== route.cwd) return false;
                if (earlier.mode === 'remote' && !earlier.ref) return false;
                return true;
            }

            /**
             * Bind the route to its session (#393; CHT-01, CHT-11): a chat route takes the member's live session from the
             * chat's binding (`ChatSummary.sessions[agentId]`) when `reusable`, with the chat's `seenSeq` for the prompt;
             * otherwise — and always for a chatless route — a fresh id. A binding refused is ended first: its
             * `session-ended` drops the chat's row, and the new session's `session-started` replaces it either way.
             * Idempotent: a route already bound (a retry) keeps its id. Called once the placement is final (the folder
             * included), since that is what reuse is judged on.
             */
            /**
             * The route's session options (#453): the chat member's (`Chat.setOptions`) over the task's, over the agent's
             * config and the plugin's defaults — read when the turn is placed, so a change made after the task was created
             * still applies to it. A chat that cannot be read leaves the member's out.
             */
            async function settleOptions(route: Route, t?: TaskView): Promise<SessionOptions> {
                const member = route.chatId
                    ? await chat(route.chatId)
                          .get()
                          .then((summary) => summary.members[route.agentId]?.options, () => undefined)
                    : undefined;
                return sessionOptionsOf(route.config, route.plugins, { ...t?.options, ...member });
            }

            async function bindSession(route: Route): Promise<SessionId> {
                if (route.sessionId) return route.sessionId;
                if (route.chatId) {
                    const row = await chat(route.chatId)
                        .get()
                        .then((summary) => summary.sessions[route.agentId], () => undefined);
                    if (row) {
                        if (await reusable(route, row.sessionId)) {
                            route.sessionId = row.sessionId;
                            route.seenSeq = row.seenSeq;
                            return row.sessionId;
                        }
                        await session(row.sessionId)
                            .close()
                            .catch(() => undefined);
                    }
                }
                route.sessionId = newSessionId();
                return route.sessionId;
            }

            /** Open a local Session (a runtime hosted in this process — `anthropic-api`) for the route and prompt it. */
            async function placeLocal(route: Route, why: string, t?: TaskView): Promise<void> {
                // The project's plugins first (#332): a platform-hosted runtime runs in no folder, so only their instructions apply here.
                const hooks = await projectHooks(route, 'local');
                if (!hooks) return;
                const sessionId = await bindSession(route);
                route.options = await settleOptions(route, t);
                // Detached copies: the route lives in the actor's state, and a spec is cloned by the actors it reaches.
                const spec: SessionOpenSpec = {
                    agentId: route.agentId,
                    runtime: route.runtime,
                    ...(route.chatId ? { chatId: route.chatId } : {}),
                    taskId: route.taskId,
                    ...(await work(route, t)),
                    config: ctx.snapshot(withModel(route.config, route.options)),
                    ...(route.constraints ? { approvalConstraints: ctx.snapshot(route.constraints) } : {}),
                    tools: grantedToolNames(route),
                    ...(route.plugins ? { plugins: ctx.snapshot(route.plugins) } : {}),
                    ...(hooks.instructions ? { projectInstructions: hooks.instructions } : {})
                };
                let opened: SessionInfo;
                try {
                    opened = await session(sessionId).open(spec);
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    // The plugin was turned off between the gate and the open: the same failure the gate gives, not a broken session.
                    const disabled = message.includes(`${PLUGIN_DISABLED_CODE}:`);
                    await fail(route, { code: disabled ? PLUGIN_DISABLED_CODE : 'session-open', message, recoverable: disabled });
                    return;
                }
                route.head = opened.head;
                await activate(route, why, sessionId);
                await prompt(route);
            }

            /**
             * The environment is unavailable — its machine is offline, or no machine of the
             * workspace reports it yet: park the task and apply the agent's policy. Every
             * branch leaves a transition that says why.
             */
            async function offline(route: Route, m: MachineView | null): Promise<void> {
                const environmentId = route.environmentId!;
                const where = m ? `environment ${environmentId} on machine ${m.machineId}${m.name ? ` (${m.name})` : ''}` : `environment ${environmentId} (no machine of the workspace reports it)`;
                await park(route, { kind: 'environment-offline', environmentId, policy: route.policy }, `${where} is offline`);
                switch (route.policy) {
                    case 'queue':
                        route.status = 'waiting-offline';
                        touch(route);
                        return;
                    case 'fail':
                        await fail(route, { code: 'environment-offline', message: `${where} is offline; the agent's offline policy is "fail"`, recoverable: true });
                        return;
                    case 'fallback-api': {
                        // NEW use of another runtime: its plugin answers for itself before the task leaves its environment (AC-13).
                        // The project first (#332): one gone meanwhile fails the task here, before a fallback is gated or recorded.
                        const { project, error: projectError } = await projectOf(route);
                        if (projectError) {
                            await fail(route, projectError);
                            return;
                        }
                        const asked = await gate(FALLBACK_RUNTIME, `fallback-api: ${where} is offline`, connectorIds(route.config, project));
                        if (asked.error) {
                            await fail(route, asked.error);
                            return;
                        }
                        if (asked.plugins) route.plugins = asked.plugins;
                        // Explicitly allowed by the config: the record says the task left its environment, and why (EXE-11/12).
                        const why = `fallback-api: ${where} is offline; running on anthropic-api as the agent's offline policy allows`;
                        const from = { runtime: route.runtime, environmentId, ...(route.machineId ? { machineId: route.machineId } : {}) };
                        route.runtime = FALLBACK_RUNTIME;
                        delete route.sessionId;
                        touch(route);
                        await audit.record(ctx, workspaceId, {
                            key: `${taskKey(workspaceId, route.taskId)}:environment:fallback`,
                            kind: 'environment.chosen',
                            at: now(),
                            by: ROUTER,
                            summary: why,
                            agentId: route.agentId,
                            taskId: route.taskId,
                            data: { runtime: 'anthropic-api', policy: route.policy, fallback: true, from, ...(route.cwd !== undefined ? { ignoredWorkdir: route.cwd } : {}), why }
                        });
                        await placeLocal(route, why);
                        return;
                    }
                }
            }

            /**
             * Host the route's session on its machine (#393, #420): the Session record opened with `spec` first — the daemon's
             * `session.opened` may arrive before `openSession` returns — then `Machine.openSession` with what the daemon runs.
             * The record's `system` is that one: the instructions plus the memory block `open` retrieved (§8). A re-opened
             * record resumes from the ref its runtime reported (#389); a fresh one from `resume`, what the task named (#285).
             * Whatever the open or the machine throws is the caller's to judge.
             */
            async function hostSession(route: Route, sessionId: SessionId, spec: SessionOpenSpec, resume?: SessionOpenSpec['resume']): Promise<OpenSessionResult> {
                const machineId = route.machineId!;
                const opened = await session(sessionId).open(spec);
                route.head = opened.head;
                const limits = route.config.execution.limits;
                const model = spec.config.execution.model;
                const placed = daemonConnectors(route.plugins?.connectors ?? [], machineId);
                return machine(machineId).openSession(
                    sessionId,
                    route.environmentId!,
                    {
                        agentId: route.agentId,
                        cwd: route.cwd ?? '',
                        system: opened.spec?.system ?? spec.system ?? route.config.instructions,
                        ...(model ? { model } : {}),
                        ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
                        ...(limits.maxTurns !== undefined ? { maxTurns: limits.maxTurns } : {}),
                        ...(limits.maxCostUsd !== undefined ? { maxBudgetUsd: limits.maxCostUsd } : {}),
                        tools: grantedToolNames(route),
                        policy: ctx.snapshot(openSpecPolicy(route)),
                        ...(placed.connectors.length ? { connectors: placed.connectors } : {}),
                        ...(opened.ref !== undefined ? { resume: opened.ref } : resume !== undefined ? { resume } : {})
                    },
                    { taskId: route.taskId }
                );
            }

            /**
             * Re-open an interrupted route's session on its machine (#420): the machine lost it (a daemon restart) and a
             * prompt would go nowhere. The record's own spec, its ref as `spec.resume` (`hostSession`); the route stays
             * `interrupted`, `rehosting`, until the daemon acknowledges it — `sessionOpened` then resumes the turn
             * (`resumeHosted`), a `session.closed` instead sends the task to a fresh session (`sessionClosed`). A machine
             * that cannot take it now (offline, gone) leaves the route as it was and says why. A record its host closed
             * (its runtime never named it: nothing to resume from) goes straight to a fresh session.
             */
            async function rehost(route: Route): Promise<void> {
                const sessionId = route.sessionId!;
                const info = await session(sessionId).get();
                if (info.status === 'closed') return freshSession(route);
                if (!info.spec) throw new ServerFnError(409, `task ${route.taskId}: session ${sessionId} has no spec to re-open`);
                route.rehosting = true;
                touch(route);
                try {
                    await hostSession(route, sessionId, ctx.snapshot(info.spec));
                } catch (e) {
                    delete route.rehosting;
                    const status = isServerFnError(e) ? e.status : 500;
                    throw new ServerFnError(status, `task ${route.taskId}: session ${sessionId} could not be re-opened on machine ${route.machineId}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }

            /**
             * Re-open the session a parked route waits on (#433), lost to a daemon restart or update: the record's own spec,
             * its ref as `spec.resume` (`hostSession`). The route stays `waiting-capacity` and `sessionOpened` prompts it when
             * the daemon acknowledges — into the same session, under the same task. A machine that cannot take it now
             * (offline) keeps it for the next `hello`; a record that cannot be re-opened fails the task, recoverable.
             */
            async function reopenParked(route: Route): Promise<void> {
                const sessionId = route.sessionId!;
                delete route.reopen;
                touch(route);
                const info = await session(sessionId)
                    .get()
                    .catch(() => undefined);
                if (!info?.spec || info.status === 'closed') {
                    await fail(route, { code: 'session-refused', message: `machine ${route.machineId} closed session ${sessionId} and it cannot be re-opened`, recoverable: true });
                    return;
                }
                try {
                    await hostSession(route, sessionId, ctx.snapshot(info.spec));
                } catch (e) {
                    if (isServerFnError(e) && e.status === 503) {
                        route.reopen = true;
                        return;
                    }
                    await fail(route, { code: 'session-open', message: e instanceof Error ? e.message : String(e), recoverable: true });
                }
            }

            /**
             * Resume an interrupted turn on a session its machine hosts (OPS-05): `Session.resume` prompts it anew with the
             * cut turn's input over the intact transcript, the task's `waiting {input, resume:…}` resolves `active` and
             * `follow` picks the new turn up. A refusal fails the task with the reply.
             */
            async function resumeHosted(route: Route): Promise<void> {
                const sessionId = route.sessionId!;
                const cut = route.turnId!;
                const reply = await session(sessionId).resume();
                if (reply.kind === 'error') {
                    await fail(route, { code: `resume-${reply.code}`, message: reply.message, recoverable: false });
                    return;
                }
                const t = await task(route.taskId).get();
                if (t.status === 'waiting') await task(route.taskId).resolveWaiting(ROUTER, `resumed: a new prompt over the intact transcript (turn ${cut} was interrupted)`, sessionId);
                route.turnId = resumeTurnId(cut);
                route.status = 'running';
                touch(route);
                await resumed(route, 're-host', cut);
                await ctx.tasks.start('follow');
                wakers.get(ctx.key)?.();
            }

            /** `session.resumed` (#366): the interrupted turn `cut` went on — `how`, and who asked (`Route.resumedBy`). */
            async function resumed(route: Route, how: 're-host' | 'fresh', cut: string): Promise<void> {
                const by = route.resumedBy ?? ROUTER;
                delete route.resumedBy;
                const sessionId = route.sessionId!;
                await audit.record(ctx, workspaceId, {
                    key: `${taskKey(workspaceId, route.taskId)}:resumed:${cut}`,
                    kind: 'session.resumed',
                    at: now(),
                    by,
                    summary: how === 're-host' ? `interrupted turn ${cut} resumed in session ${sessionId}` : `interrupted turn ${cut} went on in a fresh session ${sessionId}: the machine refused to re-open the old one`,
                    agentId: route.agentId,
                    taskId: route.taskId,
                    sessionId,
                    data: { sessionId, taskId: route.taskId, how, by }
                });
            }

            /**
             * Resume an interrupted route (OPS-05) for `by`: re-opened on its machine first when the machine no longer hosts
             * its session (`rehost`), else prompted at once (`resumeHosted`).
             */
            async function resumeRoute(route: Route, by: string): Promise<void> {
                const sessionId = route.sessionId!;
                route.resumedBy = by;
                if (route.machineId && !(await machine(route.machineId).get()).activeSessions.some((h) => h.sessionId === sessionId)) await rehost(route);
                else await resumeHosted(route);
            }

            /**
             * `onInterrupt: 'auto'` (#366; EXE-08): an interrupted route on a machine that is online, whose agent says so,
             * is resumed once on its own as `system:routing`. Once per cut turn (`autoResumed`): a second interruption of
             * the same turn waits for a person, and so does a resume that fails.
             */
            async function autoResumeRoute(route: Route): Promise<void> {
                if (route.status !== 'interrupted' || route.rehosting || !route.turnId || !route.sessionId || !route.machineId) return;
                if (route.config.execution.onInterrupt !== 'auto') return;
                const cut = baseTurnId(route.turnId);
                if (route.autoResumed === cut) return;
                if (!(await machine(route.machineId).get()).online) return;
                route.autoResumed = cut;
                touch(route);
                try {
                    await resumeRoute(route, ROUTER);
                } catch {
                    // The machine could not take it now: the task keeps waiting for a person's Resume.
                    delete route.resumedBy;
                }
            }

            /** The machine-lost reminder, due when the route offline longest reaches `MACHINE_LOST_MS` (#366) — or cleared when none is offline. */
            async function armLost(): Promise<void> {
                const since = Object.values(ctx.state.routes).flatMap((r) => (r.offlineSince === undefined ? [] : [r.offlineSince]));
                if (!since.length) await ctx.reminders.clear(MACHINE_LOST_REMINDER);
                else await ctx.reminders.set(MACHINE_LOST_REMINDER, { due: Math.max(REMINDER_FLOOR_MS, Math.min(...since) + MACHINE_LOST_MS - now()) });
            }

            /**
             * A re-open the daemon refused (#420): the task goes on in a fresh session — a new id on the same machine and
             * environment, placed as any task is, resuming the engine conversation from the lost session's ref where it can
             * (`resumeFrom` → `resumable`) and prompted with the task's own input.
             */
            async function freshSession(route: Route): Promise<void> {
                const from = route.sessionId!;
                const cut = route.turnId;
                delete route.rehosting;
                delete route.seenSeq;
                delete route.turnId;
                delete route.joined;
                delete route.attempt;
                delete route.head;
                // Minted here, not bound: the chat's binding may still name the lost session, and `bindSession` would take it
                // again. The chat member is rebound to the new one by its first open (`session-started`), over the lost one's
                // `session-ended` when the refusal closed it (#366).
                route.sessionId = newSessionId();
                route.status = 'opening';
                if (cut) await resumed(route, 'fresh', cut);
                const t = await task(route.taskId).get();
                await placeRemote(route, undefined, { ...t, resumeFrom: from });
            }

            /**
             * Open the route's Session on ITS machine (never another), or park it. A route no machine reported yet is
             * located first — and bound to that machine from then on; `run` hands in what it already located.
             */
            async function placeRemote(route: Route, view?: MachineView, t?: TaskView, located?: LocatedEnvironment | null): Promise<void> {
                const { environmentId } = route;
                if (!environmentId) return;
                if (!route.machineId) {
                    const found = located !== undefined ? located : await locate(environmentId);
                    if (!found) {
                        await offline(route, null);
                        return;
                    }
                    if (found.env.runtime !== route.runtime) {
                        await fail(route, { code: 'runtime-mismatch', message: `environment ${environmentId} runs ${found.env.runtime}, the agent is configured for ${route.runtime}`, recoverable: false });
                        return;
                    }
                    route.machineId = found.machine.machineId;
                    view = found.machine;
                }
                const machineId = route.machineId;
                const m = view ?? (await machine(machineId).get());
                const env: EnvironmentDescriptor | undefined = m.environments.find((e) => e.id === environmentId);
                if (!env) {
                    await fail(route, { code: 'unknown-environment', message: `machine ${machineId} no longer reports environment ${environmentId}`, recoverable: true });
                    return;
                }
                // The folder (#190): the first root when nothing earlier chose one, and always inside the roots (decision 3) —
                // checked against the roots the machine reports now, before a session exists, online or not.
                route.cwd ??= env.cwdRoots[0];
                if (route.cwd !== undefined && !pathWithin(route.cwd, env.cwdRoots, osOf(m))) {
                    await fail(route, { code: 'workdir-outside-roots', message: `folder ${route.cwd} is outside the roots of environment ${environmentId} on machine ${machineId} (${env.cwdRoots.join(', ') || 'none'})`, recoverable: false });
                    return;
                }
                if (!m.online) {
                    await offline(route, m);
                    return;
                }
                // The project's feature plugins (#332), with the folder final and the daemon there to ask: a plugin may move the
                // session into a folder of its own (a worktree), checked against the same roots before anything opens.
                const hooks = await projectHooks(route, 'daemon');
                if (!hooks) return;
                if (hooks.cwd !== undefined && hooks.cwd !== route.cwd) {
                    if (!pathWithin(hooks.cwd, env.cwdRoots, osOf(m))) {
                        await fail(route, { code: 'workdir-outside-roots', message: `folder ${hooks.cwd} (from a project feature plugin) is outside the roots of environment ${environmentId} on machine ${machineId} (${env.cwdRoots.join(', ') || 'none'})`, recoverable: false });
                        return;
                    }
                    route.cwd = hooks.cwd;
                }
                const sessionId = await bindSession(route);
                const options = (route.options = await settleOptions(route, t));
                // A mode that asks about nothing runs only where the machine allows it (#453) — never silently another mode (EXE-12).
                if (options.permissionMode === BYPASS_PERMISSIONS_MODE && !env.allowBypassPermissions) {
                    await fail(route, { code: 'permission-mode-not-allowed', message: `permission mode ${BYPASS_PERMISSIONS_MODE} is not allowed in environment ${environmentId} on machine ${machineId}: set allowBypassPermissions on it in environments.json there, or pick another mode`, recoverable: true });
                    return;
                }
                const opening = await work(route, t);
                const tools = grantedToolNames(route);
                const effective = withModel(route.config, options);
                // The agent's MCP connectors (#280): the ready ones go to the daemon, secret names only; the rest are named in the prompt.
                const placed = daemonConnectors(route.plugins?.connectors ?? [], machineId);
                const spec: SessionOpenSpec = {
                    agentId: route.agentId,
                    runtime: route.runtime,
                    ...(route.chatId ? { chatId: route.chatId } : {}),
                    taskId: route.taskId,
                    environmentId,
                    machineId,
                    ...(route.cwd !== undefined ? { cwd: route.cwd } : {}),
                    ...opening,
                    config: ctx.snapshot(effective),
                    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
                    ...(route.constraints ? { approvalConstraints: ctx.snapshot(route.constraints) } : {}),
                    ...(route.plugins ? { plugins: ctx.snapshot(route.plugins) } : {}),
                    ...(hooks.instructions ? { projectInstructions: hooks.instructions } : {}),
                    // The same prompt the API path builds (identity, role, instructions, skills, the chat, the project, the tools);
                    // `open` appends the memory block. The daemon's runtime appends it to its own preset.
                    system: buildSystemPrompt({ config: route.config, tools, ...(opening.roster ? { roster: opening.roster } : {}), ...(hooks.instructions ? { project: hooks.instructions } : {}), ...(placed.unavailable.length ? { unavailableConnectors: placed.unavailable } : {}) }),
                    tools
                };
                // The route is `opening` from here, so a `sessionOpened` notification (its own turn, after this one) always finds it ready.
                route.status = 'opening';
                let result: OpenSessionResult;
                try {
                    result = await hostSession(route, sessionId, spec, opening.resume);
                } catch (e) {
                    if (isServerFnError(e) && e.status === 503) {
                        await offline(route, { ...m, online: false });
                        return;
                    }
                    await fail(route, { code: isServerFnError(e) && e.status === 404 ? 'unknown-environment' : 'session-open', message: e instanceof Error ? e.message : String(e), recoverable: true });
                    return;
                }
                const where = `environment ${environmentId} on machine ${machineId}`;
                if (result === 'opened') {
                    // A session the machine already hosts and the daemon acknowledged (a reused one, #393) gets no
                    // `session.opened` of its own — `openSession` is idempotent by id — so it is prompted here.
                    const live = m.activeSessions.some((h) => h.sessionId === sessionId && h.status === 'open');
                    await activate(route, `${where} is online; session ${live ? 'live' : 'opening'}`, sessionId);
                    if (live) await prompt(route);
                } else {
                    const after = await machine(machineId).get();
                    const position = after.queued.findIndex((q) => q.sessionId === sessionId) + 1;
                    await park(route, { kind: 'capacity', environmentId, position: Math.max(1, position) }, `${where} is online; waiting for a slot`, sessionId);
                    route.status = 'waiting-capacity';
                }
                touch(route);
            }

            const locate = (environmentId: EnvironmentId, preferMachineId?: MachineId) => locateEnvironment(workspaceId, environmentId, { machines: ports.machines, driver, ...(preferMachineId ? { preferMachineId } : {}) });
            const readPairedMachine = (machineId: MachineId) => readMachine(workspaceId, machineId, { machines: ports.machines, driver });

            /**
             * The one question to the Registry before NEW work on `runtime` (§9, AC-13): `undefined` when the app has no
             * Registry — nothing is gated. A plugin that is missing or turned off, or a Registry that cannot be asked,
             * comes back as the error the task fails with; running work is never touched.
             */
            async function gate(runtime: RuntimeId, leaving?: string, connectors?: readonly string[]): Promise<{ plugins?: RegistryGate; error?: TaskError }> {
                if (!ports.registry) return {};
                const because = leaving ? ` (${leaving})` : '';
                let plugins: RegistryGate;
                try {
                    // The agent's connectors ride on the same hop (#240): the session opens the ready ones and says why the others are not there.
                    plugins = await (actor(ports.registry(), registryKey(workspaceId)).with({ context }) as unknown as RegistryClient).gate({ runtime, ...(connectors?.length ? { connectors } : {}) });
                } catch (e) {
                    return { error: { code: 'registry-unavailable', message: `the plugin registry could not be asked about runtime ${runtime}${because}: ${e instanceof Error ? e.message : String(e)}`, recoverable: true } };
                }
                if (!plugins.runtime) return { error: { code: PLUGIN_DISABLED_CODE, message: `no runtime plugin "${runtime}" is installed in this workspace${because}`, recoverable: true } };
                if (!plugins.runtime.enabled) return { error: { code: PLUGIN_DISABLED_CODE, message: `the "${runtime}" runtime plugin is turned off${because}; turn it on at /plugins/${runtime}`, recoverable: true } };
                return { plugins };
            }

            /** Whether `runtime` opens in this process. Without a catalogue: `anthropic-api` does, everything else is a daemon's. */
            const hostOf = (runtime: RuntimeId): 'local' | 'daemon' | undefined => (ports.runtimes ? resolveRuntime(ports.runtimes, runtime)?.host : runtime === FALLBACK_RUNTIME ? 'local' : 'daemon');

            /** The workspace's default environment (AGT-05) — asked only when the task, the agent and a delegating task all name none. */
            async function workspaceEnvironment(): Promise<EnvironmentId | undefined> {
                try {
                    return (await as(Workspace, workspaceKey(workspaceId)).get()).settings.defaults.environmentId;
                } catch {
                    return undefined;
                }
            }

            /** `Workspace.noteWorkdir` as a one-way hop under the driver (a user principal): the recents are a convenience, never a gate. */
            async function noteWorkdir(ref: WorkdirRef): Promise<void> {
                try {
                    await actor(Workspace, workspaceKey(workspaceId)).with({ context, oneWay: true }).noteWorkdir(ref);
                } catch {
                    // A workspace that cannot be reached never fails the route.
                }
            }

            return {
                /**
                 * Drive a queued task — or one the schedule trigger parked
                 * `waiting {environment-offline}` for the router (#42) — resolve
                 * where it runs, open its session and prompt it. Idempotent: a
                 * task already routed returns as it stands.
                 */
                async run(taskId: TaskId): Promise<TaskView> {
                    const s = ctx.state;
                    const t = await task(taskId).get();
                    const existing = s.routes[taskId];
                    if (existing) {
                        if (isTerminal(t.status)) {
                            drop(taskId);
                            await ctx.save();
                            return t;
                        }
                        // Parked by a project feature plugin (#332): the placement runs again from the hooks, on the same route (EXE-12).
                        if (t.status === 'waiting' && t.wait?.kind === 'project-feature' && existing.sessionId === undefined) {
                            if (existing.environmentId) await placeRemote(existing);
                            else await placeLocal(existing, 'started after a project feature plugin let it through');
                            await ctx.save();
                            return task(taskId).get();
                        }
                        return t;
                    }
                    const parked = t.status === 'waiting' && t.wait?.kind === 'environment-offline';
                    if (t.status !== 'queued' && !parked) throw new ServerFnError(409, `task ${taskId} is ${t.status}; run() only starts a queued task`);
                    const at = now();
                    let config: Route['config'];
                    try {
                        config = await agent(t.assignee).snapshotForSession();
                    } catch (e) {
                        await task(taskId).fail({ code: 'agent-unconfigured', message: e instanceof Error ? e.message : String(e), recoverable: false }, ROUTER);
                        return task(taskId).get();
                    }
                    const runtime = config.execution.runtime;
                    const chatId: ChatId | undefined = t.origin.kind === 'user' ? t.origin.chatId : undefined;
                    // A chat task reads its chat's attachments without a grant of its own (#205): `chat_file_read` is read-only, gated by `Chat.fileAccess`.
                    if (chatId) config = withChatFileRead(config);
                    // A delegated task inherits the approval constraints of its whole chain: the parent route's, then the parent's own rules (AC-12).
                    let constraints: readonly ApprovalRule[] | undefined;
                    if (t.origin.kind === 'agent') {
                        const parent = s.routes[t.origin.taskId];
                        const parentRules = parent ? parent.config.approvalPolicy : (await agent(t.origin.agentId).get()).config.approvalPolicy;
                        constraints = [...(parent?.constraints ?? []), ...parentRules];
                    }
                    // The task's project (#332), read once here: gone from the Workspace → the task fails, visibly (EXE-12); its connectors join the gate.
                    const { project, error: projectError } = await projectOf(t);
                    // The plugin behind the runtime, asked once and before anything is written (§9, AC-13); the answer rides on the route and the spec.
                    const gated = projectError ? {} : await gate(runtime, undefined, connectorIds(config, project));
                    const host = hostOf(runtime);
                    const refused: TaskError | undefined = projectError ?? gated.error ?? (host === undefined ? { code: UNKNOWN_RUNTIME_CODE, message: `agent ${t.assignee} runs on "${runtime}", which this build does not have`, recoverable: false } : undefined);
                    const base = { taskId, agentId: t.assignee, ...(chatId ? { chatId } : {}), runtime, policy: config.execution.offlinePolicy, config, ...(constraints ? { constraints } : {}), ...(gated.plugins ? { plugins: gated.plugins } : {}), ...(t.projectId ? { projectId: t.projectId } : {}), createdAt: at, updatedAt: at };
                    if (refused) {
                        // No route was written; `fail` tells the task's chat where the answer would have been (#128).
                        await fail({ ...base, status: 'opening' }, refused);
                        return task(taskId).get();
                    }
                    /** The one resolution of where this task runs (EXE-12), recorded before placement so a placement that fails still shows the choice (OPS-03). */
                    const chosen = (why: string, environmentId?: EnvironmentId, extra: Pick<EnvironmentChosenData, 'cwd' | 'ignoredWorkdir' | 'machineId' | 'account' | 'ignoredEnvironment'> = {}): Promise<void> =>
                        audit.record(ctx, workspaceId, {
                            key: `${taskKey(workspaceId, taskId)}:environment`,
                            kind: 'environment.chosen',
                            at,
                            by: ROUTER,
                            summary: why,
                            agentId: t.assignee,
                            taskId,
                            data: { runtime, ...(environmentId ? { environmentId } : {}), policy: config.execution.offlinePolicy, fallback: false, ...extra, why }
                        });
                    if (host === 'local') {
                        s.routes[taskId] = { ...base, status: 'opening' };
                        // A platform-hosted runtime runs in no local folder: a workdir the task asked for is ignored, and the record says so (#190).
                        const ignored = t.workdir !== undefined ? `; folder ${t.workdir} ignored (${runtime} runs in no local folder)` : '';
                        await chosen(`runtime ${runtime} (the agent's runtime); no environment needed${ignored}`, undefined, t.workdir !== undefined ? { ignoredWorkdir: t.workdir } : {});
                        await placeLocal(s.routes[taskId]!, 'started', t);
                        await ctx.save();
                        return task(taskId).get();
                    }
                    // A daemon runtime. The machine (#414): the task's own, else — for a delegated task — the delegating task's route.
                    // The environment: the task's own when that machine reports it (or when no machine is named); else the agent's
                    // ACCOUNT on that machine — the agent's, or the account of its pinned environment; else, with no machine named,
                    // the agent's pinned environment, a delegating task's route (#220: a chat-started parent's environment lives on
                    // its route, not its record — only for an agent with no account of its own, which would land on the wrong login),
                    // the workspace's default (AGT-05). From here on, this one only (EXE-12).
                    const parent = t.origin.kind === 'agent' ? s.routes[t.origin.taskId] : undefined;
                    const requestedMachineId = t.machineId ?? parent?.machineId;
                    const machineFrom = t.machineId ? "the task's own" : "the delegating task's";
                    let environmentId: EnvironmentId | undefined;
                    let envFrom = '';
                    let located: LocatedEnvironment | null | undefined;
                    /** What the audit says beyond the environment: the machine, the account, what was left aside. */
                    const detail: { machineId?: MachineId; account?: AccountKey; ignoredEnvironment?: EnvironmentId; ignoredWorkdir?: string } = {};
                    let workdir = t.workdir;
                    let alsoWhy = '';
                    /** Whether the agent's `defaultWorkdir` applies: in its pinned environment on the machine the pin resolves to (a folder is one machine's). */
                    let pinFolder = true;
                    if (t.environmentId !== undefined) {
                        located = await locate(t.environmentId, requestedMachineId);
                        if (requestedMachineId !== undefined && located?.machine.machineId !== requestedMachineId) {
                            // The environment came with a folder picked on another machine (a member's sticky folder, a resumed session's):
                            // the task's machine is what the person chose now, so the account's environment there is used instead, and the
                            // record says what was left aside (EXE-12: never a silent fallback).
                            detail.ignoredEnvironment = t.environmentId;
                            if (workdir !== undefined) detail.ignoredWorkdir = workdir;
                            alsoWhy = `; environment ${t.environmentId}${workdir !== undefined ? ` and folder ${workdir}` : ''} left aside: machine ${requestedMachineId} does not report it`;
                            workdir = undefined;
                            located = undefined;
                        } else {
                            environmentId = t.environmentId;
                            envFrom = "the task's own";
                        }
                    }
                    if (environmentId === undefined && requestedMachineId !== undefined) {
                        const m = await readPairedMachine(requestedMachineId);
                        if (!m) {
                            await fail({ ...base, status: 'opening' }, { code: 'machine-unknown', message: `the task names machine ${requestedMachineId} (${machineFrom}), which this workspace has not paired or has revoked`, recoverable: false });
                            return task(taskId).get();
                        }
                        const where = `machine ${m.machineId}${m.name ? ` (${m.name})` : ''}`;
                        // The account: the agent's; else the login of its pinned environment. A pin the named machine reports itself is
                        // taken as it stands (the pin names an environment, the task names the machine); one it does not report gives its
                        // login as the pin resolves today — the first machine of the index reporting it.
                        const pinnedHere = config.execution.account === undefined && config.execution.defaultEnvironmentId !== undefined ? m.environments.find((e) => e.id === config.execution.defaultEnvironmentId) : undefined;
                        let account: { ref: AccountRef; from: string } | undefined = config.execution.account ? { ref: config.execution.account, from: "the agent's account" } : undefined;
                        if (!account && !pinnedHere && config.execution.defaultEnvironmentId !== undefined) {
                            const pinned = await locate(config.execution.defaultEnvironmentId);
                            if (pinned) account = { ref: accountRefOf(pinned.env), from: `the account of the agent's environment ${config.execution.defaultEnvironmentId}` };
                        }
                        if (pinnedHere) {
                            environmentId = pinnedHere.id;
                            envFrom = "the agent's default";
                            alsoWhy += `; on ${where} (${machineFrom}), which reports it`;
                            located = { machine: m, env: pinnedHere };
                            detail.machineId = m.machineId;
                            // The pin's folder was picked on the machine the pin resolves to today (the first of the index): elsewhere the first root.
                            if (config.execution.defaultWorkdir !== undefined) pinFolder = (await locate(pinnedHere.id))?.machine.machineId === m.machineId;
                        } else if (!account) {
                            // Nothing names a login: a delegating task's environment on this same machine (#220), else the workspace's
                            // default environment when this machine reports it (AGT-05).
                            const inherited = parent?.machineId === m.machineId ? parent.environmentId : undefined;
                            const fallback = inherited ?? (await workspaceEnvironment());
                            const env = fallback !== undefined ? m.environments.find((e) => e.id === fallback) : undefined;
                            if (!env) {
                                await fail({ ...base, status: 'opening' }, { code: 'no-account', message: `the task names ${where} (${machineFrom}), but agent ${t.assignee} names no account and no environment a machine reports, and neither a delegating task's environment nor the workspace's default is on that machine`, recoverable: false });
                                return task(taskId).get();
                            }
                            environmentId = env.id;
                            envFrom = inherited !== undefined ? "the delegating task's" : `the workspace's default on ${where} (${machineFrom})`;
                            located = { machine: m, env };
                            detail.machineId = m.machineId;
                        } else {
                            const label = account.ref.identity ?? account.ref.label ?? '';
                            const matches = environmentsForAccount(m.environments, runtime, account.ref);
                            const first = matches[0];
                            if (!first) {
                                const message = m.environments.length
                                    ? `account ${label} (${account.from}) is not signed in on ${where} (${machineFrom}) for runtime ${runtime}; sign it in there and run the task again, or run the chat on another machine`
                                    : `${where} (${machineFrom}) has not reported its environments yet, so account ${label} (${account.from}) cannot be placed on it`;
                                await fail({ ...base, status: 'opening' }, { code: 'account-not-on-machine', message, recoverable: true });
                                return task(taskId).get();
                            }
                            environmentId = first.id;
                            envFrom = `${account.from} ${label} on ${where} (${machineFrom})`;
                            if (matches.length > 1) alsoWhy += `; the account is also on ${matches.slice(1).map((e) => e.id).join(', ')} there — the first by sign-in and name is taken`;
                            located = { machine: m, env: first };
                            detail.machineId = m.machineId;
                            detail.account = accountKeyFor(runtime, account.ref);
                        }
                    }
                    if (located && detail.machineId !== undefined && located.env.runtime !== runtime) {
                        await fail({ ...base, status: 'opening' }, { code: 'runtime-mismatch', message: `environment ${located.env.id} on machine ${detail.machineId} runs ${located.env.runtime}, the agent is configured for ${runtime}`, recoverable: false });
                        return task(taskId).get();
                    }
                    if (environmentId === undefined) {
                        if (config.execution.account && config.execution.defaultEnvironmentId === undefined) {
                            await fail({ ...base, status: 'opening' }, { code: 'no-machine', message: `agent ${t.assignee} runs as account ${config.execution.account.identity ?? config.execution.account.label} on whichever machine the chat names, and neither the task nor a delegating task names one; pick a machine for the chat`, recoverable: false });
                            return task(taskId).get();
                        }
                        const inherited = config.execution.account ? undefined : parent?.environmentId;
                        const named = config.execution.defaultEnvironmentId ?? inherited;
                        environmentId = named ?? (await workspaceEnvironment());
                        if (!environmentId) {
                            const message =
                                t.origin.kind === 'agent'
                                    ? `agent ${t.assignee} runs on ${runtime} but no environment is named by the task, the agent, the delegating task or the workspace's defaults`
                                    : `agent ${t.assignee} runs on ${runtime} but neither the task, the agent nor the workspace's defaults name an environment`;
                            await task(taskId).fail({ code: 'no-environment', message, recoverable: false }, ROUTER);
                            return task(taskId).get();
                        }
                        envFrom = config.execution.defaultEnvironmentId ? "the agent's default" : named ? "the delegating task's" : "the workspace's default";
                    }
                    // The folder, once (#190, #332, EXE-12): the task's own, the project's folder for this environment, a delegating
                    // parent's in the same environment (on the same machine), the agent's default in its default environment, else the
                    // environment's first root — which needs the machine's report.
                    const projectFolder = project ? projectFolderFor(project, environmentId) : undefined;
                    const asked: { cwd: string; from: string } | undefined =
                        workdir !== undefined
                            ? { cwd: workdir, from: "the task's own" }
                            : projectFolder !== undefined
                              ? { cwd: projectFolder, from: "the project's folder" }
                              : parent?.cwd !== undefined && parent.environmentId === environmentId && (detail.machineId === undefined || parent.machineId === detail.machineId)
                                ? { cwd: parent.cwd, from: "the delegating task's" }
                                : config.execution.defaultWorkdir !== undefined && environmentId === config.execution.defaultEnvironmentId && pinFolder
                                  ? { cwd: config.execution.defaultWorkdir, from: "the agent's default" }
                                  : undefined;
                    if (located === undefined) located = await locate(environmentId, requestedMachineId);
                    const cwd = asked?.cwd ?? located?.env.cwdRoots[0];
                    const folder = cwd === undefined ? '' : `; folder ${cwd} (${asked ? asked.from : "the environment's first root"})`;
                    await chosen(`runtime ${runtime} in environment ${environmentId} (${envFrom})${folder}; offline policy ${config.execution.offlinePolicy}${alsoWhy}`, environmentId, { ...(cwd !== undefined ? { cwd } : {}), ...detail });
                    // A folder picked for this task joins the workspace's recent folders — one-way, never failing the run.
                    if (workdir !== undefined) await noteWorkdir({ environmentId, path: workdir });
                    // The machine is bound here when the task named it (#414), else inside `placeRemote` (the first one reporting the
                    // environment); an environment nobody reports yet is "offline" under the agent's policy — `queue` waits for the
                    // machine that will (AST-05), and a route bound to a machine waits for THAT machine.
                    s.routes[taskId] = {
                        ...base,
                        environmentId,
                        ...(detail.machineId !== undefined ? { machineId: detail.machineId } : {}),
                        ...(requestedMachineId !== undefined ? { requestedMachineId } : {}),
                        ...(detail.account !== undefined ? { account: detail.account } : {}),
                        ...(cwd !== undefined ? { cwd } : {}),
                        ...(projectFolder !== undefined ? { projectFolder } : {}),
                        status: 'opening'
                    };
                    await placeRemote(s.routes[taskId]!, detail.machineId !== undefined ? located?.machine : undefined, t, located);
                    await ctx.save();
                    return task(taskId).get();
                },

                /**
                 * "Resume" on an interrupted turn (OPS-05): the session is prompted anew
                 * with the cut turn's input over its intact transcript (`Session.resume`),
                 * the task's `waiting {input, resume:…}` resolves `active` with a `resumed`
                 * transition, and `follow` picks the new turn up. Nothing is replayed. A session its machine no longer
                 * hosts (#420: the daemon restarted under the turn) is re-opened there first (`rehost`), and resumed once
                 * the daemon acknowledges it; a second `resume` meanwhile changes nothing.
                 */
                async resume(taskId: TaskId): Promise<TaskView> {
                    const s = ctx.state;
                    const route = s.routes[taskId];
                    if (!route || route.status !== 'interrupted' || !route.sessionId || !route.turnId) throw new ServerFnError(409, `task ${taskId} has no interrupted turn to resume`);
                    if (route.rehosting) return task(taskId).get();
                    await resumeRoute(route, principalLabel(ctx.principal));
                    await ctx.save();
                    return task(taskId).get();
                },

                /**
                 * Machine → router: the daemon said hello. Every route parked on it is retried — on that machine, no other; a
                 * route no machine reported yet looks again. A running route that waited `machine-offline` (#366) goes on:
                 * its task is active again and the daemon replays its turn from the `wanted` cursor — a session the daemon
                 * lost is answered `session.closed` and interrupted (#420). An interrupted route whose agent's `onInterrupt`
                 * is `auto` is resumed once (`autoResumeRoute`).
                 */
                async machineOnline(machineId: MachineId): Promise<void> {
                    const s = ctx.state;
                    for (const route of Object.values(s.routes)) {
                        if (route.status !== 'waiting-offline' || (route.machineId !== undefined && route.machineId !== machineId)) continue;
                        await placeRemote(route);
                    }
                    for (const route of Object.values(s.routes)) {
                        if (route.machineId !== machineId || route.offlineSince === undefined) continue;
                        delete route.offlineSince;
                        touch(route);
                        const t = await task(route.taskId).get();
                        if (t.status === 'waiting' && t.wait?.kind === 'machine-offline') await task(route.taskId).resolveWaiting(ROUTER, `machine ${machineId} is back; the turn goes on`, route.sessionId);
                    }
                    for (const route of Object.values(s.routes)) if (route.machineId === machineId) await autoResumeRoute(route);
                    for (const route of Object.values(s.routes)) if (route.machineId === machineId && route.reopen) await reopenParked(route);
                    await armLost();
                    await ctx.save();
                },

                /**
                 * Machine → router (#366; OPS-04, EXE-11): the machine went offline — its socket closed, or its heartbeat
                 * window passed. Every route running a turn there waits for it: the route stays `running` with
                 * `offlineSince`, and its task — when active; a task waiting on an approval or a question keeps that wait —
                 * waits `machine-offline`. Distinct from `environment-offline`, which is a placement that never started.
                 * The machine-lost reminder is armed.
                 */
                async machineOffline(machineId: MachineId): Promise<void> {
                    const at = now();
                    for (const route of Object.values(ctx.state.routes)) {
                        if (route.machineId !== machineId || route.status !== 'running' || route.offlineSince !== undefined) continue;
                        route.offlineSince = at;
                        touch(route);
                        const t = await task(route.taskId).get();
                        if (t.status === 'active') await task(route.taskId).reportWaiting({ kind: 'machine-offline', machineId, since: at }, ROUTER, route.sessionId);
                    }
                    await armLost();
                    await ctx.save();
                },

                /**
                 * The machine-lost reminder (#366; OPS-04): a route offline for `MACHINE_LOST_MS` fails `machine-lost`
                 * (recoverable), audited `task.machine-lost`, and the chat is told. The machine lets go of its session
                 * (`Machine.closeSession`): the record's turn is interrupted and it waits `idle` with its ref, so a chat
                 * member's next message re-opens it wherever the machine comes back; a chatless session is closed.
                 */
                async expireOffline(): Promise<void> {
                    const at = now();
                    const letGo = new Set<SessionId>();
                    for (const route of Object.values(ctx.state.routes)) {
                        const since = route.offlineSince;
                        if (since === undefined || !route.machineId || at - since < MACHINE_LOST_MS) continue;
                        const { machineId, sessionId } = route;
                        await audit.record(ctx, workspaceId, {
                            key: `${taskKey(workspaceId, route.taskId)}:machine-lost`,
                            kind: 'task.machine-lost',
                            at,
                            by: ROUTER,
                            summary: `machine ${machineId} offline since ${new Date(since).toISOString()}; the task's turn is lost`,
                            agentId: route.agentId,
                            taskId: route.taskId,
                            ...(sessionId ? { sessionId } : {}),
                            data: { taskId: route.taskId, machineId, since }
                        });
                        // The session first, while the task still stands: a task settled from outside has its follower cancel the
                        // turn — a Session command to the Machine — and the Machine, letting go, is waiting on that Session.
                        const first = sessionId !== undefined && !letGo.has(sessionId);
                        if (first) {
                            letGo.add(sessionId);
                            await machine(machineId)
                                .closeSession(sessionId)
                                .catch(() => undefined);
                        }
                        await fail(route, { code: MACHINE_LOST_CODE, message: `machine ${machineId} has been offline since ${new Date(since).toISOString()}; the turn is lost`, recoverable: true });
                        if (first && !route.chatId) await session(sessionId).close().catch(() => undefined);
                    }
                    await armLost();
                    await ctx.save();
                },

                /** Follower → router (#366): a route was just parked `interrupted` — resumed at once when its agent's `onInterrupt` is `auto` and its machine is online. */
                async autoResume(taskId: TaskId): Promise<void> {
                    const route = ctx.state.routes[taskId];
                    if (!route) return;
                    await autoResumeRoute(route);
                    await ctx.save();
                },

                /**
                 * Machine → router: the daemon acknowledged a session — a queued one included. Time to prompt every route
                 * waiting on it: a chat's session serves many tasks (#393), and the task the machine names is the one it was
                 * opened for, which need not be any of them. An interrupted route that re-opened it (#420, `rehosting`)
                 * resumes its turn now.
                 */
                async sessionOpened(sessionId: SessionId, _taskId?: TaskId): Promise<void> {
                    const s = ctx.state;
                    for (const route of Object.values(s.routes)) {
                        if (route.sessionId === sessionId && route.status === 'interrupted' && route.rehosting) {
                            delete route.rehosting;
                            await resumeHosted(route);
                            continue;
                        }
                        if (route.sessionId !== sessionId || (route.status !== 'opening' && route.status !== 'waiting-capacity')) continue;
                        if (route.status === 'waiting-capacity') {
                            // The slot the dequeue saw may be gone to a prompt meanwhile (#394): then the route stays parked for `slotFreed`.
                            const { free, m } = await slot(route);
                            if (!free) {
                                await parkOnCapacity(route, m!);
                                continue;
                            }
                            await activate(route, `a slot freed in environment ${route.environmentId}; session opened`, sessionId);
                        }
                        await prompt(route);
                    }
                    await ctx.save();
                },

                /**
                 * Machine → router: a turn ended in an environment, or a session running one closed (#394). The routes parked
                 * `waiting-capacity` there whose session is open are prompted in turn, one per free slot — the machine is read
                 * again before each, since a prompt out takes a slot at once. A parked route whose session is still queued waits
                 * for its own `sessionOpened`.
                 */
                async slotFreed(machineId: MachineId, environmentId: EnvironmentId, why: string): Promise<void> {
                    const s = ctx.state;
                    const parked = Object.values(s.routes).filter((r) => r.status === 'waiting-capacity' && r.machineId === machineId && r.environmentId === environmentId && r.sessionId !== undefined);
                    if (!parked.length) return;
                    // One read; refreshed only after a prompt went out, since that is what takes a slot.
                    let m = await machine(machineId).get();
                    for (const route of parked) {
                        if (!m.activeSessions.some((h) => h.sessionId === route.sessionId && h.status === 'open')) continue;
                        if (freeSlots(m, environmentId) <= 0) break;
                        await activate(route, `${why}; a slot freed in environment ${environmentId}`, route.sessionId!);
                        await prompt(route);
                        m = await machine(machineId).get();
                    }
                    await ctx.save();
                },

                /**
                 * Machine → router: the daemon answered a route's prompt with an error (#394). `busy` is the environment's own
                 * admission (a turn beyond its concurrency): the route parks `waiting-capacity` and its next prompt goes out under
                 * a fresh command id, the turn id unchanged. Any other code fails the task `prompt-{code}` — a route left `running`
                 * would wait for a turn that never starts.
                 */
                async promptRefused(sessionId: SessionId, turnId: string, code: string, message: string): Promise<void> {
                    const route = Object.values(ctx.state.routes).find((r) => r.sessionId === sessionId && r.turnId === turnId && r.status === 'running');
                    if (!route) return;
                    if (code === 'busy' && route.machineId) {
                        route.attempt = (route.attempt ?? 0) + 1;
                        await parkOnCapacity(route, await machine(route.machineId).get());
                    } else {
                        // No turn will start: the follower tailing for this turn is told so before the task settles, and ends with it.
                        abandoned.add(`${ctx.key}:${route.taskId}`);
                        await fail(route, { code: `prompt-${code}`, message, recoverable: code === 'busy' });
                    }
                    await ctx.save();
                },

                /**
                 * Machine → router: a session is gone. Every task still waiting for it — to open, or for the turn it ran to
                 * end (#395) — fails with the daemon's reason. A running one is not failed here: the Machine told the
                 * Session first (`hostEnded`, #420), which ended its turn as interrupted, and `follow` parks it for a
                 * `resume`. A re-open that `resume` asked for and the daemon refused (`rehosting`) sends the task to a
                 * fresh session (`freshSession`) — unless the machine hosts the session again, and this is the word
                 * about the session it lost, arriving late. A message parked on the live session (`waiting-capacity`,
                 * `waiting-turn`) that its host closed for a restart or an update (#433: `code` `restart` / `update` /
                 * `harness-update`, or none, with the record left `idle` with its ref) is kept, not failed: the session is
                 * re-opened with its ref (`reopenParked`) — at once, or after the next `hello` for an update — and the
                 * message delivered in it under the same task. `resume-failed`, `harness-missing` and a closed record fail it.
                 */
                async sessionClosed(sessionId: SessionId, reason: string, _taskId?: TaskId, code?: SessionClosedCode): Promise<void> {
                    const s = ctx.state;
                    /** The record, read once: whether the host left it `idle` with its ref (`hostEnded`), to be re-opened. */
                    let record: Promise<SessionInfo | undefined> | undefined;
                    const resumable = async (): Promise<boolean> => {
                        if (code !== undefined && !HOST_CLOSE_CODES.has(code)) return false;
                        const info = await (record ??= session(sessionId).get().catch(() => undefined));
                        return !!info && info.status !== 'closed' && !!info.ref && !!info.spec;
                    };
                    for (const route of Object.values(s.routes)) {
                        if (route.sessionId === sessionId && route.status === 'interrupted' && route.rehosting) {
                            const hosted = route.machineId !== undefined && (await machine(route.machineId).get()).activeSessions.some((h) => h.sessionId === sessionId);
                            if (!hosted) await freshSession(route);
                            continue;
                        }
                        if (route.sessionId !== sessionId || (route.status !== 'opening' && route.status !== 'waiting-capacity' && route.status !== 'waiting-turn' && route.status !== 'waiting-answer')) continue;
                        // A message parked on the live session — for a slot, or for its running turn — outlives a daemon restart or
                        // update (#433): the record keeps its ref, and the session is re-opened with it rather than the task failed.
                        if ((route.status === 'waiting-capacity' || route.status === 'waiting-turn') && route.machineId && (await resumable())) {
                            // The turn it waited for is gone with the session: the task now waits for a slot on the re-opened one.
                            if (route.status === 'waiting-turn') await parkOnCapacity(route, await machine(route.machineId).get());
                            route.status = 'waiting-capacity';
                            route.reopen = true;
                            touch(route);
                            // A restart's close comes after the daemon's `hello`: re-open now. An update's comes before the daemon
                            // stops, so the one that answers is the next — after its `hello`.
                            if (code !== 'update' && (await machine(route.machineId).get()).online) await reopenParked(route);
                            continue;
                        }
                        // A task waiting for the answer to its question (#396) fails here too: the answer, when it comes, starts the asker again in a fresh session.
                        const when = route.status === 'waiting-turn' ? 'while this task waited for its running turn to end' : route.status === 'waiting-answer' ? 'while this task waited for the answer to its question' : 'before it opened';
                        await fail(route, { code: 'session-refused', message: `machine ${route.machineId} closed the session ${when}: ${reason}`, recoverable: true });
                    }
                    await ctx.save();
                },

                /**
                 * Follower → router: a turn ended on a session (#395). Every route parked `waiting-turn` on it is prompted
                 * — into its own turn now that the session is idle, or parked again should another turn be running.
                 */
                async turnEnded(sessionId: SessionId, turnId: string): Promise<void> {
                    for (const route of Object.values(ctx.state.routes)) {
                        if (route.sessionId !== sessionId || route.status !== 'waiting-turn') continue;
                        await activate(route, `turn ${turnId} ended`, sessionId);
                        await prompt(route);
                    }
                    await ctx.save();
                },

                /**
                 * Session → router (through `SessionPorts.answered`, #396; CHT-09, COL-06): a late answer to the `ask_user`
                 * question `requestId` raised on `sessionId`. The asking task's route waits `waiting-answer` on that
                 * question, with the task `waiting {input}`: the task goes `active` (`request …: input`) and `input` — the
                 * answer as a user message — is prompted under it through the same seam a chat message takes
                 * (`steerOrPrompt`), into the turn `answerTurnId(taskId, requestId)`; `follow` settles the task at its end.
                 * No new task, and the engine conversation the question lives in carries on. A session running another
                 * turn takes the answer into it, or the route holds it (`Route.answer`) and sends it when that turn ends
                 * (`turnEnded`); a refusal fails the task with the reply (`refused`). Every other route waiting on the same
                 * question (two tasks that shared the asking turn, #395) joins the answer's turn as it goes out
                 * (`joinAnswerTurn`). With no route waiting on the question — the task settled, the session was ended —
                 * nothing is sent (`no-route`). Either way the answer did not reach the asker, and the caller starts it
                 * again with a follow-up task, as before (`createAnswerFollowUp`).
                 */
                async deliverAnswer(sessionId: SessionId, requestId: string, input: readonly PromptPart[]): Promise<AnswerDelivery> {
                    const s = ctx.state;
                    // A hand-over retried after the router already took it: held for the running turn, or prompted.
                    if (Object.values(s.routes).some((r) => r.sessionId === sessionId && r.answer?.requestId === requestId)) return { delivered: true };
                    const waiting = Object.values(s.routes).filter((r) => r.sessionId === sessionId && r.status === 'waiting-answer' && r.question === requestId);
                    let first: Route | undefined;
                    for (const route of waiting) {
                        const t = await task(route.taskId).get();
                        if (isTerminal(t.status)) {
                            drop(route.taskId);
                            continue;
                        }
                        first = route;
                        break;
                    }
                    if (!first) {
                        await ctx.save();
                        return { delivered: false, reason: 'no-route' };
                    }
                    const turnId = answerTurnId(first.taskId, requestId);
                    // `follow` tails from here: the log before the answer's turn is the asking turn's, already settled.
                    const head = (await session(sessionId).get()).head;
                    first.head = head;
                    delete first.question;
                    first.answer = { requestId, turnId, input: structuredClone(input) };
                    await activate(first, `request ${requestId}: input`, sessionId);
                    // The one prompt every route takes: the environment's capacity (#394), then the seam (#395). The route
                    // comes out `running` on the answer's turn, parked with the answer still on it (`waiting-turn`,
                    // `waiting-capacity` — prompted again when the turn ends or a slot frees), or gone, the task failed.
                    await prompt(first);
                    const after = s.routes[first.taskId];
                    if (!after) {
                        const failed = (await task(first.taskId).get()).error;
                        await ctx.save();
                        return { delivered: false, reason: 'refused', code: failed?.code ?? 'prompt-refused', message: failed?.message ?? `session ${sessionId} refused the prompt` };
                    }
                    if (after.status !== 'running') {
                        await ctx.save();
                        return { delivered: true, taskId: first.taskId, parked: true };
                    }
                    // Every other route waiting on the question joined the turn as the answer went out (`prompt` → `joinAnswerTurn`).
                    await ctx.save();
                    return { delivered: true, taskId: first.taskId, turnId: after.turnId ?? turnId };
                },

                /**
                 * Session → router (#396): the question `requestId` was dismissed, not answered. Every task waiting on it
                 * (`waiting-answer`) is released as it stands — completed with what its asking turn said, as a turn that
                 * ends with no question open would be — and nobody is prompted.
                 */
                async questionCancelled(sessionId: SessionId, requestId: string): Promise<void> {
                    for (const route of Object.values(ctx.state.routes)) {
                        if (route.sessionId !== sessionId || route.status !== 'waiting-answer' || route.question !== requestId) continue;
                        const t = await task(route.taskId).get();
                        if (!isTerminal(t.status)) {
                            if (t.status === 'waiting') await task(route.taskId).resolveWaiting(ROUTER, `request ${requestId}: cancel`, sessionId);
                            const text = route.turnId ? finalText(await session(sessionId).transcript(), route.turnId) : '';
                            await task(route.taskId).complete({ ...(text ? { text } : {}), artifacts: [], verified: false }, ROUTER);
                        }
                        drop(route.taskId);
                    }
                    await ctx.save();
                },

                /**
                 * `task_report` from the agent working the task — or a task sharing its turn (#395: a report filed during a
                 * turn two tasks share is the turn's, so both take it as their result): kept for the result at the turn's end.
                 */
                async report(taskId: TaskId, report: TaskReport): Promise<void> {
                    const p = ctx.principal as Principal | null;
                    const named = ctx.state.routes[taskId];
                    const sharesTurn = (r: Route): boolean => !!named && r.taskId !== taskId && r.sessionId === named.sessionId && r.turnId !== undefined && r.turnId === named.turnId && r.status === 'running';
                    const own = p?.kind === 'agent' && p.taskId !== undefined ? ctx.state.routes[p.taskId] : undefined;
                    if (p?.kind !== 'agent' || (p.taskId !== taskId && !(own && sharesTurn(own)))) throw new ServerFnError(403, `routing: only the agent working task ${taskId} reports on it`);
                    const filed: TaskReport = { status: report.status, summary: report.summary, ...(report.output !== undefined ? { output: report.output } : {}) };
                    ctx.state.reports[taskId] = filed;
                    for (const r of Object.values(ctx.state.routes)) if (sharesTurn(r)) ctx.state.reports[r.taskId] = filed;
                    await ctx.save();
                },

                /**
                 * "New session" (#399; CHT-04, OPS-10): end the session the chat binds to `agentId` — or `sessionId`,
                 * when the caller already holds it (a removal drops the binding with the member, so the chat passes
                 * the row it had) — and forget it. In order: every route on the session fails `session-reset`
                 * (recoverable; a running turn is cancelled the way any task settled from outside is, COL-12); the
                 * Session is closed — its runtime session disposed, or the daemon told `close` when a machine hosts
                 * it — and the chat's binding dropped by `session-ended`, published here when the close did not do it
                 * (a daemon's ack is still out, or the record could not be reached); then the record and every one
                 * of its pages are purged through the `store` port, so nothing of the conversation is left behind.
                 * The next message opens a fresh session that knows none of it; the chat's own history is untouched.
                 * Returns the id ended, or `null` when the member had no session. A user or an external client only.
                 * A `sessionId` is never taken on trust: with the binding still there it must be that session (409
                 * otherwise), and without one the record itself must name this chat and member — so no caller can
                 * end another chat's or another member's session through here.
                 */
                async endSession(chatId: ChatId, agentId: AgentId, reason: string, sessionId?: SessionId): Promise<SessionId | null> {
                    const row = await chat(chatId)
                        .get()
                        .then((summary) => summary.sessions[agentId]?.sessionId, () => undefined);
                    if (sessionId !== undefined && row !== undefined && row !== sessionId) {
                        throw new ServerFnError(409, `routing: session ${sessionId} is not the session chat ${chatId} binds to ${agentId} (${row})`);
                    }
                    const bound = row ?? sessionId;
                    if (!bound) return null;
                    const client = session(bound);
                    // The record first: what vouches for a session the binding no longer names, and the page count — a closed record keeps its pages, a purged one says nothing.
                    const info = await client.get().catch(() => undefined);
                    if (row === undefined) {
                        if (!info?.opened) return null;
                        if (info.spec?.chatId !== chatId || info.spec.agentId !== agentId) throw new ServerFnError(409, `routing: session ${bound} is not ${agentId}'s session in chat ${chatId}`);
                    }
                    const why = `session ${bound} of ${agentId} in chat ${chatId} was ended: ${reason}`;
                    for (const route of Object.values(ctx.state.routes)) {
                        if (route.sessionId !== bound) continue;
                        await fail(route, { code: SESSION_RESET_CODE, message: why, recoverable: true });
                    }
                    await ctx.save();
                    const acknowledged = await client.close().then((reply) => reply.kind === 'ack', () => false);
                    if (!acknowledged) await tellChatEnded(ctx, workspaceId, chatId, agentId, bound, now);
                    if (ports.store) {
                        const key = `${workspaceId}:session:${bound}`;
                        const pages = info?.pages ?? 0;
                        // The pages in bounded batches (a long session has many), every one of them before the record. A page the
                        // record already forgot (#397, a daemon session keeps only the newest) purges as a no-op; the transcript's
                        // pages (#397, an API session's history) go the same way.
                        for (let from = 0; from < pages; from += PURGE_BATCH) {
                            await Promise.all(Array.from({ length: Math.min(PURGE_BATCH, pages - from) }, (_, i) => ports.store!.purge({ type: SESSION_PAGE_TYPE, key: sessionPageKey(key, from + i) })));
                        }
                        const transcriptPages = info?.transcriptPages ?? 0;
                        for (let from = 0; from < transcriptPages; from += PURGE_BATCH) {
                            await Promise.all(Array.from({ length: Math.min(PURGE_BATCH, transcriptPages - from) }, (_, i) => ports.store!.purge({ type: SESSION_TRANSCRIPT_PAGE_TYPE, key: transcriptPageKey(key, from + i) })));
                        }
                        await ports.store.purge({ type: ports.sessions().type, key });
                    }
                    return bound;
                },

                get(): RoutingView {
                    const snap = ctx.snapshot();
                    return { key: ctx.key, routes: Object.values(snap.routes), reports: snap.reports };
                }
            };
        },
        tasks: (ctx) => {
            const ids = parseRoutingKey(ctx.key);
            const signal = ctx.abortSignal;

            /**
             * Wait out the turn a session runs that no route follows (#510: Claude Code starts one itself after a
             * background task) and tell the router it ended (`turnEnded`), so the routes parked `waiting-turn` on the
             * session are prompted. A session already idle is reported at once; one that goes away ends the wait the same
             * way, and the prompt then fails with the session.
             */
            async function watchTurn(sessionId: SessionId): Promise<void> {
                if (!ids) return;
                const context = asPrincipal(driverOf(ids.workspaceId));
                const sessionClient = actor(ports.sessions(), `${ids.workspaceId}:session:${sessionId}`).with({ context }) as unknown as SessionClient;
                const router = () => actor(self!, ctx.key).with({ context }) as unknown as { turnEnded(sessionId: SessionId, turnId: string): Promise<void> };
                const info = await sessionClient.get();
                const turnId = info.running?.turnId;
                if (turnId !== undefined) {
                    const it = sessionClient.tail(info.head)[Symbol.asyncIterator]();
                    const aborted = new Promise<IteratorResult<AgentEvent>>((resolve) => {
                        const done = () => resolve({ value: undefined as never, done: true });
                        if (signal.aborted) done();
                        else signal.addEventListener('abort', done, { once: true });
                    });
                    try {
                        for (;;) {
                            const next = await Promise.race([it.next(), aborted]);
                            if (signal.aborted) return;
                            if (next.done || (next.value.type === 'turn-end' && next.value.turnId === turnId)) break;
                        }
                    } finally {
                        await Promise.resolve(it.return?.()).catch(() => undefined);
                    }
                }
                await router().turnEnded(sessionId, turnId ?? '').catch(() => undefined);
            }

            /**
             * Follow one route's turn on its Session and settle the Task at the
             * end. A task already settled is left alone; a replay from the log
             * after an eviction finds the turn end again.
             */
            async function followOne(route: Route): Promise<void> {
                if (!ids || !route.sessionId || !route.turnId) return;
                const context = asPrincipal(driverOf(ids.workspaceId));
                const taskClient = actor(TaskActor, taskKey(ids.workspaceId, route.taskId)).with({ context });
                const sessionClient = actor(ports.sessions(), `${ids.workspaceId}:session:${route.sessionId}`).with({ context }) as unknown as SessionClient;
                const { turnId, sessionId } = route;
                /** The router itself, for what a turn's end means to OTHER routes: a method turn, never `ctx.turn` (#395). */
                const router = () => actor(self!, ctx.key).with({ context }) as unknown as { turnEnded(sessionId: SessionId, turnId: string): Promise<void>; autoResume(taskId: TaskId): Promise<void> };

                /**
                 * Settle the task and forget the route. A chatless session is closed here — it holds an environment slot
                 * (EXE-09), and its record keeps its `ref`. A chat member's session is not (#393): it lives on for the
                 * chat's next message, whatever this turn's outcome.
                 */
                const settled = async (fn: (c: ActorContext<RoutingState>) => Promise<void>): Promise<void> => {
                    await ctx.turn(async (c) => {
                        await fn(c);
                        delete c.state.routes[route.taskId];
                        delete c.state.reports[route.taskId];
                        await c.save();
                    });
                    if (!route.chatId) await sessionClient.close().catch(() => undefined);
                };
                const tryTask = async (fn: () => Promise<unknown>): Promise<void> => {
                    try {
                        await fn();
                    } catch {
                        // A transition the task no longer allows (settled meanwhile, cancelled): the record stands as it is.
                    }
                };
                /** A platform question the turn left open and nobody's call waits on (#285): its answer is still to come. */
                const stillOpen = async (requestId: string): Promise<boolean> => {
                    const q = await sessionClient.request(requestId).catch(() => null);
                    return !!q && !q.resolved && q.detached === true;
                };

                // From the head the placement saw (#393): a chat session's log outlives this turn, and what came before it is not replayed. The follower ends itself at the turn's end below — a live session never closes the tail.
                const it = sessionClient.tail(route.head ?? { epoch: 0, seq: 0 })[Symbol.asyncIterator]();
                const aborted = new Promise<IteratorResult<AgentEvent>>((resolve) => {
                    const done = () => resolve({ value: undefined as never, done: true });
                    if (signal.aborted) done();
                    else signal.addEventListener('abort', done, { once: true });
                });
                // The Task settling while the turn runs — cancelled by a user or a parent's cascade, failed on budget — is the
                // cue to cancel the session (COL-12); the turn then ends `cancelled` and the task hears `sessionStopped`.
                const never = new Promise<IteratorResult<AgentEvent>>(() => undefined);
                const outcomes = taskClient.result({ eager: true })[Symbol.asyncIterator]();
                let settledEarly: Promise<IteratorResult<AgentEvent> & { settled?: TaskOutcome }> = outcomes.next().then((r) => (r.done ? never : { value: undefined as never, done: false, settled: r.value }));
                // One `next()` in flight at a time: a race the tail loses must not discard the event it will resolve with.
                let pending: Promise<IteratorResult<AgentEvent>> | undefined;
                let end: Extract<AgentEvent, { type: 'turn-end' }> | undefined;
                // Seen settling from outside: no more Task reads. A `cancel` parks its turn until `sessionStopped`, and a
                // FIFO `get()` queued behind it would hold the turn end (and that word) until the stop deadline (#168).
                let settledOutside = false;
                try {
                    for (;;) {
                        pending ??= it.next();
                        const next = await Promise.race([pending, aborted, settledEarly]);
                        if (signal.aborted) return;
                        if (next.done) break;
                        const early = (next as { settled?: TaskOutcome }).settled;
                        if (early) {
                            settledEarly = never;
                            settledOutside = true;
                            // Failed because its prompt was refused (#394): no turn runs, nothing to cancel, nothing to wait for.
                            if (abandoned.delete(`${ctx.key}:${route.taskId}`)) return;
                            // A turn this route joined (#395) is another task's: it runs on, and this task hears `sessionStopped` at its end.
                            if (early.status !== 'completed' && !route.joined) await sessionClient.cancel().catch(() => undefined);
                            continue;
                        }
                        pending = undefined;
                        const ev = next.value;
                        if (ev.turnId !== turnId) continue;
                        if (ev.type === 'request') {
                            // The Session already told the Inbox and the chat; the Task record says what it waits for.
                            const kind = ev.kind === 'permission' ? 'approval' : 'input';
                            await tryTask(() => taskClient.reportWaiting({ kind, requestId: ev.requestId, sessionId }, ROUTER));
                        } else if (ev.type === 'request-resolved' && !settledOutside) {
                            // Only the wait this request parked: a policy decision resolves with no request, and a task waiting on a child stays waiting.
                            const wait = (await taskClient.get()).wait;
                            if (wait && (wait.kind === 'approval' || wait.kind === 'input') && wait.requestId === ev.requestId) {
                                await tryTask(() => taskClient.resolveWaiting(ROUTER, `request ${ev.requestId}: ${ev.outcome}`));
                            }
                        } else if (ev.type === 'turn-end') {
                            end = ev;
                            break;
                        }
                    }
                } finally {
                    await Promise.resolve(it.return?.()).catch(() => undefined);
                    await outcomes.return?.().catch(() => undefined);
                }
                // The session is idle now, whatever the outcome — or gone, when the tail closed without this turn's end: a
                // message parked on this turn (#395, `waiting-turn`) goes out, or fails with the session, never waits on.
                if (Object.values(ctx.snapshot().routes).some((r) => r.sessionId === sessionId && r.status === 'waiting-turn')) await router().turnEnded(sessionId, turnId).catch(() => undefined);
                if (!end) return;
                // Settled from outside while the turn ran: the turn is over now, and the task gets the driver's word.
                const stopped = async (): Promise<void> => settled(() => tryTask(() => taskClient.sessionStopped()));
                if (settledOutside) return stopped();
                let t = await taskClient.get();
                if (isTerminal(t.status)) return stopped();
                // Still waiting on its machine (#366): the machine is back — it sent this turn's end — whichever word the router heard first.
                const offlineWait = t.status === 'waiting' && t.wait?.kind === 'machine-offline' ? t.wait : undefined;
                if (offlineWait) {
                    await tryTask(() => taskClient.resolveWaiting(ROUTER, `machine ${offlineWait.machineId} is back; turn ${turnId} ended`, sessionId));
                    t = await taskClient.get();
                }
                if (end.stopReason === 'error') {
                    if (isInterruptedTurnEnd(end)) {
                        // Cut short — by an eviction, or its host going away (#420): nothing was re-run (OPS-05/06); the user decides
                        // whether to resume, unless the agent's `onInterrupt` is `auto` (#366). The route parks as `interrupted` —
                        // not followed again until `resume` re-prompts it.
                        await ctx.turn(async (c) => {
                            await tryTask(() => taskClient.reportWaiting({ kind: 'input', requestId: `resume:${turnId}`, sessionId }, ROUTER));
                            const parked = c.state.routes[route.taskId];
                            if (parked && parked.turnId === turnId) {
                                parked.status = 'interrupted';
                                delete parked.offlineSince;
                            }
                            await c.save();
                        });
                        if (route.machineId && route.config.execution.onInterrupt === 'auto') await router().autoResume(route.taskId).catch(() => undefined);
                        return;
                    }
                    const error: TaskError = { code: end.error?.code ?? 'turn-error', message: end.error?.message ?? 'the turn ended with an error', recoverable: false };
                    await settled(async (c) => {
                        await tryTask(() => taskClient.fail(error, ROUTER));
                        await tellChat(c, ids.workspaceId, route, error, now, newSessionId);
                    });
                    return;
                }
                if (end.stopReason === 'cancelled') {
                    const error: TaskError = { code: 'turn-cancelled', message: 'the session cancelled the turn', recoverable: true };
                    await settled(async (c) => {
                        await tryTask(() => taskClient.fail(error, ROUTER));
                        await tellChat(c, ids.workspaceId, route, error, now, newSessionId);
                    });
                    return;
                }
                const wait = t.status === 'waiting' ? t.wait : undefined;
                if (wait && (wait.kind === 'input' || wait.kind === 'approval') && wait.sessionId === sessionId) {
                    // The turn ended with its question still open (#285: `ask_user` answered `pending`). In a chat the task keeps
                    // waiting for it (#396): the route parks `waiting-answer` — followed by nobody — and `deliverAnswer` prompts this
                    // same session, under this same task, when the answer comes. Anywhere else nothing waits on it in this task any
                    // more — the answer starts a new one — so the task leaves `waiting` and completes.
                    if (route.chatId && wait.kind === 'input' && (await stillOpen(wait.requestId))) {
                        await ctx.turn(async (c) => {
                            const parked = c.state.routes[route.taskId];
                            if (parked && parked.turnId === turnId && parked.status === 'running') {
                                parked.status = 'waiting-answer';
                                parked.question = wait.requestId;
                                delete parked.joined;
                            }
                            await c.save();
                        });
                        return;
                    }
                    await tryTask(() => taskClient.resolveWaiting(ROUTER, `turn ${turnId} ended; request ${wait.requestId} stays open`));
                }
                const transcript = await sessionClient.transcript();
                const text = finalText(transcript, turnId);
                const report = ctx.snapshot().reports[route.taskId]; // filed during the turn, after this task started
                const output = end.output ?? report?.output;
                await settled(() =>
                    tryTask(() =>
                        taskClient.complete(
                            { ...(text ? { text } : report?.summary ? { text: report.summary } : {}), ...(output !== undefined ? { output } : {}), artifacts: [], verified: false },
                            ROUTER
                        )
                    )
                );
            }

            return {
                /**
                 * The one follower of this router: `ctx.tasks` is single-flight per
                 * name, and a workspace runs many routes at once (a parent and the
                 * child it delegated to, at the least), so `follow` supervises — it
                 * runs `followOne` for every `running` route, picks up a route the
                 * next `prompt` marks running (`wake`), and lives as long as the
                 * activation does. Restarted by the runtime's task ledger after an
                 * eviction, it finds every running route again; a route whose
                 * follower ended is dropped or settled and never followed twice.
                 */
                async follow(): Promise<void> {
                    const active = new Map<TaskId, Promise<void>>();
                    const watching = new Map<SessionId, Promise<void>>();
                    const aborted = new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                    while (!signal.aborted) {
                        // Arm the wake-up before looking, so a route marked running meanwhile is never missed.
                        const woken = new Promise<void>((resolve) => wakers.set(ctx.key, resolve));
                        const routes = Object.values(ctx.snapshot().routes);
                        for (const route of routes) {
                            if (route.status !== 'running' || active.has(route.taskId)) continue;
                            const run = followOne(route)
                                .catch(() => undefined)
                                .finally(() => active.delete(route.taskId));
                            active.set(route.taskId, run);
                        }
                        // A route parked `waiting-turn` behind a turn no route follows — one the runtime started itself
                        // (#510) — has nobody to say the turn ended: watch that session's turn instead.
                        for (const route of routes) {
                            const sessionId = route.sessionId;
                            if (route.status !== 'waiting-turn' || !sessionId || watching.has(sessionId)) continue;
                            if (routes.some((r) => r.status === 'running' && r.sessionId === sessionId)) continue;
                            const run = watchTurn(sessionId)
                                .catch(() => undefined)
                                .finally(() => watching.delete(sessionId));
                            watching.set(sessionId, run);
                        }
                        await Promise.race([woken, aborted, ...active.values(), ...watching.values()]);
                        wakers.delete(ctx.key);
                    }
                }
            };
        }
    });
    self = definition;
    return definition;
}

export type RoutingActor = ReturnType<typeof defineRoutingActor>;
