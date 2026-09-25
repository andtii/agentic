import { component } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

/** Settings › Connectors: what every session in the project gets (stub, #725; #733 builds it). */
export const ProjectConnectors = component<ProjectPageProps>(() => () => (
    <section aria-label="Connectors" data-settings-tab="">
        <h2>Connectors</h2>
        <Stub issue={733} />
    </section>
), { name: 'ProjectConnectors' });
