/**
 * The `plan` tool family (#751; PRJ-12): how an agent works a project's Plan — `plan_list`, `plan_next`, `plan_claim`,
 * `plan_assign`, `plan_update`, `plan_ref`, `plan_add`, `plan_handoff` (docs/design/projects/HANDOFF.md, "Agent tools
 * and refs"). A project feature declares the family (`ui.tools: ['plan']`) and routing grants it to every session of
 * the project.
 *
 * The tools never touch the Plan actor: they speak to an injected `PlanPort` (the session binds it under the agent's
 * principal, in the chat's project; the actor enforces every rule again and renews the caller's lease on each call).
 * What the tools add is the agent-facing side: they read the board first and refuse with a message the model can act
 * on (`refused: #11 waits on #9 (claimed by you). Try plan_next.`), pick the next item, warn about overlapping
 * touches, and keep the people-only tools (`plan_assign`, `plan_add`) to the project manager.
 */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import { PLAN_TOOLS, formatRef, parseRef, planClaimLive, planDoneWhenMet, planItemWaitsOn, planItems, planTouchesOverlap, type AgentId, type Plan, type PlanActor, type PlanDoneWhen, type PlanItem, type PlanItemState, type Ref } from '@agentic/core';
import type { ToolCall } from './ports.js';

/** A member of the project as the plan names them: `@handle`. */
export interface PlanMember {
    readonly actor: PlanActor;
    readonly handle: string;
}

/** What the tools read before they act: the project's plans, its members, and who is calling. */
export interface PlanBoard {
    readonly plans: readonly Plan[];
    readonly members: readonly PlanMember[];
    /** The agent the session runs as. */
    readonly me: AgentId;
    /** The project manager (`ProjectMembers.coordinator`), when the project has one. */
    readonly manager?: AgentId;
    /** How many items the caller may hold claimed at once (1 by default). */
    readonly limit: number;
}

export interface PlanUpdateInput {
    readonly item: number;
    /** Done-when lines (0-based) to tick. */
    readonly check?: readonly number[];
    /** Done-when lines (0-based) to untick. */
    readonly uncheck?: readonly number[];
    readonly note?: string;
    readonly state?: Exclude<PlanItemState, 'claimed'>;
    /**
     * Replace what the item waits on (#931): item numbers of this project, or `project#n` for an item in another
     * project. The project manager's (and people's); the tool sets it through `PlanPort.after`, not `update`.
     */
    readonly after?: readonly (number | string)[];
}

export interface NewPlanItem {
    readonly title: string;
    /** Item numbers of this project, or `project#n` for an item in another project (#822). */
    readonly after?: readonly (number | string)[];
    readonly touches?: readonly string[];
    readonly doneWhen?: readonly string[];
}

export interface PlanAddInput {
    /** The plan to add to; absent: the only plan, or the port's default. */
    readonly plan?: string;
    /** The phase (`n`) to add to; absent: the last phase. */
    readonly phase?: number;
    readonly items: readonly NewPlanItem[];
    /** Split this item into `items`: they replace it, and what came after it comes after them. */
    readonly split?: number;
}

/**
 * The Plan actor, as the plan tools see it (#751). One per session, bound in the session's project under the agent's
 * principal; every call renews the caller's live lease. The actor enforces the rules the tools check first — a tool
 * refusal only saves a round trip and words it for the model.
 */
export interface PlanPort {
    board(call: ToolCall): Promise<PlanBoard>;
    /** Start `item` with a lease of `leaseMs`; `undefined` (none asked) takes the project's lease. */
    claim(item: number, leaseMs: number | undefined, call: ToolCall): Promise<PlanItem>;
    /** Put `item` in the queue of the member `to` (a handle), at `index` (default: the end). */
    assign(item: number, to: string, index: number | undefined, call: ToolCall): Promise<PlanItem>;
    update(input: PlanUpdateInput, call: ToolCall): Promise<PlanItem>;
    /**
     * Replace everything `item` waits on (#931): numbers or `#n` for this project's items, `project#n` for another
     * project's. Optional: a host without it answers `plan_update` with `after` as unavailable.
     */
    after?(item: number, after: readonly (number | string)[], call: ToolCall): Promise<PlanItem>;
    /** Attach `ref`; a file ref comes back pinned to a commit. */
    ref(item: number, ref: Ref, call: ToolCall): Promise<Ref>;
    add(input: PlanAddInput, call: ToolCall): Promise<readonly PlanItem[]>;
    /** Release `item` with `note`, to the member `to` (a handle) or back to whoever assigned it. */
    handoff(item: number, to: string | undefined, note: string, call: ToolCall): Promise<PlanItem>;
}

