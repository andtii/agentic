import { component } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

/** Settings › Folders: where the project lives on each machine (stub, #725; #733 builds it). */
export const ProjectFolders = component<ProjectPageProps>(() => () => (
    <section aria-label="Folders" data-settings-tab="">
        <h2>Folders</h2>
        <Stub issue={733} />
    </section>
), { name: 'ProjectFolders' });
