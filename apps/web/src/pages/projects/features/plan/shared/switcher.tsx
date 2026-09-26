/**
 * The plan switcher by the title and the List / Board / Graph toggle (#939), one of each on every Plan view. The
 * switcher lists the project's plans, the current one marked, then New plan; picking one follows `?plan=`.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { Popover } from '@sigx/zero';
import type { Plan } from '@agentic/core';
import { Icon } from '@agentic/ui';

export const PLAN_VIEW_LABELS = [
    { value: 'list', label: 'List' },
    { value: 'board', label: 'Board' },
    { value: 'graph', label: 'Graph' }
] as const;

/** `/projects/:id/plan?view=…`, keeping the plan picked. */
export function planHref(projectId: string, view: string, planId?: string): string {
    const q = new URLSearchParams();
    if (view !== 'list') q.set('view', view);
    if (planId) q.set('plan', planId);
    const s = q.toString();
    return `/projects/${projectId}/plan${s ? `?${s}` : ''}`;
}

/** The view toggle: `follow` routes a click (see `useFollow`), `planId` rides along when the project has several plans. */
export const PlanViews = (projectId: string, view: string, follow: (href: string) => (e: MouseEvent) => void, planId?: string) => (
    <nav data-plan-views="" aria-label="Plan views">
        {PLAN_VIEW_LABELS.map((v) => {
            const href = planHref(projectId, v.value, planId);
            return <a href={href} onClick={follow(href)} aria-current={v.value === view ? 'page' : undefined} data-plan-view-link={v.value}>{v.label}</a>;
        })}
    </nav>
);

export type PlanSwitcherProps =
    & Define.Prop<'plans', readonly Plan[], true>
    & Define.Prop<'current', Plan | undefined>
    & Define.Event<'select', string>
    /** Absent (no plan store to write to), New plan is disabled. */
    & Define.Prop<'onNew', () => void>
    /** Only the chevron, beside a heading that already names the plan. */
    & Define.Prop<'compact', boolean>;

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
            {props.compact
                ? (
                    <Popover.Trigger data-plan-switcher="" data-compact="" aria-label={`Switch plan (now ${props.current?.title ?? 'none'})`}>
                        <Icon name="chevron-down" size={16} />
                    </Popover.Trigger>
                )
                : (
                    <Popover.Trigger data-plan-switcher="">
                        <span data-plan-switcher-title="">{props.current?.title ?? 'No plan'}</span>
                        <Icon name="chevron-down" size={14} />
                    </Popover.Trigger>
                )}
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
