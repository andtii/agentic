/**
 * `/projects/:id/work/:item` (#725): a work item's page. `pr:<n>` (a `WorkItem.id` for a pull request) is the pull
 * request page (#744), anything else the plain item page (#739); both inside `Projects › <project> › Work › …`.
 */
import { component } from 'sigx';
import { useRoute } from '@sigx/router';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';
import { WorkItem } from './item/WorkItem';
import { Pull } from './pull/Pull';

/** The pull request number an item param names (`pr:603`), or `undefined`. */
export function pullNumberOf(item: string): number | undefined {
    const m = /^pr:(\d+)$/.exec(item);
    return m ? Number(m[1]) : undefined;
}

const itemLabel = (item: string): string => {
    const n = pullNumberOf(item);
    return n === undefined ? item : `PR #${n}`;
};

defineTopbar('project-work-item', (route) => {
    const id = String(route.params.id);
    const item = String(route.params.item ?? '');
    return { trail: projectTrail(route, { label: 'Work', href: `/projects/${id}/work` }, { label: itemLabel(item), href: route.path }) };
});

export const ProjectWorkItem = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    return () => {
        const item = String(route.params.item ?? '');
        const n = pullNumberOf(item);
        return (
            <Page title={itemLabel(item)} page={n === undefined ? 'project-work-item' : 'project-pull'}>
                {n === undefined ? <WorkItem project={props.project} item={item} /> : <Pull project={props.project} number={n} />}
            </Page>
        );
    };
}, { name: 'ProjectWorkItem' });
