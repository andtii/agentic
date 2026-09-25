/**
 * Requests actor — `{ws}:requests:{projectId}` (#758; PRJ-14/PRJ-15; architecture §10 "Projects (redesign)").
 *
 * One per project: the requests other projects sent to it (incoming), and which projects it sent requests to (so
 * `sent()` can ask each of them). A request lives on the receiving project's actor only; every state rule is in
 * `rules.ts` and runs here server-side, whoever calls — the web inbox, the `requests_*` / `projects_request` tools
 * (#759) or another actor. The caller is the principal: a person (`user`) or an agent.
 *
 * - **send**: the sender's project must exist in the workspace; the receiving project's sender rules decide
 *   whether it goes straight to triage or a person lets it in first (decision 3). The sender's project actor
 *   remembers the target (`noteSent`).
 * - **triage turn**: whenever a request enters `triaging` and the project has a manager (`project.pm.agentId`, else
 *   the coordinator), `RequestsTurnPort.triage` starts a turn for that agent (production: a Task assigned to it). Its
 *   personality shapes the reply; its policy (`pmPolicyOf`), never its personality, decides what needs a person.
 * - **accept** adds the proposed item to the project's Plan over a hop (the first plan, or a `Requests` plan it
 *   creates; the item's phase, else the first phase with open work), assigns it when the triage names an assignee,
 *   and links it as `resultItem`. The Plan checks the caller again: only the manager and people add items.
 *
 * Every transition is a `request.changed` audit record with its actor. Workers eviction rule: every mutation ends in
 * `ctx.save()` inside the turn.
 */
