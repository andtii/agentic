import { component } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

/** Settings › Members: who works here, their roles and limits (stub, #725; #733 builds it). */
export const ProjectMembers = component<ProjectPageProps>(() => () => (
    <section aria-label="Members" data-settings-tab="">
        <h2>Members</h2>
        <Stub issue={733} />
    </section>
), { name: 'ProjectMembers' });
