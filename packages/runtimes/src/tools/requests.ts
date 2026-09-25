/**
 * The `requests` tool family (#759; PRJ-15): how work moves between projects — `requests_list`, `requests_triage` and
 * `requests_resolve` for the receiving project's manager, and `projects_request` for any agent to send one
 * (docs/design/projects/HANDOFF.md, "Project manager and requests").
 *
 * The tools never touch the Requests actor: they speak to an injected `RequestsPort` (the session binds it under the
 * agent's principal, in the chat's project; the actor enforces every rule again). What the tools add is the
 * agent-facing side: they read the inbox first and refuse with a message the model can act on, keep triage and
 * resolve to the project manager, say which triage has to come to a person (`needsPersonReasons` — high or urgent
 * priority always does), and tell a sender whether the target lets the request straight in or asks a person first.
 */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import { REQUEST_KINDS, REQUEST_PRIORITIES, REQUEST_STATES, REQUEST_TOOLS, formatRef, needsPersonReasons, parseRef, pmSenderMode, type AgentId, type ChatId, type PmAskReason, type PmPolicy, type PlanActor, type ProjectId, type ProjectRequest, type Ref, type RequestState, type Triage } from '@agentic/core';
import type { ToolCall } from './ports.js';

/** What the tools read before they act: the session's project, its manager and policy, its incoming requests, and who is calling. */
export interface RequestsBoard {
    /** The session's project: the one requests arrive in, and the one `projects_request` sends from. */
    readonly project: ProjectId;
    /** The agent the session runs as. */
    readonly me: AgentId;
    /** Whether `me` is a member of `project`. */
    readonly member: boolean;
    /** The project's manager agent (`ProjectRecord.pm.agentId`), when it has one. */
    readonly manager?: AgentId;
    /** The project's manager policy (`PM_POLICY_DEFAULT` when none was set). */
    readonly policy: PmPolicy;
    /** The requests sent to `project`, newest first. */
    readonly requests: readonly ProjectRequest[];
}

/** What another project lets in: its manager policy, and whether it has a manager to triage at all. */
export interface RequestTarget {
    readonly project: ProjectId;
    readonly name?: string;
    readonly policy: PmPolicy;
    readonly hasManager: boolean;
}

/** How the manager resolves a triaged request. */
export type RequestResolution =
    /** Add the triage's proposed item (with `edits` over it) and link it as `resultItem`. */
    | { readonly action: 'accept' }
    /** Decline with a reason posted back to the sender. */
    | { readonly action: 'decline'; readonly reason: string }
    /** Ask the sender for more; the request waits on them. */
    | { readonly action: 'ask-for-more'; readonly question: string };

export interface NewRequest {
    readonly toProject: ProjectId;
    readonly title: string;
    readonly body: string;
    readonly refs: readonly Ref[];
}

/**
 * The Requests actor, as the request tools see it (#759). One per session, bound in the session's project under the
 * agent's principal. The actor enforces the rules the tools check first — a tool refusal only saves a round trip and
 * words it for the model.
 */
export interface RequestsPort {
    board(call: ToolCall): Promise<RequestsBoard>;
    /** Another project as a sender sees it; `null` when there is no such project. */
    target(projectId: ProjectId, call: ToolCall): Promise<RequestTarget | null>;
    /** Store the manager's triage: the actor moves the request to `needs-you` when `triage.why` is not empty. */
    triage(requestId: string, triage: Triage, call: ToolCall): Promise<ProjectRequest>;
    resolve(requestId: string, resolution: RequestResolution, call: ToolCall): Promise<ProjectRequest>;
    /** Send a request from the session's project (and its chat, as `fromChat`) to `input.toProject`, as the session's agent. */
    send(input: NewRequest, call: ToolCall): Promise<ProjectRequest>;
}

/** A refusal the model can act on: the message says why and what to try instead. */
export class RequestRefusal extends Error {
    override readonly name = 'RequestRefusal';
    constructor(reason: string) {
        super(`refused: ${reason}`);
    }
}

/** A request as the tools answer it: refs in the text syntax, the sender as a handle-free id. */
export interface RequestView {
    readonly id: string;
    readonly from: ProjectId;
    readonly fromChat?: ChatId;
    readonly sender: string;
    readonly title: string;
    readonly body: string;
    readonly refs: readonly string[];
    readonly state: RequestState;
    readonly triage?: Triage;
    readonly resultItem?: number;
    readonly declineReason?: string;
}

