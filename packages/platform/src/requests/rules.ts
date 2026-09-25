/**
 * The Requests rules (#758; PRJ-14/PRJ-15; docs/design/projects/HANDOFF.md "Project manager and requests"): a pure
 * book of the requests sent to one project, and the state machine every Requests actor method runs through. No I/O
 * and no clock of its own — the actor passes `now`, who is acting, the project's manager and its policy — so each
 * rule is table-tested on its own (`__tests__/requests/rules.test.ts`).
 *
 * ```
 *  receive ─┬─ sender policy "ask", or no manager ──▶ needs-you ─ admit (person) ─▶ triaging
 *           └─ sender policy "allowed" ─────────────────────────────────────────▶ triaging
 *  triaging ── triage (manager) ─┬─ needsPerson ──▶ needs-you
 *                                └─ may act alone ─▶ triaging (with its triage)
 *  triaging | needs-you ── resolve: accept ▶ accepted (+ plan item) · decline ▶ declined · ask ▶ asked-for-more
 *  asked-for-more ── answer (sender or person) ──▶ triaging (needs-you with no manager)
 * ```
 *
 * - **The manager** (`project.pm.agentId`, else the coordinator) triages and may resolve on its own only what its
 *   policy lets it: accept a triage `needsPerson` passes, decline a duplicate when `declineDuplicates`, ask for more.
 *   Its personality shapes the reply text; its policy, never its personality, decides what needs a person.
 * - **A person** (any user of the workspace) may admit, accept (optionally with an edited item — "Edit first"),
 *   decline and ask for more from any open state.
 * - `accepted` and `declined` are final.
 *
 * Errors are `RequestRuleError`s carrying the HTTP status the actor answers with.
 */
import {
    needsPersonReasons,
    pmSenderMode,
    REQUEST_KINDS,
    REQUEST_PRIORITIES,
    type AgentId,
    type ChatId,
    type PlanActor,
    type PmAskReason,
    type PmPolicy,
    type ProjectId,
    type ProjectRequest,
    type Ref,
    type RequestKind,
    type RequestPriority,
    type RequestState,
    type Triage,
    type TriageProposedItem,
    type TriageSimilar,
    type WorkspaceId
} from '@agentic/core';
import { checkActor, checkRef, PlanRuleError } from '../plan/rules.js';

// ---------------------------------------------------------------------------
// Limits

export const REQUESTS_KEPT = 1000;
export const SENT_TO_MAX = 200;
export const TITLE_MAX = 200;
export const TEXT_MAX = 8000;
export const REFS_MAX = 50;
export const SIMILAR_MAX = 20;
export const DONE_WHEN_MAX = 30;
export const OPTIONS_MAX = 10;

// ---------------------------------------------------------------------------
// State

/** Why a request waits on a person: letting it in (sender policy / no manager), or the manager's triage. */
export type RequestAskReason = PmAskReason | 'sender' | 'no-manager';

export interface StoredRequest {
    id: string;
    fromProject: ProjectId;
    fromChat?: ChatId;
    /** The chat it came from, by title, as the sender named it (#883). */
    fromChatTitle?: string;
    sender: PlanActor;
    toProject: ProjectId;
    title: string;
    body: string;
    refs: Ref[];
    state: RequestState;
    triage?: Triage;
    /** When the manager's current triage landed (#883); cleared with the triage when the sender answers. */
    triagedAt?: number;
    resultItem?: number;
    /** `accepted`: whether a GitHub issue is opened for the item — the person's choice on accept, else the triage's (#883). */
    openIssue?: boolean;
    declineReason?: string;
    /** `needs-you`: what a person is asked — to let it in, or to decide on the triage. */
    needs?: 'admit' | 'decision';
    /** `needs-you`: every rule that sent it to a person. */
    reasons?: RequestAskReason[];
    /** `asked-for-more`: what the sender was asked. */
    question?: string;
    /** Triage turns started for it so far — the turn's idempotency counter. */
    turns: number;
    createdAt: number;
    updatedAt: number;
}

export interface RequestsBook {
    workspaceId: WorkspaceId;
    projectId: ProjectId;
    /** The next request number (`req_n`). */
    nextId: number;
    requests: Record<string, StoredRequest>;
    /** Projects this project sent requests to — where `sent()` looks. */
    sentTo: ProjectId[];
}

