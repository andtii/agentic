/**
 * Parts every Plan view draws (#754): the header (title with the switcher chevron, origin, progress, List / Board /
 * Graph, Add item), an actor's tile, a progress bar, and the Overview card.
 */
import { component, type Define } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import type { PlanActor } from '@agentic/core';
import { AgentTile, Button, Icon, ItemGlyph } from '@agentic/ui';
import type { ProjectPageProps } from '../../../layout/types';
import { actorLook, plansOf } from './data';
import { nextItems, planProgress, progressText, type PlanDoc, type Progress } from './model';

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

/**
 * A click handler that follows `href` through the router, so a plain `<a>` can carry its own attributes
 * (`@sigx/router`'s `Link` forwards none and marks `aria-current` by path alone, blind to `?view=`). Call in setup.
 */
export function useFollow(): (href: string) => (e: MouseEvent) => void {
    const router = useRouter();
    return (href) => (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void router.push(href);
    };
}

/** A thin bar, decorative: the text beside it says the same. */
export const Bar = (p: Progress, attr: string) => (
    <span data-plan-bar={attr} aria-hidden="true"><span style={`inline-size: ${p.pct}%`} /></span>
);

/** An actor's tile at `size`. */
export const ActorTile = (a: PlanActor, size: 18 | 20 | 22 | 24) => {
    const look = actorLook(a);
    return <AgentTile name={look.name} hue={look.hue} person={look.person} monogram={look.monogram} size={size} />;
};

export type PlanHeaderProps =
    & Define.Prop<'projectId', string, true>
    & Define.Prop<'doc', PlanDoc, true>
    & Define.Prop<'view', string, true>
    /** Whether the project holds more than this plan (the chevron then says so). */
    & Define.Prop<'several', boolean>;

export const PlanHeader = component<PlanHeaderProps>(({ props }) => {
    const follow = useFollow();
    return () => {
        const { plan } = props.doc;
        const progress = planProgress(plan);
        return (
            <header data-plan-head="">
                <div data-plan-ident="">
                    <h2 data-plan-title="">
                        <span>{plan.title}</span>
                        <Icon name="chevron-down" size={16} />
                    </h2>
                    <p data-plan-sub="">
                        {plan.description ? <span data-plan-description="">{plan.description}</span> : null}
                        {plan.originChatId
                            ? <span data-plan-origin="">from chat <Link to={`/chats/${plan.originChatId}`}>{`“${props.doc.originTitle ?? plan.originChatId}”`}</Link></span>
                            : null}
                    </p>
                </div>
                <div data-plan-progress="">
                    <span data-plan-progress-text="">{progressText(progress)}</span>
                    <span data-plan-progress-pct="">{`${progress.pct}%`}</span>
                    {Bar(progress, 'plan')}
                </div>
                <nav data-plan-views="" aria-label="Plan views">
                    {PLAN_VIEW_LABELS.map((v) => {
                        const href = planHref(props.projectId, v.value, props.several ? plan.id : undefined);
                        return <a href={href} onClick={follow(href)} aria-current={v.value === props.view ? 'page' : undefined} data-plan-view-link={v.value}>{v.label}</a>;
                    })}
                </nav>
                <span data-plan-add="" title="Adding items arrives with the Plan store">
                    <Button intent="primary" icon="plus" disabled>Add item</Button>
                </span>
            </header>
        );
    };
}, { name: 'PlanHeader' });

/** The Plan feature's card on the project Overview: "N of M done", the bar, the next three items. */
export const PlanOverviewCard = component<ProjectPageProps>(({ props }) => () => {
    const doc = plansOf(props.project.id)[0];
    const href = `/projects/${props.project.id}/plan`;
    const progress = doc ? planProgress(doc.plan) : undefined;
    return (
        <section data-overview-card="plan" data-plan-card="" aria-label="Plan">
            <header data-overview-card-head="">
                <Icon name="menu" size={15} />
                <h2 data-overview-card-title="">Plan</h2>
                <span data-overview-feature-tag="">FEATURE</span>
                <span data-overview-card-aside=""><Link to={href}>Open</Link></span>
            </header>
            {doc && progress
                ? (
                    <>
                        <div data-plan-card-progress="">
                            <span data-plan-card-done="">{progressText(progress)}</span>
                            <span data-plan-progress-pct="">{`${progress.pct}%`}</span>
                        </div>
                        {Bar(progress, 'card')}
                        <ul data-plan-card-next="">
                            {nextItems(doc.plan).map((i) => (
                                <li key={i.id} data-plan-card-item={i.id}>
                                    <ItemGlyph state={i.state} />
                                    <Link to={`${href}?item=${i.id}`}>{i.title}</Link>
                                    {i.assignee ? ActorTile(i.assignee, 18) : null}
                                </li>
                            ))}
                        </ul>
                    </>
                )
                : <p data-overview-empty="">No plan in this project yet.</p>}
        </section>
    );
}, { name: 'PlanOverviewCard' });
