/**
 * Plan actor — `{ws}:plan:{projectId}` (#750; PRJ-11; architecture §10 "Projects (redesign)").
 *
 * One per project, holding every plan of it: phases, items, the per-agent queues, claims and their leases. Every
 * rule lives in `rules.ts` and runs here server-side, whoever calls — the web UI, the `plan_*` tools (#751) or
 * another actor. The caller is the principal: a person (`user`) or an agent; the project's manager is the
 * project's coordinator and each agent's working limit is `memberLimit`, both read from the Workspace record on
 * every write (a `PlanProjectPort` in tests).
 *
 * Leases: every call first expires the leases that ran out and then renews the calling agent's; a durable
 * reminder (`PLAN_LEASE_REMINDER`, one-shot, re-armed for the next lease end after every write) expires them with
 * nobody calling. Expiry puts the item back at the top of its assignee's queue and leaves the manager a notice.
 * Notices (lease ran out, touches overlap, handoffs) wait on the actor until their addressee takes them
 * (`takeNotices`, which the plan tools do on each call).
 *
 * Every change is a line in the item's activity and a `plan.changed` / `plan.lease-expired` audit record with
 * its actor. Workers eviction rule: every mutation ends in `ctx.save()` inside the turn.
 */
import { memberLimit, type AgentId, type Plan, type PlanActor, type PlanItem, type Principal, type ProjectId, type ProjectRecord, type Ref, type WorkspaceId } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { auditPort, type AuditPort } from '../audit/port.js';
import { sameWorkspace, workspaceKey } from '../auth/index.js';
import { Workspace } from '../workspace/index.js';
import { parsePlanKey, PLAN_TYPE } from './key.js';
import {
    addItems,
    addPhase,
    addRef,
    assign,
    checkActor,
    claim,
    createPlan,
    emptyBook,
    expireLeases,
    handoff,
    itemView,
    nextFor,
    nextLeaseEnd,
    openItems,
    planOf,
    planView,
    PlanRuleError,
    renewLeases,
    splitItem,
    takeNotices,
    update,
    type ClaimOptions,
    type OpenPlanItem,
    type Outcome,
    type PlanBook,
    type PlanCall,
    type PlanChange,
    type PlanCreateInput,
    type PlanItemInput,
    type PlanItemPatch,
    type PlanNotice,
    type TouchesWarning
} from './rules.js';

// ---------------------------------------------------------------------------
// State and options

export interface PlanState extends PlanBook {
    /** Audit records written so far — the idempotency key's counter. */
    auditSeq: number;
    /** When the lease reminder is armed for; absent when none is. */
    leaseAlarm?: number;
}

/** Where the actor reads the project's manager, members and limits. */
export interface PlanProjectPort {
    project(ctx: ActorContext<PlanState>, workspaceId: WorkspaceId, projectId: ProjectId): Promise<Pick<ProjectRecord, 'id' | 'members'> | undefined>;
}

/** The production port: the project record on the Workspace root, over a hop. */
export const workspacePlanProjects: PlanProjectPort = {
    async project(ctx, workspaceId, projectId) {
        const projects = await ctx.actor(Workspace, workspaceKey(workspaceId)).projects();
        return projects.find((p) => p.id === projectId);
    }
};

export interface PlanActorOptions {
    /** Default: the Workspace record (`workspacePlanProjects`). */
    readonly projects?: PlanProjectPort;
    /** Clock; default `Date.now`. */
    readonly now?: () => number;
    /** Override the policy chain. Default: the package's `sameWorkspace`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
    /** Waive the identity gate (tests). */
    readonly allowAnonymous?: true;
    /** Where `plan.*` records go. Default: the workspace's Audit log. */
    readonly audit?: AuditPort;
}

/** The reminder the lease expiry runs under. */
export const PLAN_LEASE_REMINDER = 'lease';
/** Who the lease alarm's records are by. */
export const PLAN_BY = 'system:plan';

/** What `claim` returns: the item and any touches clash with another agent's live claim. */
export interface PlanClaimResult {
    readonly item: PlanItem;
    readonly warnings: readonly TouchesWarning[];
}

export interface PlanListView {
    readonly projectId: ProjectId;
    readonly plans: readonly Plan[];
}

const principalActor = (p: Principal | null | undefined): PlanActor | null => {
    if (p?.kind === 'user') return { kind: 'user', userId: p.userId };
    if (p?.kind === 'agent') return { kind: 'agent', agentId: p.agentId };
    return null;
};

const byOf = (a: PlanActor | null): string => (a === null ? PLAN_BY : a.kind === 'agent' ? `agent:${a.agentId}` : `user:${a.userId}`);

// ---------------------------------------------------------------------------
// Definition

