/**
 * The Task actor (architecture §4 Task, §7): the traceable unit of work.
 * Keyed `{ws}:task:{id}`; every mutation is one log entry folded by
 * `applyTaskEntry` and made durable inside the turn (Workers never run
 * `onDeactivate`).
 */

import {
    canTransition,
    childTaskId,
    isTerminal,
    type SessionId,
    type TaskContract,
    type TaskError,
    type TaskId,
    type TaskResult,
    type TaskStatus,
    type Usage,
    type WaitReason
} from '@agentic/core';
import { defineActor, type ActorContext, type ActorDefinition, type ActorOptions } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { recordAudit } from '../audit/port.js';
import { sameWorkspace } from '../auth/index.js';
import { budgetError, checkBudget, type BudgetVerdict } from '../ledger/budget.js';
import { applyTaskEntry, initialTaskState } from './entries.js';
import { IllegalTransitionError, TaskLimitError, TaskStateError } from './errors.js';
import { indexTask } from './index-port.js';
import { TASK_TYPE, taskKey } from './key.js';
import { checkConcurrency, checkDepth, splitBudget, type Spent } from './limits.js';
import type { CancelOptions, DelegateSpec, StopReport, TaskEntry, TaskInit, TaskOutcome, TaskState, TaskTree, TaskView } from './types.js';

/** How long `cancel` waits for acknowledgements by default (COL-12). */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/** A type alias, not an interface: `ActorMethodTable` needs the implicit index signature only aliases carry. */
export type TaskMethods = {
    /** Idempotent: a second call returns the existing task untouched. */
    create(contract: TaskContract, init: TaskInit): Promise<TaskView>;
    /** `queued → active`; `sessionId` is the session doing the work, when there is one. */
    start(by: string, sessionId?: SessionId): Promise<TaskView>;
    /** `queued | active → waiting {reason}`; `sessionId` records the session the task waits with, when one was opened for it. */
    reportWaiting(reason: WaitReason, by: string, sessionId?: SessionId): Promise<TaskView>;
    /** `waiting → active`; `sessionId` records the session that resumes the work (a fallback runtime opens a new one). */
    resolveWaiting(by: string, why?: string, sessionId?: SessionId): Promise<TaskView>;
    /** `active → completed`. */
    complete(result: TaskResult, by: string): Promise<TaskView>;
    /** `queued | active | waiting → failed`. */
    fail(error: TaskError, by: string): Promise<TaskView>;
    /** Cancel this task and its subtree; resolves with what could not be confirmed stopped. */
    cancel(by: string, options?: CancelOptions): Promise<StopReport>;
    /** Create a child under the limits and move this task to `waiting {child}`. Returns the child's id. */
    delegate(spec: DelegateSpec): Promise<TaskId>;
    recordUsage(usage: Usage, costUsd?: number): Promise<TaskView>;
    /** The session driver's word that the running work has stopped. */
    sessionStopped(): Promise<void>;
    get(): TaskView;
    /** Why the task is waiting, or `null` when it is not. */
    explain(): WaitReason | null;
    /** This task and every descendant. */
    tree(): Promise<TaskTree>;
    /** Cascade entry (called by the parent, one-way); acknowledges back to the parent. */
    stop(by: string, deadline: number): Promise<StopReport>;
    /** A child's acknowledgement of `stop`. */
    childStopped(id: TaskId, report: StopReport): Promise<void>;
    /** A child reached a terminal state. */
    childSettled(id: TaskId, status: TaskStatus): Promise<void>;
};

export type TaskStreams = {
    /**
     * Yields once, when the task reaches a terminal state, then ends. `eager` also yields as soon as a
     * cancel is committed, before its turn ends: that turn waits for the session driver's word, so the
     * driver (the router) must hear of the cancel while it is parked (#168). The early outcome carries
     * no settled `cancel` report yet.
     */
    result(options?: { eager?: boolean }): AsyncIterable<TaskOutcome>;
};

type Ctx = ActorContext<TaskState>;

/**
 * Per activation (by actor key): the eager `result()` readers to wake when a cancel is committed. A
 * change feed only yields after a turn ends, and the `cancel` turn stays open until the session
 * driver acknowledges — which it can only do once it has heard of the cancel (#168).
 */
const cancelWakers = new Map<string, Set<() => void>>();

function wakeOnCancel(key: string): void {
    for (const wake of cancelWakers.get(key) ?? []) wake();
}

