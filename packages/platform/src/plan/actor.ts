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
 * Notices (lease ran out, touches overlap, handoffs) wake their addressee once the turn is saved (#938, `wake.ts`): a
 * chat message addressed to an agent, an Inbox row for a person; one that reaches nobody waits on the actor until its
 * addressee takes it (`takeNotices`, which the plan tools do on each call).
 *
 * The Plan feature's project settings are enforced here (#938, `settings.ts`): `claimLimit` (a member's own limit
 * overriding it), `leaseMinutes`, `agentsMayTick`, and `starter` for a new plan given no phases. A merged pull request
 * marks the items handed off from its task done (`pullMerged`, called by the Pulls actor).
 *
 * Accepted requests (#943): what an item waits on is the manager's and people's to change, with one exception — the
 * manager of another project accepting a request that names the item may add that one wait on the item the accept
 * filed (`after`, checked against the other project's record and the new item's refs; see `acceptedLink`).
 *
 * Every change is a line in the item's activity and a `plan.changed` / `plan.lease-expired` audit record with
 * its actor. Workers eviction rule: every mutation ends in `ctx.save()` inside the turn.
 */
import { type AgentId, type ChatId, type Plan, type PlanActor, type PlanItem, type PlanItemState, type Principal, type ProjectId, type ProjectRecord, type Ref, type TaskId, type WorkspaceId } from '@agentic/core';
import { defineActor, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { auditPort, type AuditPort } from '../audit/port.js';
import { sameWorkspace, workspaceKey } from '../auth/index.js';
import { Workspace } from '../workspace/index.js';
import { parsePlanKey, planKey, PLAN_TYPE } from './key.js';
import {
    crossAfterOf,
    crossRefsByProject,
    linkedClaimRefusal,
    linkedItemView,
    linkedPlanView,
    linkProjectInfo,
    linkSource,
    lookupOf,
    parseAfter,
    resolveProject,
    setAfter,
    setCrossAfter,
    type CrossAfter,
    type ItemLookup,
    type LinkedItemInput,
    type LinkItemInput,
    type LinkProjectInfo
} from './links.js';
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
    isManager,
    nextFor,
    pullMerged,
    nextLeaseEnd,
    openItems,
    planOf,
    planView,
    PlanRuleError,
    renewLeases,
    splitItem,
    takeNotices,
    update,
    viewState,
    AFTER_MAX,
    type ClaimOptions,
    type HandoffOptions,
    type OpenPlanItem,
    type Outcome,
    type PlanBook,
    type PlanCall,
    type PlanChange,
    type PlanCreateInput,
    type PlanItemInput,
    type PlanItemPatch,
    type PlanNotice,
    type StoredItem,
    type TouchesWarning
} from './rules.js';
import { planLimitOf, planSettings } from './settings.js';
import { chatPlanWake, type PlanWakePort } from './wake.js';

// ---------------------------------------------------------------------------
// State and options

export interface PlanState extends PlanBook {
    /** Audit records written so far — the idempotency key's counter. */
    auditSeq: number;
    /** When the lease reminder is armed for; absent when none is. */
    leaseAlarm?: number;
}

/** What the actor reads of a project: its manager, members and limits, and the Plan feature's settings. */
export type PlanProjectInfo = Pick<ProjectRecord, 'id' | 'members'> & Partial<Pick<ProjectRecord, 'features'>>;

/** Where the actor reads the project's manager, members, limits and Plan settings. */
export interface PlanProjectPort {
    project(ctx: ActorContext<PlanState>, workspaceId: WorkspaceId, projectId: ProjectId): Promise<PlanProjectInfo | undefined>;
}

/** The production port: the project record on the Workspace root, over a hop. */
export const workspacePlanProjects: PlanProjectPort = {
    async project(ctx, workspaceId, projectId) {
        const projects = await ctx.actor(Workspace, workspaceKey(workspaceId)).projects();
        return projects.find((p) => p.id === projectId);
    }
};

/**
 * Where the actor reads what cross-project `after` needs (#822): the workspace's projects (to resolve `project#n`)
 * and the states of other projects' items (to block on them). Both default to the real thing — the Workspace record
 * and a hop to the other project's Plan actor.
 */
export interface PlanLinksPort {
    projects?(ctx: ActorContext<PlanState>, workspaceId: WorkspaceId): Promise<readonly LinkProjectInfo[]>;
    /** The view states of items `ns` of project `projectId`, by number; a missing number is unknown. */
    states?(ctx: ActorContext<PlanState>, workspaceId: WorkspaceId, projectId: ProjectId, ns: readonly number[]): Promise<Readonly<Record<string, PlanItemState>>>;
}

export interface PlanActorOptions {
    /** Default: the Workspace record (`workspacePlanProjects`). */
    readonly projects?: PlanProjectPort;
    /** Cross-project `after` (#822). Default: the Workspace's projects and the other projects' Plan actors. */
    readonly links?: PlanLinksPort;
    /** Clock; default `Date.now`. */
    readonly now?: () => number;
    /** Override the policy chain. Default: the package's `sameWorkspace`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
    /** Waive the identity gate (tests). */
    readonly allowAnonymous?: true;
    /** Where `plan.*` records go. Default: the workspace's Audit log. */
    readonly audit?: AuditPort;
    /** How a notice wakes its addressee (#938). Default: `chatPlanWake()` — a chat message for an agent, an Inbox row for a person. */
    readonly wake?: PlanWakePort;
}

/** The most item numbers one `itemStates` call reads. */
export const ITEM_STATES_MAX = 2000;

/** The reminder the lease expiry runs under. */
export const PLAN_LEASE_REMINDER = 'lease';
/** Who the lease alarm's records are by. */
export const PLAN_BY = 'system:plan';

/** What `claim` returns: the item and any touches clash with another agent's live claim. */
export interface PlanClaimResult {
    readonly item: PlanItem;
    readonly warnings: readonly TouchesWarning[];
}

/** Every item as the link graph reads it (`workspaceLinks`), from `linkItems`. */
export type PlanLinkItems = LinkItemInput[];

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

const labelOf = (a: PlanActor): string => (a.kind === 'agent' ? `agent:${a.agentId}` : `user:${a.userId}`);

/** Over the wire nobody calls it: the Pulls actor reaches `pullMerged` through `ctx.actor`, which runs no policy. */
const never: ActorPolicy = () => false;

/** The call context for `project` (absent: no manager, no members, every default). */
function planCallOf(project: PlanProjectInfo | undefined, at: number, actor: PlanActor | null): PlanCall {
    const settings = planSettings(project);
    return {
        now: at,
        actor,
        manager: project?.members.coordinator ?? null,
        members: project?.members.agentIds ?? [],
        limitOf: (agentId: AgentId) => (project ? planLimitOf(project, agentId) : 1),
        leaseMs: settings.leaseMs,
        agentsMayTick: settings.agentsMayTick,
        ...(settings.starter ? { starter: settings.starter } : {})
    };
}

/**
 * Whether `after` (parsed) keeps everything `item` waits on — its own items and other projects' — and adds only
 * `link` (#943).
 */
function onlyAdds(item: StoredItem, after: { readonly local: readonly number[]; readonly cross: readonly CrossAfter[] }, link: CrossAfter): boolean {
    const local = new Set(after.local);
    if (local.size !== item.after.length || !item.after.every((n) => local.has(n))) return false;
    const want = new Set([...crossAfterOf(item), link].map((a) => `${a.projectId}#${a.n}`));
    const got = new Set(after.cross.map((a) => `${a.projectId}#${a.n}`));
    return got.size === want.size && [...want].every((k) => got.has(k));
}

// ---------------------------------------------------------------------------
// Definition

export function definePlanActor(options: PlanActorOptions = {}) {
    const now = options.now ?? Date.now;
    const audit = options.audit ?? auditPort();
    const projects = options.projects ?? workspacePlanProjects;
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? sameWorkspace;
    const wakePort = options.wake ?? chatPlanWake();

    type Ctx = ActorContext<PlanState>;

    /** This definition, for the hop to another project's Plan actor; set once `defineActor` returns. */
    let self: AnyActorDefinition | undefined;
    type StatesClient = { itemStates(ns: readonly number[]): Promise<Record<string, PlanItemState>> };
    type RefsClient = { itemRefs(n: number): Promise<readonly Ref[]> };
    const linkProjects = async (ctx: Ctx, workspaceId: WorkspaceId): Promise<readonly LinkProjectInfo[]> =>
        options.links?.projects ? options.links.projects(ctx, workspaceId) : (await ctx.actor(Workspace, workspaceKey(workspaceId)).projects()).map(linkProjectInfo);
    const linkStates = async (ctx: Ctx, workspaceId: WorkspaceId, projectId: ProjectId, ns: readonly number[]): Promise<Readonly<Record<string, PlanItemState>>> =>
        options.links?.states ? options.links.states(ctx, workspaceId, projectId, ns) : (ctx.actor(self!, planKey(workspaceId, projectId)) as unknown as StatesClient).itemStates(ns);

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

    /** What a turn remembers to wake its addressees: the first new notice, the caller, and the tasks on the items before. */
    interface Turn {
        readonly from: number;
        readonly caller: PlanActor | null;
        readonly callerTask?: TaskId;
        readonly tasks: ReadonlyMap<number, TaskId>;
    }
    const turnOf = (ctx: Ctx, caller: PlanActor | null): Turn => {
        const tasks = new Map<number, TaskId>();
        for (const i of Object.values(ctx.state.items)) {
            const t = i.claim?.taskId ?? i.handedOff?.taskId ?? i.finishedClaim?.taskId;
            if (t !== undefined) tasks.set(i.id, t);
        }
        const p = ctx.principal as Principal | null;
        return { from: ctx.state.nextNotice, caller, ...(p?.kind === 'agent' && p.taskId ? { callerTask: p.taskId } : {}), tasks };
    };

    /**
     * Wake the addressees of the notices this turn left (#938), each once, the caller excepted (its plan tools take
     * them in-band). Woken notices leave the actor. Never a gate: a failure leaves them waiting.
     */
    const wakeAddressees = async (ctx: Ctx, turn: Turn): Promise<void> => {
        const s = ctx.state;
        const fresh = s.notices.filter((n) => n.seq >= turn.from && !(turn.caller && labelOf(n.to) === labelOf(turn.caller)));
        if (!fresh.length) return;
        const byTo = new Map<string, PlanNotice[]>();
        for (const n of fresh) byTo.set(labelOf(n.to), [...(byTo.get(labelOf(n.to)) ?? []), n]);
        const woken = new Set<number>();
        for (const notices of byTo.values()) {
            const tasks: TaskId[] = [];
            const chats: ChatId[] = [];
            const add = <T,>(into: T[], v: T | undefined): void => {
                if (v !== undefined && !into.includes(v)) into.push(v);
            };
            for (const n of notices) {
                for (const id of [n.itemId, n.otherItemId]) {
                    if (id === undefined) continue;
                    const item = s.items[String(id)];
                    add(tasks, item?.claim?.taskId ?? item?.handedOff?.taskId ?? turn.tasks.get(id));
                    add(chats, item ? s.plans[item.planId]?.originChatId : undefined);
                }
            }
            add(tasks, turn.callerTask);
            try {
                if (await wakePort.wake({ workspaceId: s.workspaceId, projectId: s.projectId, to: notices[0]!.to, notices, tasks, chats })) for (const n of notices) woken.add(n.seq);
            } catch (error) {
                console.warn(`[plan] waking ${labelOf(notices[0]!.to)} failed:`, error);
            }
        }
        if (!woken.size) return;
        s.notices = s.notices.filter((n) => !woken.has(n.seq));
        await ctx.save();
    };

    /** Save, re-arm the lease reminder for the next lease end, audit, then wake the notices' addressees — all inside the turn. */
    const commit = async (ctx: Ctx, changes: readonly PlanChange[], at: number, turn?: Turn): Promise<void> => {
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
        if (turn) await wakeAddressees(ctx, turn);
    };

    const toServerError = (error: unknown): never => {
        if (error instanceof PlanRuleError) throw new ServerFnError(error.status, error.message, { code: error.code });
        throw error;
    };

    const definition = defineActor({
        type: PLAN_TYPE,
        authorize,
        methodAuthorize: { pullMerged: never },
        // The cross-project reads never wait behind a turn: a Plan actor mid-claim reads another that may be reading it.
        methodReentrancy: { itemStates: 'always', itemRefs: 'always', linkItems: 'always' },
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
                return planCallOf(project, now(), actor);
            };

            /**
             * Run one rule for the caller: expire the leases that ran out, renew the caller's, apply, commit. A refused
             * rule still commits the expiry and renewal, so a lease runs out (and the manager hears of it) either way.
             */
            const write = async <T>(rule: (book: PlanBook, call: PlanCall) => Outcome<T>): Promise<T> => {
                requireKey();
                const actor = principalActor(ctx.principal as Principal | null);
                if (!actor) throw new ServerFnError(403, '[plan] a plan change needs an agent or a person');
                return writeAs(actor, rule);
            };

            /** `write` as `actor` (`null`: the platform itself). */
            const writeAs = async <T,>(actor: PlanActor | null, rule: (book: PlanBook, call: PlanCall) => Outcome<T>): Promise<T> => {
                const call = await callOf(actor);
                const s = ctx.state;
                const turn = turnOf(ctx, actor);
                const changes: PlanChange[] = [...expireLeases(s, call)];
                renewLeases(s, call);
                try {
                    const out = rule(s, call);
                    changes.push(...out.changes);
                    await commit(ctx, changes, call.now, turn);
                    return out.value;
                } catch (error) {
                    await commit(ctx, changes, call.now, turn);
                    return toServerError(error);
                }
            };

            /** A read also expires and renews: an agent reading its plan is still on its items. */
            const read = async <T>(fn: (book: PlanBook, call: PlanCall) => T): Promise<T> => {
                requireKey();
                const actor = principalActor(ctx.principal as Principal | null);
                const call = await callOf(actor);
                const s = ctx.state;
                const turn = turnOf(ctx, actor);
                const changes = expireLeases(s, call);
                const renewed = renewLeases(s, call);
                try {
                    return fn(s, call);
                } catch (error) {
                    return toServerError(error);
                } finally {
                    if (changes.length || renewed) await commit(ctx, changes, call.now, turn);
                }
            };

            /**
             * What the items wait on in other projects, read from those projects' Plan actors — before the rule runs, as
             * the rules are pure. A project that cannot be read leaves its items unknown (not done).
             */
            const lookupFor = async (items: Iterable<StoredItem | undefined>): Promise<ItemLookup> => {
                const byProject = crossRefsByProject([...items].filter((i): i is StoredItem => !!i));
                if (!byProject.size) return () => undefined;
                const ws = ctx.state.workspaceId;
                const states = new Map<ProjectId, Readonly<Record<string, PlanItemState>>>();
                await Promise.all(
                    [...byProject].map(async ([projectId, ns]) => {
                        // In batches `itemStates` takes; a batch that cannot be read leaves its items unknown.
                        const batches: number[][] = [];
                        for (let i = 0; i < ns.length; i += ITEM_STATES_MAX) batches.push(ns.slice(i, i + ITEM_STATES_MAX));
                        const read = await Promise.all(batches.map((batch) => linkStates(ctx, ws, projectId, batch).catch(() => ({}))));
                        states.set(projectId, Object.assign({}, ...read));
                    })
                );
                return lookupOf(states);
            };
            const allItems = () => Object.values(ctx.state.items);
            /** The workspace's projects, when the call names another project's item (else none are read). */
            const projectsFor = async (needed: boolean): Promise<readonly LinkProjectInfo[]> => (needed ? linkProjects(ctx, ctx.state.workspaceId).catch(() => []) : []);
            const mentionsProject = (values: unknown): boolean => Array.isArray(values) && values.some((v) => typeof v !== 'number');
            /** Stored items as views, their cross-project waits applied. */
            const viewsOf = async (items: readonly StoredItem[]): Promise<PlanItem[]> => {
                const lookup = await lookupFor(items);
                const at = now();
                return items.map((i) => linkedItemView(ctx.state, i, at, lookup));
            };
            const viewOf = async (item: StoredItem): Promise<PlanItem> => (await viewsOf([item]))[0]!;

            /**
             * The one wait an accept in another project may set on this project's item (#943): the caller is an agent,
             * `after` keeps everything the item waits on and adds exactly one other project's item, the caller manages
             * that project (`pm.agentId`, else its coordinator — the Requests actor's rule), and that item names this
             * one among its refs (an accepted request's refs are copied onto the item it became). `null` otherwise —
             * the ordinary rule then decides. Read before the turn: the rules are pure.
             */
            const acceptedLink = async (itemId: number, values: readonly unknown[], projectList: readonly LinkProjectInfo[]): Promise<(CrossAfter & { by: AgentId }) | null> => {
                const caller = principalActor(ctx.principal as Principal | null);
                const s = ctx.state;
                const stored = Number.isSafeInteger(itemId) ? s.items[String(itemId)] : undefined;
                if (caller?.kind !== 'agent' || !stored || !projectList.length) return null;
                let parsed: ReturnType<typeof parseAfter>;
                try {
                    parsed = parseAfter(values, s.projectId, projectList);
                } catch {
                    return null;
                }
                const had = new Set(crossAfterOf(stored).map((a) => `${a.projectId}#${a.n}`));
                const added = parsed.cross.filter((a) => !had.has(`${a.projectId}#${a.n}`));
                if (added.length !== 1 || !onlyAdds(stored, parsed, added[0]!)) return null;
                const link = added[0]!;
                try {
                    const from = (await projects.project(ctx, s.workspaceId, link.projectId)) as (PlanProjectInfo & Partial<Pick<ProjectRecord, 'pm'>>) | undefined;
                    if (!from || (from.pm?.agentId ?? from.members.coordinator ?? null) !== caller.agentId) return null;
                    const refs = await (ctx.actor(self!, planKey(s.workspaceId, link.projectId)) as unknown as RefsClient).itemRefs(link.n);
                    const names = refs.some((r) => r.kind === 'project-item' && r.n === stored.id && resolveProject(r.project, projectList) === s.projectId);
                    return names ? { ...link, by: caller.agentId } : null;
                } catch {
                    return null;
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
                    const lookup = await lookupFor(allItems());
                    return write((b, c) => {
                        const out = addPhase(b, c, planId, title);
                        return { value: linkedPlanView(b, planOf(b, planId), c.now, lookup), changes: out.changes };
                    });
                },

                /** Add items to a plan's phase; `after` may name other projects' items (`project#n`). Project manager and people. */
                async add(planId: string, phase: number, items: readonly LinkedItemInput[]): Promise<PlanItem[]> {
                    const projectList = await projectsFor(Array.isArray(items) && items.some((i) => mentionsProject(i?.after)));
                    const stored = await write((b, c) => {
                        const { inputs, cross } = splitAfter(b, items, projectList);
                        const out = addItems(b, c, planId, phase, inputs);
                        const changes = [...out.changes];
                        out.value.forEach((item, k) => {
                            if (cross[k]!.length) changes.push(...setCrossAfter(b, c, item.id, cross[k]!, projectList).changes);
                        });
                        return { value: out.value, changes };
                    });
                    return viewsOf(stored);
                },

                /**
                 * Split an item into parts in its place; `after` may name other projects' items. Each part also waits on
                 * what the original waited on in other projects. Project manager and people.
                 */
                async split(itemId: number, parts: readonly LinkedItemInput[]): Promise<PlanItem[]> {
                    const projectList = await projectsFor(Array.isArray(parts) && parts.some((i) => mentionsProject(i?.after)));
                    const stored = await write((b, c) => {
                        const original = b.items[String(itemId)];
                        const inherited = original ? crossAfterOf(original) : [];
                        const { inputs, cross } = splitAfter(b, parts, projectList);
                        const joined = cross.map((own) => dedupe([...inherited, ...own]));
                        // Checked before anything changes: a refusal after the split would leave half of it saved.
                        inputs.forEach((input, k) => {
                            if (new Set([...(original?.after ?? []), ...(input.after ?? [])]).size + joined[k]!.length > AFTER_MAX) throw new PlanRuleError('invalid', `after holds at most ${AFTER_MAX}`);
                        });
                        const out = splitItem(b, c, itemId, inputs);
                        const changes = [...out.changes];
                        // An inherited wait names a project `parseAfter` did not resolve this call: known by its id.
                        const known = [...projectList, ...inherited.filter((a) => !projectList.some((p) => p.id === a.projectId)).map((a): LinkProjectInfo => ({ id: a.projectId, name: a.projectId }))];
                        out.value.forEach((item, k) => {
                            if (joined[k]!.length) changes.push(...setCrossAfter(b, c, item.id, joined[k]!, known).changes);
                        });
                        return { value: out.value, changes };
                    });
                    return viewsOf(stored);
                },

                /**
                 * Replace everything an item waits on: numbers or `#n` for this project's items, `project#n` for another
                 * project's (#822; PRJ-17). Project manager and people.
                 */
                async after(itemId: number, values: readonly (number | string | Ref)[]): Promise<PlanItem> {
                    const projectList = await projectsFor(mentionsProject(values));
                    const vouched = await acceptedLink(itemId, values, projectList);
                    const item = await write((b, c) => {
                        const parsed = parseAfter(values, b.projectId, projectList);
                        // An accepting manager of another project sets this one wait, nothing else (#943).
                        const stored = b.items[String(itemId)];
                        const call = vouched && !isManager(c) && c.actor?.kind === 'agent' && c.actor.agentId === vouched.by && stored && onlyAdds(stored, parsed, vouched) ? { ...c, manager: vouched.by } : c;
                        return setAfter(b, call, itemId, parsed, projectList);
                    });
                    return viewOf(item);
                },

                /** Put an item in a queue at `index` (or move it within one), or `null` back to the open pool. Project manager and people. */
                async assign(itemId: number, to: PlanActor | null, index?: number): Promise<PlanItem> {
                    return viewOf(await write((b, c) => assign(b, c, itemId, to, index)));
                },

                /** The calling agent starts an item under a lease. Refused if blocked, taken, someone else's, or over its limit. */
                async claim(itemId: number, claimOptions?: ClaimOptions): Promise<PlanClaimResult> {
                    // Refused too while an item in another project it waits on is unfinished (#822).
                    const target = Number.isSafeInteger(itemId) ? ctx.state.items[String(itemId)] : undefined;
                    const lookup = await lookupFor([target]);
                    const projectList = await projectsFor(!!target && crossAfterOf(target).length > 0);
                    const out = await write((b, c) => {
                        const item = b.items[String(itemId)];
                        if (item && c.actor?.kind === 'agent') {
                            const refusal = linkedClaimRefusal(b, c, c.actor.agentId, item, lookup, projectList);
                            // Only the cross-project wait is refused here; every other refusal is `claim`'s own.
                            if (refusal?.code === 'blocked') throw refusal;
                        }
                        return claim(b, c, itemId, claimOptions ?? {});
                    });
                    return { item: await viewOf(out.item), warnings: out.warnings };
                },

                /** Tick done-when lines, add a note, change the state; `done` is a person's. */
                async update(itemId: number, patch: PlanItemPatch): Promise<PlanItem> {
                    return viewOf(await write((b, c) => update(b, c, itemId, patch)));
                },

                /** Attach a ref (object or its text form). */
                async ref(itemId: number, ref: Ref | string): Promise<PlanItem> {
                    return viewOf(await write((b, c) => addRef(b, c, itemId, ref)));
                },

                /**
                 * Release an item with a note: to the top of `to`'s queue, or `null` to the open pool. `handoffOptions.taskId`
                 * is the task it is handed off from (default the claim's): when that task's pull request merges, it is done.
                 */
                async handoff(itemId: number, to: PlanActor | null, note: string, handoffOptions?: HandoffOptions): Promise<PlanItem> {
                    return viewOf(await write((b, c) => handoff(b, c, itemId, to === null ? null : checkActor(to), note, handoffOptions ?? {})));
                },

                /**
                 * A pull request of the project merged (#938): the items handed off from its task, or naming it among
                 * their refs, are done. The Pulls actor's hop only (`methodAuthorize: never` over the wire).
                 */
                async pullMerged(pr: { readonly number: number; readonly taskId?: TaskId }): Promise<number[]> {
                    requireKey();
                    // A project with no plan items stores nothing for a merge (every project's merges come here).
                    if (!Object.keys(ctx.state.items).length) return [];
                    const done = await writeAs(null, (b, c) => pullMerged(b, c, pr));
                    return done.map((i) => i.id);
                },

                /** Renew the calling agent's leases (any plan call does too). Returns how many it holds. */
                async renew(): Promise<number> {
                    return write((b, c) => ({ value: renewLeases(b, c), changes: [] }));
                },

                /** Every plan of the project, phases and items in order. */
                async list(): Promise<PlanListView> {
                    const lookup = await lookupFor(allItems());
                    return read((b, c) => ({ projectId: b.projectId, plans: Object.values(b.plans).map((p) => linkedPlanView(b, p, c.now, lookup)) }));
                },

                async get(planId: string): Promise<Plan> {
                    const lookup = await lookupFor(allItems());
                    return read((b, c) => linkedPlanView(b, planOf(b, planId), c.now, lookup));
                },

                /**
                 * What `agentId` (default: the calling agent) should take next: its queue in order, then the open pool, each
                 * claimable and clear of other agents' touches — or `null`.
                 */
                async next(agentId?: AgentId): Promise<PlanItem | null> {
                    const lookup = await lookupFor(allItems());
                    return read((b, c) => {
                        const id = agentId ?? (c.actor?.kind === 'agent' ? c.actor.agentId : undefined);
                        if (id === undefined || typeof id !== 'string') throw new PlanRuleError('invalid', 'name the agent to find the next item for');
                        const item = nextFor(b, c, id, (i) => linkedClaimRefusal(b, c, id, i, lookup));
                        return item ? linkedItemView(b, item, c.now, lookup) : null;
                    });
                },

                /** Every item not done, with its plan and phase — the Work view's plan rows (K1). */
                async openItems(): Promise<OpenPlanItem[]> {
                    const lookup = await lookupFor(allItems());
                    return read((b, c) => openItems(b, c.now).map((o) => ({ ...o, item: linkedItemView(b, b.items[String(o.item.id)]!, c.now, lookup) })));
                },

                /**
                 * The view states of items `ns` (their own `after` applied, not their cross-project waits) — how another
                 * project's Plan actor reads whether what it waits on is done (#822). Pure read: no lease is touched.
                 */
                async itemStates(ns: readonly number[]): Promise<Record<string, PlanItemState>> {
                    requireKey();
                    if (!Array.isArray(ns) || ns.length > ITEM_STATES_MAX) throw new ServerFnError(400, '[plan] itemStates takes a list of item numbers');
                    const at = now();
                    const out: Record<string, PlanItemState> = {};
                    for (const n of ns) {
                        const item = Number.isSafeInteger(n) ? ctx.state.items[String(n)] : undefined;
                        if (item) out[String(n)] = viewState(ctx.state, item, at);
                    }
                    return out;
                },

                /**
                 * The refs of item `n` (none when there is no such item) — how another project's Plan actor checks that an
                 * accepted request's item names the item it is about to wait on (#943). Pure read: no lease is touched.
                 */
                async itemRefs(n: number): Promise<Ref[]> {
                    requireKey();
                    const item = Number.isSafeInteger(n) ? ctx.state.items[String(n)] : undefined;
                    return item ? item.refs.map((r) => ({ ...r })) : [];
                },

                /** Every item as the workspace's link graph reads it (`workspaceLinks`). Pure read: no lease is touched. */
                async linkItems(): Promise<PlanLinkItems> {
                    requireKey();
                    return [...linkSource(ctx.state, { id: ctx.state.projectId, name: ctx.state.projectId }, now()).items];
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
            const call = planCallOf(project, now(), null);
            const turn = turnOf(ctx, null);
            const changes = expireLeases(s, call);
            // Force a re-arm: the reminder that fired is spent.
            delete s.leaseAlarm;
            await commit(ctx, changes, call.now, turn);
        }
    });
    self = definition as unknown as AnyActorDefinition;
    return definition;
}

/** Split each item's `after` into this project's numbers (for the rules) and other projects' items. */
function splitAfter(book: PlanBook, items: readonly LinkedItemInput[], projects: readonly LinkProjectInfo[]): { inputs: PlanItemInput[]; cross: CrossAfter[][] } {
    if (!Array.isArray(items)) throw new PlanRuleError('invalid', 'items must be a list');
    const inputs: PlanItemInput[] = [];
    const cross: CrossAfter[][] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object' || item.after === undefined) {
            inputs.push(item as PlanItemInput);
            cross.push([]);
            continue;
        }
        const parsed = parseAfter(item.after, book.projectId, projects);
        inputs.push({ ...item, after: parsed.local });
        cross.push(parsed.cross);
    }
    return { inputs, cross };
}

const dedupe = (refs: readonly CrossAfter[]): CrossAfter[] => [...new Map(refs.map((a) => [`${a.projectId}#${a.n}`, a])).values()];

/** The Plan actor's definition type (core's `PlanActor` is who acts on a plan). */
export type PlanStoreActor = ReturnType<typeof definePlanActor>;