export function definePlanActor(options: PlanActorOptions = {}) {
    const now = options.now ?? Date.now;
    const audit = options.audit ?? auditPort();
    const projects = options.projects ?? workspacePlanProjects;
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? sameWorkspace;

    type Ctx = ActorContext<PlanState>;

    const record = async (ctx: Ctx, changes: readonly PlanChange[], at: number): Promise<void> => {
        const s = ctx.state;
        for (const c of changes) {
            const seq = ++s.auditSeq;
            const data = {
                projectId: s.projectId,
                op: c.op,
                ...(c.planId !== undefined ? { planId: c.planId } : {}),
                ...(c.itemId !== undefined ? { itemId: c.itemId } : {}),
                ...(c.actor ? { actor: { ...c.actor } } : {})
            };
            await audit.record(ctx, s.workspaceId, {
                key: `${ctx.key}:${seq}`,
                at,
                by: byOf(c.actor),
                summary: c.summary,
                ...(c.actor?.kind === 'agent' ? { agentId: c.actor.agentId } : {}),
                ...(c.op === 'lease-expired' ? { kind: 'plan.lease-expired' as const, data } : { kind: 'plan.changed' as const, data })
            });
        }
    };

    /** Save, re-arm the lease reminder for the next lease end, then audit — all inside the turn. */
    const commit = async (ctx: Ctx, changes: readonly PlanChange[], at: number): Promise<void> => {
        const s = ctx.state;
        const due = nextLeaseEnd(s);
        // Re-arm only when the next end moved earlier (or there is none left): a renewal moves it later, and a
        // reminder that fires early just re-arms from `onReminder` — so a busy agent does not re-arm on every call.
        const rearm = due === undefined ? s.leaseAlarm !== undefined : s.leaseAlarm === undefined || due < s.leaseAlarm;
        if (rearm) {
            if (due === undefined) delete s.leaseAlarm;
            else s.leaseAlarm = due;
        }
        await ctx.save();
        if (rearm) {
            if (due === undefined) await ctx.reminders.clear(PLAN_LEASE_REMINDER);
            else await ctx.reminders.set(PLAN_LEASE_REMINDER, { due: Math.max(0, due - at) });
        }
        await record(ctx, changes, at);
    };

    const toServerError = (error: unknown): never => {
        if (error instanceof PlanRuleError) throw new ServerFnError(error.status, error.message, { code: error.code });
        throw error;
    };

    return defineActor({
        type: PLAN_TYPE,
        authorize,
        ...(options.allowAnonymous ? { allowAnonymous: true as const } : {}),
        state: (key): PlanState => {
            // A malformed key is refused by the methods, not here: a throwing factory is an opaque activation failure.
            const parsed = parsePlanKey(key);
            return { ...emptyBook(parsed?.workspaceId ?? ('' as WorkspaceId), parsed?.projectId ?? ('' as ProjectId)), auditSeq: 0 };
        },
        methods: (ctx) => {
            const requireKey = (): void => {
                if (parsePlanKey(ctx.key) === null) throw new ServerFnError(400, `[plan] key must be "{ws}:plan:{projectId}", got "${ctx.key}"`);
            };

            /** The call context: who, when, and the project's manager and limits. */
            const callOf = async (actor: PlanActor | null): Promise<PlanCall> => {
                const s = ctx.state;
                const project = await projects.project(ctx, s.workspaceId, s.projectId).catch(() => undefined);
                const members = project?.members;
                return {
                    now: now(),
                    actor,
                    manager: members?.coordinator ?? null,
                    members: members?.agentIds ?? [],
                    limitOf: (agentId: AgentId) => (project ? memberLimit(project, agentId) : 1)
                };
            };

            /**
             * Run one rule for the caller: expire the leases that ran out, renew the caller's, apply, commit. A refused
             * rule still commits the expiry and renewal, so a lease runs out (and the manager hears of it) either way.
             */
            const write = async <T>(rule: (book: PlanBook, call: PlanCall) => Outcome<T>): Promise<T> => {
                requireKey();
                const actor = principalActor(ctx.principal as Principal | null);
                if (!actor) throw new ServerFnError(403, '[plan] a plan change needs an agent or a person');
                const call = await callOf(actor);
                const s = ctx.state;
                const changes: PlanChange[] = [...expireLeases(s, call)];
                renewLeases(s, call);
                try {
                    const out = rule(s, call);
                    changes.push(...out.changes);
                    await commit(ctx, changes, call.now);
                    return out.value;
                } catch (error) {
                    await commit(ctx, changes, call.now);
                    return toServerError(error);
                }
            };

            /** A read also expires and renews: an agent reading its plan is still on its items. */
            const read = async <T>(fn: (book: PlanBook, call: PlanCall) => T): Promise<T> => {
                requireKey();
                const call = await callOf(principalActor(ctx.principal as Principal | null));
                const s = ctx.state;
                const changes = expireLeases(s, call);
                const renewed = renewLeases(s, call);
                try {
                    return fn(s, call);
                } catch (error) {
                    return toServerError(error);
                } finally {
                    if (changes.length || renewed) await commit(ctx, changes, call.now);
                }
            };

            return {
                /** A new plan, optionally with its phases and items. Project manager and people. */
                async create(input: PlanCreateInput): Promise<Plan> {
                    return write((b, c) => {
                        const out = createPlan(b, c, input);
                        return { value: planView(b, out.value, c.now), changes: out.changes };
                    });
                },

                async addPhase(planId: string, title: string): Promise<Plan> {
                    return write((b, c) => {
                        const out = addPhase(b, c, planId, title);
                        return { value: planView(b, planOf(b, planId), c.now), changes: out.changes };
                    });
                },

                /** Add items to a plan's phase. Project manager and people. */
                async add(planId: string, phase: number, items: readonly PlanItemInput[]): Promise<PlanItem[]> {
                    return write((b, c) => {
                        const out = addItems(b, c, planId, phase, items);
                        return { value: out.value.map((i) => itemView(b, i, c.now)), changes: out.changes };
                    });
                },

                /** Split an item into parts in its place. Project manager and people. */
                async split(itemId: number, parts: readonly PlanItemInput[]): Promise<PlanItem[]> {
                    return write((b, c) => {
                        const out = splitItem(b, c, itemId, parts);
                        return { value: out.value.map((i) => itemView(b, i, c.now)), changes: out.changes };
                    });
                },

                /** Put an item in a queue at `index` (or move it within one), or `null` back to the open pool. Project manager and people. */
                async assign(itemId: number, to: PlanActor | null, index?: number): Promise<PlanItem> {
                    return write((b, c) => {
                        const out = assign(b, c, itemId, to, index);
                        return { value: itemView(b, out.value, c.now), changes: out.changes };
                    });
                },

                /** The calling agent starts an item under a lease. Refused if blocked, taken, someone else's, or over its limit. */
                async claim(itemId: number, claimOptions?: ClaimOptions): Promise<PlanClaimResult> {
                    return write((b, c) => {
                        const out = claim(b, c, itemId, claimOptions ?? {});
                        return { value: { item: itemView(b, out.value.item, c.now), warnings: out.value.warnings }, changes: out.changes };
                    });
                },

                /** Tick done-when lines, add a note, change the state; `done` is a person's. */
                async update(itemId: number, patch: PlanItemPatch): Promise<PlanItem> {
                    return write((b, c) => {
                        const out = update(b, c, itemId, patch);
                        return { value: itemView(b, out.value, c.now), changes: out.changes };
                    });
                },

                /** Attach a ref (object or its text form). */
                async ref(itemId: number, ref: Ref | string): Promise<PlanItem> {
                    return write((b, c) => {
                        const out = addRef(b, c, itemId, ref);
                        return { value: itemView(b, out.value, c.now), changes: out.changes };
                    });
                },

                /** Release an item with a note: to the top of `to`'s queue, or `null` to the open pool. */
                async handoff(itemId: number, to: PlanActor | null, note: string): Promise<PlanItem> {
                    return write((b, c) => {
                        const out = handoff(b, c, itemId, to === null ? null : checkActor(to), note);
                        return { value: itemView(b, out.value, c.now), changes: out.changes };
                    });
                },

                /** Renew the calling agent's leases (any plan call does too). Returns how many it holds. */
                async renew(): Promise<number> {
                    return write((b, c) => ({ value: renewLeases(b, c), changes: [] }));
                },

                /** Every plan of the project, phases and items in order. */
                async list(): Promise<PlanListView> {
                    return read((b, c) => ({ projectId: b.projectId, plans: Object.values(b.plans).map((p) => planView(b, p, c.now)) }));
                },

                async get(planId: string): Promise<Plan> {
                    return read((b, c) => planView(b, planOf(b, planId), c.now));
                },

                /**
                 * What `agentId` (default: the calling agent) should take next: its queue in order, then the open pool, each
                 * claimable and clear of other agents' touches — or `null`.
                 */
                async next(agentId?: AgentId): Promise<PlanItem | null> {
                    return read((b, c) => {
                        const id = agentId ?? (c.actor?.kind === 'agent' ? c.actor.agentId : undefined);
                        if (id === undefined || typeof id !== 'string') throw new PlanRuleError('invalid', 'name the agent to find the next item for');
                        const item = nextFor(b, c, id);
                        return item ? itemView(b, item, c.now) : null;
                    });
                },

                /** Every item not done, with its plan and phase — the Work view's plan rows (K1). */
                async openItems(): Promise<OpenPlanItem[]> {
                    return read((b, c) => openItems(b, c.now));
                },

                /** Take the caller's notices (lease ran out, touches overlap, handoffs), oldest first. */
                async takeNotices(): Promise<PlanNotice[]> {
                    return write((b, c) => ({ value: takeNotices(b, c.actor!), changes: [] }));
                }
            };
        },

        onReminder: async (ctx, name) => {
            if (name !== PLAN_LEASE_REMINDER || parsePlanKey(ctx.key) === null) return;
            const s = ctx.state;
            const project = await projects.project(ctx, s.workspaceId, s.projectId).catch(() => undefined);
            const call: PlanCall = { now: now(), actor: null, manager: project?.members.coordinator ?? null, members: project?.members.agentIds ?? [], limitOf: () => 1 };
            const changes = expireLeases(s, call);
            // Force a re-arm: the reminder that fired is spent.
            delete s.leaseAlarm;
            await commit(ctx, changes, call.now);
        }
    });
}

/** The Plan actor's definition type (core's `PlanActor` is who acts on a plan). */
export type PlanStoreActor = ReturnType<typeof definePlanActor>;
