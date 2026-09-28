/**
 * Home's plan items that need a person (#1044): every project with the Plan feature has a Plan actor
 * (`{ws}:plan:{projectId}`); `PlansFeed` mounts one live `Plan.list` read per such project (`usePlans`) and gathers
 * their plans into a `WorkspacePlans`, as `PullsFeed` does for pull requests. The item's own state is the record: a
 * row leaves Home once the item no longer needs you, whoever answered it and wherever. Answering goes through the
 * project's Plan actor (`answer`: ready again, the asker woken with the answer); Mark done is `update({state: 'done'})`.
 */
import { component, effect, onUnmounted, signal, untrack, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import type { Plan, PlanActor } from '@agentic/core';
import { useActorDefs, useViewer, type ActorDefs } from '../../../../../actors/defs';
import { planKeyOf } from '../../../../../actors/keys';
import { MOCK_PLANS } from '../../../../../mock/projects/plan';
import { MOCK_NOW, PROJECTS } from '../../../../../mock/workspace';
import type { PlanNeed, PlanNeeds } from '../../../../inbox/NeedsYou';
import { PLAN_FEATURE } from '../../../layout/counts';
import { useProjects } from '../../../live';
import { usePlans } from '../../../work/live';
import { mockPlanIdentity } from '../shared/data';

/** Every Plan project's plans, as the mounted `PlansFeed` last read them. */
export interface WorkspacePlans {
    all(): readonly { readonly projectId: string; readonly projectName: string; readonly plans: readonly Plan[] }[];
    /** What `PlansFeed` writes: the plans of a project, `null` to drop it. */
    put(projectId: string, projectName: string, plans: readonly Plan[] | null): void;
}

export function createWorkspacePlans(): WorkspacePlans {
    const st = signal<{ byProject: Readonly<Record<string, { readonly projectName: string; readonly plans: readonly Plan[] }>> }>({ byProject: {} });
    return {
        all: () => Object.entries(st.byProject).map(([projectId, v]) => ({ projectId, ...v })),
        put: (projectId, projectName, plans) => {
            // Untracked: a reader's effect writes here, and must not depend on what the other projects hold.
            untrack(() => {
                const { [projectId]: _dropped, ...rest } = st.byProject;
                st.byProject = plans ? { ...rest, [projectId]: { projectName, plans } } : rest;
            });
        }
    };
}

/** The items of `plans` that need a person, each with where it is. */
export function needsOfPlans(projectId: string, projectName: string | undefined, plans: readonly Plan[]): PlanNeed[] {
    return plans.flatMap((plan) => plan.phases.flatMap((phase) => phase.items.filter((item) => item.state === 'needs-you').map((item): PlanNeed => ({ projectId, ...(projectName ? { projectName } : {}), planId: plan.id, item }))));
}

/** The item on its plan's list, its detail panel open. */
export const planItemHref = (need: Pick<PlanNeed, 'projectId' | 'planId' | 'item'>): string => `/projects/${need.projectId}/plan?plan=${encodeURIComponent(need.planId)}&item=${need.item.id}`;

const ProjectPlansReader = component<{ projectId: string; projectName: string; feed: WorkspacePlans }>(({ props }) => {
    const id = props.projectId;
    const read = usePlans(id);
    const stop = effect(() => props.feed.put(id, props.projectName, read.plans()));
    onUnmounted(() => {
        stop();
        props.feed.put(id, props.projectName, null);
    });
    return () => null;
}, { name: 'ProjectPlansReader' });

/** Reads every Plan project's Plan actor into `feed`; renders nothing. */
export const PlansFeed = component<{ feed: WorkspacePlans }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const projects = useProjects(defs, viewer);
    return (): JSXElement => (
        <>
            {projects.list().filter((p) => PLAN_FEATURE in p.features).map((p) => <ProjectPlansReader key={p.id} projectId={p.id} projectName={p.name} feed={props.feed} />)}
        </>
    );
}, { name: 'PlansFeed' });

/** Home's plan items live: the feed's items, named by `name`; answers and Mark done through the project's Plan actor. */
export function livePlanNeeds(feed: WorkspacePlans, defs: Pick<ActorDefs, 'Plan'>, workspaceId: () => string | null, name: (a: PlanActor) => string): PlanNeeds {
    const client = (need: PlanNeed) => {
        const ws = workspaceId();
        if (!ws) throw new Error('you are signed out');
        return actor(defs.Plan, planKeyOf(ws, need.projectId));
    };
    return {
        useItems: () => () => feed.all().flatMap((p) => needsOfPlans(p.projectId, p.projectName, p.plans)),
        name,
        now: () => Date.now(),
        href: planItemHref,
        // The row leaves once the live read shows the item ready (or done).
        answer: async (need, text) => {
            await client(need).answer(need.item.id, text);
        },
        done: async (need) => {
            await client(need).update(need.item.id, { state: 'done' });
        }
    };
}

/** Home's plan items on mock data: the fixtures' needs-you items; the card is read-only there. */
export function mockPlanNeeds(): PlanNeeds {
    const all = Object.entries(MOCK_PLANS).flatMap(([projectId, docs]) => docs.flatMap((d) => needsOfPlans(projectId, PROJECTS.find((p) => p.id === projectId)?.name, [d.plan])));
    return { useItems: () => () => all, name: mockPlanIdentity.name, now: () => MOCK_NOW, href: planItemHref };
}
