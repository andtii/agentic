/**
 * The Plan views' pure model (#754, PRJ-13; docs/design/projects/HANDOFF.md → "Plan"): what the list, its detail
 * panel, the crew strip and the Overview card derive from a plan. No DOM, no data source — `data.ts` picks mock or
 * live, the components draw. The board (#755) and the graph (#756) may read the same helpers.
 */
import { formatRef, planItems, planItemWaitsOn, planTouchesOverlap, type Plan, type PlanActor, type PlanItem, type PlanPhase, type Ref, type TaskId } from '@agentic/core';

/** Where the task carrying an item out runs: `t_93d1` on alien01, branch `604-mcp-tools`. */
export interface PlanItemRun {
    readonly taskId: TaskId;
    /** The task's short ref as chats print it. */
    readonly taskRef: string;
    readonly machine?: string;
    readonly branch?: string;
    /** The session the task runs in, for "Open file". */
    readonly sessionId?: string;
}

/** The pinned lines of a file ref, for its hover card: `lines[0]` is line `ref.from`. */
export interface PlanFilePin {
    /** The branch the pinned commit is on (`main@4f2a9c1`). */
    readonly branch: string;
    readonly lines: readonly string[];
}

/** A plan with what the page draws beside it: the origin chat's title, each item's run, the file pins. */
export interface PlanDoc {
    readonly plan: Plan;
    readonly originTitle?: string;
    /** By item `#n`. */
    readonly runs?: Readonly<Record<number, PlanItemRun>>;
    /** By the file ref's text form (`formatRef`). */
    readonly pins?: Readonly<Record<string, PlanFilePin>>;
}

export type PlanFilter = 'all' | 'mine' | 'open';
export const PLAN_FILTERS: readonly { readonly value: PlanFilter; readonly label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'mine', label: 'Mine' },
    { value: 'open', label: 'Open' }
];

export interface Progress {
    readonly done: number;
    readonly total: number;
    /** Whole percent, 0 for an empty plan. */
    readonly pct: number;
}