export function emptyBook(workspaceId: WorkspaceId, projectId: ProjectId): RequestsBook {
    return { workspaceId, projectId, nextId: 1, requests: {}, sentTo: [] };
}

/** A request as the actor answers it: the core record plus why it waits and what was asked. */
export interface RequestView extends ProjectRequest {
    readonly needs?: 'admit' | 'decision';
    readonly reasons?: readonly RequestAskReason[];
    readonly question?: string;
    /** The chat it came from, by title (#883). */
    readonly fromChatTitle?: string;
    /** When the manager's current triage landed (#883). */
    readonly triagedAt?: number;
    /** `accepted`: whether a GitHub issue is opened for the item it became (#883). */
    readonly openIssue?: boolean;
}

export function requestView(r: StoredRequest): RequestView {
    const { turns: _turns, ...rest } = r;
    // A plain copy: the stored request may be the actor's reactive state.
    return JSON.parse(JSON.stringify(rest)) as RequestView;
}

// ---------------------------------------------------------------------------
// Errors and the call context

export type RequestErrorCode = 'invalid' | 'forbidden' | 'not-found' | 'final' | 'wrong-state' | 'needs-person' | 'full';

const STATUS: Record<RequestErrorCode, number> = { invalid: 400, forbidden: 403, 'not-found': 404, final: 409, 'wrong-state': 409, 'needs-person': 409, full: 409 };

export class RequestRuleError extends Error {
    readonly status: number;
    constructor(
        readonly code: RequestErrorCode,
        message: string
    ) {
        super(`[requests] ${message}`);
        this.name = 'RequestRuleError';
        this.status = STATUS[code];
    }
}

const fail = (code: RequestErrorCode, message: string): never => {
    throw new RequestRuleError(code, message);
};

/** A plan-rule validation error (refs, actors) re-raised as a request one. */
function asRequestError<T>(fn: () => T): T {
    try {
        return fn();
    } catch (error) {
        if (error instanceof PlanRuleError) fail('invalid', error.message.replace(/^\[plan\] /, ''));
        throw error;
    }
}

/** What a rule needs besides the book: when, who, and the receiving project's manager and policy. */
export interface RequestCall {
    readonly now: number;
    readonly actor: PlanActor;
    /** The receiving project's manager agent, if it has one. */
    readonly manager: AgentId | null;
    readonly policy: PmPolicy;
}

/** One change, for the audit log. */
export interface RequestChange {
    readonly op: RequestOp;
    readonly requestId: string;
    readonly state: RequestState;
    readonly summary: string;
    readonly resultItem?: number;
}

export type RequestOp = 'received' | 'admitted' | 'triaged' | 'accepted' | 'declined' | 'asked' | 'answered';

const isPerson = (call: RequestCall): boolean => call.actor.kind === 'user';
const isManager = (call: RequestCall): boolean => call.actor.kind === 'agent' && call.manager !== null && call.actor.agentId === call.manager;
const sameActor = (a: PlanActor, b: PlanActor): boolean => (a.kind === 'agent' ? b.kind === 'agent' && a.agentId === b.agentId : b.kind === 'user' && a.userId === b.userId);
const who = (a: PlanActor): string => (a.kind === 'agent' ? `@${a.agentId}` : `@${a.userId}`);

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

function list<T>(value: unknown, what: string, max: number, each: (v: unknown) => T): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return fail('invalid', `${what} must be a list`);
    if (value.length > max) fail('invalid', `${what} holds at most ${max}`);
    return value.map(each);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A proposed plan item, as the manager proposes it or a person edits it. */
