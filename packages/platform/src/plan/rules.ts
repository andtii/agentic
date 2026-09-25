/**
 * The Plan rules (#750; PRJ-11; docs/design/projects/HANDOFF.md "Plan"): a pure book of a project's plans that every
 * Plan actor method runs through. No I/O and no clock of its own — the actor passes `now`, who is acting and the
 * project's manager and limits — so each rule is table-tested on its own (`__tests__/plan/rules.test.ts`).
 *
 * - **Assigned**: an item sits in its assignee's ordered queue; only the project manager (the project's
 *   coordinator) and people put it there, reorder it or move it.
 * - **Claimed**: an agent works it now under a lease (`PLAN_LEASE_DEFAULT_MS`) that renews on each plan call it
 *   makes; refused while the item waits on an `after` item, is claimed by someone else, sits in someone else's
 *   queue, needs a person, or the agent is at its working limit (`memberLimit`). A claimed item leaves the queue.
 * - **Lease runs out**: the item goes back to the top of its assignee's queue, never the open pool, and the
 *   manager is told.
 * - **Touches**: claiming an item whose paths overlap a live claim of another agent warns both agents and
 *   suggests an order (the item already being worked first).
 * - **Done**: when every done-when line is ticked, or a person marks it.
 * - Every change adds a line to the item's activity and yields an audit record with its actor (History).
 *
 * A stored item is `ready`, `claimed`, `needs-you`, `stuck` or `done`; `blocked` is derived for the view from
 * its unfinished `after` items. Errors are `PlanRuleError`s carrying the HTTP status the actor answers with.
 */
import {
    formatRef,
    parseRef,
    planDoneWhenMet,
    planItemWaitsOn,
    planTouchesOverlap,
    type AgentId,
    type ChatId,
    type Plan,
    type PlanActivity,
    type PlanActor,
    type PlanClaim,
    type PlanDoneWhen,
    type PlanItem,
    type PlanItemState,
    type PlanOption,
    type ProjectId,
    type Ref,
    type TaskId,
    type WorkspaceId,
    PLAN_LEASE_DEFAULT_MS
} from '@agentic/core';

// ---------------------------------------------------------------------------
// Limits

export const PLANS_MAX = 50;
export const PHASES_MAX = 50;
export const ITEMS_MAX = 2000;
export const ITEMS_PER_CALL_MAX = 100;
export const TITLE_MAX = 200;
export const TEXT_MAX = 4000;
export const DONE_WHEN_MAX = 30;
export const AFTER_MAX = 50;
export const TOUCHES_MAX = 50;
export const PATH_MAX = 500;
export const REFS_MAX = 100;
export const OPTIONS_MAX = 10;
/** Activity lines kept per item, newest last. */
export const ACTIVITY_KEPT = 100;
/** Notices kept for all addressees together; the oldest go first. */
export const NOTICES_KEPT = 500;
/** The shortest lease a claim may ask for, and the longest. */
export const LEASE_MIN_MS = 1_000;
export const LEASE_MAX_MS = 4 * 60 * 60_000;

// ---------------------------------------------------------------------------
// State

export type StoredState = Exclude<PlanItemState, 'blocked'>;

export interface StoredClaim {
    agentId: AgentId;
    leaseUntil: number;
    /** How long each renewal extends the lease. */
    leaseMs: number;
    claimedAt: number;
    taskId?: TaskId;
}

export interface StoredItem {
    id: number;
    planId: string;
    title: string;
    state: StoredState;
    assignee?: PlanActor;
    assignedBy?: PlanActor;
    claim?: StoredClaim;
    after: number[];
    touches: string[];
    refs: Ref[];
    doneWhen: PlanDoneWhen[];
    activity: PlanActivity[];
    options?: PlanOption[];
    createdAt: number;
    updatedAt: number;
}

export interface StoredPhase {
    n: number;
    title: string;
    items: number[];
}

export interface StoredPlan {
    id: string;
    title: string;
    description?: string;
    originChatId?: ChatId;
    phases: StoredPhase[];
    createdAt: number;
    createdBy: PlanActor;
}

/** Something an agent or person is told: a lease ran out, touches overlap, an item was handed to them. */
export interface PlanNotice {
    readonly seq: number;
    readonly at: number;
    readonly to: PlanActor;
    readonly kind: 'lease-expired' | 'touches' | 'handoff' | 'reassigned';
    readonly itemId: number;
    readonly text: string;
    /** `touches`: the other item and the suggested order (first to last). */
    readonly otherItemId?: number;
    readonly order?: readonly number[];
    readonly paths?: readonly string[];
}

export interface PlanBook {
    workspaceId: WorkspaceId;
    projectId: ProjectId;
    /** The next item number (`#n`), per project across its plans. */
    nextItem: number;
    /** The next plan number (`plan-n`). */
    nextPlan: number;
    plans: Record<string, StoredPlan>;
    items: Record<string, StoredItem>;
    /** Ordered queues by actor label (`agent:<id>` / `user:<id>`) — item numbers, first next. */
    queues: Record<string, number[]>;
    notices: PlanNotice[];
    nextNotice: number;
}

export function emptyBook(workspaceId: WorkspaceId, projectId: ProjectId): PlanBook {
    return { workspaceId, projectId, nextItem: 1, nextPlan: 1, plans: {}, items: {}, queues: {}, notices: [], nextNotice: 1 };
}

// ---------------------------------------------------------------------------
// Errors, actors, the call context

export type PlanErrorCode = 'invalid' | 'forbidden' | 'not-found' | 'done' | 'blocked' | 'taken' | 'assigned-elsewhere' | 'over-limit' | 'needs-person' | 'full';

