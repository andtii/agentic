/**
 * Where the Plan views read from and write to (#754, #926): on mock data the plans in `mock/projects/plan.ts`; live,
 * the project's Plan actor (#750) — `list()` read in setup, and the views' writes (add item, new plan, assign, tick,
 * comment) as its methods, a refusal kept as the page's note. Also how a plan names its actors and what "now" is.
 */
import { signal, useData } from 'sigx';
import { actor } from '@sigx/actors';
import type { Plan, PlanActor, PlanItem, TaskSnapshot } from '@agentic/core';
import type { AgentHue } from '@agentic/ui';
import { useActorDefs, useViewer, type ActorDefs, type ViewerState } from '../../../../../actors/defs';
import { planKeyOf, taskKeyOf } from '../../../../../actors/keys';
import { dataMode } from '../../../../../data-mode';
import { MOCK_PLANS, MOCK_PLAN_VIEWER } from '../../../../../mock/projects/plan';
import { AGENTS, MOCK_NOW, USER } from '../../../../../mock/workspace';
import { useAgentDirectory } from '../../../../chat/directory';
import type { AgentLookup } from '../../../../chat/live';
import { usePlans } from '../../../work/live';
import type { PlanDoc, PlanItemRun } from './model';

/** A project's plans on mock data. */
export const mockPlansOf = (projectId: string): readonly PlanDoc[] => MOCK_PLANS[projectId] ?? [];

type PlanClient = ReturnType<typeof actor<ActorDefs['Plan']>>;

/** The Plan actor's writes the views make (#926). Each resolves to its result, or `undefined` when refused (the note says why). */
export interface PlanWrites {
    /** Add an item to the plan's last phase — opening a first phase when the plan has none. */
    addItem(plan: Plan, title: string): Promise<readonly PlanItem[] | undefined>;
    newPlan(title: string): Promise<Plan | undefined>;
    /** Into `to`'s queue at `index`, or `null` back to the open pool. */
    assign(itemId: number, to: PlanActor | null, index?: number): Promise<PlanItem | undefined>;
    /** Release a worked item to the top of `to`'s queue with a note. */
    handoff(itemId: number, to: PlanActor | null, note: string): Promise<PlanItem | undefined>;
    tick(itemId: number, index: number, checked: boolean): Promise<PlanItem | undefined>;
    comment(itemId: number, text: string): Promise<PlanItem | undefined>;
}

/** A project's plans for the Plan views, with the live writes. */
export interface PlanStore {
    docs(): readonly PlanDoc[];
    readonly loading: boolean;
    /** Live only; absent on mock data, where the views keep their own copy. */
    readonly writes?: PlanWrites;
    /** The last refused write, for the page's error note; `''` when there is none (a success clears it). */
    note(): string;
}

/** The tasks the plans' open, claimed items run as, sorted — the key the live read of their tasks follows. */
export function claimTaskIds(plans: readonly Plan[]): string[] {
    const ids = new Set<string>();
    for (const plan of plans) for (const phase of plan.phases) for (const item of phase.items) if (item.state !== 'done' && item.claim?.taskId) ids.add(item.claim.taskId);
    return [...ids].sort();
}

/** Where a task runs, as an item's Runs as (#939): its machine and environment, its folder, its session. */
export function runOfTask(task: Pick<TaskSnapshot, 'id' | 'machineId' | 'environmentId' | 'workdir' | 'sessionId'>): PlanItemRun {
    return {
        taskId: task.id,
        taskRef: task.id,
        ...(task.machineId ? { machine: task.machineId, machineId: task.machineId } : {}),
        ...(task.environmentId ? { environmentId: task.environmentId } : {}),
        ...(task.workdir ? { workdir: task.workdir } : {}),
        ...(task.sessionId ? { sessionId: task.sessionId } : {})
    };
}

/** A plan's runs by item `#n`, from the tasks read by id. */
export function runsOf(plan: Plan, tasks: Readonly<Record<string, PlanItemRun>>): Record<number, PlanItemRun> {
    const out: Record<number, PlanItemRun> = {};
    for (const phase of plan.phases) {
        for (const item of phase.items) {
            const run = item.state !== 'done' && item.claim?.taskId ? tasks[item.claim.taskId] : undefined;
            if (run) out[item.id] = run;
        }
    }
    return out;
}

/** A failed call as the page's note. */
export function planFailureNote(what: string, error: unknown): string {
    const message = error instanceof Error ? error.message.replace(/^\[plan\]\s*/, '') : String(error);
    return `Could not ${what}: ${message}`;
}

/**
 * The project's plans and the writes to them. Call in setup; `projectId` may be a getter, so the read follows the
 * project a mounted page moves to. Live, one `list()` read of the project's Plan actor (`usePlans`, #882).
 */