export function checkProposedItem(value: unknown): TriageProposedItem {
    if (!isObject(value)) return fail('invalid', 'the proposed item is { title, doneWhen, phase?, assignee?, first?, options? }');
    const phase = value.phase;
    if (phase !== undefined && (!Number.isSafeInteger(phase) || (phase as number) < 1)) fail('invalid', 'the proposed item phase is a phase number');
    if (value.first !== undefined && typeof value.first !== 'boolean') fail('invalid', 'the proposed item first must be true or false');
    const options = list(value.options, 'options', OPTIONS_MAX, (o) => {
        const label = text(isObject(o) ? o.label : undefined, 'an option label', TITLE_MAX);
        const detail = optionalText(isObject(o) ? o.detail : undefined, 'an option detail', TEXT_MAX);
        return detail !== undefined ? { label, detail } : { label };
    });
    return {
        title: text(value.title, 'the proposed item title', TITLE_MAX),
        ...(phase !== undefined ? { phase: phase as number } : {}),
        ...(value.assignee !== undefined && value.assignee !== null ? { assignee: asRequestError(() => checkActor(value.assignee)) } : {}),
        doneWhen: list(value.doneWhen, 'doneWhen', DONE_WHEN_MAX, (d) => text(d, 'a done-when line', TITLE_MAX)),
        ...(value.first === true ? { first: true } : {}),
        ...(options.length ? { options } : {})
    };
}

/** A manager's triage, checked. */
export function checkTriage(value: unknown): Triage {
    if (!isObject(value)) return fail('invalid', 'a triage is { kind, priority, similar, proposedItem?, openIssue, reply, why }');
    const kind = value.kind;
    if (!REQUEST_KINDS.includes(kind as RequestKind)) fail('invalid', `triage kind is one of ${REQUEST_KINDS.join(', ')}`);
    const priority = value.priority;
    if (!REQUEST_PRIORITIES.includes(priority as RequestPriority)) fail('invalid', `triage priority is one of ${REQUEST_PRIORITIES.join(', ')}`);
    if (typeof value.openIssue !== 'boolean') fail('invalid', 'triage openIssue must be true or false');
    const rep = value.reproduced;
    if (rep !== undefined && (!isObject(rep) || typeof rep.ok !== 'boolean')) fail('invalid', 'triage reproduced is { ok, note? }');
    const repNote = isObject(rep) ? optionalText(rep.note, 'the reproduced note', TEXT_MAX) : undefined;
    const similar = list(value.similar, 'similar', SIMILAR_MAX, (s): TriageSimilar => {
        if (!isObject(s)) return fail('invalid', 'a similar item is { ref, note? }');
        const note = optionalText(s.note, 'a similar note', TEXT_MAX);
        return { ref: asRequestError(() => checkRef(s.ref)), ...(note !== undefined ? { note } : {}) };
    });
    if (kind === 'duplicate' && !similar.length) fail('invalid', 'a duplicate names the item it duplicates in similar');
    const proposedItem = kind === 'duplicate' || value.proposedItem === undefined || value.proposedItem === null ? undefined : checkProposedItem(value.proposedItem);
    const priorityNote = optionalText(value.priorityNote, 'the priority note', TEXT_MAX);
    const why = value.why === undefined || value.why === '' ? '' : text(value.why, 'why', TEXT_MAX);
    return {
        kind: kind as RequestKind,
        priority: priority as RequestPriority,
        ...(priorityNote !== undefined ? { priorityNote } : {}),
        ...(rep !== undefined ? { reproduced: { ok: (rep as { ok: boolean }).ok, ...(repNote !== undefined ? { note: repNote } : {}) } } : {}),
        similar,
        ...(proposedItem ? { proposedItem } : {}),
        openIssue: value.openIssue as boolean,
        reply: text(value.reply, 'the reply', TEXT_MAX),
        why
    };
}

/** What `send` takes. The sender is the caller; `toProject` is the actor's own project. */
export interface RequestInput {
    readonly fromProject: ProjectId;
    readonly fromChat?: ChatId;
    /** The chat's title, shown in the receiving inbox; kept only with `fromChat`. */
    readonly fromChatTitle?: string;
    readonly title: string;
    readonly body: string;
    readonly refs?: readonly (Ref | string)[];
}

/**
 * How a request is resolved: accept (optionally with an edited item, a target plan and whether to open a GitHub issue
 * for it — default: the triage's `openIssue`), decline, or ask for more.
 */
export type RequestResolution =
    | { readonly action: 'accept'; readonly item?: TriageProposedItem; readonly planId?: string; readonly openIssue?: boolean }
    | { readonly action: 'decline'; readonly reason: string }
    | { readonly action: 'ask'; readonly question: string };

// ---------------------------------------------------------------------------
// Lookups

export function requestOf(book: RequestsBook, id: unknown): StoredRequest {
    if (typeof id !== 'string') fail('invalid', 'a request is named by its id');
    return book.requests[id as string] ?? fail('not-found', `no request ${String(id)}`);
}

