import { component } from 'sigx';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { Stub } from '../layout/Stub';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';

defineTopbar('project-requests', (route) => ({ trail: projectTrail(route, { label: 'Requests', href: `/projects/${String(route.params.id)}/requests` }) }));

/** `/projects/:id/requests` — the project manager’s inbox (stub, #725; #761 builds it). */
export const ProjectRequests = component<ProjectPageProps>(() => () => (
    <Page title="Requests" page="project-requests">
        <Stub issue={761} />
    </Page>
), { name: 'ProjectRequests' });