/** A refusal the model can act on: the message says why and what to try instead. */
export class PlanRefusal extends Error {
    override readonly name = 'PlanRefusal';
    constructor(reason: string) {
        super(`refused: ${reason}`);
    }
}

/** An item as the tools answer it: owner by handle, refs in the text syntax. */
export interface PlanItemView {
    readonly id: number;
    readonly title: string;
    readonly state: PlanItemState;
    readonly plan: string;
    readonly phase: number;
    readonly owner?: string;
    readonly queueIndex?: number;
    readonly claimedBy?: string;
    readonly leaseUntil?: number;
    readonly after: readonly number[];
    /** The `after` items not done yet. */
    readonly waitsOn: readonly number[];
    readonly touches: readonly string[];
    readonly refs: readonly string[];
    readonly doneWhen: readonly PlanDoneWhen[];
}

const same = (a: PlanActor | undefined, b: PlanActor): boolean => a !== undefined && (a.kind === 'agent' ? b.kind === 'agent' && a.agentId === b.agentId : b.kind === 'user' && a.userId === b.userId);
const agent = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });

/** `@handle`, or the raw id when the member is unknown. */
function handleOf(board: PlanBoard, actor: PlanActor): string {
    const m = board.members.find((x) => same(x.actor, actor));
    return `@${m?.handle ?? (actor.kind === 'agent' ? actor.agentId : actor.userId)}`;
}

interface Located {
    readonly item: PlanItem;
    readonly plan: Plan;
    readonly phase: number;
}

function locate(board: PlanBoard): Located[] {
    return board.plans.flatMap((plan) => plan.phases.flatMap((phase) => phase.items.map((item) => ({ item, plan, phase: phase.n }))));
}

function find(board: PlanBoard, n: number): Located {
    const hit = locate(board).find((l) => l.item.id === n);
    if (!hit) throw new PlanRefusal(`#${n} is not an item of this project's plans. Try plan_list.`);
    return hit;
}

function allItems(board: PlanBoard): PlanItem[] {
    return board.plans.flatMap((p) => planItems(p));
}

/** The item as the tools answer it. */
export function planItemView(board: PlanBoard, { item, plan, phase }: Located, now: number = Date.now()): PlanItemView {
    const live = planClaimLive(item.claim, now);
    return {
        id: item.id,
        title: item.title,
        state: item.state,
        plan: plan.id,
        phase,
        ...(item.assignee ? { owner: handleOf(board, item.assignee) } : {}),
        ...(item.queueIndex !== undefined ? { queueIndex: item.queueIndex } : {}),
        ...(live && item.claim ? { claimedBy: handleOf(board, agent(item.claim.agentId)), leaseUntil: item.claim.leaseUntil } : {}),
        after: item.after,
        waitsOn: planItemWaitsOn(item, allItems(board)),
        touches: item.touches,
        refs: item.refs.map(formatRef),
        doneWhen: item.doneWhen
    };
}

/** Whether `item` is held by a live claim of someone other than `me`. */
const takenByOther = (item: PlanItem, me: AgentId, now: number): boolean => planClaimLive(item.claim, now) && item.claim!.agentId !== me;

/** The items `me` holds claimed right now. */
function myClaims(board: PlanBoard, now: number): PlanItem[] {
    return allItems(board).filter((i) => i.state !== 'done' && planClaimLive(i.claim, now) && i.claim!.agentId === board.me);
}

/** Overlapping touches between `item` and the items other agents hold claimed: `#10 (@lint) also touches plugins/model.ts`. */
export function planTouchWarnings(board: PlanBoard, item: PlanItem, now: number = Date.now()): string[] {
    const out: string[] = [];
    for (const other of allItems(board)) {
        if (other.id === item.id || other.state === 'done' || !takenByOther(other, board.me, now)) continue;
        const paths = other.touches.filter((p) => item.touches.some((q) => planTouchesOverlap(p, q)));
        if (paths.length) out.push(`#${other.id} (${handleOf(board, agent(other.claim!.agentId))}) also touches ${paths.join(', ')}`);
    }
    return out;
}