const open = (r: StoredRequest): void => {
    if (r.state === 'accepted' || r.state === 'declined') fail('final', `${r.id} is ${r.state}`);
};

const REASON_TEXT: Record<RequestAskReason, string> = {
    sender: "the sender's project asks you first",
    'no-manager': 'this project has no project manager',
    priority: 'the priority is above what the manager may set alone',
    'add-items': 'the manager may not add items alone',
    assign: 'the manager may not assign alone',
    'decline-duplicates': 'the manager may not decline duplicates alone',
    'open-issues': 'the manager may not open GitHub issues alone'
};

/** The "why you:" line for `reasons`. */
export const whyText = (reasons: readonly RequestAskReason[]): string => reasons.map((r) => REASON_TEXT[r]).join('; ');

function toPerson(r: StoredRequest, needs: 'admit' | 'decision', reasons: RequestAskReason[]): void {
    r.state = 'needs-you';
    r.needs = needs;
    r.reasons = reasons;
}

function leaveNeedsYou(r: StoredRequest): void {
    delete r.needs;
    delete r.reasons;
}

/** Whether `change` owes the manager a triage turn: the request just entered `triaging` (arrived, let in, answered) and there is a manager. */
export const wantsTurn = (r: StoredRequest, change: Pick<RequestChange, 'op'>, call: Pick<RequestCall, 'manager'>): boolean =>
    r.state === 'triaging' && call.manager !== null && (change.op === 'received' || change.op === 'admitted' || change.op === 'answered');

// ---------------------------------------------------------------------------
// Transitions

/**
 * A request arrives from `input.fromProject`, sent by the caller. The target's sender rules decide whether it goes
 * straight to triage or a person lets it in first (decision 3: same-owner requests skip approval unless the rule says
 * "Ask me first"); with no manager, a person handles it. `isMember`: the sender is a member of `fromProject`.
 */
export function receive(book: RequestsBook, call: RequestCall, input: RequestInput, isMember: boolean): { value: StoredRequest; change: RequestChange } {
    if (!isObject(input)) fail('invalid', 'a request is { fromProject, title, body, refs?, fromChat? }');
    const fromProject = text(input.fromProject, 'fromProject', 200) as ProjectId;
    if (fromProject === book.projectId) fail('invalid', 'a project does not send requests to itself');
    const fromChat = optionalText(input.fromChat, 'fromChat', 200) as ChatId | undefined;
    const fromChatTitle = fromChat !== undefined ? optionalText(input.fromChatTitle, 'fromChatTitle', TITLE_MAX) : undefined;
    const title = text(input.title, 'the request title', TITLE_MAX);
    const body = text(input.body, 'the request body', TEXT_MAX);
    const refs = list(input.refs, 'refs', REFS_MAX, (r) => asRequestError(() => checkRef(r)));
    if (Object.keys(book.requests).length >= REQUESTS_KEPT) fail('full', `a project holds at most ${REQUESTS_KEPT} requests`);
    const r: StoredRequest = {
        id: `req_${book.nextId++}`,
        fromProject,
        ...(fromChat !== undefined ? { fromChat } : {}),
        ...(fromChatTitle !== undefined ? { fromChatTitle } : {}),
        sender: call.actor,
        toProject: book.projectId,
        title,
        body,
        refs,
        state: 'triaging',
        turns: 0,
        createdAt: call.now,
        updatedAt: call.now
    };
    const mode = pmSenderMode(call.policy, fromProject, call.actor, isMember);
    if (mode === 'ask') toPerson(r, 'admit', ['sender']);
    else if (call.manager === null) toPerson(r, 'decision', ['no-manager']);
    book.requests[r.id] = r;
    return { value: r, change: { op: 'received', requestId: r.id, state: r.state, summary: `${r.id} from ${fromProject} by ${who(call.actor)}: ${title}${r.state === 'needs-you' ? ` — needs you (${whyText(r.reasons!)})` : ''}` } };
}