const actorText = (a: PlanActor): string => (a.kind === 'agent' ? a.agentId : a.userId);

export function requestView(r: ProjectRequest): RequestView {
    return {
        id: r.id,
        from: r.fromProject,
        ...(r.fromChat !== undefined ? { fromChat: r.fromChat } : {}),
        sender: actorText(r.sender),
        title: r.title,
        body: r.body,
        refs: r.refs.map(formatRef),
        state: r.state,
        ...(r.triage ? { triage: r.triage } : {}),
        ...(r.resultItem !== undefined ? { resultItem: r.resultItem } : {}),
        ...(r.declineReason !== undefined ? { declineReason: r.declineReason } : {})
    };
}

const REASON_TEXT: Record<PmAskReason, string> = {
    priority: 'the priority is above what the policy lets the project manager set alone (high and urgent always come to a person)',
    'add-items': 'the policy does not let the project manager add items alone',
    assign: 'the policy does not let the project manager assign alone',
    'decline-duplicates': 'the policy does not let the project manager decline duplicates alone',
    'open-issues': 'the policy does not let the project manager open GitHub issues alone'
};

/** The "why you:" line for `reasons`; empty when there are none. */
export function requestWhyLine(reasons: readonly PmAskReason[]): string {
    return reasons.map((r) => REASON_TEXT[r]).join('; ');
}

/** The refusal for a manager-only tool when the caller is not this project's manager. */
export function requestManagerRefusal(board: RequestsBoard, tool: 'requests_triage' | 'requests_resolve'): string | undefined {
    if (board.manager !== undefined && board.manager === board.me) return undefined;
    return `${tool} is for this project's manager, and you are not it. Ask ${board.manager !== undefined ? board.manager : 'a person'} in the chat instead.`;
}

function find(board: RequestsBoard, id: string): ProjectRequest {
    const hit = board.requests.find((r) => r.id === id);
    if (!hit) throw new RequestRefusal(`"${id}" is not a request to this project. Try requests_list.`);
    return hit;
}

const CLOSED: readonly RequestState[] = ['accepted', 'declined'];

/**
 * The refusal for resolving `request` with `resolution` on the manager's own authority, or `undefined` when it may go
 * ahead. Accept needs a triage with a proposed item the policy lets it add; decline alone is only for a duplicate the
 * policy lets it decline; asking for more is always the manager's to do.
 */
export function requestResolveRefusal(board: RequestsBoard, request: ProjectRequest, resolution: RequestResolution): string | undefined {
    if (CLOSED.includes(request.state)) return `${request.id} is already ${request.state}.`;
    if (resolution.action === 'ask-for-more') return undefined;
    const t = request.triage;
    if (!t) return `${request.id} has no triage yet. Triage it with requests_triage first.`;
    const reasons = needsPersonReasons(t, board.policy);
    if (reasons.length) return `${request.id} needs a person: ${requestWhyLine(reasons)}. It waits in the Requests inbox; say so in the chat.`;
    if (resolution.action === 'accept') {
        if (t.kind === 'duplicate') return `${request.id} was triaged as a duplicate; decline it with a reason pointing at the item it duplicates.`;
        if (!t.proposedItem) return `${request.id}'s triage proposes no item. Triage it again with proposedItem, or decline it.`;
        return undefined;
    }
    if (t.kind !== 'duplicate') return `only a person declines a request that is not a duplicate. Ask for more with requests_resolve, or leave it to a person in the Requests inbox.`;
    return undefined;
}

const call = (ctx: { toolCallId: string; signal: AbortSignal }): ToolCall => ({ callId: ctx.toolCallId, signal: ctx.signal });

function need(port: RequestsPort | undefined, tool: string): RequestsPort {
    if (!port) throw new Error(`${tool}: requests are not available here (the session is in no project, or this host has no Requests actor)`);
    return port;
}

const REF_SYNTAX = '#9, signalx#14, @lint, path/file.ts:38-41, pr:604, 4f2a9c1, chat:msg-42, doc:architecture.md#7, or a URL';

function refsOf(texts: readonly string[] | undefined): Ref[] {
    return (texts ?? []).map((t) => {
        const ref = parseRef(t);
        if (!ref) throw new RequestRefusal(`"${t}" is not one ref. Write one of: ${REF_SYNTAX}.`);
        return ref;
    });
}

