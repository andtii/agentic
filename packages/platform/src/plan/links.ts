/**
 * Links across projects (#764; PRJ-17; docs/design/projects/HANDOFF.md "Links across projects"): an item can wait on
 * an item in another project (`after` holding `project#n`), its blocked state follows that item, and the workspace
 * lists every cross-project link as a graph — one lane per project with its manager, chains ending in a milestone or
 * release.
 *
 * Pure, like `rules.ts`: no I/O and no clock. A cross-project wait is stored on the item beside its local `after`
 * (`afterRefs`, the other project's id and item number), set by `setCrossAfter` under the same who-may rules as the
 * rest of the plan. The other project's item is read through an `ItemLookup` — the caller reads the other Plan
 * actors — and an unknown item counts as not done, like an unknown local `after` number.
 */
import { parseRef, type AgentId, type Plan, type PlanActor, type PlanItem, type PlanItemState, type ProjectId, type ProjectRecord, type Ref } from '@agentic/core';
import { ACTIVITY_KEPT, AFTER_MAX, PlanRuleError, claimRefusal, isManager, itemOf, itemView, planView, type Outcome, type PlanBook, type PlanCall, type PlanChange, type PlanItemInput, type StoredItem, type StoredPlan } from './rules.js';

// ---------------------------------------------------------------------------
// Cross-project `after`

/** An item in another project this item waits on. */
export interface CrossAfter {
    readonly projectId: ProjectId;
    readonly n: number;
}

/** A stored item with its cross-project waits (kept in the Plan book beside `after`). */
export type LinkedItem = StoredItem & { afterRefs?: CrossAfter[] };

/** The project facts a link needs: its id, its name (how `project#n` is written) and its manager. */
export interface LinkProjectInfo {
    readonly id: ProjectId;
    readonly name: string;
    /** The project's manager (its coordinator), if any. */
    readonly manager?: AgentId | null;
}

const fail = (message: string): never => {
    throw new PlanRuleError('invalid', message);
};

/** A value for an error message; never throws (a BigInt or a cycle would make `JSON.stringify` throw). */
function describe(v: unknown): string {
    if (typeof v === 'string') return v.slice(0, 80);
    try {
        return String(JSON.stringify(v)).slice(0, 80);
    } catch {
        return typeof v;
    }
}

/** A project name as a handle: lower case, runs of anything but letters, digits, `.`, `_` and `-` as one `-`. */
export const projectHandle = (name: string): string =>
    name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');

/** The project `handle` (from `project#n`) names: its id, else its name ignoring case, else its name as a handle. */
export function resolveProject(handle: string, projects: readonly LinkProjectInfo[]): ProjectId | null {
    const exact = projects.find((p) => p.id === handle);
    if (exact) return exact.id;
    const lower = handle.toLowerCase();
    const byName = projects.filter((p) => p.name.toLowerCase() === lower);
    if (byName.length === 1) return byName[0]!.id;
    const byHandle = projects.filter((p) => projectHandle(p.name) === projectHandle(handle));
    return byHandle.length === 1 ? byHandle[0]!.id : null;
}

/**
 * Split an `after` list as written — numbers, `#n`, `project#n`, or their refs — into this project's item numbers
 * and waits on other projects. `project#n` naming this project is local. Duplicates collapse.
 */
export function parseAfter(values: readonly unknown[], here: ProjectId, projects: readonly LinkProjectInfo[]): { local: number[]; cross: CrossAfter[] } {
    if (!Array.isArray(values)) fail('after must be a list');
    if (values.length > AFTER_MAX) fail(`after holds at most ${AFTER_MAX}`);
    const local = new Set<number>();
    const cross = new Map<string, CrossAfter>();
    for (const v of values) {
        let ref: Ref | null = null;
        if (typeof v === 'number') ref = Number.isSafeInteger(v) && v > 0 ? { kind: 'item', n: v } : null;
        else if (typeof v === 'string') ref = v.length <= 300 ? parseRef(v) : null;
        else if (v && typeof v === 'object') ref = v as Ref;
        if (ref?.kind === 'item' && Number.isSafeInteger(ref.n) && ref.n > 0) local.add(ref.n);
        else if (ref?.kind === 'project-item' && typeof ref.project === 'string' && Number.isSafeInteger(ref.n) && ref.n > 0) {
            const projectId = resolveProject(ref.project, projects) ?? fail(`after names ${ref.project}#${ref.n}, but there is no project ${ref.project}`);
            if (projectId === here) local.add(ref.n);
            else cross.set(`${projectId}#${ref.n}`, { projectId, n: ref.n });
        } else fail(`after takes #n or project#n, not ${describe(v)}`);
    }
    return { local: [...local], cross: [...cross.values()] };
}

