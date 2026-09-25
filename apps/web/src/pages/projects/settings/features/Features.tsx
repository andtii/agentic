import { component } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

/** Settings › Features: the enabled features, their slot marks and the add-a-feature catalogue (stub, #725; #736 builds it). */
export const ProjectFeatures = component<ProjectPageProps>(() => () => (
    <section aria-label="Features" data-settings-tab="">
        <h2>Features</h2>
        <Stub issue={736} />
    </section>
), { name: 'ProjectFeatures' });