/** A person lets a request in that the sender rules held back: to triage, or on to a person when there is no manager. */
export function admit(book: RequestsBook, call: RequestCall, id: string): { value: StoredRequest; change: RequestChange } {
    const r = requestOf(book, id);
    open(r);
    if (!isPerson(call)) fail('forbidden', 'only a person lets a request in');
    if (r.state !== 'needs-you' || r.needs !== 'admit') fail('wrong-state', `${r.id} is not waiting to be let in`);
    leaveNeedsYou(r);
    if (call.manager === null) toPerson(r, 'decision', ['no-manager']);
    else r.state = 'triaging';
    r.updatedAt = call.now;
    return { value: r, change: { op: 'admitted', requestId: r.id, state: r.state, summary: `${r.id} let in by ${who(call.actor)}` } };
}

/**
 * The manager's triage. It lands on the request; when the policy says it needs a person (`needsPersonReasons`: high
 * or urgent always does) the request goes to Needs you with the "why you:" line, else it stays with the manager.
 */
export function triage(book: RequestsBook, call: RequestCall, id: string, value: unknown): { value: StoredRequest; change: RequestChange } {
    const r = requestOf(book, id);
    open(r);
    if (!isManager(call)) fail('forbidden', 'only the project manager triages a request');
    if (r.state !== 'triaging') fail('wrong-state', `${r.id} is ${r.state}, not triaging`);
    const checked = checkTriage(value);
    const reasons = needsPersonReasons(checked, call.policy);
    r.triage = reasons.length && !checked.why ? { ...checked, why: whyText(reasons) } : checked;
    r.triagedAt = call.now;
    if (reasons.length) toPerson(r, 'decision', reasons);
    r.updatedAt = call.now;
    return {
        value: r,
        change: { op: 'triaged', requestId: r.id, state: r.state, summary: `${r.id} triaged ${checked.kind}, ${checked.priority}${reasons.length ? ` — needs you (${whyText(reasons)})` : ''}` }
    };
}

/** What `accept` will add to the plan, decided (and permission-checked) before the actor touches the Plan. */
export interface AcceptPlan {
    readonly item: TriageProposedItem;
    readonly planId?: string;
    /** Whether a GitHub issue is opened for the item: the person's choice, else the triage's. */
    readonly openIssue: boolean;
}

/**
 * Check a resolution against the state and the caller, without changing anything. For an accept it returns the
 * item to add: a person's edit, else the triage's proposal. The manager may only accept what its policy lets it do
 * alone, decline duplicates when `declineDuplicates`, and ask for more; a person may do any of it.
 */
export function checkResolution(book: RequestsBook, call: RequestCall, id: string, resolution: unknown): AcceptPlan | null {
    const r = requestOf(book, id);
    open(r);
    if (!isObject(resolution)) return fail('invalid', 'a resolution is { action: "accept" | "decline" | "ask", … }');
    const action = resolution.action;
    const person = isPerson(call);
    if (!person && !isManager(call)) fail('forbidden', 'only the project manager and people resolve a request');
    if (action === 'accept') {
        if (resolution.planId !== undefined && typeof resolution.planId !== 'string') fail('invalid', 'planId is a plan id');
        const planId = resolution.planId as string | undefined;
        if (resolution.openIssue !== undefined && typeof resolution.openIssue !== 'boolean') fail('invalid', 'openIssue must be true or false');
        const openIssue = (resolution.openIssue as boolean | undefined) ?? r.triage?.openIssue ?? false;
        if (person) {
            const item = resolution.item !== undefined ? checkProposedItem(resolution.item) : (r.triage?.proposedItem ?? fail('invalid', `${r.id} has no proposed item; give one`));
            return { item, openIssue, ...(planId !== undefined ? { planId } : {}) };
        }
        if (resolution.item !== undefined) fail('forbidden', 'the project manager accepts its triage as proposed; triage again to change it');
        if (resolution.openIssue !== undefined && resolution.openIssue !== (r.triage?.openIssue ?? false)) fail('forbidden', 'the project manager accepts its triage as proposed; triage again to change openIssue');
        if (r.state !== 'triaging' || !r.triage) fail('wrong-state', `${r.id} is ${r.state}${r.triage ? '' : ' with no triage'}; triage it first`);
        const reasons = needsPersonReasons(r.triage!, call.policy);
        if (reasons.length) fail('needs-person', `${r.id} needs a person: ${whyText(reasons)}`);
        const item = r.triage!.proposedItem ?? fail('invalid', `${r.id} is a ${r.triage!.kind} with no proposed item; decline it instead`);
        return { item, openIssue, ...(planId !== undefined ? { planId } : {}) };
    }
    if (action === 'decline') {
        text(resolution.reason, 'the decline reason', TEXT_MAX);
        if (!person) {
            if (r.state !== 'triaging') fail('wrong-state', `${r.id} is ${r.state}`);
            if (r.triage?.kind !== 'duplicate') fail('needs-person', `only a person declines a request that is not a duplicate`);
            if (!call.policy.autonomy.declineDuplicates) fail('needs-person', `${r.id} needs a person: ${whyText(['decline-duplicates'])}`);
        }
        return null;
    }
    if (action === 'ask') {
        text(resolution.question, 'the question', TEXT_MAX);
        if (r.state === 'asked-for-more') fail('wrong-state', `${r.id} already waits on the sender`);
        if (!person && r.state !== 'triaging') fail('wrong-state', `${r.id} is ${r.state}`);
        return null;
    }
    return fail('invalid', 'a resolution action is "accept", "decline" or "ask"');
}

