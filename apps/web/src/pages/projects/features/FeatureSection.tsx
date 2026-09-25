/**
 * `/projects/:id/f/:feature` (#725): an enabled feature's own section, drawn by its `Section` in `registry.ts`. A
 * feature with none (yet) says so. The git feature's section lives at `/projects/:id/code` instead (#841).
 */
import { component } from 'sigx';
import { useRoute } from '@sigx/router';
import { EmptyState } from '@agentic/ui';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';
import { featureViewsOf } from './registry';
import { GIT_FEATURE_ID } from './git/model';

const labelOf = (feature: string): string => featureViewsOf(feature)?.label ?? feature;

defineTopbar('project-feature', (route) => {
    const feature = String(route.params.feature ?? '');
    return { trail: projectTrail(route, { label: labelOf(feature), href: route.path }) };
});

/** One feature's section page: its `Section`, or an empty state when it draws none. */
const sectionPage = (feature: string, props: ProjectPageProps, page: string) => {
    const Section = featureViewsOf(feature)?.Section;
    return (
        <Page title={labelOf(feature)} page={page}>
            {Section
                ? <Section project={props.project} />
                : <EmptyState variant="generic" title="Nothing to show here yet" caption={`${feature} has no section of its own in this build.`} />}
        </Page>
    );
};

export const ProjectFeatureSection = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    return () => sectionPage(String(route.params.feature ?? ''), props, 'project-feature');
}, { name: 'ProjectFeatureSection' });

defineTopbar('project-code', (route) => ({ trail: projectTrail(route, { label: labelOf(GIT_FEATURE_ID), href: `/projects/${String(route.params.id)}/code` }) }));

/** `/projects/:id/code` (#841): the git feature's section at its canonical route (the HANDOFF's name for it). */
export const ProjectCodeSection = component<ProjectPageProps>(({ props }) => () => sectionPage(GIT_FEATURE_ID, props, 'project-feature'), { name: 'ProjectCodeSection' });
