/**
 * The Plan board's rules (#755, PRJ-13) as pure functions: which column an item sits in, what each column holds
 * (WORKING, then QUEUE in order), and what a drop does — docs/design/projects/HANDOFF.md → "Board view".
 */
import { memberLimit, planClaimLive, planItemWaitsOn, planTouchesOverlap, type AgentId, type PlanActor, type PlanItem, type ProjectMembers } from '@agentic/core';

/** `open` is Not assigned, `you` the viewer, `agent:<id>` a member. */
export type BoardColumnKey = 'open' | 'you' | `agent:${string}`;

export interface BoardColumn {
    readonly key: BoardColumnKey;
    readonly kind: 'open' | 'agent' | 'you';
    readonly agentId?: string;
    /** Items claimed now, oldest number first. */
    readonly working: readonly PlanItem[];
    /** Items waiting, in the order they are worked. */
    readonly queue: readonly PlanItem[];
    /** How many items the agent may work at once; `null` for Not assigned and You. */
    readonly limit: number | null;
}

export const agentColumn = (agentId: string): BoardColumnKey => `agent:${agentId}`;

/** The column an item sits in: its assignee's, or Not assigned. */
export function columnOf(item: Pick<PlanItem, 'assignee'>): BoardColumnKey {
    if (!item.assignee) return 'open';
    return item.assignee.kind === 'user' ? 'you' : agentColumn(item.assignee.agentId);
}

/**
 * Whether the item is being worked at `now`: a claimed (or stuck / needs-you) item whose claim's lease has not run
 * out. An expired lease returns the item to its assignee's QUEUE (#813).
 */
export const isWorking = (item: Pick<PlanItem, 'claim' | 'state'>, now: number): boolean =>
    planClaimLive(item.claim, now) && item.state !== 'done' && item.state !== 'ready';

const byQueue = (a: PlanItem, b: PlanItem): number => (a.queueIndex ?? Number.MAX_SAFE_INTEGER) - (b.queueIndex ?? Number.MAX_SAFE_INTEGER) || a.id - b.id;

/**
 * The board's columns: Not assigned, each agent member (the coordinator only when it holds items — it assigns rather
 * than works), any other agent an item is assigned to, then You. Done items are left out.
 */
export function boardColumns(items: readonly PlanItem[], members: ProjectMembers, now: number): BoardColumn[] {
    const open = items.filter((i) => i.state !== 'done');
    const agents: string[] = [];
    const add = (id: string): void => { if (!agents.includes(id)) agents.push(id); };
    const holds = (id: string): boolean => open.some((i) => columnOf(i) === agentColumn(id));
    for (const id of members.agentIds) if (id !== members.coordinator || holds(id)) add(id);
    for (const i of open) if (i.assignee?.kind === 'agent') add(i.assignee.agentId);
    const column = (key: BoardColumnKey, kind: BoardColumn['kind'], agentId?: string): BoardColumn => {
        const mine = open.filter((i) => columnOf(i) === key);
        const working = kind === 'agent' ? mine.filter((i) => isWorking(i, now)).sort((a, b) => a.id - b.id) : [];
        const queue = mine.filter((i) => !working.includes(i)).sort(byQueue);
        return {
            key,
            kind,
            ...(agentId ? { agentId } : {}),
            working,
            queue,
            limit: agentId ? memberLimit({ members }, agentId as AgentId) : null
        };
    };
    return [column('open', 'open'), ...agents.map((id) => column(agentColumn(id), 'agent', id)), column('you', 'you')];
}

/** How many items are done — hidden on the board, shown in the List. */
export const doneCount = (items: readonly Pick<PlanItem, 'state'>[]): number => items.filter((i) => i.state === 'done').length;

/** Where a dragged card would land: a column and a position in its QUEUE. */
export interface BoardSlot {
    readonly column: BoardColumnKey;
    readonly index: number;
}

/** Whether dropping `item` at `slot` takes it from the agent working it now — the owner then gets a handoff note. */
export function needsHandoff(item: PlanItem, slot: BoardSlot, now: number): boolean {
    return isWorking(item, now) && columnOf(item) !== slot.column;
}

/** Whether dropping `item` at `slot` changes nothing (same column and same place in the queue, or its own column while it is worked). */
export function isNoop(item: PlanItem, slot: BoardSlot, columns: readonly BoardColumn[], now: number): boolean {
    if (columnOf(item) !== slot.column) return false;
    // A card being worked stays in WORKING: dropping it back into its own column changes nothing.
    if (isWorking(item, now)) return true;
    const col = columns.find((c) => c.key === slot.column);
    const at = col?.queue.findIndex((i) => i.id === item.id) ?? -1;
    return at >= 0 && (slot.index === at || slot.index === at + 1);
}

const actorOf = (column: BoardColumnKey, you: PlanActor): PlanActor | undefined =>
    column === 'open' ? undefined : column === 'you' ? you : { kind: 'agent', agentId: column.slice('agent:'.length) as AgentId };

/**
 * The plan after dropping item `id` at `slot`: it joins that column's queue at the slot's position (the slot counts
 * the queue as it is shown, the dragged card included), and both queues are renumbered from 0. Moved to another
 * column, it loses any claim on it — live, or a lease that ran out — and a claimed or stuck item is ready again (one
 * that needs a person still does); a `note` goes into its history as the handoff. Whether an item is worked, for the
 * queues, is judged at `by.at`.
 */
