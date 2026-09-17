/**
 * The Routing actor — `{ws}:routing:main` (architecture §7 "Driver"; EXE-09,
 * EXE-11, EXE-12, AST-05). A task always runs where it was told to, or
 * waits / fails with a visible reason:
 *
 * - `run(taskId)` resolves the runtime and the environment ONCE — the task's
 *   `environmentId`, else the agent's default — and records them on the
 *   route; nothing later changes them (EXE-12).
 * - `anthropic-api` opens a local Session (the `SessionFactory`) and prompts.
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
 *   `approvalConstraints`, so the child's policy is never wider (AC-12), and
 *   a `request` it raises is pushed to the Inbox when one is wired.
 *
 * Every mutation ends in `ctx.save()` inside the turn. Calls into Task,
 * Session, Machine and Agent are fresh `actor()` calls under the driver
 * principal, never `ctx.actor` hops: a notification turn belongs to a
 * machine, and the machine may not drive sessions.
 */

import { createId, hasScope, isTerminal, type AgentId, type ApprovalRule, type ChatId, type EnvironmentDescriptor, type EnvironmentId, type MachineId, type Principal, type PromptPart, type SessionId, type TaskError, type TaskId, type WaitReason, type WorkspaceId } from '@agentic/core';
import type { TaskReport } from '@agentic/runtimes';
import { actor, defineActor, type ActorClientWith, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import type { AgentEvent, AgentTranscript } from '@sigx/ai-agent';
import { isServerFnError, ServerFnError } from '@sigx/server';

import { AgentActor, agentKey } from '../agent/index.js';
import { auditPort } from '../audit/port.js';
import { asPrincipal, sameWorkspace, userPrincipal } from '../auth/index.js';
import { machineKey, type MachineView, type OpenSessionResult } from '../machine/index.js';
import { inboxKey, type NotificationInput } from '../notify/index.js';
import { isInterruptedTurnEnd, type SessionCommandResult, type SessionInfo, type SessionOpenSpec } from '../session/index.js';
import { TaskActor, taskKey, type TaskOutcome, type TaskView } from '../task/index.js';
import { parseRoutingKey, ROUTING_TYPE } from './key.js';
import { locateEnvironment } from './locate.js';
import type { RoutingPorts } from './ports.js';
import { initialRoutingState, type Route, type RoutingState } from './state.js';

/** The `by` the router signs its transitions with. */
export const ROUTER = 'system:routing';

/** The slice of the Session actor the router drives (`defineSessionActor`). */
interface SessionClient {
    open(spec: SessionOpenSpec): Promise<SessionInfo>;
    prompt(input: readonly PromptPart[], turnId: string): Promise<SessionCommandResult>;
    get(): Promise<SessionInfo>;
    transcript(): Promise<AgentTranscript | undefined>;
    tail(from?: { epoch: number; seq: number }): AsyncIterable<AgentEvent>;
    cancel(): Promise<SessionCommandResult>;
    close(): Promise<SessionCommandResult>;
}

/** The slice of the Machine actor the router drives (`defineMachineActor`). */
interface MachineClient {
    get(): Promise<MachineView>;
    openSession(sessionId: SessionId, environmentId: EnvironmentId, spec: { agentId: string; cwd: string; system: string; model?: string; maxTurns?: number; maxBudgetUsd?: number; tools: readonly string[]; resume?: unknown }, options?: { taskId?: TaskId }): Promise<OpenSessionResult>;
}

/** The slice of the Inbox actor the router notifies (`defineInbox`). */
interface InboxClient {
    push(input: NotificationInput): Promise<unknown>;
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

const grantedToolNames = (route: Route): string[] => route.config.tools.filter((g) => g.mode !== 'deny').map((g) => g.name);

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
            const session = (id: SessionId): SessionClient => actor(ports.sessions(), `${workspaceId}:session:${id}`).with({ context }) as unknown as SessionClient;
            const machine = (id: MachineId): MachineClient => actor(ports.machines(), machineKey(workspaceId, id)).with({ context }) as unknown as MachineClient;

            const touch = (route: Route): void => void (route.updatedAt = now());
            const drop = (taskId: TaskId): void => {
                delete ctx.state.routes[taskId];
                delete ctx.state.reports[taskId];
            };

            /** Fail the task with a reason and forget the route. A task already settled is left alone. */
            async function fail(route: Route, error: TaskError): Promise<void> {
                const t = await task(route.taskId).get();
                if (!isTerminal(t.status)) await task(route.taskId).fail(error, ROUTER);
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

            /** The one prompt of a route: objective + context, idempotent by its turn id (a retry after an eviction runs once). */
            async function prompt(route: Route): Promise<void> {
                if (!route.sessionId) return;
                const t = await task(route.taskId).get();
                if (isTerminal(t.status)) {
                    drop(route.taskId);
                    return;
                }
                const turnId = `${route.taskId}:turn:1`;
                const input: PromptPart[] = [{ type: 'text', text: t.objective }, ...t.context];
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

            /** Open a local (`anthropic-api`) Session for the route and prompt it. */
            async function placeLocal(route: Route, why: string): Promise<void> {
                const sessionId = (route.sessionId ??= newSessionId());
                // Detached copies: the route lives in the actor's state, and a spec is cloned by the actors it reaches.
                const spec: SessionOpenSpec = {
                    agentId: route.agentId,
                    runtime: 'anthropic-api',
                    ...(route.chatId ? { chatId: route.chatId } : {}),
                    taskId: route.taskId,
                    config: ctx.snapshot(route.config),
                    ...(route.constraints ? { approvalConstraints: ctx.snapshot(route.constraints) } : {}),
                    tools: grantedToolNames(route)
                };
                try {
                    await session(sessionId).open(spec);
                } catch (e) {
                    await fail(route, { code: 'session-open', message: e instanceof Error ? e.message : String(e), recoverable: false });
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
                        // Explicitly allowed by the config: the record says the task left its environment, and why (EXE-11/12).
                        const why = `fallback-api: ${where} is offline; running on anthropic-api as the agent's offline policy allows`;
                        const from = { runtime: route.runtime, environmentId, ...(route.machineId ? { machineId: route.machineId } : {}) };
                        route.runtime = 'anthropic-api';
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
                            data: { runtime: 'anthropic-api', policy: route.policy, fallback: true, from, why }
                        });
                        await placeLocal(route, why);
                        return;
                    }
                }
            }

            /** Open the route's Session on ITS machine (never another), or park it. A route no machine reported yet is located first — and bound to that machine from then on. */
            async function placeRemote(route: Route, view?: MachineView): Promise<void> {
                const { environmentId } = route;
                if (!environmentId) return;
                if (!route.machineId) {
                    const found = await locate(environmentId);
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
                if (!m.online) {
                    await offline(route, m);
                    return;
                }
                const sessionId = (route.sessionId ??= newSessionId());
                const spec: SessionOpenSpec = {
                    agentId: route.agentId,
                    runtime: route.runtime,
                    ...(route.chatId ? { chatId: route.chatId } : {}),
                    taskId: route.taskId,
                    environmentId,
                    machineId,
                    config: ctx.snapshot(route.config),
                    ...(route.constraints ? { approvalConstraints: ctx.snapshot(route.constraints) } : {}),
                    system: route.config.instructions,
                    tools: grantedToolNames(route)
                };
                // The Session record first: the daemon's `session.opened` may arrive before `openSession` returns — and the route
                // is `opening` from here, so a `sessionOpened` notification (its own turn, after this one) always finds it ready.
                await session(sessionId).open(spec);
                route.status = 'opening';
                const limits = route.config.execution.limits;
                let result: OpenSessionResult;
                try {
                    result = await machine(machineId).openSession(
                        sessionId,
                        environmentId,
                        {
                            agentId: route.agentId,
                            cwd: env.cwdRoots[0] ?? '',
                            system: route.config.instructions,
                            ...(route.config.execution.model ? { model: route.config.execution.model } : {}),
                            ...(limits.maxTurns !== undefined ? { maxTurns: limits.maxTurns } : {}),
                            ...(limits.maxCostUsd !== undefined ? { maxBudgetUsd: limits.maxCostUsd } : {}),
                            tools: grantedToolNames(route)
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
                    // A delegated task inherits the approval constraints of its whole chain: the parent route's, then the parent's own rules (AC-12).
                    let constraints: readonly ApprovalRule[] | undefined;
                    if (t.origin.kind === 'agent') {
                        const parent = s.routes[t.origin.taskId];
                        const parentRules = parent ? parent.config.approvalPolicy : (await agent(t.origin.agentId).get()).config.approvalPolicy;
                        constraints = [...(parent?.constraints ?? []), ...parentRules];
                    }
                    const base = { taskId, agentId: t.assignee, ...(chatId ? { chatId } : {}), runtime, policy: config.execution.offlinePolicy, config, ...(constraints ? { constraints } : {}), createdAt: at, updatedAt: at };
                    /** The one resolution of where this task runs (EXE-12), recorded before placement so a placement that fails still shows the choice (OPS-03). */
                    const chosen = (why: string, environmentId?: EnvironmentId): Promise<void> =>
                        audit.record(ctx, workspaceId, {
                            key: `${taskKey(workspaceId, taskId)}:environment`,
                            kind: 'environment.chosen',
                            at,
                            by: ROUTER,
                            summary: why,
                            agentId: t.assignee,
                            taskId,
                            data: { runtime, ...(environmentId ? { environmentId } : {}), policy: config.execution.offlinePolicy, fallback: false, why }
                        });
                    if (runtime === 'anthropic-api') {
                        s.routes[taskId] = { ...base, status: 'opening' };
                        await chosen(`runtime anthropic-api (the agent's runtime); no environment needed`);
                        await placeLocal(s.routes[taskId]!, 'started');
                        await ctx.save();
                        return task(taskId).get();
                    }
                    // A daemon runtime: the environment is the task's, else the agent's — and from here on, this one only (EXE-12).
                    const environmentId = t.environmentId ?? config.execution.defaultEnvironmentId;
                    if (!environmentId) {
                        await task(taskId).fail({ code: 'no-environment', message: `agent ${t.assignee} runs on ${runtime} but neither the task nor the agent names an environment`, recoverable: false }, ROUTER);
                        return task(taskId).get();
                    }
                    await chosen(`runtime ${runtime} in environment ${environmentId} (${t.environmentId ? "the task's own" : "the agent's default"}); offline policy ${config.execution.offlinePolicy}`, environmentId);
                    // The machine is bound inside `placeRemote` (the first one reporting the environment); an environment nobody
                    // reports yet is "offline" under the agent's policy — `queue` waits for the machine that will (AST-05).
                    s.routes[taskId] = { ...base, environmentId, status: 'opening' };
                    await placeRemote(s.routes[taskId]!);
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
                const inboxDef = ports.inbox?.();
                const inbox = inboxDef ? (actor(inboxDef, inboxKey(ids.workspaceId)).with({ context }) as unknown as InboxClient) : undefined;
                const { turnId, sessionId, agentId } = route;

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
                const outcomes = taskClient.result()[Symbol.asyncIterator]();
                let settledEarly: Promise<IteratorResult<AgentEvent> & { settled?: TaskOutcome }> = outcomes.next().then((r) => (r.done ? never : { value: undefined as never, done: false, settled: r.value }));
                // One `next()` in flight at a time: a race the tail loses must not discard the event it will resolve with.
                let pending: Promise<IteratorResult<AgentEvent>> | undefined;
                let end: Extract<AgentEvent, { type: 'turn-end' }> | undefined;
                try {
                    for (;;) {
                        pending ??= it.next();
                        const next = await Promise.race([pending, aborted, settledEarly]);
                        if (signal.aborted || next.done) return;
                        const early = (next as { settled?: TaskOutcome }).settled;
                        if (early) {
                            settledEarly = never;
                            if (early.status !== 'completed') await sessionClient.cancel().catch(() => undefined);
                            continue;
                        }
                        pending = undefined;
                        const ev = next.value;
                        if (ev.turnId !== turnId) continue;
                        if (ev.type === 'request') {
                            const kind = ev.kind === 'permission' ? 'approval' : 'input';
                            await tryTask(() => taskClient.reportWaiting({ kind, requestId: ev.requestId, sessionId }, ROUTER));
                            await inbox
                                ?.push({ kind, title: kind === 'approval' ? `${agentId} asks for approval${ev.toolName ? `: ${ev.toolName}` : ''}` : `${agentId} needs input`, ...(ev.message ? { body: ev.message } : {}), ref: { kind: 'session', sessionId, requestId: ev.requestId } })
                                .catch(() => undefined);
                        } else if (ev.type === 'request-resolved') {
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
                const t = await taskClient.get();
                if (isTerminal(t.status)) {
                    // Settled from outside while the turn ran: the turn is over now, and the task gets the driver's word.
                    await settled(() => tryTask(() => taskClient.sessionStopped()));
                    return;
                }
                if (end.stopReason === 'error') {
                    if (isInterruptedTurnEnd(end)) {
                        // Cut short by an eviction: nothing was re-run (OPS-05/06); the user decides whether to resume.
                        await ctx.turn(async (c) => {
                            await tryTask(() => taskClient.reportWaiting({ kind: 'input', requestId: `resume:${turnId}`, sessionId }, ROUTER));
                            await c.save();
                        });
                        return;
                    }
                    await settled(() => tryTask(() => taskClient.fail({ code: end!.error?.code ?? 'turn-error', message: end!.error?.message ?? 'the turn ended with an error', recoverable: false }, ROUTER)));
                    return;
                }
                if (end.stopReason === 'cancelled') {
                    await settled(() => tryTask(() => taskClient.fail({ code: 'turn-cancelled', message: 'the session cancelled the turn', recoverable: true }, ROUTER)));
                    return;
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