const requestId = z.string().min(1).describe('The request id, `req_…` (requests_list).');
const actor = z.union([z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }), z.object({ kind: z.literal('user'), userId: z.string().min(1) })]);

export const requestsListInput = z.object({ state: z.enum(REQUEST_STATES as [RequestState, ...RequestState[]]).optional().describe('Only requests in this state.') });
export const requestsTriageInput = z.object({
    request: requestId,
    kind: z.enum(REQUEST_KINDS as [Triage['kind'], ...Triage['kind'][]]),
    priority: z.enum(REQUEST_PRIORITIES as [Triage['priority'], ...Triage['priority'][]]).describe('High and urgent always come to a person.'),
    priorityNote: z.string().min(1).optional().describe('Why this priority ("blocks a release in another project").'),
    reproduced: z.object({ ok: z.boolean(), note: z.string().min(1).optional() }).optional().describe('Whether you reproduced the report, and how.'),
    similar: z.array(z.object({ ref: z.string().min(1), note: z.string().min(1).optional() })).optional().describe('Earlier items that look alike; for a duplicate, the item it duplicates.'),
    proposedItem: z
        .object({
            title: z.string().min(1),
            phase: z.number().int().min(1).optional(),
            assignee: actor.optional(),
            doneWhen: z.array(z.string().min(1)).min(1),
            first: z.boolean().optional()
        })
        .optional()
        .describe('The plan item to add in this project when the request is accepted. Not for a duplicate.'),
    openIssue: z.boolean().optional().describe('Also open a GitHub issue through the project’s git feature.'),
    reply: z.string().min(1).describe('What will be posted back to the sender.')
});
export const requestsResolveInput = z.object({
    request: requestId,
    action: z.enum(['accept', 'decline', 'ask-for-more']),
    reason: z.string().min(1).optional().describe('Why it is declined (decline only).'),
    question: z.string().min(1).optional().describe('What the sender should add (ask-for-more only).')
});
export const projectsRequestInput = z.object({
    toProject: z.string().min(1).describe('The project to send it to (its id).'),
    title: z.string().min(1),
    body: z.string().min(1).describe('What is needed and why, with enough for the other project’s manager to triage it.'),
    refs: z.array(z.string().min(1)).optional().describe(`Refs in the shared syntax: ${REF_SYNTAX}.`)
});

const READ = { readOnly: true, idempotent: true } as const;
const WRITE = { readOnly: false, destructive: false } as const;