export function usePlanStore(projectId: string | (() => string)): PlanStore {
    const id = typeof projectId === 'function' ? projectId : () => projectId;
    if (dataMode() !== 'live') return { docs: () => mockPlansOf(id()), loading: false, note: () => '' };
    const defs = useActorDefs();
    const viewer = useViewer()();
    const read = usePlans(id, { defs, viewer });
    // Runs as (#939): the task each claimed item's claim names, read once per set of claims.
    const tasks = useData(
        () => {
            const ws = viewer.workspaceId;
            const ids = claimTaskIds(read.plans());
            return ws && ids.length ? (['plan-runs', ws, ...ids] as const) : false;
        },
        async (key): Promise<Record<string, PlanItemRun>> => {
            const [, ws, ...ids] = key as readonly [string, string, ...string[]];
            const out: Record<string, PlanItemRun> = {};
            await Promise.all(ids.map(async (taskId) => {
                try {
                    out[taskId] = runOfTask(await actor(defs.TaskActor, taskKeyOf(ws, taskId)).get());
                } catch {
                    // Gone or not readable: the item shows no run.
                }
            }));
            return out;
        }
    );
    // The note belongs to the project the write went to: a page that moves to another project does not show it.
    const st = signal({ note: '', projectId: '' });
    const run = async <T>(what: string, call: (client: PlanClient) => Promise<T>): Promise<T | undefined> => {
        const ws = viewer.workspaceId;
        const projectId = id();
        if (!ws) return undefined;
        try {
            const out = await call(actor(defs.Plan, planKeyOf(ws, projectId)));
            st.note = '';
            return out;
        } catch (error) {
            st.note = planFailureNote(what, error);
            st.projectId = projectId;
            return undefined;
        }
    };
    const writes: PlanWrites = {
        addItem: (plan, title) => run('add the item', async (c) => {
            let phase = plan.phases.at(-1)?.n;
            if (phase === undefined) phase = (await c.addPhase(plan.id, 'Phase 1')).phases.at(-1)?.n ?? 1;
            return c.add(plan.id, phase, [{ title }]);
        }),
        newPlan: (title) => run('start a plan', (c) => c.create({ title })),
        assign: (itemId, to, index) => run(`move #${itemId}`, (c) => c.assign(itemId, to, index)),
        handoff: (itemId, to, note) => run(`hand #${itemId} off`, (c) => c.handoff(itemId, to, note)),
        tick: (itemId, index, checked) => run(`tick #${itemId}`, (c) => c.update(itemId, { tick: [{ index, checked }] })),
        comment: (itemId, text) => run(`comment on #${itemId}`, (c) => c.update(itemId, { note: text }))
    };
    return {
        docs: () => read.plans().map((plan) => ({ plan, runs: runsOf(plan, tasks.value ?? {}) })),
        get loading() {
            return read.loading;
        },
        writes,
        note: () => (st.projectId === id() ? st.note : '')
    };
}

/** Who "Mine" and "You" are on mock data. */
export const planViewer = (): PlanActor => MOCK_PLAN_VIEWER;

/** The clock leases and ages count from. */
export const planNow = (): number => (dataMode() === 'live' ? Date.now() : MOCK_NOW);

export interface PlanActorLook {
    readonly name: string;
    readonly hue?: AgentHue;
    readonly person: boolean;
    /** The tile's monogram when it is not the name's (you: your initials, labelled "You"). */
    readonly monogram?: string;
}

const initials = (name: string): string => name.slice(0, 2).toUpperCase();

/**
 * How an actor is drawn: an agent by its name and hue (`agent` answers for an id, or `undefined` when unknown), the
 * viewer `me` as "You" (with `monogram`), another person by their id.
 */
export function lookOf(a: PlanActor, me: PlanActor, agent: (id: string) => { readonly name: string; readonly hue?: AgentHue } | undefined, monogram?: string): PlanActorLook {
    if (a.kind === 'user') {
        return me.kind === 'user' && me.userId !== '' && a.userId === me.userId ? { name: 'You', person: true, ...(monogram ? { monogram } : {}) } : { name: a.userId, person: true };
    }
    const found = agent(a.agentId);
    return found ? { name: found.name, ...(found.hue !== undefined ? { hue: found.hue } : {}), person: false } : { name: a.agentId, person: false };
}

/** How an actor is drawn on mock data. */
export function actorLook(a: PlanActor, me: PlanActor = planViewer()): PlanActorLook {
    return lookOf(a, me, (id) => AGENTS.find((x) => x.id === id), initials(USER.name));
}

export const actorName = (a: PlanActor): string => actorLook(a).name;

/** Who the viewer is and how the plan's actors are named (#939): the mock workspace, or live the signed-in user and the agent directory. */
export interface PlanIdentity {
    /** The viewer as a plan actor — "You" and "Mine". Live and signed out (or still asking), a user nobody is. */
    me(): PlanActor;
    look(a: PlanActor): PlanActorLook;
    name(a: PlanActor): string;
}

export const mockPlanIdentity: PlanIdentity = { me: planViewer, look: (a) => actorLook(a), name: actorName };

/** Nobody: the live viewer before `whoami` answers. Matches no item. */
const NOBODY: PlanActor = { kind: 'user', userId: '' };

/** The live identity over a viewer and an agent lookup (#939). */
export function livePlanIdentity(viewer: Pick<ViewerState, 'userId' | 'login'>, lookup: AgentLookup): PlanIdentity {
    const me = (): PlanActor => (viewer.userId ? { kind: 'user', userId: viewer.userId } : NOBODY);
    const look = (a: PlanActor): PlanActorLook => lookOf(a, me(), (id) => lookup(id), viewer.login ? initials(viewer.login) : undefined);
    return { me, look, name: (a) => look(a).name };
}

/** The identity the Plan views draw with. Call in setup; live, it reads the agent directory. */
export function usePlanIdentity(): PlanIdentity {
    if (dataMode() !== 'live') return mockPlanIdentity;
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    return livePlanIdentity(viewer, directory.lookup);
}
