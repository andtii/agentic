/**
 * The Plan actor as the `plan_*` tools see it (#816; PRJ-11, PRJ-12): a pure mapping from the actor's methods
 * (`definePlanActor`, #750) onto the runtimes' `PlanPort` (#751), plus the pieces the MCP surface's `PlanMcpPort`
 * shares — members by handle, the update patch, where `plan_add` lands, who a handoff goes back to.
 *
 * The port owns no actor and no principal: `scope(call)` hands it the Plan client already bound to the caller (the
 * session's agent, in the session's project), the project record and the members' names. Every write maps onto the
 * actor method of the same name and its refusal comes back unchanged; after every call the caller's notices (lease
 * ran out, touches overlap, handoff) are taken and handed to `deliver`. A file ref is pinned through `pin` when the
 * host can, and stored unpinned otherwise.
 */
import { formatRef, type AgentId, type FileRef, type Plan, type PlanActor, type PlanItem, type ProjectRecord, type Ref, type TaskId } from '@agentic/core';
import { PlanRefusal, type NewPlanItem, type PlanAddInput, type PlanBoard, type PlanMember, type PlanPort, type PlanUpdateInput, type ToolCall } from '@agentic/runtimes';
import type { LinkedItemInput } from './links.js';
import type { ClaimOptions, HandoffOptions, PlanItemPatch, PlanNotice } from './rules.js';
import { planLimitOf } from './settings.js';

/** The Plan actor methods the port calls; a client of `definePlanActor()` satisfies it. */
export interface PlanActorClient {
    list(): Promise<{ readonly plans: readonly Plan[] }>;
    next(agentId?: AgentId): Promise<PlanItem | null>;
    claim(itemId: number, options?: ClaimOptions): Promise<{ readonly item: PlanItem }>;
    assign(itemId: number, to: PlanActor | null, index?: number): Promise<PlanItem>;
    update(itemId: number, patch: PlanItemPatch): Promise<PlanItem>;
    ref(itemId: number, ref: Ref | string): Promise<PlanItem>;
    add(planId: string, phase: number, items: readonly LinkedItemInput[]): Promise<readonly PlanItem[]>;
    split(itemId: number, parts: readonly LinkedItemInput[]): Promise<readonly PlanItem[]>;
    handoff(itemId: number, to: PlanActor | null, note: string, options?: HandoffOptions): Promise<PlanItem>;
    takeNotices(): Promise<readonly PlanNotice[]>;
}

/** Who may be named on a plan: the project's agents (by name) and the people who may be named by handle. */
export interface PlanPeople {
    readonly project: Pick<ProjectRecord, 'members'> & Partial<Pick<ProjectRecord, 'features'>>;
    /** The agents' display names by id; a handle is the name's slug (`Lint Bot` → `lint-bot`), else the id. */
    readonly names: ReadonlyMap<AgentId, string>;
    /** People (user ids) who may be named; the handle is the user id. */
    readonly users?: readonly string[];
}

/** One call's view of the session's project: the Plan client bound to the caller, and its people. */
export interface PlanScope extends PlanPeople {
    readonly plan: PlanActorClient;
}

export interface PlanPortDeps {
    /** The agent the session runs as. */
    readonly me: AgentId;
    /** The session's project for this call; throws when the session has none (the tool then shows why). */
    scope(call: ToolCall): Promise<PlanScope>;
    /** The task the session works now; the claim records it. */
    readonly taskId?: () => TaskId | undefined;
    /** Pin a file ref to the current commit; `undefined` (or a throw) stores it unpinned. */
    readonly pin?: (ref: FileRef, call: ToolCall) => Promise<FileRef | undefined>;
    /** Where the caller's notices go after each call. A throw is swallowed: a notice never fails the call. */
    readonly deliver?: (notices: readonly PlanNotice[], call: ToolCall) => Promise<void>;
}

/** A display name as a handle: lower case, runs of anything but letters, digits, `_` and `-` as one `-`. */
export function planHandle(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, '-')
        .replace(/^-+|-+$/g, '');
}

/** The project's members as the plan names them: its agents, then the named people. */
export function planMembers(people: PlanPeople): PlanMember[] {
    const agents = people.project.members.agentIds.map((agentId): PlanMember => ({ actor: { kind: 'agent', agentId }, handle: planHandle(people.names.get(agentId) ?? '') || agentId }));
    const users = (people.users ?? []).map((userId): PlanMember => ({ actor: { kind: 'user', userId }, handle: userId }));
    return [...agents, ...users];
}

/** The member `handle` names (`lint`, `@lint`, the agent's id or name) — or a refusal listing who there is. */
export function resolvePlanMember(people: PlanPeople, handle: string): PlanActor {
    const wanted = handle.replace(/^@/, '').trim();
    const lower = wanted.toLowerCase();
    const members = planMembers(people);
    const hit =
        members.find((m) => m.handle.toLowerCase() === lower) ??
        members.find((m) => (m.actor.kind === 'agent' ? m.actor.agentId === wanted || people.names.get(m.actor.agentId)?.toLowerCase() === lower : m.actor.userId === wanted)) ??
        members.find((m) => m.handle.toLowerCase() === planHandle(wanted));
    if (!hit) throw new PlanRefusal(`@${wanted} is not a member of this project. Members: ${members.map((m) => `@${m.handle}`).join(', ') || 'none'}.`);
    return hit.actor;
}

