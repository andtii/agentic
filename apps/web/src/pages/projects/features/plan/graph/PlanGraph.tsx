/**
 * `/projects/:id/plan?view=graph` (#756, PRJ-13): the Plan graph, kept minimal — one plan's items as nodes in phase
 * lanes, `after` as arrows, each node its state glyph — and the plan switcher by the title (the project's plans, then
 * New plan). The layout is `planGraphLayout` (./layout.ts). Undrawn in the boards: HANDOFF.md "Plan" gives the glyphs.
 *
 * Mock data draws `MOCK_GRAPH_PLANS`; live, the project has no plan store yet, so the view says so.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { Popover } from '@sigx/zero';
import type { Plan } from '@agentic/core';
import { Icon, ItemGlyph } from '@agentic/ui';
import { dataMode } from '../../../../../data-mode';
import type { ProjectPageProps } from '../../../layout/types';
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
    // The arrows into each node, for its off-screen `after #n` line.
    const waitsOn = new Map<number, number[]>();
    for (const e of g.edges) waitsOn.set(e.to, [...(waitsOn.get(e.to) ?? []), e.from]);
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
                        const waits = waitsOn.get(n.id) ?? [];
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

export type PlanSwitcherProps =
    & Define.Prop<'plans', readonly Plan[], true>
    & Define.Prop<'current', Plan | undefined>
    & Define.Event<'select', string>
    /** Absent (no plan store to write to), New plan is disabled. */
    & Define.Prop<'onNew', () => void>;

/** The plan switcher by the title: a popover listing the project's plans, the current one marked, then New plan. */
export const PlanSwitcher = component<PlanSwitcherProps>(({ props, emit }) => {
    const st = signal({ open: false });
    const pick = (id: string): void => {
        st.open = false;
        emit('select', id);
    };
    const create = (): void => {
        st.open = false;
        props.onNew?.();
    };
    return (): JSXElement => (
        <Popover.Root model={() => st.open} placement="bottom-start">
            <Popover.Trigger data-plan-switcher="">
                <span data-plan-switcher-title="">{props.current?.title ?? 'No plan'}</span>
                <Icon name="chevron-down" size={14} />
            </Popover.Trigger>
            <Popover.Popup data-plan-switcher-popup="">
                <Popover.Title>Plans</Popover.Title>
                <ul data-plan-switcher-list="">
                    {props.plans.map((p) => (
                        <li key={p.id}>
                            <button type="button" data-plan-option={p.id} aria-current={p.id === props.current?.id ? 'true' : undefined} onClick={() => pick(p.id)}>
                                {p.title}
                            </button>
                        </li>
                    ))}
                </ul>
                <button type="button" data-plan-new="" disabled={!props.onNew} onClick={create}>
                    <Icon name="plus" size={14} />
                    <span>New plan</span>
                </button>
            </Popover.Popup>
        </Popover.Root>
    );
}, { name: 'PlanSwitcher' });

/** The Plan graph view and its plan switcher (#756). */
export const PlanGraph = component<ProjectPageProps>(({ props }) => {
    const st = signal<{ planId: string | null; created: Plan[] }>({ planId: null, created: [] });
    const plans = (): readonly Plan[] => (dataMode() === 'live' ? [] : [...(MOCK_GRAPH_PLANS[props.project.id] ?? []), ...st.created.filter((p) => p.projectId === props.project.id)]);
    const newPlan = (): void => {
        const plan: Plan = { id: `plan_new_${st.created.length + 1}`, projectId: props.project.id, title: `Untitled plan ${st.created.length + 1}`, phases: [] };
        st.created = [...st.created, plan];
        st.planId = plan.id;
    };
    return () => {
        const list = plans();
        const current = list.find((p) => p.id === st.planId) ?? list[0];
        return (
            <section aria-label="Plan graph" data-plan-graph="">
                <header data-plan-graph-head="">
                    <PlanSwitcher plans={list} current={current} onSelect={(id: string) => { st.planId = id; }} onNew={dataMode() === 'live' ? undefined : newPlan} />
                </header>
                {current ? <PlanGraphCanvas plan={current} /> : <p data-plan-graph-empty="" role="status">No plans yet.</p>}
            </section>
        );
    };
}, { name: 'PlanGraph' });
