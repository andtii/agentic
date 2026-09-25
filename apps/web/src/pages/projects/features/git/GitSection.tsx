import { component } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

/** The Git feature’s Code section (and its Overview card) (stub, #725; #746 builds it). */
export const GitSection = component<ProjectPageProps>(() => () => (
    <section aria-label="Code" data-feature-section="">
        <h2>Code</h2>
        <Stub issue={746} />
    </section>
), { name: 'GitSection' });