/** Why `n` is not done, for a "waits on" refusal: `#9 (claimed by you)`, `#9 (in @lint's queue)`, `#9 (ready)`. */
function blockerText(board: PlanBoard, n: number, now: number): string {
    const hit = locate(board).find((l) => l.item.id === n)?.item;
    if (!hit) return `#${n} (not in this project)`;
    if (planClaimLive(hit.claim, now)) return `#${n} (claimed by ${hit.claim!.agentId === board.me ? 'you' : handleOf(board, agent(hit.claim!.agentId))})`;
    if (hit.assignee) return `#${n} (in ${same(hit.assignee, agent(board.me)) ? 'your' : `${handleOf(board, hit.assignee)}'s`} queue)`;
    return `#${n} (${hit.state})`;
}

/**
 * The next item for the caller (#751): its own queue first, in queue order, then the open pool in plan order — only
 * `ready` items whose `after` items are done, not held by someone else, whose touches do not overlap an item another
 * agent holds claimed. `null` when nothing qualifies.
 */
export function planNext(board: PlanBoard, planId?: string, now: number = Date.now()): Located | null {
    const me = agent(board.me);
    const items = allItems(board);
    const pool = locate(board).filter((l) => (planId === undefined || l.plan.id === planId) && l.item.state === 'ready' && !takenByOther(l.item, board.me, now));
    const eligible = (l: Located): boolean => planItemWaitsOn(l.item, items).length === 0 && planTouchWarnings(board, l.item, now).length === 0;
    const mine = pool.filter((l) => same(l.item.assignee, me)).sort((a, b) => (a.item.queueIndex ?? Infinity) - (b.item.queueIndex ?? Infinity));
    const open = pool.filter((l) => l.item.assignee === undefined);
    return mine.find(eligible) ?? open.find(eligible) ?? null;
}

/** The refusal for claiming `n`, or `undefined` when the claim may go ahead. */
export function planClaimRefusal(board: PlanBoard, n: number, now: number = Date.now()): string | undefined {
    const { item } = find(board, n);
    if (item.state === 'done') return `#${n} is done.`;
    if (takenByOther(item, board.me, now)) return `#${n} is claimed by ${handleOf(board, agent(item.claim!.agentId))} until ${new Date(item.claim!.leaseUntil).toISOString()}. Try plan_next.`;
    const mineAlready = planClaimLive(item.claim, now) && item.claim!.agentId === board.me;
    if (mineAlready) return undefined;
    if (item.assignee && !same(item.assignee, agent(board.me))) return `#${n} is in ${handleOf(board, item.assignee)}'s queue. Try plan_next, or ask the project manager to assign it to you.`;
    const waits = planItemWaitsOn(item, allItems(board));
    if (waits.length) return `#${n} waits on ${waits.map((w) => blockerText(board, w, now)).join(', ')}. Try plan_next.`;
    // A claim whose lease ran out holds nothing: the actor returns the item to its queue on the next call.
    const lapsed = item.state === 'claimed' && !planClaimLive(item.claim, now);
    if (item.state !== 'ready' && !lapsed) return `#${n} is ${item.state}. Try plan_next.`;
    const held = myClaims(board, now);
    if (held.length >= board.limit) return `you already hold ${held.map((i) => `#${i.id}`).join(', ')} and your limit is ${board.limit} at once. Finish it with plan_update or release it with plan_handoff first.`;
    return undefined;
}

/** The refusal for a people-only tool (`plan_assign`, `plan_add`) when the caller is not the project manager. */
export function planManagerRefusal(board: PlanBoard, tool: 'plan_assign' | 'plan_add' | 'plan_update with after'): string | undefined {
    if (board.manager !== undefined && board.manager === board.me) return undefined;
    const pm = board.manager !== undefined ? handleOf(board, agent(board.manager)) : undefined;
    return `${tool} is for the project manager and people, and you are not this project's manager. ${pm ? `Ask ${pm}` : 'Ask a person'} in the chat instead.`;
}

/** The done-when list after ticking `check` and unticking `uncheck`; refuses a line number the item does not have. */
export function planApplyChecks(item: PlanItem, check: readonly number[] = [], uncheck: readonly number[] = []): PlanDoneWhen[] {
    for (const i of [...check, ...uncheck]) {
        if (!Number.isInteger(i) || i < 0 || i >= item.doneWhen.length) throw new PlanRefusal(`#${item.id} has ${item.doneWhen.length} done-when line${item.doneWhen.length === 1 ? '' : 's'} (0–${Math.max(0, item.doneWhen.length - 1)}); there is no line ${i}.`);
    }
    return item.doneWhen.map((d, i) => ({ text: d.text, checked: check.includes(i) ? true : uncheck.includes(i) ? false : d.checked }));
}