export function moveItem(items: readonly PlanItem[], id: number, slot: BoardSlot, by: { readonly you: PlanActor; readonly at: number; readonly note?: string }): PlanItem[] {
    const item = items.find((i) => i.id === id);
    if (!item) return [...items];
    const from = columnOf(item);
    const queueOf = (key: BoardColumnKey): PlanItem[] => items.filter((i) => i.state !== 'done' && columnOf(i) === key && !(key !== 'open' && key !== 'you' && isWorking(i, by.at))).sort(byQueue);
    const target = queueOf(slot.column);
    const before = target.slice(0, Math.max(0, Math.min(slot.index, target.length))).filter((i) => i.id !== id);
    const after = target.slice(Math.max(0, Math.min(slot.index, target.length))).filter((i) => i.id !== id);
    const leaves = from !== slot.column && item.claim !== undefined;
    const assignee = actorOf(slot.column, by.you);
    const { assignee: _a, assignedBy: _b, queueIndex: _q, claim: _c, ...rest } = item;
    const moved: PlanItem = {
        ...rest,
        ...(assignee ? { assignee, assignedBy: by.you } : {}),
        ...(!leaves && item.claim ? { claim: item.claim } : {}),
        state: leaves && (item.state === 'claimed' || item.state === 'stuck') ? 'ready' : item.state,
        activity: by.note?.trim() ? [...item.activity, { at: by.at, actor: by.you, text: `Handoff: ${by.note.trim()}` }] : item.activity
    };
    const order = new Map<number, number>();
    [...before, moved, ...after].forEach((i, n) => order.set(i.id, n));
    if (from !== slot.column) queueOf(from).filter((i) => i.id !== id).forEach((i, n) => order.set(i.id, n));
    return items.map((i) => {
        const base = i.id === id ? moved : i;
        const n = order.get(i.id);
        return n === undefined ? base : { ...base, queueIndex: n };
    });
}

/** The meta line under a card's title: what it waits on, its lease, whom it is moving to, or what it asks. */
export function cardMeta(item: PlanItem, items: readonly PlanItem[], now: number, nameOf: (actor: PlanActor) => string): string[] {
    const meta: string[] = [];
    if (item.claim && isWorking(item, now)) {
        const mins = Math.max(0, Math.round((item.claim.leaseUntil - now) / 60_000));
        meta.push(`lease ${mins}m${item.claim.taskId ? ` · ${item.claim.taskId}` : ''}`);
    }
    if (isWorking(item, now)) {
        const clash = items.filter((o) => o.id !== item.id && isWorking(o, now) && o.id < item.id && o.touches.some((t) => item.touches.some((u) => planTouchesOverlap(t, u))));
        if (clash.length) meta.push(`overlaps ${clash.map((o) => `#${o.id}`).join(', ')} · waits to rebase`);
    }
    const waits = planItemWaitsOn(item, items);
    if (waits.length) meta.push(`${isWorking(item, now) ? 'waits on' : item.queueIndex !== undefined && item.assignee ? 'after' : 'waits on'} ${waits.map((n) => `#${n}`).join(', ')}`);
    if (item.options?.length) meta.push(`${item.assignedBy ? `${nameOf(item.assignedBy)} asks · ` : ''}${item.options.length} option${item.options.length === 1 ? '' : 's'}`);
    return meta;
}

/** Where a card being dragged starts: its own place in its queue, or the top of its column when it is worked. */
export function startSlot(item: PlanItem, columns: readonly BoardColumn[]): BoardSlot {
    const key = columnOf(item);
    const at = columns.find((c) => c.key === key)?.queue.findIndex((i) => i.id === item.id) ?? -1;
    return { column: key, index: Math.max(0, at) };
}

export type BoardStep = 'up' | 'down' | 'left' | 'right';

/**
 * The slot one arrow key away, for a keyboard drag. Up and down move within the column's queue (the card's own
 * place counts once, so every step shows a change); left and right move to the next column, keeping the position
 * where it fits.
 */
export function stepSlot(item: PlanItem, slot: BoardSlot, step: BoardStep, columns: readonly BoardColumn[]): BoardSlot {
    const ci = columns.findIndex((c) => c.key === slot.column);
    if (ci < 0) return slot;
    const own = (col: BoardColumn): number => col.queue.findIndex((i) => i.id === item.id);
    if (step === 'left' || step === 'right') {
        const next = columns[ci + (step === 'left' ? -1 : 1)];
        if (!next) return slot;
        const at = own(next);
        const max = next.queue.length;
        const index = Math.min(slot.index, max);
        // Landing on the card's own place from the side: the slot sits where the card is.
        return { column: next.key, index: at >= 0 && index === at + 1 ? at : index };
    }
    const col = columns[ci]!;
    const at = own(col);
    const max = col.queue.length;
    let index = slot.index + (step === 'up' ? -1 : 1);
    // `at` and `at + 1` are the same place: skip the second.
    if (at >= 0 && index === at + 1) index += step === 'up' ? -1 : 1;
    return index < 0 || index > max ? slot : { column: col.key, index };
}
