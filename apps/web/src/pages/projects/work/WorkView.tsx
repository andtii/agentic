import { component } from 'sigx';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { Stub } from '../layout/Stub';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';

defineTopbar('project-work', (route) => ({ trail: projectTrail(route, { label: 'Work', href: `/projects/${String(route.params.id)}/work` }) }));

/** `/projects/:id/work` — everything in flight, one row per work item with its stage track (stub, #725; #738 builds it). */
export const ProjectWork = component<ProjectPageProps>(() => () => (
    <Page title="Work" page="project-work">
        <Stub issue={738} />
    </Page>
), { name: 'ProjectWork' });
