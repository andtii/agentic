import { component } from 'sigx';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { Stub } from '../layout/Stub';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';

defineTopbar('project-chats', (route) => ({ trail: projectTrail(route, { label: 'Chats', href: `/projects/${String(route.params.id)}/chats` }) }));

/** `/projects/:id/chats` — the project’s chats, grouped by who acts next (stub, #725; #731 builds it). */
export const ProjectChats = component<ProjectPageProps>(() => () => (
    <Page title="Chats" page="project-chats">
        <Stub issue={731} />
    </Page>
), { name: 'ProjectChats' });