/**
 * Make one entry durable. `ctx.append` (O(entry), @sigx/actors #312) where the
 * runtime has it; the reducer plus a full `ctx.save()` where it does not —
 * the same result the append path gives on a storage without `appendText`.
 */
async function commit(ctx: Ctx, entry: TaskEntry): Promise<void> {
    const append = (ctx as Partial<{ append(entry: unknown): Promise<void> }>).append;
    if (typeof append === 'function') {
        await append.call(ctx, entry);
        return;
    }
    applyTaskEntry(ctx.state, entry);
    await ctx.save();
}

function toView(s: TaskState): TaskView {
    return {
        id: s.id,
        owner: s.owner,
        objective: s.objective,
        origin: s.origin,
        assignee: s.assignee,
        context: s.context,
        constraints: s.constraints,
        ...(s.expected !== undefined ? { expected: s.expected } : {}),
        ...(s.environmentId !== undefined ? { environmentId: s.environmentId } : {}),
        ...(s.machineId !== undefined ? { machineId: s.machineId } : {}),
        ...(s.workdir !== undefined ? { workdir: s.workdir } : {}),
        ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
        ...(s.resumeFrom !== undefined ? { resumeFrom: s.resumeFrom } : {}),
        ...(s.options !== undefined ? { options: { ...s.options } } : {}),
        depth: s.depth,
        ...(s.parentId !== undefined ? { parentId: s.parentId } : {}),
        status: s.status,
        ...(s.wait ? { wait: s.wait } : {}),
        ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
        children: s.children,
        ...(s.result ? { result: s.result } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(s.cancel ? { cancel: { requestedAt: s.cancel.requestedAt, by: s.cancel.by, stopped: s.cancel.stopped } } : {}),
        notStopped: s.notStopped,
        usage: s.usage,
        costUsd: s.costUsd,
        configVersion: s.configVersion,
        transitions: s.transitions
    };
}

function outcomeOf(s: TaskState): TaskOutcome {
    return {
        id: s.id,
        status: s.status as TaskOutcome['status'],
        ...(s.result ? { result: s.result } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(s.cancel ? { cancel: { requestedAt: s.cancel.requestedAt, by: s.cancel.by, stopped: s.cancel.stopped } } : {})
    };
}

function spentOf(s: TaskState, now: number): Spent {
    return {
        maxCostUsd: s.costUsd,
        maxTokens: s.usage.totalTokens ?? s.usage.inputTokens + s.usage.outputTokens,
        maxWallMs: s.startedAt === undefined ? 0 : now - s.startedAt
    };
}

const options: ActorOptions<TaskState, TaskMethods, TaskStreams> & { applyEntry(state: TaskState, entry: unknown): void } = {
    type: TASK_TYPE,
    authorize: [sameWorkspace],
    state: initialTaskState,
    applyEntry: applyTaskEntry,
    // Acknowledgements must interleave with a `cancel` turn parked on its deadline. Reads stay FIFO.
    methodReentrancy: {
        childStopped: 'always',
        childSettled: 'always',
        sessionStopped: 'always'
    },
    methods: (ctx): TaskMethods => {
        const s = ctx.state;
        const ackWaiters = new Map<TaskId, () => void>();
        let sessionWaiter: (() => void) | undefined;

        const requireCreated = (): void => {
            if (!s.created) throw new TaskStateError('not-created', `task ${s.id} has not been created`);
        };
        const view = (): TaskView => toView(ctx.snapshot());
        const childClient = (id: TaskId) => ctx.actor(TaskActor, taskKey(s.workspaceId, id));
        const parentClient = () => (s.parentId === undefined ? null : ctx.actor(TaskActor, taskKey(s.workspaceId, s.parentId)).with({ oneWay: true }));
        const liveChildren = (): TaskId[] => s.children.filter((id) => Object.hasOwn(s.live, id));

        const transition = async (
            to: TaskStatus,
            by: string,
            why: string,
            extra: { wait?: WaitReason; sessionId?: SessionId; result?: TaskResult; error?: TaskError } = {}
        ): Promise<void> => {
            requireCreated();
            const from = s.status;
            if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, s.id);
            const at = Date.now();
            await commit(ctx, { t: 'transition', from, to, at, by, why, ...extra });
            // The workspace's list (#146): awaited so rows land in order, never a gate on the work.
            await indexTask(ctx, s.workspaceId, ctx.snapshot(), at);
            const sessionId = extra.sessionId ?? s.sessionId;
            // The record of the edge (OPS-03), one-way: keyed by its position in the log so a replay folds once.
            await recordAudit(ctx, s.workspaceId, {
                key: `${ctx.key}:transition:${s.transitions.length}`,
                kind: 'task.transition',
                at,
                by,
                summary: `task ${s.id}: ${from} → ${to} (${why})`,
                agentId: s.assignee,
                taskId: s.id,
                ...(sessionId === undefined ? {} : { sessionId }),
                data: { from, to, why, ...(extra.wait ? { wait: extra.wait } : {}) }
            });
            if (isTerminal(to)) {
                const parent = parentClient();
                if (parent) await parent.childSettled(s.id, to).catch(() => undefined);
            }
        };

        /**
         * `start` and `resolveWaiting` both move to `active`, which `canTransition` allows from
         * queued AND waiting; each method only owns one of those edges. An illegal target still
         * reports as `IllegalTransitionError` first.
         */
        const requireStatus = (from: TaskStatus, method: string): void => {
            requireCreated();
            if (s.status === from || !canTransition(s.status, 'active')) return;
            throw new TaskStateError('wrong-state', `task ${s.id} is ${s.status}; ${method}() runs only from ${from}`);
        };

        const report = (): StopReport => ({ id: s.id, stopped: s.cancel ? s.cancel.stopped : isTerminal(s.status), notStopped: [...s.notStopped] });

        const ackParent = async (r: StopReport): Promise<void> => {
            const parent = parentClient();
            if (parent) await parent.childStopped(s.id, r).catch(() => undefined);
        };

        /**
         * The budget is spent (COL-11, OPS-08): the task ends `failed {budget}` and every
         * unsettled child is cancelled one-way, so nothing below it starts or goes on.
         */
        const overBudget = async (verdict: Exclude<BudgetVerdict, { ok: true }>, by: string): Promise<void> => {
            if (isTerminal(s.status)) return;
            await transition('failed', by, 'failed: budget', { error: budgetError(verdict) });
            for (const id of liveChildren()) {
                childClient(id)
                    .with({ oneWay: true })
                    .cancel(by)
                    .catch(() => undefined);
            }
        };

        /** The stop cascade (COL-12): cancel, fan out one-way, wait for acks until the deadline, list the rest. */
        const runStop = async (by: string, deadline: number, ack: boolean): Promise<StopReport> => {
            requireCreated();
            if (s.cancel?.settled || (!s.cancel && isTerminal(s.status))) {
                const r = report();
                if (ack) await ackParent(r);
                return r;
            }
            if (!s.cancel) {
                await transition('cancelled', by, 'cancel requested');
                await commit(ctx, { t: 'cancel', at: Date.now(), by, deadline });
                wakeOnCancel(ctx.key);
            }
            const now = Date.now();
            const pending = liveChildren();
            // Each hop keeps a margin so a child's own timeout report reaches us before ours fires.
            const childDeadline = deadline - Math.max(5, Math.floor((deadline - now) * 0.2));
            const acked = new Set<TaskId>();
            const waits: Promise<void>[] = [];
            for (const id of pending) {
                waits.push(
                    new Promise<void>((resolve) => {
                        ackWaiters.set(id, () => {
                            acked.add(id);
                            resolve();
                        });
                    })
                );
                childClient(id)
                    .with({ oneWay: true })
                    .stop(by, childDeadline)
                    .catch(() => undefined);
            }
            if (s.sessionId !== undefined && !s.sessionStopped) {
                waits.push(new Promise<void>((resolve) => (sessionWaiter = resolve)));
            }
            if (waits.length > 0) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const timeout = new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
                });
                await Promise.race([Promise.all(waits), timeout]);
                clearTimeout(timer);
            }
            ackWaiters.clear();
            sessionWaiter = undefined;
            const notStopped = new Set<TaskId>(s.notStopped);
            for (const id of pending) if (!acked.has(id)) notStopped.add(id);
            if (s.sessionId !== undefined && !s.sessionStopped) notStopped.add(s.id);
            await commit(ctx, { t: 'cancel-settled', at: Date.now(), stopped: notStopped.size === 0, notStopped: [...notStopped] });
            const r = report();
            if (ack) await ackParent(r);
            return r;
        };

        return {
            async create(contract, init) {
                // A folder is only meaningful on one machine: it travels with its environment (#190).
                if (contract.workdir !== undefined && (typeof contract.workdir !== 'string' || !contract.workdir.trim() || contract.environmentId === undefined)) {
                    throw new ServerFnError(400, `task ${s.id}: a workdir needs an environmentId (and a path)`);
                }
                if (s.created) return view();
                const at = Date.now();
                await commit(ctx, {
                    t: 'created',
                    at,
                    // The folder as `pathWithin` will check it: surrounding whitespace is never part of a path here.
                    contract: contract.workdir !== undefined ? { ...contract, workdir: contract.workdir.trim() } : contract,
                    owner: init.owner,
                    depth: init.depth ?? 0,
                    ...(init.parentId !== undefined ? { parentId: init.parentId } : {}),
                    configVersion: init.configVersion ?? 0
                });
                await indexTask(ctx, s.workspaceId, ctx.snapshot(), at);
                return view();
            },
            async start(by, sessionId) {
                requireStatus('queued', 'start');
                await transition('active', by, 'started', sessionId === undefined ? {} : { sessionId });
                return view();
            },
            async reportWaiting(reason, by, sessionId) {
                await transition('waiting', by, `waiting: ${reason.kind}`, { wait: reason, ...(sessionId === undefined ? {} : { sessionId }) });
                return view();
            },
            async resolveWaiting(by, why = 'resumed', sessionId) {
                requireStatus('waiting', 'resolveWaiting');
                await transition('active', by, why, sessionId === undefined ? {} : { sessionId });
                return view();
            },
            async complete(result, by) {
                await transition('completed', by, 'completed', { result });
                return view();
            },
            async fail(error, by) {
                await transition('failed', by, `failed: ${error.code}`, { error });
                return view();
            },
            cancel(by, options) {
                return runStop(by, Date.now() + (options?.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS), false);
            },
            stop(by, deadline) {
                return runStop(by, deadline, true);
            },
            async delegate(spec) {
                requireCreated();
                if (s.status !== 'active' && !(s.status === 'waiting' && s.wait?.kind === 'child')) {
                    throw new TaskStateError('not-active', `task ${s.id} is ${s.status}; only an active task delegates`);
                }
                const id = childTaskId(s.id, spec.callId);
                if (s.children.includes(id)) return id;
                const sessionId = spec.sessionId ?? s.sessionId;
                if (sessionId === undefined) throw new TaskStateError('no-session', `task ${s.id} has no session to delegate from`);
                const now = Date.now();
                // A task that has already spent its budget ends here; the child is never created (COL-11, OPS-08).
                const budget = checkBudget(s.constraints, spentOf(s, now));
                if (!budget.ok) {
                    await overBudget(budget, 'system:budget');
                    throw new TaskLimitError('budget', budgetError(budget).message, budget.limit);
                }
                const live = liveChildren();
                const depth = checkDepth(s.depth, s.constraints);
                checkConcurrency(live.length, s.constraints);
                const constraints = splitBudget(
                    s.constraints,
                    spentOf(s, now),
                    live.map((c) => s.live[c] ?? {}),
                    spec.constraints
                );
                const contract: TaskContract = {
                    objective: spec.objective,
                    origin: { kind: 'agent', agentId: s.assignee, taskId: s.id, sessionId, callId: spec.callId },
                    assignee: spec.assignee,
                    context: spec.context ?? [],
                    constraints,
                    ...(spec.expected !== undefined ? { expected: spec.expected } : {}),
                    ...((spec.environmentId ?? s.environmentId) !== undefined ? { environmentId: spec.environmentId ?? s.environmentId } : {}),
                    // The child runs on the parent's machine unless the spec names one (#414); the router also reads the parent route's.
                    ...((spec.machineId ?? s.machineId) !== undefined ? { machineId: spec.machineId ?? s.machineId } : {}),
                    ...(spec.workdir !== undefined ? { workdir: spec.workdir } : {}),
                    // The child works in the parent's project unless the spec names its own (#332), as with the environment.
                    ...((spec.projectId ?? s.projectId) !== undefined ? { projectId: spec.projectId ?? s.projectId } : {})
                };
                const owner = spec.owner ?? s.assignee;
                await childClient(id).create(contract, { owner, depth, parentId: s.id, configVersion: s.configVersion });
                await commit(ctx, { t: 'child', at: now, id, constraints });
                // The one `delegation.*` record (COL-09): the DelegateTool calls `delegate` and emits nothing of its own.
                await recordAudit(ctx, s.workspaceId, {
                    key: `${ctx.key}:child:${id}`,
                    kind: 'delegation.created',
                    at: now,
                    by: `agent:${s.assignee}`,
                    summary: `task ${s.id} delegated ${id} to ${spec.assignee}: ${spec.objective}`,
                    agentId: s.assignee,
                    taskId: s.id,
                    sessionId,
                    data: {
                        parentTaskId: s.id,
                        childTaskId: id,
                        assignee: spec.assignee,
                        owner,
                        objective: spec.objective,
                        callId: spec.callId,
                        constraints,
                        ...(contract.environmentId !== undefined ? { environmentId: contract.environmentId } : {})
                    }
                });
                const wait: WaitReason = { kind: 'child', childTaskIds: liveChildren() };
                if (s.status === 'active') await transition('waiting', `agent:${s.assignee}`, `delegated ${id}`, { wait });
                else {
                    await commit(ctx, { t: 'wait', at: now, wait });
                    await indexTask(ctx, s.workspaceId, ctx.snapshot(), now);
                }
                return id;
            },
            async recordUsage(usage, costUsd = 0) {
                requireCreated();
                const now = Date.now();
                await commit(ctx, { t: 'usage', at: now, usage, costUsd });
                const budget = checkBudget(s.constraints, spentOf(s, now));
                if (!budget.ok) await overBudget(budget, 'system:budget');
                return view();
            },
            async sessionStopped() {
                requireCreated();
                if (s.sessionStopped) return;
                await commit(ctx, { t: 'session-stopped', at: Date.now() });
                sessionWaiter?.();
                // The word came after the cascade settled: the parent's record of this subtree is corrected upward (COL-12).
                if (s.cancel?.settled) await ackParent(report());
            },
            get() {
                requireCreated();
                return view();
            },
            explain() {
                requireCreated();
                return s.status === 'waiting' && s.wait ? ctx.snapshot(s.wait) : null;
            },
            async tree() {
                requireCreated();
                const snap = ctx.snapshot();
                const children = await Promise.all(snap.children.map((id) => childClient(id).tree()));
                return {
                    id: snap.id,
                    status: snap.status,
                    ...(snap.wait ? { wait: snap.wait } : {}),
                    owner: snap.owner,
                    assignee: snap.assignee,
                    objective: snap.objective,
                    depth: snap.depth,
                    ...(snap.cancel ? { stopped: snap.cancel.stopped } : {}),
                    children
                };
            },
            async childStopped(id, r) {
                if (!s.children.includes(id)) return;
                await commit(ctx, { t: 'child-stopped', at: Date.now(), id, stopped: r.stopped, notStopped: r.notStopped });
                const waiter = ackWaiters.get(id);
                if (waiter) waiter();
                // A late acknowledgement after our own cascade settled travels on up, so every ancestor's record is corrected.
                else if (s.cancel?.settled) await ackParent(report());
            },
            async childSettled(id, status) {
                if (!s.children.includes(id) || !Object.hasOwn(s.live, id)) return;
                await commit(ctx, { t: 'child-settled', at: Date.now(), id, status });
                if (s.status !== 'waiting' || s.wait?.kind !== 'child') return;
                const rest = liveChildren();
                if (rest.length === 0) await transition('active', `task:${id}`, `child ${status}`);
                else {
                    const at = Date.now();
                    await commit(ctx, { t: 'wait', at, wait: { kind: 'child', childTaskIds: rest } });
                    await indexTask(ctx, s.workspaceId, ctx.snapshot(), at);
                }
            }
        };
    },
    streams: (ctx): TaskStreams => ({
        async *result(options) {
            const changes = ctx.changes({ initial: true })[Symbol.asyncIterator]();
            let wake: (() => void) | undefined;
            const cancelled = new Promise<'cancelled'>((resolve) => (wake = () => resolve('cancelled')));
            const wakers = options?.eager ? (cancelWakers.get(ctx.key) ?? new Set<() => void>()) : undefined;
            if (wakers) cancelWakers.set(ctx.key, wakers.add(wake!));
            try {
                for (;;) {
                    const next = await (wakers ? Promise.race([changes.next(), cancelled]) : changes.next());
                    const snap = next === 'cancelled' ? ctx.snapshot() : next.done ? undefined : next.value;
                    if (!snap) return;
                    if (isTerminal(snap.status)) {
                        yield outcomeOf(snap);
                        return;
                    }
                }
            } finally {
                if (wakers) {
                    wakers.delete(wake!);
                    if (wakers.size === 0) cancelWakers.delete(ctx.key);
                }
                await changes.return?.();
            }
        }
    })
};

export const TaskActor: ActorDefinition<TaskState, TaskMethods, TaskStreams> = defineActor(options);
