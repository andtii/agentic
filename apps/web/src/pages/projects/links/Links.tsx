import { component } from 'sigx';
import { Page } from '../../../components/Page';
import { Stub } from '../layout/Stub';

/** `/projects/links` — cross-project links: lanes, arrows, the chain panel (stub, #725; #765 builds it). Its trail is `crumbs.ts`'s. */
export const ProjectLinks = component(() => () => (
    <Page title="Links" page="projects-links">
        <Stub issue={765} />
    </Page>
), { name: 'ProjectLinks' });
