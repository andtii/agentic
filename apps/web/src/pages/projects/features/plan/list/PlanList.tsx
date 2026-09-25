import { component } from 'sigx';
import { Stub } from '../../../layout/Stub';
import type { ProjectPageProps } from '../../../layout/types';

/** The Plan list view: phases, crew strip, item detail (stub, #725; #754 builds it). */
export const PlanList = component<ProjectPageProps>(() => () => (
    <section aria-label="Plan" data-plan-view="">
        <h2>Plan</h2>
        <Stub issue={754} />
    </section>
), { name: 'PlanList' });