/** The four request tools over `port`, in `REQUEST_TOOLS` order. Absent port: each reports requests unavailable. */
export function requestTools(port: RequestsPort | undefined) {
    const [LIST, TRIAGE, RESOLVE, SEND] = REQUEST_TOOLS;
    return [
        defineTool({
            name: LIST,
            description: 'The requests other projects sent to this project: origin, sender, what they asked, state, the triage and the item an accepted one became.',
            input: requestsListInput,
            annotations: READ,
            execute: async (input, ctx) => {
                const board = await need(port, LIST).board(call(ctx));
                if (!board.member) throw new RequestRefusal(`you are not a member of ${board.project}, so you cannot read its requests.`);
                const requests = board.requests.filter((r) => input.state === undefined || r.state === input.state).map(requestView);
                return { project: board.project, manager: board.manager === board.me, requests };
            }
        }),
        defineTool({
            name: TRIAGE,
            description: 'Triage a request as this project’s manager: kind, priority, whether you reproduced it, similar items, the item you propose and the reply. Says whether the policy lets you resolve it or it goes to a person.',
            input: requestsTriageInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const p = need(port, TRIAGE);
                const board = await p.board(call(ctx));
                const refusal = requestManagerRefusal(board, TRIAGE);
                if (refusal) throw new RequestRefusal(refusal);
                const request = find(board, input.request);
                if (CLOSED.includes(request.state)) throw new RequestRefusal(`${request.id} is already ${request.state}.`);
                if (input.kind === 'duplicate' && input.proposedItem) throw new RequestRefusal('a duplicate adds no item: drop proposedItem and put the item it duplicates in similar.');
                if (input.kind === 'duplicate' && !input.similar?.length) throw new RequestRefusal('name the item it duplicates in similar.');
                if (input.kind !== 'duplicate' && !input.proposedItem) throw new RequestRefusal('propose the item to add (proposedItem), or triage it as a duplicate.');
                const similar = (input.similar ?? []).map((s) => ({ ref: refsOf([s.ref])[0]!, ...(s.note !== undefined ? { note: s.note } : {}) }));
                const draft: Triage = {
                    kind: input.kind,
                    priority: input.priority,
                    ...(input.priorityNote !== undefined ? { priorityNote: input.priorityNote } : {}),
                    ...(input.reproduced ? { reproduced: { ok: input.reproduced.ok, ...(input.reproduced.note !== undefined ? { note: input.reproduced.note } : {}) } } : {}),
                    similar,
                    ...(input.proposedItem
                        ? {
                              proposedItem: {
                                  title: input.proposedItem.title,
                                  ...(input.proposedItem.phase !== undefined ? { phase: input.proposedItem.phase } : {}),
                                  ...(input.proposedItem.assignee ? { assignee: input.proposedItem.assignee as PlanActor } : {}),
                                  doneWhen: input.proposedItem.doneWhen,
                                  ...(input.proposedItem.first !== undefined ? { first: input.proposedItem.first } : {})
                              }
                          }
                        : {}),
                    openIssue: input.openIssue ?? false,
                    reply: input.reply,
                    why: ''
                };
                const reasons = needsPersonReasons(draft, board.policy);
                const triage: Triage = { ...draft, why: requestWhyLine(reasons) };
                const out = await p.triage(request.id, triage, call(ctx));
                return reasons.length
                    ? { request: out.id, state: out.state, needsPerson: true, why: triage.why, note: 'a person decides this one in the Requests inbox; do not resolve it.' }
                    : { request: out.id, state: out.state, needsPerson: false, note: 'you may resolve it with requests_resolve.' };
            }
        }),
        defineTool({
            name: RESOLVE,
            description: 'Resolve a triaged request as this project’s manager: accept it (adds the proposed item), decline a duplicate with a reason, or ask the sender for more. Refused when the policy says a person decides.',
            input: requestsResolveInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const p = need(port, RESOLVE);
                const board = await p.board(call(ctx));
                const refusal = requestManagerRefusal(board, RESOLVE);
                if (refusal) throw new RequestRefusal(refusal);
                const request = find(board, input.request);
                let resolution: RequestResolution;
                if (input.action === 'decline') {
                    if (input.reason === undefined) throw new RequestRefusal('say why it is declined (reason); it is posted back to the sender.');
                    resolution = { action: 'decline', reason: input.reason };
                } else if (input.action === 'ask-for-more') {
                    if (input.question === undefined) throw new RequestRefusal('say what the sender should add (question).');
                    resolution = { action: 'ask-for-more', question: input.question };
                } else resolution = { action: 'accept' };
                const why = requestResolveRefusal(board, request, resolution);
                if (why) throw new RequestRefusal(why);
                const out = await p.resolve(request.id, resolution, call(ctx));
                return { request: out.id, state: out.state, ...(out.resultItem !== undefined ? { item: `#${out.resultItem}` } : {}), ...(out.declineReason !== undefined ? { declineReason: out.declineReason } : {}) };
            }
        }),
        defineTool({
            name: SEND,
            description: 'Send a request to another project’s manager: what you need from that project, with refs. Its policy decides whether it goes straight to triage or a person there approves it first.',
            input: projectsRequestInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const refs = refsOf(input.refs);
                const p = need(port, SEND);
                const board = await p.board(call(ctx));
                const to = input.toProject as ProjectId;
                if (to === board.project) throw new RequestRefusal('that is this project. Add the work to its plan, or ask its manager in the chat.');
                if (!board.member) throw new RequestRefusal(`you are not a member of ${board.project}, so you cannot send requests from it.`);
                const target = await p.target(to, call(ctx));
                if (!target) throw new RequestRefusal(`there is no project "${input.toProject}". Try the projects tool to list them.`);
                if (!target.hasManager) throw new RequestRefusal(`${target.name ?? target.project} has no project manager to take requests. Ask a person there instead.`);
                const mode = pmSenderMode(target.policy, board.project, { kind: 'agent', agentId: board.me }, board.member);
                const out = await p.send({ toProject: to, title: input.title, body: input.body, refs }, call(ctx));
                return {
                    request: out.id,
                    state: out.state,
                    mode,
                    note: mode === 'allowed' ? `sent: ${target.name ?? target.project}'s manager triages it.` : `sent: a person in ${target.name ?? target.project} approves it before its manager triages it.`
                };
            }
        })
    ];
}