/**
 * Apply a resolution `checkResolution` passed; an accept carries the plan item it became and records whether a GitHub
 * issue is opened for it (`resolution.openIssue`, else the triage's).
 */
export function resolve(book: RequestsBook, call: RequestCall, id: string, resolution: RequestResolution, resultItem?: number): { value: StoredRequest; change: RequestChange } {
    const r = requestOf(book, id);
    leaveNeedsYou(r);
    delete r.question;
    r.updatedAt = call.now;
    if (resolution.action === 'accept') {
        r.state = 'accepted';
        if (resultItem !== undefined) r.resultItem = resultItem;
        r.openIssue = resolution.openIssue ?? r.triage?.openIssue ?? false;
        return { value: r, change: { op: 'accepted', requestId: r.id, state: r.state, summary: `${r.id} accepted by ${who(call.actor)}${resultItem !== undefined ? ` as #${resultItem}` : ''}`, ...(resultItem !== undefined ? { resultItem } : {}) } };
    }
    if (resolution.action === 'decline') {
        r.state = 'declined';
        r.declineReason = resolution.reason.trim();
        return { value: r, change: { op: 'declined', requestId: r.id, state: r.state, summary: `${r.id} declined by ${who(call.actor)}: ${r.declineReason}` } };
    }
    r.state = 'asked-for-more';
    r.question = resolution.question.trim();
    return { value: r, change: { op: 'asked', requestId: r.id, state: r.state, summary: `${r.id}: ${who(call.actor)} asked for more` } };
}

/**
 * The sender (or a person) answers a request that was asked for more: the answer joins the body and it goes back to
 * the manager's triage — or to a person when there is no manager.
 */
export function answer(book: RequestsBook, call: RequestCall, id: string, value: unknown): { value: StoredRequest; change: RequestChange } {
    const r = requestOf(book, id);
    open(r);
    if (!isPerson(call) && !sameActor(call.actor, r.sender)) fail('forbidden', 'only the sender or a person answers a request');
    if (r.state !== 'asked-for-more') fail('wrong-state', `${r.id} is ${r.state}, not asked for more`);
    const more = text(value, 'the answer', TEXT_MAX);
    const body = `${r.body}\n\n${who(call.actor)}: ${more}`;
    if (body.length > TEXT_MAX * 4) fail('full', `${r.id} is too long to add to; send a new request`);
    r.body = body;
    delete r.question;
    // A new triage is owed: the old one was made without the answer.
    delete r.triage;
    delete r.triagedAt;
    if (call.manager === null) toPerson(r, 'decision', ['no-manager']);
    else r.state = 'triaging';
    r.updatedAt = call.now;
    return { value: r, change: { op: 'answered', requestId: r.id, state: r.state, summary: `${r.id} answered by ${who(call.actor)}` } };
}

/** Remember that this project sent a request to `to` (bounded; the oldest target goes first). */
export function noteSentTo(book: RequestsBook, to: ProjectId): void {
    if (book.sentTo.includes(to)) return;
    book.sentTo.push(to);
    if (book.sentTo.length > SENT_TO_MAX) book.sentTo.splice(0, book.sentTo.length - SENT_TO_MAX);
}
