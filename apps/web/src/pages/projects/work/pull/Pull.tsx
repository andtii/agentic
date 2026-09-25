import { component, type Define } from 'sigx';
import { Stub } from '../../layout/Stub';
import type { ProjectPageProps } from '../../layout/types';

export type PullProps = ProjectPageProps & Define.Prop<'number', number, true>;

/** `/projects/:id/work/pr:<n>` — a pull request: checks, threads, autopilot, merge (stub, #725; #744 builds it). */
export const Pull = component<PullProps>(({ props }) => () => (
    <section aria-label={`PR #${props.number}`} data-pull-page={String(props.number)}>
        <Stub issue={744} />
    </section>
), { name: 'Pull' });
