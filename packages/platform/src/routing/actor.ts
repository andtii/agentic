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
 *   then; an offline machine → Task `waiting {environment-offline, policy}`
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
 *
 * Every mutation ends in `ctx.save()` inside the turn. Calls into Task,
 * Session, Machine and Agent are fresh `actor()` calls under the driver
 * principal, never `ctx.actor` hops: a notification turn belongs to a
 * machine, and the machine may not drive sessions.
 */

import { actorKey, createId, hasScope, isChatFilePart, isTerminal, pathWithin, SESSION_EVENTS_TOPIC, type AgentId, type ApprovalRule, type ChatFilePart, type ChatId, type ChatRoster, type EnvironmentDescriptor, type EnvironmentId, type FrozenAgentConfig, type HostOs, type MachineId, type OpenSpec, type OpenSpecPolicy, type Principal, type PromptPart, type RuntimeId, type SessionEvent, type SessionId, type TaskError, type TaskId, type WaitReason, type WorkdirRef, type WorkspaceId } from '@agentic/core';
import { buildSystemPrompt, type TaskReport } from '@agentic/runtimes';
import { actor, defineActor, topic, type ActorClientWith, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import type { AgentEvent, AgentTranscript } from '@sigx/ai-agent';
import { isServerFnError, ServerFnError } from '@sigx/server';

import { AgentActor, agentKey } from '../agent/index.js';
import { auditPort } from '../audit/port.js';
import { Chat } from '../chat/index.js';
import { asPrincipal, mintAgentPrincipal, sameWorkspace, userPrincipal, workspaceKey } from '../auth/index.js';
import { machineKey, type MachineView, type OpenSessionResult } from '../machine/index.js';
import { isInterruptedTurnEnd, resumeTurnId, type SessionCommandResult, type SessionInfo, type SessionOpenSpec } from '../session/index.js';
import { TaskActor, taskKey, type TaskOutcome, type TaskView } from '../task/index.js';
import { Workspace } from '../workspace/index.js';
import { FALLBACK_RUNTIME } from '../registry/dependents.js';
import { registryKey } from '../registry/key.js';
import type { RegistryGate } from '../registry/types.js';
import { PLUGIN_DISABLED_CODE, resolveRuntime, UNKNOWN_RUNTIME_CODE } from './factory.js';
import { hydrateChatFiles, withChatFileRead } from './files.js';
import { parseRoutingKey, ROUTING_TYPE } from './key.js';
import { locateEnvironment, type LocatedEnvironment } from './locate.js';
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

/** The slice of the Session actor the router drives (`defineSessionActor`). */
interface SessionClient {
    open(spec: SessionOpenSpec): Promise<SessionInfo>;
    prompt(input: readonly PromptPart[], turnId: string): Promise<SessionCommandResult>;
    resume(): Promise<SessionCommandResult>;
    get(): Promise<SessionInfo>;
    transcript(): Promise<AgentTranscript | undefined>;
    tail(from?: { epoch: number; seq: number }): AsyncIterable<AgentEvent>;
    cancel(): Promise<SessionCommandResult>;
    close(): Promise<SessionCommandResult>;
}

/** The slice of the Machine actor the router drives (`defineMachineActor`). */
interface MachineClient {
    get(): Promise<MachineView>;
    openSession(sessionId: SessionId, environmentId: EnvironmentId, spec: OpenSpec, options?: { taskId?: TaskId }): Promise<OpenSessionResult>;
}

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

/** The connectors an agent names, for `gate()` to answer for (#240). */
const connectorIds = (config: Pick<FrozenAgentConfig, 'connectors'>): readonly string[] => config.connectors.map((c) => c.id);

/** The slice of the Registry actor the router asks (`defineRegistry`). */
interface RegistryClient {
    gate(input: { readonly runtime: string; readonly connectors?: readonly string[] }): Promise<RegistryGate>;
}

/**
 * The config a session opens with: the agent's own, with the runtime plugin's `defaultModel` where the agent names no
 * model (§9). Only when the gate answered for the route's current runtime — after a `fallback-api` that is `anthropic-api`.
 */
function withDefaultModel(config: FrozenAgentConfig, plugins: RegistryGate | undefined): FrozenAgentConfig {
    const model = plugins?.runtime?.config['defaultModel'];
    if (config.execution.model || typeof model !== 'string' || !model) return config;
    return { ...config, execution: { ...config.execution, model } };
}

const grantedToolNames = (route: Route): string[] => route.config.tools.filter((g) => g.mode !== 'deny').map((g) => g.name);

/** What the daemon compiles the session policy from (#121): the agent's rules and grants, and the ancestors' rules on a delegated task (AC-12) — the same input `sessionPolicy` takes on the local path. */
const openSpecPolicy = (route: Route): OpenSpecPolicy => ({ rules: route.config.approvalPolicy, grants: route.config.tools, ...(route.constraints?.length ? { constraints: route.constraints } : {}) });

/** Build the Routing actor definition over its ports. One call per app — the actor `type` is `'routing'`. */
export function defineRoutingActor(ports: RoutingPorts) {
    const now = ports.now ?? Date.now;
    const newSessionId = ports.newSessionId ?? ((): SessionId => createId('session') as SessionId);
    const driverOf = ports.driver ?? ((ws: WorkspaceId): Principal => userPrincipal(ws, ws));
    const audit = ports.audit ?? auditPort();
    /** Per activation (by actor key): what `prompt` pokes so the `follow` supervisor rescans the routes. */
    const wakers = new Map<string, () => void>();

    return defineActor({
        type: ROUTING_TYPE,
        authorize: [sameWorkspace],
        methodAuthorize: { run: taskDriver, machineOnline: machineOnly, sessionOpened: machineOnly, sessionClosed: machineOnly, report: ownTask },
        state: (): RoutingState => initialRoutingState(),
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
             * The turn's input: the objective, the triggering message's attachments the context does not
             * already carry, then the context — every attachment resolved for the route's agent (#205):
             * images inlined within `CHAT_FILE_INLINE_BUDGET` (the trigger's first, then the newest),
             * everything else a note (`hydrateChatFiles`).
             */
            async function promptInput(route: Route, t: TaskView): Promise<PromptPart[]> {
                const trigger = await triggerFiles(route, t);
                const inContext = new Set(t.context.filter(isChatFilePart).map((p) => p.url));
                const parts: PromptPart[] = [{ type: 'text', text: t.objective }, ...trigger.filter((p) => !inContext.has(p.url)), ...t.context];
                if (!parts.some(isChatFilePart)) return parts;
                return hydrateChatFiles(parts, {
                    workspaceId,
                    access: (chatId, fileId) => chatAsAgent(route, chatId).fileAccess(fileId),
                    ...(ports.files ? { store: ports.files } : {}),
                    first: trigger.map((p) => p.url)
                });
            }

            /** The one prompt of a route: objective + context, idempotent by its turn id (a retry after an eviction runs once). */
            async function prompt(route: Route): Promise<void> {
                if (!route.sessionId) return;
                const t = await task(route.taskId).get();
                if (isTerminal(t.status)) {
                    drop(route.taskId);
                    return;
                }
                const turnId = `${route.taskId}:turn:1`;
                const input = await promptInput(route, t);
                const reply = await session(route.sessionId).prompt(input, turnId);
                if (reply.kind === 'error') {
                    await fail(route, { code: `prompt-${reply.code}`, message: reply.message, recoverable: reply.code === 'busy' });
                    return;
                }
                route.status = 'running';
                route.turnId = turnId;
                touch(route);
                await ctx.tasks.start('follow');
                wakers.get(ctx.key)?.();
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
                        members
                    };
                } catch {
                    return undefined;
                }
            }

            /** Open a local Session (a runtime hosted in this process — `anthropic-api`) for the route and prompt it. */
            async function placeLocal(route: Route, why: string, t?: TaskView): Promise<void> {
                const sessionId = (route.sessionId ??= newSessionId());
                // Detached copies: the route lives in the actor's state, and a spec is cloned by the actors it reaches.
                const spec: SessionOpenSpec = {
                    agentId: route.agentId,
                    runtime: route.runtime,
                    ...(route.chatId ? { chatId: route.chatId } : {}),
                    taskId: route.taskId,
                    ...(await work(route, t)),
                    config: ctx.snapshot(withDefaultModel(route.config, route.plugins)),
                    ...(route.constraints ? { approvalConstraints: ctx.snapshot(route.constraints) } : {}),
                    tools: grantedToolNames(route),
                    ...(route.plugins ? { plugins: ctx.snapshot(route.plugins) } : {})
                };
                try {
                    await session(sessionId).open(spec);
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    // The plugin was turned off between the gate and the open: the same failure the gate gives, not a broken session.
                    const disabled = message.includes(`${PLUGIN_DISABLED_CODE}:`);
                    await fail(route, { code: disabled ? PLUGIN_DISABLED_CODE : 'session-open', message, recoverable: disabled });
                    return;
                }
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
                        const asked = await gate(FALLBACK_RUNTIME, `fallback-api: ${where} is offline`, connectorIds(route.config));
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
                const sessionId = (route.sessionId ??= newSessionId());
                const opening = await work(route, t);
                const tools = grantedToolNames(route);
                const effective = withDefaultModel(route.config, route.plugins);
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
                    ...(route.constraints ? { approvalConstraints: ctx.snapshot(route.constraints) } : {}),
                    ...(route.plugins ? { plugins: ctx.snapshot(route.plugins) } : {}),
                    // The same prompt the API path builds (identity, role, instructions, skills, the chat, the tools);
                    // `open` appends the memory block. The daemon's runtime appends it to its own preset.
                    system: buildSystemPrompt({ config: route.config, tools, ...(opening.roster ? { roster: opening.roster } : {}) }),
                    tools
                };
                // The Session record first: the daemon's `session.opened` may arrive before `openSession` returns — and the route
                // is `opening` from here, so a `sessionOpened` notification (its own turn, after this one) always finds it ready.
                // The record's `system` is the one the daemon runs: the instructions plus the memory block `open` retrieved (§8).
                const opened = await session(sessionId).open(spec);
                route.status = 'opening';
                const limits = route.config.execution.limits;
                let result: OpenSessionResult;
                try {
                    result = await machine(machineId).openSession(
                        sessionId,
                        environmentId,
                        {
                            agentId: route.agentId,
                            cwd: route.cwd ?? '',
                            system: opened.spec?.system ?? spec.system ?? route.config.instructions,
                            ...(effective.execution.model ? { model: effective.execution.model } : {}),
                            ...(limits.maxTurns !== undefined ? { maxTurns: limits.maxTurns } : {}),
                            ...(limits.maxCostUsd !== undefined ? { maxBudgetUsd: limits.maxCostUsd } : {}),
                            tools: grantedToolNames(route),
                            policy: ctx.snapshot(openSpecPolicy(route)),
                            ...(opening.resume !== undefined ? { resume: opening.resume } : {})
                        },
                        { taskId: route.taskId }
                    );
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
                    await activate(route, `${where} is online; session opening`, sessionId);
                } else {
                    const after = await machine(machineId).get();
                    const position = after.queued.findIndex((q) => q.sessionId === sessionId) + 1;
                    await park(route, { kind: 'capacity', environmentId, position: Math.max(1, position) }, `${where} is online; waiting for a slot`, sessionId);
                    route.status = 'waiting-capacity';
                }
                touch(route);
            }

            const locate = (environmentId: EnvironmentId) => locateEnvironment(workspaceId, environmentId, { machines: ports.machines, driver });

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
                    // The plugin behind the runtime, asked once and before anything is written (§9, AC-13); the answer rides on the route and the spec.
                    const gated = await gate(runtime, undefined, connectorIds(config));
                    const host = hostOf(runtime);
                    const refused: TaskError | undefined = gated.error ?? (host === undefined ? { code: UNKNOWN_RUNTIME_CODE, message: `agent ${t.assignee} runs on "${runtime}", which this build does not have`, recoverable: false } : undefined);
                    const base = { taskId, agentId: t.assignee, ...(chatId ? { chatId } : {}), runtime, policy: config.execution.offlinePolicy, config, ...(constraints ? { constraints } : {}), ...(gated.plugins ? { plugins: gated.plugins } : {}), createdAt: at, updatedAt: at };
                    if (refused) {
                        // No route was written; `fail` tells the task's chat where the answer would have been (#128).
                        await fail({ ...base, status: 'opening' }, refused);
                        return task(taskId).get();
                    }
                    /** The one resolution of where this task runs (EXE-12), recorded before placement so a placement that fails still shows the choice (OPS-03). */
                    const chosen = (why: string, environmentId?: EnvironmentId, folder: { cwd?: string; ignoredWorkdir?: string } = {}): Promise<void> =>
                        audit.record(ctx, workspaceId, {
                            key: `${taskKey(workspaceId, taskId)}:environment`,
                            kind: 'environment.chosen',
                            at,
                            by: ROUTER,
                            summary: why,
                            agentId: t.assignee,
                            taskId,
                            data: { runtime, ...(environmentId ? { environmentId } : {}), policy: config.execution.offlinePolicy, fallback: false, ...folder, why }
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
                    // A daemon runtime: the environment is the task's, else the agent's, else — for a delegated task — the
                    // delegating task's route (#220: a chat-started parent's environment lives on its route, not its record),
                    // else the workspace's default (AGT-05). From here on, this one only (EXE-12).
                    const parent = t.origin.kind === 'agent' ? s.routes[t.origin.taskId] : undefined;
                    const named = t.environmentId ?? config.execution.defaultEnvironmentId ?? parent?.environmentId;
                    const environmentId = named ?? (await workspaceEnvironment());
                    if (!environmentId) {
                        const message =
                            t.origin.kind === 'agent'
                                ? `agent ${t.assignee} runs on ${runtime} but no environment is named by the task, the agent, the delegating task or the workspace's defaults`
                                : `agent ${t.assignee} runs on ${runtime} but neither the task, the agent nor the workspace's defaults name an environment`;
                        await task(taskId).fail({ code: 'no-environment', message, recoverable: false }, ROUTER);
                        return task(taskId).get();
                    }
                    const envFrom = t.environmentId ? "the task's own" : config.execution.defaultEnvironmentId ? "the agent's default" : named ? "the delegating task's" : "the workspace's default";
                    // The folder, once (#190, EXE-12): the task's own, a delegating parent's in the same environment, the agent's
                    // default in its default environment, else the environment's first root — which needs the machine's report.
                    const asked: { cwd: string; from: string } | undefined =
                        t.workdir !== undefined
                            ? { cwd: t.workdir, from: "the task's own" }
                            : parent?.cwd !== undefined && parent.environmentId === environmentId
                              ? { cwd: parent.cwd, from: "the delegating task's" }
                              : config.execution.defaultWorkdir !== undefined && environmentId === config.execution.defaultEnvironmentId
                                ? { cwd: config.execution.defaultWorkdir, from: "the agent's default" }
                                : undefined;
                    const located = await locate(environmentId);
                    const cwd = asked?.cwd ?? located?.env.cwdRoots[0];
                    const folder = cwd === undefined ? '' : `; folder ${cwd} (${asked ? asked.from : "the environment's first root"})`;
                    await chosen(`runtime ${runtime} in environment ${environmentId} (${envFrom})${folder}; offline policy ${config.execution.offlinePolicy}`, environmentId, cwd !== undefined ? { cwd } : {});
                    // A folder picked for this task joins the workspace's recent folders — one-way, never failing the run.
                    if (t.workdir !== undefined) await noteWorkdir({ environmentId, path: t.workdir });
                    // The machine is bound inside `placeRemote` (the first one reporting the environment); an environment nobody
                    // reports yet is "offline" under the agent's policy — `queue` waits for the machine that will (AST-05).
                    s.routes[taskId] = { ...base, environmentId, ...(cwd !== undefined ? { cwd } : {}), status: 'opening' };
                    await placeRemote(s.routes[taskId]!, undefined, t, located);
                    await ctx.save();
                    return task(taskId).get();
                },

                /**
                 * "Resume" on an interrupted turn (OPS-05): the session is prompted anew
                 * with the cut turn's input over its intact transcript (`Session.resume`),
                 * the task's `waiting {input, resume:…}` resolves `active` with a `resumed`
                 * transition, and `follow` picks the new turn up. Nothing is replayed.
                 */
                async resume(taskId: TaskId): Promise<TaskView> {
                    const s = ctx.state;
                    const route = s.routes[taskId];
                    if (!route || route.status !== 'interrupted' || !route.sessionId || !route.turnId) throw new ServerFnError(409, `task ${taskId} has no interrupted turn to resume`);
                    const reply = await session(route.sessionId).resume();
                    if (reply.kind === 'error') {
                        await fail(route, { code: `resume-${reply.code}`, message: reply.message, recoverable: false });
                        await ctx.save();
                        return task(taskId).get();
                    }
                    const t = await task(taskId).get();
                    if (t.status === 'waiting') await task(taskId).resolveWaiting(ROUTER, `resumed: a new prompt over the intact transcript (turn ${route.turnId} was interrupted)`, route.sessionId);
                    route.turnId = resumeTurnId(route.turnId);
                    route.status = 'running';
                    touch(route);
                    await ctx.tasks.start('follow');
                    wakers.get(ctx.key)?.();
                    await ctx.save();
                    return task(taskId).get();
                },

                /** Machine → router: the daemon said hello. Every route parked on it is retried — on that machine, no other; a route no machine reported yet looks again. */
                async machineOnline(machineId: MachineId): Promise<void> {
                    const s = ctx.state;
                    for (const route of Object.values(s.routes)) {
                        if (route.status !== 'waiting-offline' || (route.machineId !== undefined && route.machineId !== machineId)) continue;
                        await placeRemote(route);
                    }
                    await ctx.save();
                },

                /** Machine → router: the daemon acknowledged a session — a queued one included. Time to prompt. */
                async sessionOpened(sessionId: SessionId, taskId?: TaskId): Promise<void> {
                    const s = ctx.state;
                    const route = (taskId ? s.routes[taskId] : undefined) ?? Object.values(s.routes).find((r) => r.sessionId === sessionId);
                    if (!route || route.sessionId !== sessionId || (route.status !== 'opening' && route.status !== 'waiting-capacity')) return;
                    if (route.status === 'waiting-capacity') await activate(route, `a slot freed in environment ${route.environmentId}; session opened`, sessionId);
                    await prompt(route);
                    await ctx.save();
                },

                /** Machine → router: a session is gone. One the daemon refused before it opened fails its task with the daemon's reason. */
                async sessionClosed(sessionId: SessionId, reason: string, taskId?: TaskId): Promise<void> {
                    const s = ctx.state;
                    const route = (taskId ? s.routes[taskId] : undefined) ?? Object.values(s.routes).find((r) => r.sessionId === sessionId);
                    if (!route || route.sessionId !== sessionId) return;
                    if (route.status === 'opening' || route.status === 'waiting-capacity') {
                        await fail(route, { code: 'session-refused', message: `machine ${route.machineId} closed the session before it opened: ${reason}`, recoverable: true });
                    }
                    await ctx.save();
                },

                /** `task_report` from the task's own agent: kept for the result at the turn's end. */
                async report(taskId: TaskId, report: TaskReport): Promise<void> {
                    const p = ctx.principal as Principal | null;
                    if (p?.kind !== 'agent' || p.taskId !== taskId) throw new ServerFnError(403, `routing: only the agent working task ${taskId} reports on it`);
                    ctx.state.reports[taskId] = { status: report.status, summary: report.summary, ...(report.output !== undefined ? { output: report.output } : {}) };
                    await ctx.save();
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

                /** Settle the task, forget the route, and close the session: a daemon session holds an environment slot (EXE-09), and the record keeps its `ref` for a resume. */
                const settled = async (fn: (c: ActorContext<RoutingState>) => Promise<void>): Promise<void> => {
                    await ctx.turn(async (c) => {
                        await fn(c);
                        delete c.state.routes[route.taskId];
                        delete c.state.reports[route.taskId];
                        await c.save();
                    });
                    await sessionClient.close().catch(() => undefined);
                };
                const tryTask = async (fn: () => Promise<unknown>): Promise<void> => {
                    try {
                        await fn();
                    } catch {
                        // A transition the task no longer allows (settled meanwhile, cancelled): the record stands as it is.
                    }
                };

                const it = sessionClient.tail({ epoch: 0, seq: 0 })[Symbol.asyncIterator]();
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
                        if (signal.aborted || next.done) return;
                        const early = (next as { settled?: TaskOutcome }).settled;
                        if (early) {
                            settledEarly = never;
                            settledOutside = true;
                            if (early.status !== 'completed') await sessionClient.cancel().catch(() => undefined);
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
                if (!end) return;
                // Settled from outside while the turn ran: the turn is over now, and the task gets the driver's word.
                const stopped = async (): Promise<void> => settled(() => tryTask(() => taskClient.sessionStopped()));
                if (settledOutside) return stopped();
                const t = await taskClient.get();
                if (isTerminal(t.status)) return stopped();
                if (end.stopReason === 'error') {
                    if (isInterruptedTurnEnd(end)) {
                        // Cut short by an eviction: nothing was re-run (OPS-05/06); the user decides whether to resume.
                        // The route parks as `interrupted` — not followed again until `resume` re-prompts it.
                        await ctx.turn(async (c) => {
                            await tryTask(() => taskClient.reportWaiting({ kind: 'input', requestId: `resume:${turnId}`, sessionId }, ROUTER));
                            const parked = c.state.routes[route.taskId];
                            if (parked && parked.turnId === turnId) parked.status = 'interrupted';
                            await c.save();
                        });
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
                    // The turn ended with its question still open (#285: `ask_user` answered `pending`): nothing waits on it in
                    // this task any more — the answer starts a new one — so the task leaves `waiting` and completes.
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
                    const aborted = new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                    while (!signal.aborted) {
                        // Arm the wake-up before looking, so a route marked running meanwhile is never missed.
                        const woken = new Promise<void>((resolve) => wakers.set(ctx.key, resolve));
                        for (const route of Object.values(ctx.snapshot().routes)) {
                            if (route.status !== 'running' || active.has(route.taskId)) continue;
                            const run = followOne(route)
                                .catch(() => undefined)
                                .finally(() => active.delete(route.taskId));
                            active.set(route.taskId, run);
                        }
                        await Promise.race([woken, aborted, ...active.values()]);
                        wakers.delete(ctx.key);
                    }
                }
            };
        }
    });
}

export type RoutingActor = ReturnType<typeof defineRoutingActor>;
