/**
 * The `requests` tool family on the orchestration surface (#759; PRJ-15): `requests_list`, `requests_triage`,
 * `requests_resolve` and `projects_request` for an external client, over an injected `RequestsMcpPort` (the app binds
 * it to the Requests actor under the client's principal). An external client acts in its user's name — a person — so
 * it may triage and resolve what the policy would keep from the project manager; the Requests actor enforces every
 * rule (sender policy, states) and its refusals come back as `isError` results. The family is gated by the `projects`
 * scope: requests belong to projects.
 */
import { REQUEST_KINDS, REQUEST_PRIORITIES, REQUEST_STATES, REQUEST_TOOLS, parseRef, type ChatId, type PlanActor, type ProjectId, type ProjectRequest, type Ref, type RequestState, type Scope, type Triage } from '@agentic/core';
import type { AnyTool, ToolAnnotations } from '@sigx/ai';
import { z } from 'zod';
import type { ScopedTool } from './plan.js';

/** How a person resolves a request. `accept` adds the triage's proposed item and links it as `resultItem`. */
export type RequestMcpResolution = { readonly action: 'accept' } | { readonly action: 'decline'; readonly reason: string } | { readonly action: 'ask-for-more'; readonly question: string };

export interface RequestMcpSend {
    readonly fromProject: ProjectId;
    readonly fromChat?: ChatId;
    readonly toProject: ProjectId;
    readonly title: string;
    readonly body: string;
    readonly refs: readonly Ref[];
}

/** The Requests actor as the surface calls it, one per authenticated client. */
export interface RequestsMcpPort {
    /** The requests sent to `projectId`, newest first. */
    list(projectId: ProjectId, state?: RequestState): Promise<readonly ProjectRequest[]>;
    triage(projectId: ProjectId, requestId: string, triage: Triage): Promise<ProjectRequest>;
    resolve(projectId: ProjectId, requestId: string, resolution: RequestMcpResolution): Promise<ProjectRequest>;
    /** Send as the client's user; the target's sender policy decides whether a person there approves it first. */
    send(input: RequestMcpSend): Promise<ProjectRequest>;
}

/** The scope the requests family is gated by. */
export const REQUESTS_SCOPE: Scope = 'projects';

const READ: ToolAnnotations = { readOnly: true, idempotent: true };
const WRITE: ToolAnnotations = { readOnly: false, destructive: false };

const projectId = z.string().min(1).describe('The project the requests were sent to (projects_list).');
const requestId = z.string().min(1).describe('The request id, `req_…` (requests_list).');
const actor = z.union([z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }), z.object({ kind: z.literal('user'), userId: z.string().min(1) })]);
const REF_SYNTAX = '#9, signalx#14, @lint, path/file.ts:38-41, pr:604, 4f2a9c1, chat:msg-42, doc:architecture.md#7 or a URL';

function refOf(tool: string, text: string): Ref {
    const ref = parseRef(text);
    if (!ref) throw new Error(`${tool}: "${text}" is not one ref — write ${REF_SYNTAX}`);
    return ref;
}

/**
 * The request tools (`REQUEST_TOOLS` order) over `port`, made with the surface's gated `tool` factory. A host without
 * a Requests port declares none of them, so a client never sees a tool that cannot work.
 */