const STATUS: Record<PlanErrorCode, number> = {
    invalid: 400,
    forbidden: 403,
    'not-found': 404,
    done: 409,
    blocked: 409,
    taken: 409,
    'assigned-elsewhere': 409,
    'over-limit': 409,
    'needs-person': 409,
    full: 409
};

export class PlanRuleError extends Error {
    readonly status: number;
    constructor(
        readonly code: PlanErrorCode,
        message: string
    ) {
        super(`[plan] ${message}`);
        this.name = 'PlanRuleError';
        this.status = STATUS[code];
    }
}

const fail = (code: PlanErrorCode, message: string): never => {
    throw new PlanRuleError(code, message);
};

export const actorLabel = (a: PlanActor): string => (a.kind === 'agent' ? `agent:${a.agentId}` : `user:${a.userId}`);
export const sameActor = (a: PlanActor | undefined, b: PlanActor | undefined): boolean => !!a && !!b && actorLabel(a) === actorLabel(b);
const agentActor = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });

/** What a rule needs besides the book: when, who, and the project's manager and member limits. */
export interface PlanCall {
    readonly now: number;
    /** Who is acting; `null` is the platform itself (the lease alarm). */
    readonly actor: PlanActor | null;
    /** The project's manager (`ProjectMembers.coordinator`), if any. */
    readonly manager: AgentId | null;
    /** The project's agent members. */
    readonly members: readonly AgentId[];
    /** How many items `agentId` may work on at once (`memberLimit`). */
    readonly limitOf: (agentId: AgentId) => number;
}

/** One change, for History. */
export interface PlanChange {
    readonly op: PlanOp;
    readonly actor: PlanActor | null;
    readonly planId?: string;
    readonly itemId?: number;
    readonly summary: string;
}

export type PlanOp = 'plan-created' | 'phase-added' | 'items-added' | 'split' | 'assigned' | 'claimed' | 'released' | 'updated' | 'ticked' | 'noted' | 'ref-added' | 'handed-off' | 'done' | 'lease-expired';

/** What a mutation hands back: its changes (audited by the actor) and, for a claim, the touches warnings. */
export interface Outcome<T> {
    readonly value: T;
    readonly changes: readonly PlanChange[];
}

/** A person, or the project's manager agent. */
export function isManager(call: PlanCall): boolean {
    const a = call.actor;
    return !!a && (a.kind === 'user' || (call.manager !== null && a.agentId === call.manager));
}

function requireActor(call: PlanCall): PlanActor {
    return call.actor ?? fail('forbidden', 'a plan change needs an agent or a person');
}

function requireManager(call: PlanCall, what: string): PlanActor {
    const a = requireActor(call);
    if (!isManager(call)) fail('forbidden', `only the project manager and people may ${what}`);
    return a;
}

const who = (a: PlanActor | null): string => (a === null ? 'the platform' : a.kind === 'agent' ? `@${a.agentId}` : `@${a.userId}`);

// ---------------------------------------------------------------------------
// Validation

function text(value: unknown, what: string, max: number): string {
    if (typeof value !== 'string' || !value.trim()) fail('invalid', `${what} must be text`);
    const t = (value as string).trim();
    if (t.length > max) fail('invalid', `${what} is longer than ${max} characters`);
    return t;
}

function optionalText(value: unknown, what: string, max: number): string | undefined {
    return value === undefined || value === null || value === '' ? undefined : text(value, what, max);
}

export function checkActor(value: unknown): PlanActor {
    const v = value as { kind?: unknown; agentId?: unknown; userId?: unknown } | null;
    if (v && v.kind === 'agent' && typeof v.agentId === 'string' && v.agentId.trim() && v.agentId.length <= 200) return { kind: 'agent', agentId: v.agentId as AgentId };
    if (v && v.kind === 'user' && typeof v.userId === 'string' && v.userId.trim() && v.userId.length <= 200) return { kind: 'user', userId: v.userId };
    return fail('invalid', 'an actor is {kind: "agent", agentId} or {kind: "user", userId}');
}

/** A ref as given (object or its text form), made canonical: `parseRef(formatRef(r))`. */
export function checkRef(value: unknown): Ref {
    let parsed: Ref | null = null;
    if (typeof value === 'string') parsed = value.length <= TEXT_MAX ? parseRef(value) : null;
    else if (value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string') {
        try {
            const printed = formatRef(value as Ref);
            parsed = typeof printed === 'string' && printed.length <= TEXT_MAX ? parseRef(printed) : null;
        } catch {
            parsed = null;
        }
        if (parsed && parsed.kind !== (value as Ref).kind) parsed = null;
        const title = (value as { title?: unknown }).title;
        if (parsed?.kind === 'url' && typeof title === 'string' && title.trim()) parsed = { ...parsed, title: title.trim().slice(0, TITLE_MAX) };
    }
    return parsed ?? fail('invalid', `not a ref: ${typeof value === 'string' ? value.slice(0, 80) : JSON.stringify(value)?.slice(0, 80)}`);
}

function checkPath(value: unknown): string {
    const p = text(value, 'a touches path', PATH_MAX).replace(/\\/g, '/');
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) fail('invalid', `touches paths are relative to the project: ${p}`);
    return p;
}

function list<T>(value: unknown, what: string, max: number, each: (v: unknown) => T): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return fail('invalid', `${what} must be a list`);
    if (value.length > max) fail('invalid', `${what} holds at most ${max}`);
    return value.map(each);
}

