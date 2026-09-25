/**
 * `/projects/:id/work/pr:<n>` — a pull request (#744, PRJ-08/09): on mock data the fixtures in `mock/projects/pull.ts`,
 * live the project's `Pulls.get` view (the PR by number) with names from the agent directory. `PullView` renders both.
 */
import { component, type Define } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../../../actors/defs';
import { pullsKeyOf } from '../../../../actors/keys';
import { dataMode } from '../../../../data-mode';
import { MOCK_PULLS } from '../../../../mock/projects/pull';
import { AGENTS, MOCK_NOW } from '../../../../mock/workspace';
import { useAgentDirectory } from '../../../chat/directory';
import type { ProjectPageProps } from '../../layout/types';
import { findPull, type PullPageData } from './model';
import { PullView, type PullAgent } from './PullView';

export type PullProps = ProjectPageProps & Define.Prop<'number', number, true>;

const missing = (n: number, caption: string) => <EmptyState variant="generic" title={`No pull request #${n}`} caption={caption} />;

const mockAgent = (id: string): PullAgent | undefined => {
    const a = AGENTS.find((x) => x.id === id);
    return a ? { name: a.name, hue: a.hue } : undefined;
};

const LivePull = component<PullProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const view = useActorState(defs.Pulls, () => viewer.workspaceId && ([pullsKeyOf(viewer.workspaceId, props.project.id), 'get'] as const), { live: true });
    const agentOf = (id: string): PullAgent | undefined => {
        const a = directory.lookup(id);
        return a.name === id ? undefined : { name: a.name, hue: a.hue };
    };
    return () => {
        const pr = view.value?.pulls.find((p) => p.number === props.number);
        if (!pr) return view.loading ? null : missing(props.number, 'The project has not read a pull request by that number.');
        const env = pr.autopilot ? directory.lookup(pr.autopilot.agentId).environment : undefined;
        const data: PullPageData = { pr, ...(env && env.machine !== '—' ? { linked: { environment: env } } : {}) };
        return <PullView projectId={props.project.id} data={data} agentOf={agentOf} now={Date.now()} readOnly />;
    };
}, { name: 'LivePull' });

export const Pull = component<PullProps>(({ props }) => () => {
    const live = dataMode() === 'live';
    const data = live ? undefined : findPull(MOCK_PULLS[props.project.id] ?? [], props.number);
    return (
        <section aria-label={`PR #${props.number}`} data-pull-page={String(props.number)}>
            {live
                ? <LivePull project={props.project} number={props.number} />
                : data
                    ? <PullView key={data.pr.number} projectId={props.project.id} data={data} agentOf={mockAgent} now={MOCK_NOW} />
                    : missing(props.number, `Nothing in ${props.project.name} is PR #${props.number}.`)}
        </section>
    );
}, { name: 'Pull' });
