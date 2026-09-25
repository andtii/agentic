/**
 * Where the Plan views read from and write to (#754, #926): on mock data the plans in `mock/projects/plan.ts`; live,
 * the project's Plan actor (#750) — `list()` read in setup, and the views' writes (add item, new plan, assign, tick,
 * comment) as its methods, a refusal kept as the page's note. Also how a plan names its actors and what "now" is.
 */
import { signal } from 'sigx';
import { actor } from '@sigx/actors';
import type { Plan, PlanActor, PlanItem } from '@agentic/core';
import type { AgentHue } from '@agentic/ui';
import { useActorDefs, useViewer, type ActorDefs } from '../../../../../actors/defs';
import { planKeyOf } from '../../../../../actors/keys';
import { dataMode } from '../../../../../data-mode';
import { MOCK_PLANS, MOCK_PLAN_VIEWER } from '../../../../../mock/projects/plan';
import { AGENTS, MOCK_NOW, USER } from '../../../../../mock/workspace';
import { usePlans } from '../../../work/live';
import type { PlanDoc } from './model';

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
    const st = signal({ note: '' });
    const run = async <T>(what: string, call: (client: PlanClient) => Promise<T>): Promise<T | undefined> => {
        const ws = viewer.workspaceId;
        if (!ws) return undefined;
        try {
            const out = await call(actor(defs.Plan, planKeyOf(ws, id())));
            st.note = '';
            return out;
        } catch (error) {
            st.note = planFailureNote(what, error);
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
        docs: () => read.plans().map((plan) => ({ plan })),
        get loading() {
            return read.loading;
        },
        writes,
        note: () => st.note
    };
}

/** Who "Mine" and "You" are. */
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

/** How an actor is drawn: an agent by its name and hue, the viewer as "You", another person by their id. */
export function actorLook(a: PlanActor, me: PlanActor = planViewer()): PlanActorLook {
    if (a.kind === 'user') return a.userId === (me.kind === 'user' ? me.userId : '') ? { name: 'You', person: true, monogram: initials(USER.name) } : { name: a.userId, person: true };
    const agent = AGENTS.find((x) => x.id === a.agentId);
    return agent ? { name: agent.name, hue: agent.hue, person: false } : { name: a.agentId, person: false };
}

export const actorName = (a: PlanActor): string => actorLook(a).name;