/** What `add` and `split` take per item. */
export interface PlanItemInput {
    readonly title: string;
    /** Item numbers that must be done first; each must exist in the project. */
    readonly after?: readonly number[];
    readonly touches?: readonly string[];
    readonly refs?: readonly (Ref | string)[];
    /** The done-when checklist, unticked. */
    readonly doneWhen?: readonly string[];
    readonly options?: readonly PlanOption[];
}

interface CheckedInput {
    title: string;
    after: number[];
    touches: string[];
    refs: Ref[];
    doneWhen: PlanDoneWhen[];
    options?: PlanOption[];
}

/**
 * Check one item of a batch. `after` may name items of the project or items earlier in the same batch: the batch's
 * `k`-th item (0-based) will be `#(book.nextItem + k)`.
 */
function checkInput(book: PlanBook, input: unknown, k: number): CheckedInput {
    if (!input || typeof input !== 'object') fail('invalid', 'an item must be an object');
    const i = input as Record<string, unknown>;
    const after = [
        ...new Set(
            list(i.after, 'after', AFTER_MAX, (n) => {
                const earlier = Number.isSafeInteger(n) && (n as number) >= book.nextItem && (n as number) < book.nextItem + k;
                if (!Number.isSafeInteger(n) || (!book.items[String(n)] && !earlier)) fail('invalid', `after names #${String(n)}, which is not an item of this project`);
                return n as number;
            })
        )
    ];
    const options = list(i.options, 'options', OPTIONS_MAX, (o) => {
        const opt = o as { label?: unknown; detail?: unknown } | null;
        const label = text(opt?.label, 'an option label', TITLE_MAX);
        const detail = optionalText(opt?.detail, 'an option detail', TEXT_MAX);
        return detail !== undefined ? { label, detail } : { label };
    });
    return {
        title: text(i.title, 'an item title', TITLE_MAX),
        after,
        touches: [...new Set(list(i.touches, 'touches', TOUCHES_MAX, checkPath))],
        refs: list(i.refs, 'refs', REFS_MAX, checkRef),
        doneWhen: list(i.doneWhen, 'doneWhen', DONE_WHEN_MAX, (d) => ({ text: text(d, 'a done-when line', TITLE_MAX), checked: false })),
        ...(options.length ? { options } : {})
    };
}

// ---------------------------------------------------------------------------
// Lookups and bookkeeping

export function itemOf(book: PlanBook, itemId: unknown): StoredItem {
    if (!Number.isSafeInteger(itemId)) fail('invalid', 'an item is named by its number');
    return book.items[String(itemId)] ?? fail('not-found', `no item #${String(itemId)}`);
}

export function planOf(book: PlanBook, planId: unknown): StoredPlan {
    if (typeof planId !== 'string') fail('invalid', 'a plan is named by its id');
    return book.plans[planId as string] ?? fail('not-found', `no plan ${String(planId)}`);
}

const all = (book: PlanBook): StoredItem[] => Object.values(book.items);

/** Whether the item's claim is live at `now`. */
export const liveClaim = (item: StoredItem, now: number): boolean => item.claim !== undefined && item.claim.leaseUntil > now;

/** The `after` items still unfinished. */
export const waitsOn = (book: PlanBook, item: StoredItem): number[] => planItemWaitsOn(item, all(book));

/** Items `agentId` holds a live claim on. */
export const claimsOf = (book: PlanBook, agentId: AgentId, now: number): StoredItem[] => all(book).filter((i) => liveClaim(i, now) && i.claim!.agentId === agentId);

function note(item: StoredItem, at: number, actor: PlanActor | null, line: string): void {
    // History lines by the platform (a lease running out) are attributed to the agent the change concerns.
    const by: PlanActor = actor ?? item.assignee ?? { kind: 'user', userId: 'system' };
    item.activity.push({ at, actor: by, text: line });
    if (item.activity.length > ACTIVITY_KEPT) item.activity.splice(0, item.activity.length - ACTIVITY_KEPT);
    item.updatedAt = at;
}

function dequeue(book: PlanBook, itemId: number): void {
    for (const [label, q] of Object.entries(book.queues)) {
        const i = q.indexOf(itemId);
        if (i >= 0) q.splice(i, 1);
        if (!q.length) delete book.queues[label];
    }
}

function enqueue(book: PlanBook, to: PlanActor, itemId: number, index?: number): void {
    dequeue(book, itemId);
    const label = actorLabel(to);
    const q = (book.queues[label] ??= []);
    const at = index === undefined ? q.length : Math.max(0, Math.min(q.length, Math.trunc(index)));
    q.splice(at, 0, itemId);
}

function tell(book: PlanBook, notice: Omit<PlanNotice, 'seq'>): void {
    book.notices.push({ ...notice, seq: book.nextNotice++ });
    if (book.notices.length > NOTICES_KEPT) book.notices.splice(0, book.notices.length - NOTICES_KEPT);
}

function finish(book: PlanBook, item: StoredItem, call: PlanCall, how: string): PlanChange {
    delete item.claim;
    dequeue(book, item.id);
    item.state = 'done';
    note(item, call.now, call.actor, how);
    return { op: 'done', actor: call.actor, planId: item.planId, itemId: item.id, summary: `#${item.id} done (${how}): ${item.title}` };
}

// ---------------------------------------------------------------------------
// Leases

/**
 * Every claim whose lease ran out goes back to the top of its assignee's queue, `ready`, and the manager is told
 * (or, with no manager, the agent whose lease it was). Run first on every call and from the lease alarm.
 */
