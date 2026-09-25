import { component } from 'sigx';
import { Stub } from '../../../layout/Stub';
import type { ProjectPageProps } from '../../../layout/types';

/** The Plan board view: columns by agent, limits, drag to assign (stub, #725; #755 builds it). */
export const PlanBoard = component<ProjectPageProps>(() => () => (
    <section aria-label="Plan board" data-plan-view="">
        <h2>Plan board</h2>
        <Stub issue={755} />
    </section>
), { name: 'PlanBoard' });