export function requestsMcpTools(port: RequestsMcpPort | undefined, tool: ScopedTool): AnyTool[] {
    if (!port) return [];
    const [LIST, TRIAGE, RESOLVE, SEND] = REQUEST_TOOLS;
    return [
        tool({
            name: LIST,
            scope: REQUESTS_SCOPE,
            description: 'The requests other projects sent to a project: origin, sender, title, body, refs, state, triage and the item an accepted one became.',
            input: z.object({ projectId, state: z.enum(REQUEST_STATES as [RequestState, ...RequestState[]]).optional() }),
            annotations: READ,
            run: async (input) => ({ requests: await port.list(input.projectId as ProjectId, input.state) })
        }),
        tool({
            name: TRIAGE,
            scope: REQUESTS_SCOPE,
            description: 'Triage a request: kind, priority, reproduced, similar items (refs), the proposed item and the reply posted back to the sender.',
            input: z.object({
                projectId,
                request: requestId,
                kind: z.enum(REQUEST_KINDS as [Triage['kind'], ...Triage['kind'][]]),
                priority: z.enum(REQUEST_PRIORITIES as [Triage['priority'], ...Triage['priority'][]]),
                priorityNote: z.string().min(1).optional(),
                reproduced: z.object({ ok: z.boolean(), note: z.string().min(1).optional() }).optional(),
                similar: z.array(z.object({ ref: z.string().min(1), note: z.string().min(1).optional() })).optional(),
                proposedItem: z.object({ title: z.string().min(1), phase: z.number().int().min(1).optional(), assignee: actor.optional(), doneWhen: z.array(z.string().min(1)).min(1), first: z.boolean().optional() }).optional(),
                openIssue: z.boolean().optional(),
                reply: z.string().min(1)
            }),
            annotations: WRITE,
            run: (input) => {
                if (input.kind === 'duplicate' && input.proposedItem) throw new Error(`${TRIAGE}: a duplicate adds no item — drop proposedItem and name the item it duplicates in similar`);
                const p = input.proposedItem;
                const triage: Triage = {
                    kind: input.kind,
                    priority: input.priority,
                    ...(input.priorityNote !== undefined ? { priorityNote: input.priorityNote } : {}),
                    ...(input.reproduced ? { reproduced: { ok: input.reproduced.ok, ...(input.reproduced.note !== undefined ? { note: input.reproduced.note } : {}) } } : {}),
                    similar: (input.similar ?? []).map((s) => ({ ref: refOf(TRIAGE, s.ref), ...(s.note !== undefined ? { note: s.note } : {}) })),
                    ...(p ? { proposedItem: { title: p.title, doneWhen: p.doneWhen, ...(p.phase !== undefined ? { phase: p.phase } : {}), ...(p.assignee ? { assignee: p.assignee as PlanActor } : {}), ...(p.first !== undefined ? { first: p.first } : {}) } } : {}),
                    openIssue: input.openIssue ?? false,
                    reply: input.reply,
                    // A person triages here: the "why you:" line is the manager's, and the actor fills it when it routes.
                    why: ''
                };
                return port.triage(input.projectId as ProjectId, input.request, triage);
            }
        }),
        tool({
            name: RESOLVE,
            scope: REQUESTS_SCOPE,
            description: 'Resolve a request: accept it (adds the triage’s proposed item), decline it with a reason, or ask the sender for more.',
            input: z.object({ projectId, request: requestId, action: z.enum(['accept', 'decline', 'ask-for-more']), reason: z.string().min(1).optional(), question: z.string().min(1).optional() }),
            annotations: WRITE,
            run: (input) => {
                let resolution: RequestMcpResolution;
                if (input.action === 'decline') {
                    if (input.reason === undefined) throw new Error(`${RESOLVE}: decline needs a reason — it is posted back to the sender`);
                    resolution = { action: 'decline', reason: input.reason };
                } else if (input.action === 'ask-for-more') {
                    if (input.question === undefined) throw new Error(`${RESOLVE}: ask-for-more needs the question for the sender`);
                    resolution = { action: 'ask-for-more', question: input.question };
                } else resolution = { action: 'accept' };
                return port.resolve(input.projectId as ProjectId, input.request, resolution);
            }
        }),
        tool({
            name: SEND,
            scope: REQUESTS_SCOPE,
            description: 'Send a request from one project to another project’s manager, with refs. The target’s policy decides whether a person there approves it before triage.',
            input: z.object({
                fromProject: z.string().min(1).describe('The project sending it.'),
                fromChat: z.string().min(1).optional().describe('The chat the need came up in.'),
                toProject: z.string().min(1).describe('The project to send it to.'),
                title: z.string().min(1),
                body: z.string().min(1),
                refs: z.array(z.string().min(1)).optional()
            }),
            annotations: WRITE,
            run: (input) => {
                if (input.fromProject === input.toProject) throw new Error(`${SEND}: a request goes to another project — add the work to this project's plan instead`);
                const refs = (input.refs ?? []).map((r) => refOf(SEND, r));
                return port.send({
                    fromProject: input.fromProject as ProjectId,
                    ...(input.fromChat !== undefined ? { fromChat: input.fromChat as ChatId } : {}),
                    toProject: input.toProject as ProjectId,
                    title: input.title,
                    body: input.body,
                    refs
                });
            }
        })
    ];
}
