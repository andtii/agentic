/**
 * Parts every Plan view draws (#754): the header (title with the switcher chevron, origin, progress, List / Board /
 * Graph, Add item), an actor's tile, a progress bar, and the Overview card.
 */
import { component, signal, type Define } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import type { Plan, PlanActor } from '@agentic/core';
import { AgentTile, Button, Icon, ItemGlyph } from '@agentic/ui';
import type { ProjectPageProps } from '../../../layout/types';
import { actorLook, usePlanIdentity, usePlanStore, type PlanActorLook, type PlanStore } from './data';
import { PlanSwitcher, PlanViews, planHref } from './switcher';
import { nextItems, planProgress, progressText, type PlanDoc, type Progress } from './model';
import { chatHref } from '../../../../chat/href';

export { PLAN_VIEW_LABELS, planHref } from './switcher';

/** Picking a plan follows `?plan=` in `view`; New plan is the store's `create`, then that plan (absent on mock data). Call in setup. */
export function usePlanNav(view: string, projectId: () => string, store: Pick<PlanStore, 'docs' | 'writes'>): { select(id: string): void; readonly create?: () => void } {
    const router = useRouter();
    const writes = store.writes;
    return {
        select: (id) => { void router.push(planHref(projectId(), view, id)); },
        ...(writes
            ? {
                create: () => {
                    void writes.newPlan(`Untitled plan ${store.docs().length + 1}`).then((plan) => {
                        if (plan) void router.push(planHref(projectId(), view, plan.id));
                    });
                }
            }
            : {})
    };
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

/** An actor's tile at `size`, drawn by `lookOf` (the mock workspace's when absent). */
export const ActorTile = (a: PlanActor, size: 18 | 20 | 22 | 24, lookOf: (a: PlanActor) => PlanActorLook = actorLook) => {
    const look = lookOf(a);
    return <AgentTile name={look.name} hue={look.hue} person={look.person} monogram={look.monogram} size={size} />;
};

export type PlanHeaderProps =
    & Define.Prop<'projectId', string, true>
    & Define.Prop<'doc', PlanDoc, true>
    & Define.Prop<'view', string, true>
    /** Whether the project holds more than this plan (the chevron then says so). */
    & Define.Prop<'several', boolean>
    /** The project's plans (#939): the title becomes the plan switcher. */
    & Define.Prop<'plans', readonly Plan[]>
    /** Pick a plan from the switcher. */
    & Define.Prop<'onSelectPlan', (id: string) => void>
    /** New plan from the switcher; absent, it is disabled. */
    & Define.Prop<'onNewPlan', () => void>
    /** Add an item titled so (live, #926); resolves whether it was added. Absent, Add item is disabled. */
    & Define.Prop<'onAdd', (title: string) => Promise<boolean>>;

export const PlanHeader = component<PlanHeaderProps>(({ props }) => {
    const follow = useFollow();
    const st = signal({ adding: false, title: '', busy: false });
    const submit = async (e: Event): Promise<void> => {
        e.preventDefault();
        const title = st.title.trim();
        if (!title || st.busy || !props.onAdd) return;
        st.busy = true;
        const added = await props.onAdd(title);
        st.busy = false;
        if (added) {
            st.title = '';
            st.adding = false;
        }
    };
    return () => {
        const { plan } = props.doc;
        const progress = planProgress(plan);
        const several = props.plans ? props.plans.length > 1 : props.several === true;
        return (
            <header data-plan-head="">
                <div data-plan-ident="">
                    <div data-plan-title-row="" style="display: flex; align-items: center; gap: 6px; min-inline-size: 0">
                        <h2 data-plan-title="">
                            <span>{plan.title}</span>
                            {props.plans ? null : <Icon name="chevron-down" size={16} />}
                        </h2>
                        {props.plans
                            ? <PlanSwitcher compact plans={props.plans} current={plan} onSelect={(id: string) => props.onSelectPlan?.(id)} {...(props.onNewPlan ? { onNew: props.onNewPlan } : {})} />
                            : null}
                    </div>
                    <p data-plan-sub="">
                        {plan.description ? <span data-plan-description="">{plan.description}</span> : null}
                        {plan.originChatId
                            ? <span data-plan-origin="">from chat <Link to={chatHref({ id: plan.originChatId, projectId: props.projectId })}>{`“${props.doc.originTitle ?? plan.originChatId}”`}</Link></span>
                            : null}
                    </p>
                </div>
                <div data-plan-progress="">
                    <span data-plan-progress-text="">{progressText(progress)}</span>
                    <span data-plan-progress-pct="">{`${progress.pct}%`}</span>
                    {Bar(progress, 'plan')}
                </div>
                {PlanViews(props.projectId, props.view, follow, several ? plan.id : undefined)}
                {props.onAdd
                    ? (
                        <span data-plan-add="">
                            <Button intent="primary" icon="plus" onClick={() => { st.adding = !st.adding; }}>Add item</Button>
                        </span>
                    )
                    : (
                        <span data-plan-add="" title="Adding items needs the Plan store">
                            <Button intent="primary" icon="plus" disabled>Add item</Button>
                        </span>
                    )}
                {props.onAdd && st.adding
                    ? (
                        <form data-plan-add-form="" onSubmit={(e: Event) => void submit(e)}>
                            <input
                                type="text"
                                aria-label="New item title"
                                placeholder="What needs doing"
                                value={st.title}
                                onInput={(e: Event) => { st.title = (e.target as HTMLInputElement).value; }}
                            />
                            <Button type="submit" intent="primary" disabled={st.busy || !st.title.trim()}>Add</Button>
                            <Button onClick={() => { st.adding = false; }}>Cancel</Button>
                        </form>
                    )
                    : null}
            </header>
        );
    };
}, { name: 'PlanHeader' });

/** The Plan feature's card on the project Overview: "N of M done", the bar, the next three items. */
export const PlanOverviewCard = component<ProjectPageProps>(({ props }) => {
    const store = usePlanStore(() => props.project.id);
    const identity = usePlanIdentity();
    return () => {
        const doc = store.docs()[0];
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
                                        {i.assignee ? ActorTile(i.assignee, 18, identity.look) : null}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )
                    : <p data-overview-empty="">No plan in this project yet.</p>}
            </section>
        );
    };
}, { name: 'PlanOverviewCard' });
