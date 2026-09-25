/**
 * `/projects/:id/plan?view=list|board|graph` (#725): the Plan feature's section — the list (#754, the default), the
 * board (#755) or the graph (#756), each its own folder.
 */
import { component } from 'sigx';
import { useRoute } from '@sigx/router';
import { Page } from '../../../../components/Page';
import { defineTopbar } from '../../../../components/topbar';
import { projectTrail } from '../../layout/trail';
import type { ProjectPage, ProjectPageProps } from '../../layout/types';
import { PlanBoard } from './board/PlanBoard';
import { PlanGraph } from './graph/PlanGraph';
import { PlanList } from './list/PlanList';

export const PLAN_VIEWS = ['list', 'board', 'graph'] as const;
export type PlanView = (typeof PLAN_VIEWS)[number];

const VIEW_PAGES: Readonly<Record<PlanView, ProjectPage>> = { list: PlanList, board: PlanBoard, graph: PlanGraph };

/** The view a `?view=` asks for; the list when it names none we know. */
export const planViewOf = (view: unknown): PlanView => ((PLAN_VIEWS as readonly unknown[]).includes(view) ? (view as PlanView) : 'list');

defineTopbar('project-plan', (route) => ({ trail: projectTrail(route, { label: 'Plan', href: `/projects/${String(route.params.id)}/plan` }) }));

export const ProjectPlan = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    return () => {
        const view = planViewOf(route.query.view);
        const View = VIEW_PAGES[view];
        return (
            <Page title="Plan" page="project-plan">
                <div data-plan-view={view}>
                    <View project={props.project} />
                </div>
            </Page>
        );
    };
}, { name: 'ProjectPlan' });
