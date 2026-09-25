import { component } from 'sigx';
import { Stub } from '../../../layout/Stub';
import type { ProjectPageProps } from '../../../layout/types';

/** The Plan graph view and the plan switcher (stub, #725; #756 builds it). */
export const PlanGraph = component<ProjectPageProps>(() => () => (
    <section aria-label="Plan graph" data-plan-view="">
        <h2>Plan graph</h2>
        <Stub issue={756} />
    </section>
), { name: 'PlanGraph' });
