import { component, type Define } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

export type WorkItemProps = ProjectPageProps & Define.Prop<'item', string, true>;

/** `/projects/:id/work/:item` for work that is not a pull request (stub, #725; #739 builds it). */
export const WorkItem = component<WorkItemProps>(({ props }) => () => (
    <section aria-label={props.item} data-work-item={props.item}>
        <Stub issue={739} />
    </section>
), { name: 'WorkItem' });