/** The item's waits on other projects. */
export const crossAfterOf = (item: StoredItem): CrossAfter[] => [...((item as LinkedItem).afterRefs ?? [])];

/**
 * Set (replace) the item's waits on other projects. The project manager and people may; not on a done item, and not
 * on this project (that is plain `after`). `projects` names the workspace's projects so each wait is checked to exist.
 */
export function setCrossAfter(book: PlanBook, call: PlanCall, itemId: number, after: readonly CrossAfter[], projects: readonly LinkProjectInfo[]): Outcome<StoredItem> {
    const actor = call.actor ?? fail('a plan change needs an agent or a person');
    if (!isManager(call)) throw new PlanRuleError('forbidden', 'only the project manager and people may change what an item waits on');
    const item = itemOf(book, itemId) as LinkedItem;
    if (item.state === 'done') throw new PlanRuleError('done', `#${item.id} is done`);
    if (!Array.isArray(after)) fail('after must be a list');
    const seen = new Map<string, CrossAfter>();
    for (const a of after) {
        if (!a || typeof a.projectId !== 'string' || !Number.isSafeInteger(a.n) || a.n < 1) fail('a cross-project wait is {projectId, n}');
        if (a.projectId === book.projectId) fail(`#${a.n} is in this project; use after`);
        if (!projects.some((p) => p.id === a.projectId)) fail(`there is no project ${a.projectId}`);
        seen.set(`${a.projectId}#${a.n}`, { projectId: a.projectId, n: a.n });
    }
    const next = [...seen.values()];
    if (item.after.length + next.length > AFTER_MAX) fail(`after holds at most ${AFTER_MAX}`);
    const nameOf = (id: ProjectId) => projects.find((p) => p.id === id)?.name ?? id;
    const printed = next.map((a) => `${nameOf(a.projectId)}#${a.n}`);
    if (next.length) item.afterRefs = next;
    else delete item.afterRefs;
    const line = next.length ? `waits on ${printed.join(', ')}` : 'waits on no other project';
    item.activity.push({ at: call.now, actor, text: line });
    if (item.activity.length > ACTIVITY_KEPT) item.activity.splice(0, item.activity.length - ACTIVITY_KEPT);
    item.updatedAt = call.now;
    return { value: item, changes: [{ op: 'updated', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} ${line}: ${item.title}` }] };
}

// ---------------------------------------------------------------------------
// Blocked follows the other project's item

/** The view state of an item in another project, or `undefined` when it is not known (counts as not done). */
export type ItemLookup = (projectId: ProjectId, n: number) => PlanItemState | undefined;

/** The item's waits on other projects whose item is not done. */
export const crossWaitsOn = (item: StoredItem, lookup: ItemLookup): CrossAfter[] => crossAfterOf(item).filter((a) => lookup(a.projectId, a.n) !== 'done');

/** An item's state with its cross-project waits folded in: `ready` / `stuck` is `blocked` while one is unfinished. */
export function linkedState(state: PlanItemState, unfinished: number): PlanItemState {
    return unfinished > 0 && (state === 'ready' || state === 'stuck') ? 'blocked' : state;
}

/** `itemView` with the cross-project waits applied to its state. */
export function linkedItemView(book: PlanBook, item: StoredItem, now: number, lookup: ItemLookup): PlanItem & { readonly afterRefs: readonly CrossAfter[] } {
    const view = itemView(book, item, now);
    return { ...view, state: linkedState(view.state, crossWaitsOn(item, lookup).length), afterRefs: crossAfterOf(item) };
}

/** `claimRefusal`, also refusing while an item in another project it waits on is unfinished. */
export function linkedClaimRefusal(book: PlanBook, call: PlanCall, agentId: AgentId, item: StoredItem, lookup: ItemLookup, projects: readonly LinkProjectInfo[] = []): PlanRuleError | null {
    const local = claimRefusal(book, call, agentId, item);
    if (local) return local;
    const waits = crossWaitsOn(item, lookup);
    if (!waits.length) return null;
    const nameOf = (id: ProjectId) => projects.find((p) => p.id === id)?.name ?? id;
    return new PlanRuleError('blocked', `#${item.id} waits on ${waits.map((a) => `${nameOf(a.projectId)}#${a.n}`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// The link graph

/** One item as the link graph reads it. */
export interface LinkItemInput {
    /** The item's view in its own project (its local `after` already applied to `state`). */
    readonly item: PlanItem;
    readonly afterRefs?: readonly CrossAfter[];
    readonly planId: string;
    readonly planTitle: string;
    /** A milestone or release, which chains end in; default: a title starting with "Release" or "Milestone". */
    readonly milestone?: boolean;
}

export interface LinkSource {
    readonly project: LinkProjectInfo;
    readonly items: readonly LinkItemInput[];
}

/** One project's items for `links()`, from its Plan book. */
export function linkSource(book: PlanBook, project: LinkProjectInfo, now: number): LinkSource {
    const items: LinkItemInput[] = [];
    for (const plan of Object.values(book.plans)) {
        for (const phase of plan.phases) {
            for (const n of phase.items) {
                const stored = book.items[String(n)];
                if (!stored) continue;
                const afterRefs = crossAfterOf(stored);
                items.push({ item: itemView(book, stored, now), ...(afterRefs.length ? { afterRefs } : {}), planId: plan.id, planTitle: plan.title });
            }
        }
    }
    return { project, items };
}

/** Whether a title reads as a milestone or release. */
export const isMilestoneTitle = (title: string): boolean => /^(release|milestone)\b/i.test(title.trim());

export type LinkShow = 'open' | 'done';

export interface LinkNode {
    /** `{projectId}#{n}` — unique across the workspace. */
    readonly key: string;
    readonly projectId: ProjectId;
    readonly n: number;
    /** How it is written: `{project name}#{n}`. */
    readonly label: string;
    readonly title: string;
    /** With cross-project waits applied. */
    readonly state: PlanItemState;
    /** Whoever works it now (a live claim), else whose queue it is in. */
    readonly owner?: PlanActor;
    readonly planId: string;
    readonly planTitle: string;
    readonly milestone: boolean;
    /** Keys of the items it waits on that are not done (local and cross-project). */
    readonly waitsOn: readonly string[];
}

/** An arrow from the item waited on (`from`) to the waiting item (`to`). */
export interface LinkEdge {
    readonly from: string;
    readonly to: string;
    /** Across projects; a local edge shows only as a step of a chain. */
    readonly cross: boolean;
    /** `done` once the item waited on is done. */
    readonly state: LinkShow;
}

export interface LinkLane {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly manager: AgentId | null;
    /** Upstream first. */
    readonly nodes: readonly LinkNode[];
}

/** What a milestone, release or last waiting item is waiting for, upstream first, the root last. */
export interface LinkChain {
    readonly root: string;
    /** The plan's title for a milestone or release ("agentic 0.5"), else the root's label. */
    readonly label: string;
    readonly steps: readonly LinkNode[];
    /** Further items in the root's own project it waits on, off the cross-project chain. */
    readonly inside: number;
}

export interface LinkGraph {
    readonly show: LinkShow;
    /** Cross-project links by state — the `Open N` / `Done N` toggle. */
    readonly counts: { readonly open: number; readonly done: number };
    readonly lanes: readonly LinkLane[];
    readonly edges: readonly LinkEdge[];
    readonly chains: readonly LinkChain[];
}

interface Entry {
    readonly source: LinkSource;
    readonly input: LinkItemInput;
    readonly key: string;
    /** Upstream keys: local `after` and cross-project waits. */
    readonly after: readonly string[];
    state: PlanItemState;
}

const keyOf = (projectId: ProjectId | string, n: number): string => `${projectId}#${n}`;

/**
 * Every cross-project link of the workspace: the `open` ones (the item waited on is not done) or the `done` ones,
 * with a lane per project that has a node, and a chain per root — each milestone or release the links lead to, else
 * each last waiting item. `sources` is every project's items (its order is the lanes' order); an item in another
 * project that no source holds counts as not done and is left out of the nodes.
 */
export function links(sources: readonly LinkSource[], show: LinkShow = 'open'): LinkGraph {
    const entries = new Map<string, Entry>();
    for (const source of sources) {
        for (const input of source.items) {
            const key = keyOf(source.project.id, input.item.id);
            const after = [...input.item.after.map((n) => keyOf(source.project.id, n)), ...(input.afterRefs ?? []).filter((a) => a.projectId !== source.project.id).map((a) => keyOf(a.projectId, a.n))];
            entries.set(key, { source, input, key, after: [...new Set(after)], state: input.item.state });
        }
    }
    const isDone = (key: string) => entries.get(key)?.state === 'done';
    // Blocked follows the other project's item: done-ness is stored, so one pass settles every state.
    for (const e of entries.values()) {
        const crossOpen = (e.input.afterRefs ?? []).filter((a) => a.projectId !== e.source.project.id && !isDone(keyOf(a.projectId, a.n))).length;
        e.state = linkedState(e.state, crossOpen);
    }
    const downstream = new Map<string, string[]>();
    for (const e of entries.values()) for (const up of e.after) (downstream.get(up) ?? downstream.set(up, []).get(up)!).push(e.key);

    const crossEdges: LinkEdge[] = [];
    for (const e of entries.values()) {
        for (const a of e.input.afterRefs ?? []) {
            if (a.projectId === e.source.project.id) continue;
            const from = keyOf(a.projectId, a.n);
            if (!entries.has(from)) continue;
            crossEdges.push({ from, to: e.key, cross: true, state: isDone(from) ? 'done' : 'open' });
        }
    }
    const counts = { open: crossEdges.filter((l) => l.state === 'open').length, done: crossEdges.filter((l) => l.state === 'done').length };
    const shown = crossEdges.filter((l) => l.state === show);

    const milestone = (e: Entry) => e.input.milestone ?? isMilestoneTitle(e.input.item.title);
    // Open: a done item no longer holds anything up, so the walks stop at it.
    const walkable = (key: string) => entries.has(key) && (show === 'done' || !isDone(key));

    // Roots: every milestone downstream of a shown link, and every last waiting item that reaches none.
    const candidates = new Set<string>();
    const stack = shown.map((l) => l.to);
    while (stack.length) {
        const k = stack.pop()!;
        if (candidates.has(k) || !entries.has(k)) continue;
        candidates.add(k);
        for (const d of downstream.get(k) ?? []) if (walkable(d)) stack.push(d);
    }
    const roots = [...candidates].filter((k) => milestone(entries.get(k)!) || !(downstream.get(k) ?? []).some((d) => candidates.has(d)));

    const nodeKeys = new Set<string>();
    for (const l of shown) nodeKeys.add(l.from).add(l.to);
    const chainEdges = new Map<string, LinkEdge>();
    const chainSteps: { root: string; steps: string[]; inside: number }[] = [];
    for (const root of roots) {
        const rootProject = entries.get(root)!.source.project.id;
        // Upstream of the root, stopping at done items when showing open links.
        const up = new Set<string>([root]);
        const walk = [root];
        while (walk.length) {
            const k = walk.pop()!;
            for (const a of entries.get(k)?.after ?? []) {
                if (up.has(a) || !walkable(a)) continue;
                up.add(a);
                walk.push(a);
            }
        }
        // On the chain: anything in another project, and anything here that waits (through `up`) on one.
        const onChain = new Set([...up].filter((k) => entries.get(k)!.source.project.id !== rootProject));
        for (let grew = true; grew; ) {
            grew = false;
            for (const k of up) {
                if (!onChain.has(k) && entries.get(k)!.after.some((a) => onChain.has(a))) {
                    onChain.add(k);
                    grew = true;
                }
            }
        }
        const steps = order([...up].filter((k) => k === root || onChain.has(k)), entries);
        const inside = [...up].filter((k) => k !== root && !steps.includes(k)).length;
        chainSteps.push({ root, steps, inside });
        for (const k of steps) {
            nodeKeys.add(k);
            for (const a of entries.get(k)!.after) {
                if (!steps.includes(a)) continue;
                const cross = entries.get(a)!.source.project.id !== entries.get(k)!.source.project.id;
                const edge: LinkEdge = { from: a, to: k, cross, state: isDone(a) ? 'done' : 'open' };
                if (!cross) chainEdges.set(`${a}>${k}`, edge);
            }
        }
    }

    const nodeOf = (key: string): LinkNode => {
        const e = entries.get(key)!;
        const it = e.input.item;
        const owner: PlanActor | undefined = it.claim ? { kind: 'agent', agentId: it.claim.agentId } : it.assignee;
        return {
            key,
            projectId: e.source.project.id,
            n: it.id,
            label: `${e.source.project.name}#${it.id}`,
            title: it.title,
            state: e.state,
            ...(owner ? { owner: { ...owner } } : {}),
            planId: e.input.planId,
            planTitle: e.input.planTitle,
            milestone: milestone(e),
            waitsOn: e.after.filter((a) => !isDone(a))
        };
    };
    const ordered = order([...nodeKeys], entries);
    const lanes: LinkLane[] = [];
    for (const source of sources) {
        const nodes = ordered.filter((k) => entries.get(k)!.source === source).map(nodeOf);
        if (nodes.length) lanes.push({ projectId: source.project.id, name: source.project.name, manager: source.project.manager ?? null, nodes });
    }
    const chains: LinkChain[] = chainSteps.map(({ root, steps, inside }) => {
        const e = entries.get(root)!;
        return { root, label: milestone(e) ? e.input.planTitle : `${e.source.project.name}#${e.input.item.id}`, steps: steps.map(nodeOf), inside };
    });
    return { show, counts, lanes, edges: [...shown, ...chainEdges.values()], chains };
}

/** Upstream first (Kahn over `after`); ties by project and number; a cycle's members follow in that order. */
function order(keys: readonly string[], entries: ReadonlyMap<string, Entry>): string[] {
    const set = new Set(keys);
    const byKey = (a: string, b: string) => {
        const x = entries.get(a)!;
        const y = entries.get(b)!;
        return x.source.project.id < y.source.project.id ? -1 : x.source.project.id > y.source.project.id ? 1 : x.input.item.id - y.input.item.id;
    };
    const pending = new Map(keys.map((k) => [k, entries.get(k)!.after.filter((a) => set.has(a) && a !== k).length]));
    const out: string[] = [];
    while (pending.size) {
        const ready = [...pending].filter(([, n]) => n === 0).map(([k]) => k);
        const take = (ready.length ? ready : [...pending.keys()]).sort(byKey);
        const next = ready.length ? take : [take[0]!];
        for (const k of next) {
            pending.delete(k);
            out.push(k);
        }
        for (const [k] of pending) pending.set(k, entries.get(k)!.after.filter((a) => pending.has(a) && a !== k).length);
    }
    return out;
}

// ---------------------------------------------------------------------------
// The Plan actor's side (#822): replacing an item's waits, views, and the lookups the actor prefetches

/** An item as `add` / `split` take it when `after` may name other projects' items (`project#n`). */
export type LinkedItemInput = Omit<PlanItemInput, 'after'> & { readonly after?: readonly (number | string | Ref)[] };

/**
 * Replace everything an item waits on — this project's items and other projects' — from a parsed `after`
 * (`parseAfter`). The project manager and people may; not on a done item; a local number must be another item of
 * this project.
 */
export function setAfter(book: PlanBook, call: PlanCall, itemId: number, after: { readonly local: readonly number[]; readonly cross: readonly CrossAfter[] }, projects: readonly LinkProjectInfo[]): Outcome<StoredItem> {
    const actor = call.actor ?? fail('a plan change needs an agent or a person');
    if (!isManager(call)) throw new PlanRuleError('forbidden', 'only the project manager and people may change what an item waits on');
    const item = itemOf(book, itemId);
    if (item.state === 'done') throw new PlanRuleError('done', `#${item.id} is done`);
    const local = [...new Set(after.local)];
    for (const n of local) {
        if (n === item.id) fail(`#${item.id} cannot wait on itself`);
        if (!book.items[String(n)]) fail(`after names #${n}, which is not an item of this project`);
    }
    const cross = [...new Map(after.cross.map((a) => [`${a.projectId}#${a.n}`, a])).values()];
    if (local.length + cross.length > AFTER_MAX) fail(`after holds at most ${AFTER_MAX}`);
    // No cycle here: nothing it would wait on may (through its own `after`) wait on it.
    const seen = new Set<number>();
    const walk = [...local];
    while (walk.length) {
        const n = walk.pop()!;
        if (n === item.id) fail(`#${item.id} cannot wait on an item that waits on it`);
        if (seen.has(n)) continue;
        seen.add(n);
        walk.push(...(book.items[String(n)]?.after ?? []));
    }
    const changes: PlanChange[] = [];
    const same = local.length === item.after.length && local.every((n) => item.after.includes(n));
    if (!same) {
        item.after = local;
        const line = local.length ? `waits on ${local.map((n) => `#${n}`).join(', ')}` : 'waits on no item here';
        item.activity.push({ at: call.now, actor, text: line });
        item.updatedAt = call.now;
        changes.push({ op: 'updated', actor, planId: item.planId, itemId: item.id, summary: `#${item.id} ${line}: ${item.title}` });
    }
    const set = setCrossAfter(book, call, itemId, cross, projects);
    return { value: set.value, changes: [...changes, ...set.changes] };
}

/** The other projects' items the given items wait on, by project. */
export function crossRefsByProject(items: Iterable<StoredItem>): Map<ProjectId, number[]> {
    const out = new Map<ProjectId, Set<number>>();
    for (const item of items) for (const a of crossAfterOf(item)) (out.get(a.projectId) ?? out.set(a.projectId, new Set()).get(a.projectId)!).add(a.n);
    return new Map([...out].map(([p, ns]) => [p, [...ns]]));
}

/** An `ItemLookup` over states read per project (`{projectId: {n: state}}`); anything missing is unknown. */
export function lookupOf(states: ReadonlyMap<ProjectId, Readonly<Record<string, PlanItemState | undefined>>>): ItemLookup {
    return (projectId, n) => states.get(projectId)?.[String(n)];
}

/** `planView` with the cross-project waits applied to each item. */
export function linkedPlanView(book: PlanBook, plan: StoredPlan, now: number, lookup: ItemLookup): Plan {
    const view = planView(book, plan, now);
    return {
        ...view,
        phases: view.phases.map((phase, k) => ({ ...phase, items: plan.phases[k]!.items.map((n) => book.items[String(n)]).filter((i): i is StoredItem => !!i).map((i) => linkedItemView(book, i, now, lookup)) }))
    };
}

/** The project facts a link needs, from its record. */
export const linkProjectInfo = (p: Pick<ProjectRecord, 'id' | 'name' | 'members'>): LinkProjectInfo => ({ id: p.id, name: p.name, manager: p.members.coordinator ?? null });

/** Where the workspace-wide `links` read gets its projects and each project's plan items. */
export interface WorkspaceLinksSource {
    projects(): Promise<readonly LinkProjectInfo[]>;
    /** A project's items for the graph (the Plan actor's `linkItems`); a throw leaves the project out. */
    items(projectId: ProjectId): Promise<readonly LinkItemInput[]>;
}

/** The workspace's link graph (`/projects/links`, the projects index strip): every project's items, then `links()`. */
export async function workspaceLinks(source: WorkspaceLinksSource, show: LinkShow = 'open'): Promise<LinkGraph> {
    const projects = await source.projects();
    const sources = await Promise.all(projects.map(async (project): Promise<LinkSource> => ({ project, items: await source.items(project.id).catch(() => []) })));
    return links(sources, show);
}