/** What an item waits on, in the ref syntax: `#9`, and `signalx#14` for another project's (`afterRefs`, by id). */
const afterText = (item: PlanItem): string[] => [
    ...item.after.map((n) => `#${n}`),
    ...((item as PlanItem & { afterRefs?: readonly { projectId: string; n: number }[] }).afterRefs ?? []).map((a) => `${a.projectId}#${a.n}`)
];

const ticked = (d: readonly PlanDoneWhen[]): string => `${d.filter((x) => x.checked).length} of ${d.length} done-when ticked`;

const call = (ctx: { toolCallId: string; signal: AbortSignal }): ToolCall => ({ callId: ctx.toolCallId, signal: ctx.signal });

function need(port: PlanPort | undefined, tool: string): PlanPort {
    if (!port) throw new Error(`${tool}: the plan is not available here (the project has no Plan feature, or this host has no Plan actor)`);
    return port;
}

const itemNo = z.number().int().min(1).describe('The item number, `#n` without the `#`.');
const handle = z.string().min(1).describe('A member of the project by handle, `lint` or `@lint`.');
/** A handle without its `@`. */
const bare = (h: string): string => h.replace(/^@/, '');
const planId = z.string().min(1).optional().describe('Limit to one plan by id; absent: every plan of the project.');

export const planListInput = z.object({
    plan: planId,
    state: z.enum(['ready', 'claimed', 'needs-you', 'blocked', 'done', 'stuck']).optional().describe('Only items in this state.'),
    mine: z.boolean().optional().describe('Only items assigned to or claimed by you.')
});
export const planNextInput = z.object({ plan: planId });
export const planClaimInput = z.object({ item: itemNo, leaseMinutes: z.number().int().min(1).max(240).optional().describe('How long the lease runs before it needs renewing (default: the project’s lease, 30 unless set). Any plan_* call renews it.') });
export const planAssignInput = z.object({ item: itemNo, to: handle, index: z.number().int().min(0).optional().describe('Position in their queue, 0 first; absent: the end.') });
export const planUpdateInput = z.object({
    item: itemNo,
    check: z.array(z.number().int().min(0)).optional().describe('Done-when lines to tick, 0-based.'),
    uncheck: z.array(z.number().int().min(0)).optional().describe('Done-when lines to untick, 0-based.'),
    note: z.string().min(1).optional().describe('A note for the item’s History; refs in the shared syntax (`#9`, `pr:604`, `path/file.ts:38-41`) are linked.'),
    state: z.enum(['ready', 'needs-you', 'blocked', 'done', 'stuck']).optional().describe('A new state. `done` needs every done-when ticked, and the project letting agents tick; use plan_claim to start an item.'),
    after: z
        .array(z.union([z.number().int().min(1), z.string().min(1).max(300)]))
        .max(50)
        .optional()
        .describe('Replace what the item waits on (project manager only): item numbers of this project (`9` or `#9`), or `project#n` for an item in another project — it stays blocked until each is done. `[]` clears it; list what it already waits on to keep it.')
});
export const planRefInput = z.object({ item: itemNo, ref: z.string().min(1).describe('One ref: `#9`, `signalx#14`, `@lint`, `path/file.ts:38-41`, `pr:604`, `4f2a9c1`, `chat:msg-42`, `doc:architecture.md#7` or a URL.') });
export const planAddInput = z.object({
    plan: planId,
    phase: z.number().int().min(1).optional().describe('The phase to add to; absent: the last one.'),
    items: z
        .array(
            z.object({
                title: z.string().min(1),
                after: z
                    .array(z.union([z.number().int().min(1), z.string().min(1).max(300)]))
                    .optional()
                    .describe('What must be done first: item numbers of this project (`9` or `#9`), or `project#n` for an item in another project — it stays blocked until that item is done.'),
                touches: z.array(z.string().min(1)).optional(),
                doneWhen: z.array(z.string().min(1)).optional()
            })
        )
        .min(1),
    split: z.number().int().min(1).optional().describe('Split this item into `items` instead of adding new work.')
});
export const planHandoffInput = z.object({ item: itemNo, to: handle.optional().describe('Who picks it up, `lint` or `@lint`; absent: back to whoever assigned it.'), note: z.string().min(1).describe('What is done, what is left, and anything the next owner needs.') });

