import { component } from 'sigx';
import { Link } from '@sigx/router';
import { Page } from '../../../components/Page';
import { Stub } from '../layout/Stub';
import type { ProjectPageProps } from '../layout/types';
import { settingsHref } from '../settings/tabs';

/**
 * `/projects/:id` — the project's home: Your move, recent chats, the feature cards (stub, #725; #730 builds it). The
 * topbar is route `project`'s (`pages/Projects.tsx`): `Projects › <project>`. Until #730 it links to the settings,
 * where today's project form now lives.
 */
export const ProjectOverview = component<ProjectPageProps>(({ props }) => () => (
    <Page title={props.project.name} page="project-overview">
        <Stub issue={730} />
        <p><Link to={settingsHref(props.project.id, 'general')}>Project settings</Link></p>
    </Page>
), { name: 'ProjectOverview' });