export function expireLeases(book: PlanBook, call: PlanCall): PlanChange[] {
    const changes: PlanChange[] = [];
    const expired = all(book)
        .filter((i) => i.claim && i.claim.leaseUntil <= call.now)
        .sort((a, b) => b.claim!.claimedAt - a.claim!.claimedAt || b.id - a.id);
    // Newest claim first, each to the top: the oldest expired ends up first in its queue.
    for (const item of expired) {
        const agentId = item.claim!.agentId;
        delete item.claim;
        item.state = 'ready';
        item.assignee = agentActor(agentId);
        enqueue(book, item.assignee, item.id, 0);
        note(item, call.now, item.assignee, `lease ran out; back to the top of @${agentId}'s queue`);
        const to = call.manager !== null ? agentActor(call.manager) : item.assignee;
        tell(book, { at: call.now, to, kind: 'lease-expired', itemId: item.id, text: `@${agentId}'s lease on #${item.id} ran out; it is back at the top of their queue: ${item.title}` });
        changes.push({ op: 'lease-expired', actor: null, planId: item.planId, itemId: item.id, summary: `lease on #${item.id} ran out for @${agentId}; back to the top of their queue: ${item.title}` });
    }
    return changes;
}

/** A plan call by an agent renews every live lease it holds. Returns how many. */
export function renewLeases(book: PlanBook, call: PlanCall): number {
    const a = call.actor;
    if (!a || a.kind !== 'agent') return 0;
    const mine = claimsOf(book, a.agentId, call.now);
    for (const item of mine) item.claim!.leaseUntil = call.now + item.claim!.leaseMs;
    return mine.length;
}

/** When the next lease runs out, if any claim is live. */
export function nextLeaseEnd(book: PlanBook): number | undefined {
    let min: number | undefined;
    for (const i of all(book)) if (i.claim && (min === undefined || i.claim.leaseUntil < min)) min = i.claim.leaseUntil;
    return min;
}

// ---------------------------------------------------------------------------
// Plans, phases, items

export interface PlanCreateInput {
    readonly title: string;
    readonly description?: string;
    readonly originChatId?: ChatId;
    readonly phases?: readonly { readonly title: string; readonly items?: readonly PlanItemInput[] }[];
}

export function createPlan(book: PlanBook, call: PlanCall, input: PlanCreateInput): Outcome<StoredPlan> {
    const actor = requireManager(call, 'create a plan');
    if (!input || typeof input !== 'object') fail('invalid', 'a plan must be an object');
    if (Object.keys(book.plans).length >= PLANS_MAX) fail('full', `a project holds at most ${PLANS_MAX} plans`);
    const title = text(input.title, 'a plan title', TITLE_MAX);
    const description = optionalText(input.description, 'a plan description', TEXT_MAX);
    const originChatId = optionalText(input.originChatId, 'originChatId', 200) as ChatId | undefined;
    const phases = list(input.phases, 'phases', PHASES_MAX, (p) => p as { title: string; items?: readonly PlanItemInput[] });
    const plan: StoredPlan = {
        id: `plan-${book.nextPlan}`,
        title,
        ...(description !== undefined ? { description } : {}),
        ...(originChatId !== undefined ? { originChatId } : {}),
        phases: [],
        createdAt: call.now,
        createdBy: actor
    };
    // Validate every phase and item before anything lands, so a bad one leaves the book as it was.
    let k = 0;
    const checkedPhases = phases.map((p) => ({ title: text(p?.title, 'a phase title', TITLE_MAX), items: list(p?.items, 'items', ITEMS_PER_CALL_MAX, (i) => checkInput(book, i, k++)) }));
    const count = checkedPhases.reduce((n, p) => n + p.items.length, 0);
    if (Object.keys(book.items).length + count > ITEMS_MAX) fail('full', `a project holds at most ${ITEMS_MAX} plan items`);
    book.nextPlan++;
    book.plans[plan.id] = plan;
    checkedPhases.forEach((p, i) => {
        const phase: StoredPhase = { n: i + 1, title: p.title, items: [] };
        plan.phases.push(phase);
        for (const input of p.items) phase.items.push(insertItem(book, call, plan.id, input).id);
    });
    return { value: plan, changes: [{ op: 'plan-created', actor, planId: plan.id, summary: `plan "${title}" created with ${count} item${count === 1 ? '' : 's'}` }] };
}

export function addPhase(book: PlanBook, call: PlanCall, planId: string, title: string): Outcome<StoredPhase> {
    const actor = requireManager(call, 'add a phase');
    const plan = planOf(book, planId);
    const t = text(title, 'a phase title', TITLE_MAX);
    if (plan.phases.length >= PHASES_MAX) fail('full', `a plan holds at most ${PHASES_MAX} phases`);
    const phase: StoredPhase = { n: plan.phases.length + 1, title: t, items: [] };
    plan.phases.push(phase);
    return { value: phase, changes: [{ op: 'phase-added', actor, planId, summary: `phase ${phase.n} "${t}" added to "${plan.title}"` }] };
}

function insertItem(book: PlanBook, call: PlanCall, planId: string, input: CheckedInput): StoredItem {
    const item: StoredItem = { id: book.nextItem++, planId, state: 'ready', ...input, activity: [], createdAt: call.now, updatedAt: call.now };
    book.items[String(item.id)] = item;
    note(item, call.now, call.actor, 'added');
    return item;
}