function progressOf(items: readonly PlanItem[]): Progress {
    const done = items.filter((i) => i.state === 'done').length;
    return { done, total: items.length, pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}

export const planProgress = (plan: Pick<Plan, 'phases'>): Progress => progressOf(planItems(plan));
export const phaseProgress = (phase: Pick<PlanPhase, 'items'>): Progress => progressOf(phase.items);

/** "7 of 17 done". */
export const progressText = (p: Progress): string => `${p.done} of ${p.total} done`;

/** A key per actor, so an agent and a person never collide. */
export const actorKey = (a: PlanActor): string => (a.kind === 'agent' ? `agent:${a.agentId}` : `user:${a.userId}`);
export const sameActor = (a: PlanActor | undefined, b: PlanActor | undefined): boolean => a !== undefined && b !== undefined && actorKey(a) === actorKey(b);

/** Whether an item is still to do (anything but done). */
export const isOpen = (i: Pick<PlanItem, 'state'>): boolean => i.state !== 'done';

/** A path cut to its last two segments, as rows and chips print it: `plugins/model.ts`. */
export function shortPath(path: string): string {
    const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    return parts.slice(-2).join('/');
}

/** The open items other than `item` whose touches overlap one of its own, with the path they share. */
export function touchOverlaps(item: PlanItem, items: readonly PlanItem[]): { readonly item: PlanItem; readonly path: string }[] {
    const out: { item: PlanItem; path: string }[] = [];
    for (const other of items) {
        if (other.id === item.id || !isOpen(other)) continue;
        const path = item.touches.find((a) => other.touches.some((b) => planTouchesOverlap(a, b)));
        if (path !== undefined) out.push({ item: other, path });
    }
    return out;
}

/** The items that list `item` under `after`. */
export const unblocksOf = (item: Pick<PlanItem, 'id'>, items: readonly PlanItem[]): PlanItem[] => items.filter((i) => i.after.includes(item.id));

/** Cross-project items an item waits on, from its `project-item` refs: `signalx#14`. */
const externalWaits = (item: PlanItem): string[] => item.refs.filter((r) => r.kind === 'project-item').map(formatRef);

export type MetaTone = 'dim' | 'needs-you' | 'working';
export interface MetaPart {
    readonly text: string;
    readonly tone?: MetaTone;
}

/**
 * The line under an item's title: `waits on #9`, `after #8 · touches 2 paths · t_93d1`,
 * `touches plugins/model.ts · overlaps #9`, `Atlas asks you · 2 options`. A done item has none. An overlap is named
 * on the later item only, so the earlier one reads as the one the other waits for.
 */
export function itemMeta(item: PlanItem, items: readonly PlanItem[], name: (a: PlanActor) => string, run?: PlanItemRun): MetaPart[] {
    if (item.state === 'done') return [];
    const parts: MetaPart[] = [];
    if (item.state === 'needs-you') {
        parts.push({ text: item.assignedBy ? `${name(item.assignedBy)} asks you` : 'Needs you', tone: 'needs-you' });
        if (item.options?.length) parts.push({ text: `${item.options.length} option${item.options.length === 1 ? '' : 's'}` });
        return parts;
    }
    const waits = [...planItemWaitsOn(item, items).map((n) => `#${n}`), ...externalWaits(item)];
    if (waits.length) parts.push({ text: `waits on ${waits.join(', ')}` });
    else if (item.after.length) parts.push({ text: `after ${item.after.map((n) => `#${n}`).join(', ')}` });
    if (item.touches.length && item.state !== 'blocked') {
        const overlaps = touchOverlaps(item, items).filter((o) => o.item.id < item.id);
        const tone: MetaTone | undefined = overlaps.length ? 'needs-you' : undefined;
        parts.push({ text: item.touches.length === 1 ? `touches ${shortPath(item.touches[0]!)}` : `touches ${item.touches.length} paths`, ...(tone ? { tone } : {}) });
        if (overlaps.length) parts.push({ text: `overlaps ${overlaps.map((o) => `#${o.item.id}`).join(', ')}`, tone: 'needs-you' });
    }
    if (run && (item.state === 'claimed' || item.state === 'stuck')) parts.push({ text: run.taskRef });
    return parts;
}

export type OwnerTone = 'working' | 'needs-you' | 'failed' | 'dim';
export interface OwnerStatus {
    readonly text: string;
    readonly tone: OwnerTone;
}

/** The owner column's second line: `done`, `working`, `queued 2`, `your call`, `stuck`, or `not assigned`. */
export function ownerStatus(item: PlanItem): OwnerStatus {
    switch (item.state) {
        case 'done': return { text: 'done', tone: 'dim' };
        case 'claimed': return { text: 'working', tone: 'working' };
        case 'stuck': return { text: 'stuck', tone: 'failed' };
        case 'needs-you': return { text: 'your call', tone: 'needs-you' };
        default: return item.assignee ? { text: `queued ${(item.queueIndex ?? 0) + 1}`, tone: 'dim' } : { text: 'not assigned', tone: 'dim' };
    }
}

/** The last thing that happened to an item, for the age column; `undefined` when nothing has. */
export const lastActivityAt = (item: PlanItem): number | undefined =>
    item.activity.length ? Math.max(...item.activity.map((a) => a.at)) : undefined;

/** Whether `item` matches the search (title, `#n`, touches, refs) and the All / Mine / Open filter. */
export function itemMatches(item: PlanItem, q: string, filter: PlanFilter, me: PlanActor): boolean {
    if (filter === 'open' && !isOpen(item)) return false;
    if (filter === 'mine' && !sameActor(item.assignee, me)) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    const hay = [item.title, `#${item.id}`, ...item.touches, ...item.refs.map(formatRef)].join('\n').toLowerCase();
    return hay.includes(needle);
}

/** The phases with only their matching items; a phase left empty by a search or filter drops out. */
export function filterPhases(plan: Pick<Plan, 'phases'>, q: string, filter: PlanFilter, me: PlanActor): { readonly phase: PlanPhase; readonly items: readonly PlanItem[] }[] {
    const narrowed = q.trim() !== '' || filter !== 'all';
    return plan.phases
        .map((phase) => ({ phase, items: phase.items.filter((i) => itemMatches(i, q, filter, me)) }))
        .filter((p) => !narrowed || p.items.length > 0);
}

export interface CrewEntry {
    readonly actor: PlanActor;
    /** The project manager: labelled, counts shown only when it has items. */
    readonly manager: boolean;
    readonly working: number;
    readonly queued: number;
    readonly needsYou: number;
}

/**
 * The crew strip: the project manager first, then the project's agents, then anyone else holding items, then you —
 * each with how many items it is working on and how many wait in its queue (yours: how many need you).
 */
export function crewOf(plan: Pick<Plan, 'phases'>, members: { readonly agentIds: readonly string[]; readonly coordinator?: string | null }, me: PlanActor): CrewEntry[] {
    const items = planItems(plan);
    const order: PlanActor[] = [];
    const add = (a: PlanActor): void => {
        if (!order.some((o) => sameActor(o, a)) && !sameActor(a, me)) order.push(a);
    };
    if (members.coordinator) add({ kind: 'agent', agentId: members.coordinator as never });
    for (const id of members.agentIds) add({ kind: 'agent', agentId: id as never });
    for (const i of items) if (i.assignee) add(i.assignee);
    order.push(me);
    return order.map((actor) => {
        const mine = items.filter((i) => sameActor(i.assignee, actor));
        return {
            actor,
            manager: actor.kind === 'agent' && actor.agentId === members.coordinator,
            working: mine.filter((i) => i.state === 'claimed' || i.state === 'stuck').length,
            queued: mine.filter((i) => i.state === 'ready' || i.state === 'blocked').length,
            needsYou: mine.filter((i) => i.state === 'needs-you').length
        };
    });
}

/** A crew entry's counts: `1 working · 3 queued`, `1 needs you`, or `idle`. */
export function crewCounts(e: Pick<CrewEntry, 'working' | 'queued' | 'needsYou'>): { readonly text: string; readonly tone: OwnerTone }[] {
    const out: { text: string; tone: OwnerTone }[] = [];
    if (e.working) out.push({ text: `${e.working} working`, tone: 'working' });
    if (e.queued) out.push({ text: `${e.queued} queued`, tone: 'dim' });
    if (e.needsYou) out.push({ text: `${e.needsYou} needs you`, tone: 'needs-you' });
    return out;
}

/** The Overview card's next items: the first three still to do, in plan order. */
export const nextItems = (plan: Pick<Plan, 'phases'>, n = 3): PlanItem[] => planItems(plan).filter(isOpen).slice(0, n);

/** The item a page opens on when none is picked: the first one being worked on, else the first open one. */
export function defaultItem(plan: Pick<Plan, 'phases'>): PlanItem | undefined {
    const items = planItems(plan);
    return items.find((i) => i.state === 'claimed') ?? items.find(isOpen);
}

/** Which plan `?plan=` names; the first when it names none of them. */
export const planOf = (docs: readonly PlanDoc[], id: unknown): PlanDoc | undefined => docs.find((d) => d.plan.id === id) ?? docs[0];

/** Minutes left on a lease, never below 0. */
export const leaseMinutesLeft = (leaseUntil: number, now: number): number => Math.max(0, Math.ceil((leaseUntil - now) / 60_000));

/** `n of m in queue` for a queued item: its place among its assignee's ready and blocked items. */
export function queuePlace(item: PlanItem, items: readonly PlanItem[]): string | undefined {
    if (!item.assignee || (item.state !== 'ready' && item.state !== 'blocked')) return undefined;
    const queue = items.filter((i) => sameActor(i.assignee, item.assignee) && (i.state === 'ready' || i.state === 'blocked'));
    return `${(item.queueIndex ?? 0) + 1} of ${queue.length} in queue`;
}

/** How a ref reads on its chip: `plugins/model.ts:38-41`, `#604`, `architecture.md §7`, `modelcontextprotocol.io/spec`. */
export function refLabel(ref: Ref): string {
    switch (ref.kind) {
        case 'file': return `${shortPath(ref.path)}:${ref.from === ref.to ? ref.from : `${ref.from}-${ref.to}`}`;
        case 'pr': return `#${ref.n}`;
        case 'chat': return `chat · ${ref.messageId}`;
        case 'doc': return ref.section !== undefined ? `${shortPath(ref.path)} §${ref.section}` : shortPath(ref.path);
        case 'url': return ref.title ?? ref.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
        default: return formatRef(ref);
    }
}

/** The icon a ref chip carries. */
export function refIcon(ref: Ref): 'file' | 'branch' | 'commit' | 'chats' | 'link' | 'menu' | 'agents' {
    switch (ref.kind) {
        case 'file':
        case 'doc': return 'file';
        case 'pr': return 'branch';
        case 'commit': return 'commit';
        case 'chat': return 'chats';
        case 'url': return 'link';
        case 'member': return 'agents';
        default: return 'menu';
    }
}

/** What a ref typed into the comment box is, for the hint under it. */
export const REF_KIND_HINT: Readonly<Record<Ref['kind'], string>> = {
    item: 'item',
    'project-item': 'item in another project',
    member: 'agent or person',
    file: 'file lines',
    pr: 'pull request',
    commit: 'commit',
    chat: 'chat message',
    doc: 'doc',
    url: 'link'
};

/** A file ref's hover card line: `L38–41 · main@4f2a9c1`. */
export function pinLine(ref: Extract<Ref, { kind: 'file' }>, pin: PlanFilePin | undefined): string {
    const lines = ref.from === ref.to ? `L${ref.from}` : `L${ref.from}–${ref.to}`;
    return ref.sha ? `${lines} · ${pin?.branch ?? 'commit'}@${ref.sha}` : `${lines} · not pinned`;
}
