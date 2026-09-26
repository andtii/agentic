/**
 * `/projects/:id/plan?view=graph` (#756, PRJ-13): the Plan graph, kept minimal — one plan's items as nodes in phase
 * lanes, `after` as arrows, each node its state glyph — and the plan switcher by the title (the project's plans, then
 * New plan). The layout is `planGraphLayout` (./layout.ts). Undrawn in the boards: HANDOFF.md "Plan" gives the glyphs.
 *
 * Mock data draws `MOCK_GRAPH_PLANS`; live (#926), the project's Plan actor — New plan is its `create`, and a refusal
 * shows as the note under the switcher.
 */
import { component, signal, type Define } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import type { Plan } from '@agentic/core';
import { ItemGlyph } from '@agentic/ui';
import { dataMode } from '../../../../../data-mode';
import type { ProjectPageProps } from '../../../layout/types';
import { usePlanStore } from '../shared/data';
import { useFollow } from '../shared/parts';
import { PlanSwitcher, PlanViews, planHref } from '../shared/switcher';
import { GRAPH_NODE_H, GRAPH_NODE_W, planGraphLayout } from './layout';
import { MOCK_GRAPH_PLANS } from './mock';

const STATE_LABEL: Readonly<Record<Plan['phases'][number]['items'][number]['state'], string>> = {
    ready: 'Ready',
    claimed: 'Claimed',
    'needs-you': 'Needs you',
    blocked: 'Blocked',
    done: 'Done',
    stuck: 'Stuck'
};

/** The graph of one plan: lanes, arrows, nodes. */
export const PlanGraphCanvas = component<Define.Prop<'plan', Plan, true>>(({ props }) => () => {
    const g = planGraphLayout(props.plan);
    if (g.nodes.length === 0) return <p data-plan-graph-empty="" role="status">No items in this plan yet.</p>;
    return (
        <div data-plan-graph-scroll="">
            <div data-plan-graph-canvas="" style={{ width: `${g.width}px`, height: `${g.height}px` }}>
                {g.lanes.map((l) => (
                    <div key={l.phase} data-plan-graph-lane={String(l.phase)} style={{ top: `${l.y}px`, height: `${l.height}px` }}>
                        <span data-plan-graph-lane-title="">{`${l.phase} · ${l.title}`}</span>
                    </div>
                ))}
                <svg data-plan-graph-edges="" width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true">
                    <defs>
                        <marker id="plan-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                            <path d="M0 0 L8 4 L0 8 z" data-plan-graph-arrow="" />
                        </marker>
                    </defs>
                    {g.edges.map((e) => (
                        <path key={`${e.from}-${e.to}`} d={e.d} data-plan-graph-edge={`${e.from}-${e.to}`} data-done={e.done ? '' : undefined} marker-end="url(#plan-graph-arrow)" />
                    ))}
                </svg>
                <ol data-plan-graph-nodes="" aria-label="Items">
                    {g.nodes.map((n) => {
                        const item = props.plan.phases.flatMap((p) => p.items).find((i) => i.id === n.id);
                        const waits = (item?.after ?? []).filter((a) => g.nodes.some((m) => m.id === a));
                        return (
                            <li
                                key={n.id}
                                data-plan-graph-node={String(n.id)}
                                data-state={n.state}
                                data-depth={String(n.depth)}
                                style={{ left: `${n.x}px`, top: `${n.y}px`, width: `${GRAPH_NODE_W}px`, height: `${GRAPH_NODE_H}px` }}
                            >
                                <ItemGlyph state={n.state} label={STATE_LABEL[n.state]} />
                                <span data-plan-graph-node-id="">{`#${n.id}`}</span>
                                <span data-plan-graph-node-title="" title={n.title}>{n.title}</span>
                                {waits.length ? <span data-plan-graph-node-after="">{`after ${waits.map((a) => `#${a}`).join(', ')}`}</span> : null}
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
}, { name: 'PlanGraphCanvas' });

export { PlanSwitcher, type PlanSwitcherProps } from '../shared/switcher';

/** The Plan graph view and its plan switcher (#756). */
export const PlanGraph = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    const router = useRouter();
    const follow = useFollow();
    const st = signal<{ planId: string | null; created: Plan[] }>({ planId: null, created: [] });
    const live = dataMode() === 'live';
    const store = live ? usePlanStore(() => props.project.id) : undefined;
    const plans = (): readonly Plan[] => (store ? store.docs().map((d) => d.plan) : [...(MOCK_GRAPH_PLANS[props.project.id] ?? []), ...st.created.filter((p) => p.projectId === props.project.id)]);
    const newPlan = async (): Promise<void> => {
        if (store?.writes) {
            const plan = await store.writes.newPlan(`Untitled plan ${plans().length + 1}`);
            if (plan) select(plan.id);
            return;
        }
        const plan: Plan = { id: `plan_new_${st.created.length + 1}`, projectId: props.project.id, title: `Untitled plan ${st.created.length + 1}`, phases: [] };
        st.created = [...st.created, plan];
        st.planId = plan.id;
    };
    /** Picking a plan follows `?plan=`, as on the list and the board. */
    const select = (id: string): void => {
        st.planId = id;
        void router.push(planHref(props.project.id, 'graph', id));
    };
    return () => {
        const list = plans();
        const current = list.find((p) => p.id === (st.planId ?? route.query.plan)) ?? list[0];
        return (
            <section aria-label="Plan graph" data-plan-graph="">
                <header data-plan-graph-head="">
                    <PlanSwitcher plans={list} current={current} onSelect={select} onNew={() => void newPlan()} />
                    {PlanViews(props.project.id, 'graph', follow, list.length > 1 ? current?.id : undefined)}
                </header>
                {store?.note() ? <p data-plan-note="" role="alert">{store.note()}</p> : null}
                {current ? <PlanGraphCanvas plan={current} /> : <p data-plan-graph-empty="" role="status">No plans yet.</p>}
            </section>
        );
    };
}, { name: 'PlanGraph' });