/** The tools' tick / untick / note / state as the actor's patch. */
export function planPatch(input: Omit<PlanUpdateInput, 'item'>): PlanItemPatch {
    const tick = [...(input.check ?? []).map((index) => ({ index, checked: true })), ...(input.uncheck ?? []).map((index) => ({ index, checked: false }))];
    return {
        ...(tick.length ? { tick } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        // `blocked` is derived, never stored: the actor refuses it in its own words.
        ...(input.state !== undefined ? { state: input.state as PlanItemPatch['state'] } : {})
    };
}

/** `after` may hold `project#n` (#822): the actor resolves it. */
const itemInput = (i: NewPlanItem): LinkedItemInput => ({
    title: i.title,
    ...(i.after ? { after: i.after } : {}),
    ...(i.touches ? { touches: i.touches } : {}),
    ...(i.doneWhen ? { doneWhen: i.doneWhen } : {})
});

/**
 * `plan_add`: a split replaces the item in place; otherwise the items go to `plan` (absent: the project's only plan)
 * in `phase` (absent: its last phase).
 */
export async function planAdd(client: PlanActorClient, input: PlanAddInput): Promise<readonly PlanItem[]> {
    const items = input.items.map(itemInput);
    if (input.split !== undefined) return client.split(input.split, items);
    const { plans } = await client.list();
    let plan: Plan | undefined;
    if (input.plan !== undefined) {
        plan = plans.find((p) => p.id === input.plan);
        if (!plan) throw new PlanRefusal(`there is no plan "${input.plan}" in this project. Try plan_list.`);
    } else if (plans.length === 1) plan = plans[0];
    else if (plans.length === 0) throw new PlanRefusal('this project has no plan yet: a person or the project manager creates one first.');
    else throw new PlanRefusal(`this project has ${plans.length} plans (${plans.map((p) => p.id).join(', ')}): name one with \`plan\`.`);
    const phase = input.phase ?? plan!.phases.at(-1)?.n;
    if (phase === undefined) throw new PlanRefusal(`plan "${plan!.id}" has no phase to add to yet.`);
    return client.add(plan!.id, phase, items);
}

/** Who a handoff goes to: the member `to` names, else back to whoever assigned the item, else the open pool. */
export function planHandoffTarget(people: PlanPeople, plans: readonly Plan[], item: number, to: string | undefined): PlanActor | null {
    if (to !== undefined) return resolvePlanMember(people, to);
    for (const plan of plans) for (const phase of plan.phases) for (const i of phase.items) if (i.id === item) return i.assignedBy ?? null;
    return null;
}

/** The runtimes' `PlanPort` over the Plan actor (#816). */
export function createPlanPort(deps: PlanPortDeps): PlanPort {
    const { me } = deps;

    /** Run `fn` in this call's scope, then hand over the caller's notices. */
    async function run<T>(call: ToolCall, fn: (scope: PlanScope) => Promise<T>): Promise<T> {
        const scope = await deps.scope(call);
        try {
            return await fn(scope);
        } finally {
            if (deps.deliver) {
                try {
                    const notices = await scope.plan.takeNotices();
                    if (notices.length) await deps.deliver(notices, call);
                } catch {
                    // A notice is best effort: it stays with the actor or is lost, never fails the call.
                }
            }
        }
    }

    return {
        board: (call) =>
            run(call, async (scope): Promise<PlanBoard> => {
                const { plans } = await scope.plan.list();
                const manager = scope.project.members.coordinator;
                return { plans, members: planMembers(scope), me, ...(manager ? { manager } : {}), limit: planLimitOf(scope.project, me) };
            }),
        claim: (item, leaseMs, call) =>
            run(call, async (scope) => {
                const taskId = deps.taskId?.();
                // None asked (`undefined`): the project's lease setting applies (#938); an explicit lease always wins (#962).
                return (await scope.plan.claim(item, { ...(leaseMs !== undefined ? { leaseMs } : {}), ...(taskId ? { taskId } : {}) })).item;
            }),
        assign: (item, to, index, call) => run(call, (scope) => scope.plan.assign(item, resolvePlanMember(scope, to), index)),
        update: (input, call) => run(call, (scope) => scope.plan.update(input.item, planPatch(input))),
        ref: (item, ref, call) =>
            run(call, async (scope) => {
                let stored = ref;
                if (ref.kind === 'file' && ref.sha === undefined && deps.pin) stored = (await deps.pin(ref, call).catch(() => undefined)) ?? ref;
                const out = await scope.plan.ref(item, stored);
                // The actor keeps one of each printed ref: answer what it holds.
                const printed = formatRef(stored);
                return out.refs.find((r) => formatRef(r) === printed) ?? stored;
            }),
        add: (input, call) => run(call, (scope) => planAdd(scope.plan, input)),
        handoff: (item, to, note, call) =>
            run(call, async (scope) => {
                const target = to !== undefined ? resolvePlanMember(scope, to) : planHandoffTarget(scope, (await scope.plan.list()).plans, item, undefined);
                // The session's task: when its pull request merges, the item is done (#938).
                const taskId = deps.taskId?.();
                return scope.plan.handoff(item, target, note, ...(taskId ? [{ taskId }] : []));
            })
    };
}
