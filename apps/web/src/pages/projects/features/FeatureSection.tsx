/**
 * `/projects/:id/f/:feature` (#725): an enabled feature's own section, drawn by its `Section` in `registry.ts`. A
 * feature with none (yet) says so.
 */
import { component } from 'sigx';
import { useRoute } from '@sigx/router';
import { EmptyState } from '@agentic/ui';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';
import { featureViewsOf } from './registry';

const labelOf = (feature: string): string => featureViewsOf(feature)?.label ?? feature;

defineTopbar('project-feature', (route) => {
    const feature = String(route.params.feature ?? '');
    return { trail: projectTrail(route, { label: labelOf(feature), href: route.path }) };
});

export const ProjectFeatureSection = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    return () => {
        const feature = String(route.params.feature ?? '');
        const Section = featureViewsOf(feature)?.Section;
        return (
            <Page title={labelOf(feature)} page="project-feature">
                {Section
                    ? <Section project={props.project} />
                    : <EmptyState variant="generic" title="Nothing to show here yet" caption={`${feature} has no section of its own in this build.`} />}
            </Page>
        );
    };
}, { name: 'ProjectFeatureSection' });