const READ = { readOnly: true, idempotent: true } as const;
const WRITE = { readOnly: false, destructive: false } as const;

/** The eight plan tools over `port`, in `PLAN_TOOLS` order. Absent port: each reports the plan unavailable. */
export function planTools(port: PlanPort | undefined) {
    const [LIST, NEXT, CLAIM, ASSIGN, UPDATE, REF, ADD, HANDOFF] = PLAN_TOOLS;
    return [
        defineTool({
            name: LIST,
            description: 'The items of this project’s plans: state, owner, queue position, what each waits on, the paths it touches, its refs and done-when checklist.',
            input: planListInput,
            annotations: READ,
            execute: async (input, ctx) => {
                const board = await need(port, LIST).board(call(ctx));
                const now = Date.now();
                const me = agent(board.me);
                const items = locate(board)
                    .filter((l) => (input.plan === undefined || l.plan.id === input.plan) && (input.state === undefined || l.item.state === input.state))
                    .filter((l) => !input.mine || same(l.item.assignee, me) || (planClaimLive(l.item.claim, now) && l.item.claim!.agentId === board.me))
                    .map((l) => planItemView(board, l, now));
                return { plans: board.plans.map((p) => ({ id: p.id, title: p.title })), items };
            }
        }),
        defineTool({
            name: NEXT,
            description: 'The item to work on next: from your own queue first, then the open pool — its `after` items done and no path clash with work in progress. Claim it with plan_claim.',
            input: planNextInput,
            annotations: READ,
            execute: async (input, ctx) => {
                const board = await need(port, NEXT).board(call(ctx));
                const now = Date.now();
                const next = planNext(board, input.plan, now);
                if (!next) return { item: null, note: 'nothing is ready for you: your queue is empty or waiting, and no open item has its after-items done without a path clash.' };
                return { item: planItemView(board, next, now), from: next.item.assignee ? 'your queue' : 'open items' };
            }
        }),
        defineTool({
            name: CLAIM,
            description: 'Start an item: you hold it with a lease (the project’s, 30 minutes unless set) that every plan_* call renews. Refused while it waits on unfinished items, is someone else’s, or you already hold your limit.',
            input: planClaimInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const p = need(port, CLAIM);
                const board = await p.board(call(ctx));
                const refusal = planClaimRefusal(board, input.item);
                if (refusal) throw new PlanRefusal(refusal);
                const item = await p.claim(input.item, input.leaseMinutes !== undefined ? input.leaseMinutes * 60_000 : undefined, call(ctx));
                const headsUp = planTouchWarnings(board, item);
                return { item: item.id, state: item.state, ...(item.claim ? { leaseUntil: new Date(item.claim.leaseUntil).toISOString() } : {}), note: 'the lease renews on each plan_* call', ...(headsUp.length ? { headsUp } : {}) };
            }
        }),
        defineTool({
            name: ASSIGN,
            description: 'Put an item in a member’s queue. Only the project manager (and people) assign; any other agent is refused.',
            input: planAssignInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const p = need(port, ASSIGN);
                const board = await p.board(call(ctx));
                const refusal = planManagerRefusal(board, ASSIGN);
                if (refusal) throw new PlanRefusal(refusal);
                find(board, input.item);
                const item = await p.assign(input.item, bare(input.to), input.index, call(ctx));
                return { item: item.id, owner: item.assignee ? handleOf(board, item.assignee) : `@${bare(input.to)}`, ...(item.queueIndex !== undefined ? { queueIndex: item.queueIndex } : {}) };
            }
        }),
        defineTool({
            name: UPDATE,
            description: 'Tick or untick done-when lines, add a note to the item’s History, change its state, or (project manager only) replace what it waits on with `after` — including `project#n` items of other projects. `done` needs every done-when ticked; otherwise a person marks it done. Where the project does not let agents tick, a person ticks and marks it done: add a note or set needs-you to ask.',
            input: planUpdateInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const p = need(port, UPDATE);
                const board = await p.board(call(ctx));
                const { item } = find(board, input.item);
                const patching = !!input.check?.length || !!input.uncheck?.length || input.note !== undefined || input.state !== undefined;
                if (!patching && input.after === undefined) throw new PlanRefusal(`nothing to change on #${item.id}: pass check, uncheck, note, state or after.`);
                const ticks = planApplyChecks(item, input.check, input.uncheck);
                if (input.state === 'done' && !planDoneWhenMet(ticks)) throw new PlanRefusal(`#${item.id} has ${ticked(ticks)}; tick them all first, or ask a person to mark it done.`);
                if (input.after !== undefined) {
                    const refusal = planManagerRefusal(board, 'plan_update with after');
                    if (refusal) throw new PlanRefusal(refusal);
                    if (!p.after) throw new PlanRefusal(`changing what an item waits on is not available here; ask a person to set it on #${item.id}.`);
                    const linked = await p.after(input.item, input.after, call(ctx));
                    if (!patching) return { item: linked.id, state: linked.state, after: afterText(linked) };
                }
                const updated = await p.update({ item: input.item, ...(input.check ? { check: input.check } : {}), ...(input.uncheck ? { uncheck: input.uncheck } : {}), ...(input.note !== undefined ? { note: input.note } : {}), ...(input.state !== undefined ? { state: input.state } : {}) }, call(ctx));
                return { item: updated.id, state: updated.state, doneWhen: ticked(updated.doneWhen), ...(input.after !== undefined ? { after: afterText(updated) } : {}) };
            }
        }),
        defineTool({
            name: REF,
            description: 'Attach a ref to an item: a file range (pinned to the current commit), PR, commit, chat message, doc section, URL, member or another item. It shows on the item for everyone.',
            input: planRefInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const ref = parseRef(input.ref);
                if (!ref) throw new PlanRefusal(`"${input.ref}" is not one ref. Write one of: #9, signalx#14, @lint, path/file.ts:38-41, pr:604, 4f2a9c1, chat:msg-42, doc:architecture.md#7, or a URL.`);
                const p = need(port, REF);
                find(await p.board(call(ctx)), input.item);
                const attached = await p.ref(input.item, ref, call(ctx));
                return { item: input.item, ref: formatRef(attached), ...(attached.kind === 'file' && attached.sha ? { pinned: attached.sha } : {}) };
            }
        }),
        defineTool({
            name: ADD,
            description: 'Add items to a plan, or split one item into several. Only the project manager (and people) add; any other agent is refused — suggest the item in the chat instead.',
            input: planAddInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const p = need(port, ADD);
                const board = await p.board(call(ctx));
                const refusal = planManagerRefusal(board, ADD);
                if (refusal) throw new PlanRefusal(refusal);
                if (input.plan !== undefined && !board.plans.some((x) => x.id === input.plan)) throw new PlanRefusal(`there is no plan "${input.plan}" in this project. Try plan_list.`);
                if (input.split !== undefined) {
                    const { item } = find(board, input.split);
                    if (item.state === 'done') throw new PlanRefusal(`#${item.id} is done and cannot be split.`);
                }
                const items = await p.add({ ...(input.plan !== undefined ? { plan: input.plan } : {}), ...(input.phase !== undefined ? { phase: input.phase } : {}), items: input.items, ...(input.split !== undefined ? { split: input.split } : {}) }, call(ctx));
                return { added: items.map((i) => ({ id: i.id, title: i.title })) };
            }
        }),
        defineTool({
            name: HANDOFF,
            description: 'Release an item you hold, with a note, to another member (`to`) or back to whoever assigned it; they are told at once. The note and the item’s refs go with it. Hand off once your pull request is open: when it merges, the item is marked done.',
            input: planHandoffInput,
            annotations: WRITE,
            execute: async (input, ctx) => {
                const p = need(port, HANDOFF);
                const board = await p.board(call(ctx));
                const { item } = find(board, input.item);
                const holds = (planClaimLive(item.claim) && item.claim!.agentId === board.me) || same(item.assignee, agent(board.me));
                if (!holds) throw new PlanRefusal(`#${item.id} is not yours to hand off: you neither hold it nor have it in your queue.`);
                const out = await p.handoff(input.item, input.to !== undefined ? bare(input.to) : undefined, input.note, call(ctx));
                return { item: out.id, state: out.state, to: out.assignee ? handleOf(board, out.assignee) : input.to !== undefined ? `@${bare(input.to)}` : 'whoever assigned it' };
            }
        })
    ];
}