import type { AgentId, Plan, PlanActor, Principal, ProjectId, ProjectRecord, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { defineActor, type ActorClient, type ActorContext, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { auditPort, type AuditPort } from '../audit/port.js';
import { sameWorkspace, workspaceKey } from '../auth/index.js';
import { definePlanActor } from '../plan/actor.js';
import { planKey } from '../plan/key.js';
import { PlanRuleError, type PlanItemInput } from '../plan/rules.js';
import { TaskActor } from '../task/actor.js';
import { taskKey } from '../task/key.js';
import { Workspace } from '../workspace/index.js';
import { pmPolicyOf } from '../workspace/pm-policy.js';
import { parseRequestsKey, REQUESTS_TYPE, requestsKey } from './key.js';
import {
    admit,
    answer,
    checkResolution,
    emptyBook,
    noteSentTo,
    receive,
    requestOf,
    RequestRuleError,
    requestView,
    resolve,
    triage,
    wantsTurn,
    type AcceptPlan,
    type RequestCall,
    type RequestChange,
    type RequestInput,
    type RequestResolution,
    type RequestsBook,
    type RequestView,
    type StoredRequest
} from './rules.js';

// ---------------------------------------------------------------------------
// State, ports and options

export interface RequestsState extends RequestsBook {
    /** Audit records written so far — the idempotency key's counter. */
    auditSeq: number;
}

/** Where the actor reads the workspace's projects (their members, manager and policy). */
export interface RequestsProjectPort {
    projects(ctx: ActorContext<RequestsState>, workspaceId: WorkspaceId): Promise<readonly Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'>[]>;
}

/** The production port: the project records on the Workspace root, over a hop. */
export const workspaceRequestProjects: RequestsProjectPort = {
    async projects(ctx, workspaceId) {
        return ctx.actor(Workspace, workspaceKey(workspaceId)).projects();
    }
};

/** One triage turn owed to the receiving project's manager. */
export interface RequestTurn {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    readonly projectName: string;
    readonly managerId: AgentId;
    readonly request: RequestView;
    /** 1-based: the how-many-th turn for this request (a turn per arrival or answer). */
    readonly turn: number;
}

/** How a triage turn reaches the manager agent. */
export interface RequestsTurnPort {
    triage(hop: RequestTurnHop, turn: RequestTurn): Promise<void>;
}

/** How the turn port reaches the rest of the platform: the Requests actor's own `ctx.actor`. */
export interface RequestTurnHop {
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClient<D>;
}

/** The task a triage turn creates — deterministic, so a retried turn finds the task it already made. */
export function requestTurnTaskId(projectId: ProjectId, requestId: string, turn: number): TaskId {
    return `task_${requestId}_${projectId}_${turn}` as TaskId;
}

/** The production turn: a Task assigned to the manager, in the project, asking it to triage the request. */
export const taskTriageTurns: RequestsTurnPort = {
    async triage(hop, t) {
        const r = t.request;
        const contract: TaskContract = {
            objective: `Triage request ${r.id} sent to ${t.projectName}: "${r.title}". Read it with requests_list, then call requests_triage with your triage and, when your policy lets you act alone, requests_resolve.`,
            origin: { kind: 'trigger', triggerId: `request:${t.projectId}:${r.id}` },
            assignee: t.managerId,
            context: [{ type: 'text', text: `Request ${r.id} from project ${r.fromProject}${r.fromChat ? ` (chat ${r.fromChat})` : ''}, sent by ${r.sender.kind === 'agent' ? `agent ${r.sender.agentId}` : `a person (${r.sender.userId})`}.\n\n${r.title}\n\n${r.body}` }],
            constraints: {},
            projectId: t.projectId
        };
        await hop.actor(TaskActor, taskKey(t.workspaceId, requestTurnTaskId(t.projectId, r.id, t.turn))).create(contract, { owner: t.managerId });
    }
};

/** No turns (tests; a deployment without agents): the manager finds requests through `requests_list`. */
export const NO_REQUEST_TURNS: RequestsTurnPort = { async triage() {} };

export interface RequestsActorOptions {
    /** Default: the Workspace record (`workspaceRequestProjects`). */
    readonly projects?: RequestsProjectPort;
    /** Default: `taskTriageTurns`. */
    readonly turns?: RequestsTurnPort;
    /** Clock; default `Date.now`. */
    readonly now?: () => number;
    /** Override the policy chain. Default: the package's `sameWorkspace`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
    /** Waive the identity gate (tests). */
    readonly allowAnonymous?: true;
    /** Where `request.*` records go. Default: the workspace's Audit log. */
    readonly audit?: AuditPort;
}

/** A request and the side it is on, for `linked()`. */
export interface LinkedRequest {
    readonly direction: 'incoming' | 'sent';
    readonly request: RequestView;
}

const principalActor = (p: Principal | null | undefined): PlanActor | null => {
    if (p?.kind === 'user') return { kind: 'user', userId: p.userId };
    if (p?.kind === 'agent') return { kind: 'agent', agentId: p.agentId };
    return null;
};

const byOf = (a: PlanActor): string => (a.kind === 'agent' ? `agent:${a.agentId}` : `user:${a.userId}`);

/** Only its `type` matters for a hop: the host runs the app's own Plan definition. */
const PlanRef = definePlanActor();

/** What one Requests actor calls on another (typed here: the definition cannot name its own client type). */
interface RequestsPeer {
    from(projectId: ProjectId): Promise<RequestView[]>;
    noteSent(to: ProjectId): Promise<void>;
}

const newestFirst = (a: StoredRequest, b: StoredRequest) => b.updatedAt - a.updatedAt || Number(b.id.slice(4)) - Number(a.id.slice(4));

// ---------------------------------------------------------------------------
// Definition

export function defineRequestsActor(options: RequestsActorOptions = {}) {
    const now = options.now ?? Date.now;
    const audit = options.audit ?? auditPort();
    const projectsPort = options.projects ?? workspaceRequestProjects;
    const turns = options.turns ?? taskTriageTurns;
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? sameWorkspace;

    type Ctx = ActorContext<RequestsState>;

    const toServerError = (error: unknown): never => {
        if (error instanceof RequestRuleError || error instanceof PlanRuleError) throw new ServerFnError(error.status, error.message, { code: error.code });
        throw error;
    };

    /** Held per isolate — one actor instance lives in one — so it spans every call of an activation. */
    const acceptingNow = new Set<string>();

    let self: AnyActorDefinition | undefined;
    const peer = (ctx: Ctx, projectId: ProjectId): RequestsPeer => ctx.actor(self!, requestsKey(ctx.state.workspaceId, projectId)) as unknown as RequestsPeer;

    const definition = defineActor({
        type: REQUESTS_TYPE,
        authorize,
        ...(options.allowAnonymous ? { allowAnonymous: true as const } : {}),
        state: (key): RequestsState => {
            // A malformed key is refused by the methods, not here: a throwing factory is an opaque activation failure.
            const parsed = parseRequestsKey(key);
            return { ...emptyBook(parsed?.workspaceId ?? ('' as WorkspaceId), parsed?.projectId ?? ('' as ProjectId)), auditSeq: 0 };
        },
        methods: (ctx: Ctx) => {
            const requireKey = (): void => {
                if (parseRequestsKey(ctx.key) === null) throw new ServerFnError(400, `[requests] key must be "{ws}:requests:{projectId}", got "${ctx.key}"`);
            };

            /** Requests an accept is adding a plan item for (`{key} {id}`): every other change to them waits (409) until it lands. */
            const accepting = {
                has: (id: string) => acceptingNow.has(`${ctx.key} ${id}`),
                add: (id: string) => acceptingNow.add(`${ctx.key} ${id}`),
                delete: (id: string) => acceptingNow.delete(`${ctx.key} ${id}`)
            };
            const requireIdle = (id: unknown): void => {
                if (typeof id === 'string' && accepting.has(id)) throw new ServerFnError(409, `[requests] ${id} is being accepted`, { code: 'wrong-state' });
            };

            const callerActor = (): PlanActor => {
                const actor = principalActor(ctx.principal as Principal | null);
                if (!actor) throw new ServerFnError(403, '[requests] a request change needs an agent or a person');
                return actor;
            };

            /** This project's record, manager and policy; 404 when the project is gone. */
            const context = async (actor: PlanActor) => {
                const s = ctx.state;
                const all = await projectsPort.projects(ctx, s.workspaceId);
                const project = all.find((p) => p.id === s.projectId);
                if (!project) throw new ServerFnError(404, `[requests] no project ${s.projectId} in this workspace`);
                const call: RequestCall = { now: now(), actor, manager: project.pm?.agentId ?? project.members.coordinator ?? null, policy: pmPolicyOf(project) };
                return { all, project, call };
            };

            const record = async (change: RequestChange, r: StoredRequest, actor: PlanActor, at: number): Promise<void> => {
                const s = ctx.state;
                const seq = ++s.auditSeq;
                await ctx.save();
                await audit.record(ctx, s.workspaceId, {
                    key: `${ctx.key}:${seq}`,
                    kind: 'request.changed',
                    at,
                    by: byOf(actor),
                    summary: change.summary,
                    ...(actor.kind === 'agent' ? { agentId: actor.agentId } : {}),
                    data: {
                        projectId: s.projectId,
                        requestId: r.id,
                        fromProject: r.fromProject,
                        op: change.op,
                        state: change.state,
                        actor: { ...actor },
                        ...(change.resultItem !== undefined ? { resultItem: change.resultItem } : {})
                    }
                });
            };

            /** Start the manager's triage turn when the change owes one (`wantsTurn`). Best effort: the request is saved. */
            const maybeTurn = async (r: StoredRequest, change: RequestChange, call: RequestCall, projectName: string): Promise<void> => {
                if (!wantsTurn(r, change, call)) return;
                r.turns += 1;
                await ctx.save();
                try {
                    await turns.triage(ctx, { workspaceId: ctx.state.workspaceId, projectId: ctx.state.projectId, projectName, managerId: call.manager!, request: requestView(r), turn: r.turns });
                } catch {
                    // The request stays in triaging and the manager still finds it with requests_list.
                }
            };

            /** Run one pure transition, save, audit, and start a turn when it is owed. */
            const transition = async (id: string, fn: (book: RequestsBook, call: RequestCall) => { value: StoredRequest; change: RequestChange }): Promise<RequestView> => {
                requireKey();
                requireIdle(id);
                const actor = callerActor();
                const { project, call } = await context(actor);
                let out: { value: StoredRequest; change: RequestChange };
                try {
                    out = fn(ctx.state, call);
                } catch (error) {
                    return toServerError(error);
                }
                await record(out.change, out.value, actor, call.now);
                await maybeTurn(out.value, out.change, call, project.name);
                return requestView(out.value);
            };

            /** Add the accepted item to the project's plan, as the caller; returns its number. */
            const addToPlan = async (accept: AcceptPlan, request: StoredRequest): Promise<number> => {
                const s = ctx.state;
                const plan = ctx.actor(PlanRef, planKey(s.workspaceId, s.projectId));
                const item: PlanItemInput = {
                    title: accept.item.title,
                    doneWhen: [...accept.item.doneWhen],
                    refs: [...request.refs],
                    ...(accept.item.options ? { options: [...accept.item.options] } : {})
                };
                const { plans } = await plan.list();
                let target: Plan | undefined = accept.planId !== undefined ? plans.find((p) => p.id === accept.planId) : plans[0];
                if (accept.planId !== undefined && !target) throw new ServerFnError(404, `[requests] no plan ${accept.planId} in this project`);
                let itemId: number;
                if (!target) {
                    target = await plan.create({ title: 'Requests', phases: [{ title: 'Incoming', items: [item] }] });
                    itemId = target.phases[0]!.items[0]!.id;
                } else {
                    const phase = accept.item.phase ?? target.phases.find((p) => p.items.some((i) => i.state !== 'done'))?.n ?? target.phases[0]?.n;
                    if (phase === undefined) throw new ServerFnError(409, `[requests] plan ${target.id} has no phase to add the item to`);
                    itemId = (await plan.add(target.id, phase, [item]))[0]!.id;
                }
                if (accept.item.assignee) await plan.assign(itemId, accept.item.assignee, accept.item.first ? 0 : undefined);
                return itemId;
            };

            /** Requests this project sent, from each project it sent to (one that cannot be read is skipped). */
            const sentRequests = async (): Promise<RequestView[]> => {
                const s = ctx.state;
                const lists = await Promise.all(s.sentTo.map((to) => peer(ctx, to).from(s.projectId).catch(() => [] as RequestView[])));
                return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
            };

            return {
                /**
                 * Send this project a request, as the caller, from `input.fromProject` (which must exist and not be this
                 * project). Goes to triage, or to a person first when this project's sender rules say "ask".
                 */
                async send(input: RequestInput): Promise<RequestView> {
                    requireKey();
                    const actor = callerActor();
                    const { all, project, call } = await context(actor);
                    const from = all.find((p) => p.id === (input as { fromProject?: unknown } | null)?.fromProject);
                    if (!from) throw new ServerFnError(404, `[requests] no project ${String((input as { fromProject?: unknown } | null)?.fromProject)} to send from`);
                    const isMember = actor.kind === 'user' || from.members.agentIds.includes(actor.agentId) || from.members.coordinator === actor.agentId;
                    let out: ReturnType<typeof receive>;
                    try {
                        out = receive(ctx.state, call, input, isMember);
                    } catch (error) {
                        return toServerError(error);
                    }
                    await record(out.change, out.value, actor, call.now);
                    await maybeTurn(out.value, out.change, call, project.name);
                    try {
                        await peer(ctx, from.id).noteSent(ctx.state.projectId);
                    } catch {
                        // Best effort: the request is stored; only the sender's `sent()` misses it until its next send here.
                    }
                    return requestView(out.value);
                },

                /** A person lets in a request the sender rules held back. */
                async admit(id: string): Promise<RequestView> {
                    return transition(id, (b, c) => admit(b, c, id));
                },

                /** The manager's triage: stays with it when its policy lets it act alone, else goes to Needs you. */
                async triage(id: string, value: unknown): Promise<RequestView> {
                    return transition(id, (b, c) => triage(b, c, id, value));
                },

                /**
                 * Accept (adding the plan item and linking it), decline with a reason, or ask the sender for more. The
                 * manager only within its policy; a person any of it, and may accept with an edited item.
                 */
                async resolve(id: string, resolution: RequestResolution): Promise<RequestView> {
                    requireKey();
                    requireIdle(id);
                    const actor = callerActor();
                    const { call } = await context(actor);
                    requireIdle(id);
                    let accept: AcceptPlan | null;
                    try {
                        accept = checkResolution(ctx.state, call, id, resolution);
                    } catch (error) {
                        return toServerError(error);
                    }
                    // The plan item first: a Plan refusal leaves the request as it was.
                    let resultItem: number | undefined;
                    if (accept) {
                        // The request is held while the Plan hop runs, so nothing else moves it and the item is linked.
                        accepting.add(id);
                        try {
                            resultItem = await addToPlan(accept, requestOf(ctx.state, id));
                        } finally {
                            accepting.delete(id);
                        }
                    }
                    // One instant for the request and its audit record, taken after the Plan hop.
                    const at = now();
                    let out: ReturnType<typeof resolve>;
                    try {
                        out = resolve(ctx.state, { ...call, now: at }, id, resolution, resultItem);
                    } catch (error) {
                        return toServerError(error);
                    }
                    await record(out.change, out.value, actor, at);
                    return requestView(out.value);
                },

                /** The sender (or a person) answers a request that was asked for more; it goes back to triage. */
                async answer(id: string, text: string): Promise<RequestView> {
                    return transition(id, (b, c) => answer(b, c, id, text));
                },

                async get(id: string): Promise<RequestView> {
                    requireKey();
                    try {
                        return requestView(requestOf(ctx.state, id));
                    } catch (error) {
                        return toServerError(error);
                    }
                },

                /** Requests sent to this project, newest first. */
                async incoming(): Promise<RequestView[]> {
                    requireKey();
                    return Object.values(ctx.state.requests).sort(newestFirst).map(requestView);
                },

                /** Requests this project sent, newest first — read from each project it sent to. */
                async sent(): Promise<RequestView[]> {
                    requireKey();
                    return sentRequests();
                },

                /** Accepted requests either way — each linked to the plan item it became. */
                async linked(): Promise<LinkedRequest[]> {
                    requireKey();
                    const incoming = Object.values(ctx.state.requests).filter((r) => r.state === 'accepted');
                    const sent = (await sentRequests()).filter((r) => r.state === 'accepted');
                    return [...incoming.map((r) => ({ direction: 'incoming' as const, request: requestView(r) })), ...sent.map((request) => ({ direction: 'sent' as const, request }))].sort(
                        (a, b) => b.request.updatedAt - a.request.updatedAt
                    );
                },

                /** Requests `projectId` sent to this project (what the sender's `sent()` reads). */
                async from(projectId: ProjectId): Promise<RequestView[]> {
                    requireKey();
                    return Object.values(ctx.state.requests)
                        .filter((r) => r.fromProject === projectId)
                        .sort(newestFirst)
                        .map(requestView);
                },

                /** Remember that this project sent a request to `to` (the receiving actor calls it on send). */
                async noteSent(to: ProjectId): Promise<void> {
                    requireKey();
                    if (typeof to !== 'string' || !to || to === ctx.state.projectId) throw new ServerFnError(400, '[requests] noteSent names another project');
                    if (ctx.state.sentTo.includes(to)) return;
                    noteSentTo(ctx.state, to);
                    await ctx.save();
                }
            };

        }
    });
    self = definition;
    return definition;
}

/** The Requests actor's definition type. */
export type RequestsActor = ReturnType<typeof defineRequestsActor>;