export function addItems(book: PlanBook, call: PlanCall, planId: string, phaseN: number, inputs: readonly PlanItemInput[]): Outcome<StoredItem[]> {
    const actor = requireManager(call, 'add items');
    const plan = planOf(book, planId);
    const phase = plan.phases.find((p) => p.n === phaseN) ?? fail('not-found', `plan ${planId} has no phase ${String(phaseN)}`);
    let k = 0;
    const checked = list(inputs, 'items', ITEMS_PER_CALL_MAX, (i) => checkInput(book, i, k++));
    if (!checked.length) fail('invalid', 'add at least one item');
    if (Object.keys(book.items).length + checked.length > ITEMS_MAX) fail('full', `a project holds at most ${ITEMS_MAX} plan items`);
    const items = checked.map((c) => insertItem(book, call, planId, c));
    phase.items.push(...items.map((i) => i.id));
    return { value: items, changes: [{ op: 'items-added', actor, planId, summary: `${items.map((i) => `#${i.id}`).join(', ')} added to "${plan.title}" phase ${phase.n}` }] };
}

/**
 * Split an item into parts in its place: each part waits on what the original waited on, inherits its touches when
 * it names none, and takes the original's queue slot in order; every item that waited on the original waits on all
 * parts. A done or claimed item is not split.
 */
export function splitItem(book: PlanBook, call: PlanCall, itemId: number, parts: readonly PlanItemInput[]): Outcome<StoredItem[]> {
    const actor = requireManager(call, 'split an item');
    const item = itemOf(book, itemId);
    if (item.state === 'done') fail('done', `#${item.id} is done`);
    if (liveClaim(item, call.now)) fail('taken', `#${item.id} is being worked by @${item.claim!.agentId}; hand it off first`);
    let k = 0;
    const checked = list(parts, 'parts', ITEMS_PER_CALL_MAX, (i) => checkInput(book, i, k++));
    if (checked.length < 2) fail('invalid', 'split into at least two parts');
    if (checked.some((c) => c.after.includes(item.id))) fail('invalid', `a part cannot wait on #${item.id}, which it replaces`);
    if (Object.keys(book.items).length - 1 + checked.length > ITEMS_MAX) fail('full', `a project holds at most ${ITEMS_MAX} plan items`);
    const plan = book.plans[item.planId]!;
    const phase = plan.phases.find((p) => p.items.includes(item.id))!;
    const queue = item.assignee ? book.queues[actorLabel(item.assignee)] : undefined;
    const slot = queue ? queue.indexOf(item.id) : -1;
    const made = checked.map((c) =>
        insertItem(book, call, item.planId, {
            ...c,
            after: [...new Set([...item.after, ...c.after])],
            touches: c.touches.length ? c.touches : [...item.touches]
        })
    );
    for (const part of made) note(part, call.now, actor, `split from #${item.id}`);
    phase.items.splice(phase.items.indexOf(item.id), 1, ...made.map((m) => m.id));
    for (const other of all(book)) {
        const i = other.after.indexOf(item.id);
        if (i >= 0) other.after.splice(i, 1, ...made.map((m) => m.id).filter((n) => !other.after.includes(n)));
    }
    if (item.assignee && queue && slot >= 0) {
        made.forEach((m, k) => {
            m.assignee = item.assignee;
            if (item.assignedBy) m.assignedBy = item.assignedBy;
            enqueue(book, item.assignee!, m.id, slot + k);
        });
    }
    dequeue(book, item.id);
    delete book.items[String(item.id)];
    return { value: made, changes: [{ op: 'split', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} split into ${made.map((m) => `#${m.id}`).join(', ')}: ${item.title}` }] };
}

// ---------------------------------------------------------------------------
// Assign, claim, handoff

/**
 * Put an item in `to`'s queue at `index` (default: last), move it within the queue, or (`to` null) back to the
 * open pool. An agent must be a project member. A live claim of another agent ends; that agent is told.
 */
export function assign(book: PlanBook, call: PlanCall, itemId: number, to: PlanActor | null, index?: number): Outcome<StoredItem> {
    const actor = requireManager(call, 'assign items');
    const item = itemOf(book, itemId);
    if (item.state === 'done') fail('done', `#${item.id} is done`);
    const target = to === null ? null : checkActor(to);
    if (target?.kind === 'agent' && !call.members.includes(target.agentId)) fail('invalid', `@${target.agentId} is not a member of this project`);
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) fail('invalid', 'index must be a queue position');
    const changes: PlanChange[] = [];
    const holder = liveClaim(item, call.now) ? item.claim!.agentId : undefined;
    if (holder !== undefined && !(target?.kind === 'agent' && target.agentId === holder)) {
        delete item.claim;
        item.state = 'ready';
        tell(book, { at: call.now, to: agentActor(holder), kind: 'reassigned', itemId: item.id, text: `${who(actor)} moved #${item.id} to ${target ? who(target) : 'the open pool'}; stop working on it: ${item.title}` });
    }
    if (target === null) {
        dequeue(book, item.id);
        delete item.assignee;
        delete item.assignedBy;
        note(item, call.now, actor, 'back to the open pool');
    } else if (holder !== undefined && target.kind === 'agent' && target.agentId === holder) {
        note(item, call.now, actor, `kept with @${holder}, who is working on it`);
    } else {
        const moved = !sameActor(item.assignee, target);
        item.assignee = target;
        item.assignedBy = actor;
        enqueue(book, target, item.id, index);
        note(item, call.now, actor, moved ? `assigned to ${who(target)}` : `moved in ${who(target)}'s queue`);
    }
    changes.push({ op: 'assigned', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} ${target ? `assigned to ${who(target)}` : 'back to the open pool'}: ${item.title}` });
    return { value: item, changes };
}

/** A touches clash reported to a claimer. */
export interface TouchesWarning {
    readonly itemId: number;
    readonly otherItemId: number;
    readonly otherAgentId: AgentId;
    readonly paths: readonly string[];
    /** Suggested order, first to last: the item already being worked first. */
    readonly order: readonly number[];
}

export interface ClaimOptions {
    readonly taskId?: TaskId;
    /** The lease length; default `PLAN_LEASE_DEFAULT_MS`, between `LEASE_MIN_MS` and `LEASE_MAX_MS`. */
    readonly leaseMs?: number;
}

/** Why `agentId` may not claim `item` now, or `null`. The same checks `claim` refuses with, for `next`. */
export function claimRefusal(book: PlanBook, call: PlanCall, agentId: AgentId, item: StoredItem): PlanRuleError | null {
    if (item.state === 'done') return new PlanRuleError('done', `#${item.id} is done`);
    const waits = waitsOn(book, item);
    if (waits.length) return new PlanRuleError('blocked', `#${item.id} waits on ${waits.map((n) => `#${n}`).join(', ')}`);
    if (liveClaim(item, call.now) && item.claim!.agentId !== agentId) return new PlanRuleError('taken', `#${item.id} is being worked by @${item.claim!.agentId}`);
    if (item.state === 'needs-you') return new PlanRuleError('needs-person', `#${item.id} needs a person first`);
    if (item.assignee && !sameActor(item.assignee, agentActor(agentId))) return new PlanRuleError('assigned-elsewhere', `#${item.id} is in ${who(item.assignee)}'s queue`);
    if (!(liveClaim(item, call.now) && item.claim!.agentId === agentId)) {
        const limit = call.limitOf(agentId);
        const working = claimsOf(book, agentId, call.now).length;
        if (working >= limit) return new PlanRuleError('over-limit', `@${agentId} already works ${working} item${working === 1 ? '' : 's'} (limit ${limit})`);
    }
    return null;
}

/** Live claims of other agents whose touches overlap `item`'s. */
function clashes(book: PlanBook, call: PlanCall, agentId: AgentId, item: StoredItem): { other: StoredItem; paths: string[] }[] {
    if (!item.touches.length) return [];
    const out: { other: StoredItem; paths: string[] }[] = [];
    for (const other of all(book)) {
        if (other.id === item.id || !liveClaim(other, call.now) || other.claim!.agentId === agentId) continue;
        const paths = item.touches.filter((p) => other.touches.some((q) => planTouchesOverlap(p, q)));
        if (paths.length) out.push({ other, paths });
    }
    return out;
}

export function claim(book: PlanBook, call: PlanCall, itemId: number, options: ClaimOptions = {}): Outcome<{ item: StoredItem; warnings: TouchesWarning[] }> {
    const actor = requireActor(call);
    if (actor.kind !== 'agent') fail('forbidden', 'only an agent claims an item; a person assigns it');
    const agentId = (actor as { agentId: AgentId }).agentId;
    const item = itemOf(book, itemId);
    const leaseMs = options.leaseMs ?? PLAN_LEASE_DEFAULT_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < LEASE_MIN_MS || leaseMs > LEASE_MAX_MS) fail('invalid', `leaseMs must be between ${LEASE_MIN_MS} and ${LEASE_MAX_MS}`);
    if (options.taskId !== undefined && (typeof options.taskId !== 'string' || !options.taskId.trim() || options.taskId.length > 200)) fail('invalid', 'taskId must be a task id');
    const refusal = claimRefusal(book, call, agentId, item);
    if (refusal) throw refusal;
    const renewing = liveClaim(item, call.now);
    item.claim = {
        agentId,
        leaseUntil: call.now + leaseMs,
        leaseMs,
        claimedAt: renewing ? item.claim!.claimedAt : call.now,
        ...(options.taskId !== undefined ? { taskId: options.taskId } : item.claim?.taskId !== undefined && renewing ? { taskId: item.claim.taskId } : {})
    };
    item.state = 'claimed';
    if (!item.assignee) {
        item.assignee = actor;
        item.assignedBy = actor;
    }
    dequeue(book, item.id);
    const warnings: TouchesWarning[] = [];
    if (!renewing) {
        note(item, call.now, actor, 'claimed');
        for (const { other, paths } of clashes(book, call, agentId, item)) {
            const order = [other.id, item.id];
            const w: TouchesWarning = { itemId: item.id, otherItemId: other.id, otherAgentId: other.claim!.agentId, paths, order };
            warnings.push(w);
            const line = `#${item.id} (@${agentId}) and #${other.id} (@${other.claim!.agentId}) both touch ${paths.join(', ')}; suggested order: #${other.id} then #${item.id}`;
            tell(book, { at: call.now, to: actor, kind: 'touches', itemId: item.id, otherItemId: other.id, order, paths, text: line });
            tell(book, { at: call.now, to: agentActor(other.claim!.agentId), kind: 'touches', itemId: other.id, otherItemId: item.id, order, paths, text: line });
            note(item, call.now, actor, `touches overlap with #${other.id}: ${paths.join(', ')}`);
        }
    }
    return {
        value: { item, warnings },
        changes: renewing ? [] : [{ op: 'claimed', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} claimed by @${agentId}: ${item.title}` }]
    };
}

/**
 * Release an item with a note: to `to`'s queue top, or (`to` null) to the open pool. The claimer, the assignee
 * or a manager may; `to` is told.
 */
export function handoff(book: PlanBook, call: PlanCall, itemId: number, to: PlanActor | null, noteText: string): Outcome<StoredItem> {
    const actor = requireActor(call);
    const item = itemOf(book, itemId);
    if (item.state === 'done') fail('done', `#${item.id} is done`);
    const line = text(noteText, 'a handoff note', TEXT_MAX);
    const holder = liveClaim(item, call.now) ? agentActor(item.claim!.agentId) : undefined;
    if (!isManager(call) && !sameActor(holder, actor) && !sameActor(item.assignee, actor)) fail('forbidden', `only whoever holds #${item.id}, its assignee or the project manager may hand it off`);
    const target = to === null ? null : checkActor(to);
    if (target?.kind === 'agent' && !call.members.includes(target.agentId)) fail('invalid', `@${target.agentId} is not a member of this project`);
    delete item.claim;
    if (item.state === 'claimed') item.state = 'ready';
    if (target) {
        item.assignee = target;
        item.assignedBy = actor;
        enqueue(book, target, item.id, 0);
        tell(book, { at: call.now, to: target, kind: 'handoff', itemId: item.id, text: `${who(actor)} handed #${item.id} to you: ${line}` });
    } else {
        dequeue(book, item.id);
        delete item.assignee;
        delete item.assignedBy;
        if (call.manager !== null && !sameActor(actor, agentActor(call.manager))) tell(book, { at: call.now, to: agentActor(call.manager), kind: 'handoff', itemId: item.id, text: `${who(actor)} released #${item.id} to the open pool: ${line}` });
    }
    note(item, call.now, actor, `handed off to ${target ? who(target) : 'the open pool'}: ${line}`);
    return { value: item, changes: [{ op: 'handed-off', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} handed off to ${target ? who(target) : 'the open pool'}: ${item.title}` }] };
}

// ---------------------------------------------------------------------------
// Update, refs

export interface PlanItemPatch {
    /** Tick (or untick) done-when lines by index. */
    readonly tick?: readonly { readonly index: number; readonly checked: boolean }[];
    readonly note?: string;
    /** `needs-you` / `stuck` release the claim and wait at the top of the queue; `ready` returns it; `done` is a person's. */
    readonly state?: 'ready' | 'needs-you' | 'stuck' | 'done';
    /** The task carrying the item out (the claimer's). */
    readonly taskId?: TaskId;
}

export function update(book: PlanBook, call: PlanCall, itemId: number, patch: PlanItemPatch): Outcome<StoredItem> {
    const actor = requireActor(call);
    const item = itemOf(book, itemId);
    if (!patch || typeof patch !== 'object') fail('invalid', 'a patch must be an object');
    const holder = liveClaim(item, call.now) ? agentActor(item.claim!.agentId) : undefined;
    const involved = isManager(call) || sameActor(holder, actor) || sameActor(item.assignee, actor);
    if (!involved) fail('forbidden', `only whoever holds #${item.id}, its assignee or the project manager may change it`);
    const noteLine = optionalText(patch.note, 'a note', TEXT_MAX);
    const ticks = list(patch.tick, 'tick', DONE_WHEN_MAX, (t) => {
        const v = t as { index?: unknown; checked?: unknown } | null;
        if (!v || !Number.isSafeInteger(v.index) || (v.index as number) < 0 || (v.index as number) >= item.doneWhen.length) fail('invalid', `#${item.id} has no done-when line ${String(v?.index)}`);
        if (typeof v!.checked !== 'boolean') fail('invalid', 'checked must be true or false');
        return { index: v!.index as number, checked: v!.checked as boolean };
    });
    const state = patch.state;
    if (state !== undefined && !(['ready', 'needs-you', 'stuck', 'done'] as const).includes(state)) fail('invalid', 'state is ready, needs-you, stuck or done');
    if (state === 'done' && actor.kind !== 'user') fail('forbidden', `only a person marks #${item.id} done; tick its done-when lines instead`);
    if (patch.taskId !== undefined) {
        if (!holder || !sameActor(holder, actor)) fail('forbidden', 'only the agent working the item sets its task');
        if (typeof patch.taskId !== 'string' || !patch.taskId.trim() || patch.taskId.length > 200) fail('invalid', 'taskId must be a task id');
    }
    if (item.state === 'done' && (ticks.length || (state !== undefined && state !== 'ready') || patch.taskId !== undefined)) fail('done', `#${item.id} is done`);
    if (state === 'ready' && item.state === 'done' && actor.kind !== 'user') fail('forbidden', `only a person reopens #${item.id}`);

    const changes: PlanChange[] = [];
    if (noteLine !== undefined) {
        note(item, call.now, actor, noteLine);
        changes.push({ op: 'noted', actor, planId: item.planId, itemId: item.id, summary: `note on #${item.id}: ${noteLine.slice(0, 200)}` });
    }
    if (patch.taskId !== undefined && item.claim) item.claim.taskId = patch.taskId;
    if (ticks.length) {
        for (const t of ticks) item.doneWhen[t.index] = { ...item.doneWhen[t.index]!, checked: t.checked };
        note(item, call.now, actor, ticks.map((t) => `${t.checked ? 'ticked' : 'unticked'} "${item.doneWhen[t.index]!.text}"`).join('; '));
        changes.push({ op: 'ticked', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} done-when ${item.doneWhen.filter((d) => d.checked).length}/${item.doneWhen.length}: ${item.title}` });
    }
    if (state === 'done') changes.push(finish(book, item, call, `marked done by ${who(actor)}`));
    else if (item.state !== 'done' && ticks.length && planDoneWhenMet(item.doneWhen)) changes.push(finish(book, item, call, 'every done-when ticked'));
    else if (state !== undefined && state !== item.state) {
        const was = item.state;
        const agent = item.claim?.agentId;
        delete item.claim;
        item.state = state;
        if (was === 'done' && item.assignee) enqueue(book, item.assignee, item.id, 0);
        else if (agent !== undefined && item.assignee) enqueue(book, item.assignee, item.id, 0);
        note(item, call.now, actor, `${was} → ${state}`);
        changes.push({ op: agent !== undefined ? 'released' : 'updated', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} ${was} → ${state}: ${item.title}` });
    }
    return { value: item, changes };
}

export function addRef(book: PlanBook, call: PlanCall, itemId: number, ref: Ref | string): Outcome<StoredItem> {
    const actor = requireActor(call);
    const item = itemOf(book, itemId);
    const r = checkRef(ref);
    const printed = formatRef(r);
    if (item.refs.some((x) => formatRef(x) === printed)) return { value: item, changes: [] };
    if (item.refs.length >= REFS_MAX) fail('full', `#${item.id} holds at most ${REFS_MAX} refs`);
    item.refs.push(r);
    note(item, call.now, actor, `ref ${printed}`);
    return { value: item, changes: [{ op: 'ref-added', actor, planId: item.planId, itemId: item.id, summary: `ref ${printed.slice(0, 200)} on #${item.id}` }] };
}

// ---------------------------------------------------------------------------
// Reads

/**
 * The next item for `agentId`: its own queue in order, then the open pool in plan order — claimable, no touches clash.
 * `refusal` is why an item may not be claimed (default `claimRefusal`; the actor adds cross-project waits).
 */
export function nextFor(book: PlanBook, call: PlanCall, agentId: AgentId, refusal: (item: StoredItem) => PlanRuleError | null = (item) => claimRefusal(book, call, agentId, item)): StoredItem | null {
    const fits = (item: StoredItem) => !refusal(item) && !liveClaim(item, call.now) && clashes(book, call, agentId, item).length === 0;
    for (const n of book.queues[`agent:${agentId}`] ?? []) {
        const item = book.items[String(n)];
        if (item && fits(item)) return item;
    }
    for (const plan of Object.values(book.plans)) {
        for (const phase of plan.phases) {
            for (const n of phase.items) {
                const item = book.items[String(n)];
                if (item && !item.assignee && fits(item)) return item;
            }
        }
    }
    return null;
}

/** The view state of a stored item: `blocked` while an `after` item is unfinished, `ready` once a lease is past. */
export function viewState(book: PlanBook, item: StoredItem, now: number): PlanItemState {
    if (item.state === 'claimed' && !liveClaim(item, now)) return 'ready';
    if ((item.state === 'ready' || item.state === 'stuck') && waitsOn(book, item).length) return 'blocked';
    return item.state;
}

export function itemView(book: PlanBook, item: StoredItem, now: number): PlanItem {
    const queueIndex = item.assignee ? (book.queues[actorLabel(item.assignee)]?.indexOf(item.id) ?? -1) : -1;
    const claim: PlanClaim | undefined = liveClaim(item, now) ? { agentId: item.claim!.agentId, leaseUntil: item.claim!.leaseUntil, ...(item.claim!.taskId !== undefined ? { taskId: item.claim!.taskId } : {}) } : undefined;
    return {
        id: item.id,
        title: item.title,
        state: viewState(book, item, now),
        ...(item.assignee ? { assignee: { ...item.assignee } } : {}),
        ...(queueIndex >= 0 ? { queueIndex } : {}),
        ...(item.assignedBy ? { assignedBy: { ...item.assignedBy } } : {}),
        ...(claim ? { claim } : {}),
        after: [...item.after],
        touches: [...item.touches],
        refs: item.refs.map((r) => ({ ...r })),
        doneWhen: item.doneWhen.map((d) => ({ ...d })),
        activity: item.activity.map((a) => ({ ...a, actor: { ...a.actor } })),
        ...(item.options ? { options: item.options.map((o) => ({ ...o })) } : {})
    };
}

export function planView(book: PlanBook, plan: StoredPlan, now: number): Plan {
    return {
        id: plan.id,
        projectId: book.projectId,
        title: plan.title,
        ...(plan.description !== undefined ? { description: plan.description } : {}),
        ...(plan.originChatId !== undefined ? { originChatId: plan.originChatId } : {}),
        phases: plan.phases.map((p) => ({ n: p.n, title: p.title, items: p.items.map((n) => book.items[String(n)]).filter((i): i is StoredItem => !!i).map((i) => itemView(book, i, now)) }))
    };
}

/** One not-done item with where it sits — the Work view's plan rows (K1). */
export interface OpenPlanItem {
    readonly planId: string;
    readonly planTitle: string;
    readonly phase: { readonly n: number; readonly title: string };
    readonly item: PlanItem;
    readonly updatedAt: number;
}

export function openItems(book: PlanBook, now: number): OpenPlanItem[] {
    const out: OpenPlanItem[] = [];
    for (const plan of Object.values(book.plans)) {
        for (const phase of plan.phases) {
            for (const n of phase.items) {
                const item = book.items[String(n)];
                if (!item || item.state === 'done') continue;
                out.push({ planId: plan.id, planTitle: plan.title, phase: { n: phase.n, title: phase.title }, item: itemView(book, item, now), updatedAt: item.updatedAt });
            }
        }
    }
    return out;
}

/** Take (remove and return) the notices addressed to `to`, oldest first. */
export function takeNotices(book: PlanBook, to: PlanActor): PlanNotice[] {
    const label = actorLabel(to);
    const mine = book.notices.filter((n) => actorLabel(n.to) === label);
    if (mine.length) book.notices = book.notices.filter((n) => actorLabel(n.to) !== label);
    return mine;
}
