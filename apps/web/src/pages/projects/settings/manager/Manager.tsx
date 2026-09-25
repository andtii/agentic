import { component } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

/** Settings › Project manager: the coordinator and its policy (stub, #725; #760 builds it). */
export const ProjectManager = component<ProjectPageProps>(() => () => (
    <section aria-label="Project manager" data-settings-tab="">
        <h2>Project manager</h2>
        <Stub issue={760} />
    </section>
), { name: 'ProjectManager' });
