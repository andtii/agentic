/**
 * `/projects/:id/work/pr:<n>` — a pull request (#744, PRJ-08/09): on mock data the fixtures in `mock/projects/pull.ts`,
 * live the project's `Pulls.get` view (the PR by number) with names from the agent directory, its controls wired to the
 * Pulls actor's autopilot methods (#858) and its `merge` (#935); Linked names the task and chat live and the issue the
 * PR is for. `PullView` renders both.
 */
import { component, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../../../actors/defs';
import { chatKeyOf, pullsKeyOf, taskKeyOf } from '../../../../actors/keys';
import { dataMode } from '../../../../data-mode';
import { MOCK_PULLS } from '../../../../mock/projects/pull';
import { AGENTS, MOCK_NOW } from '../../../../mock/workspace';
import { useAgentDirectory } from '../../../chat/directory';
import type { ProjectPageProps } from '../../layout/types';
import { findPull, pullIssueOf, type PullActions, type PullLinked, type PullPageData } from './model';
import { PullView, type PullAgent } from './PullView';
import { PullsSignIn } from './PullsSignIn';

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
    const pulls = () => actor(defs.Pulls, pullsKeyOf(viewer.workspaceId!, props.project.id));
    // Each write re-reads the view: the actor hands the new one back, but the page follows `get` like any reader.
    const write = async (call: () => Promise<unknown>): Promise<void> => {
        await call();
        await view.refresh();
    };
    const actions: PullActions = {
        setAutopilot: (switches) => write(() => pulls().setAutopilot(props.number, switches)),
        takeOver: () => write(() => pulls().takeOver(props.number)),
        stopAutopilot: () => write(() => pulls().stopAutopilot(props.number)),
        resumeAutopilot: () => write(() => pulls().resumeAutopilot(props.number)),
        answerMerge: (approve) => write(() => pulls().answerMerge(props.number, approve)),
        merge: () => write(() => pulls().merge(props.number))
    };
    const prOf = () => view.value?.pulls.find((p) => p.number === props.number);
    // Linked, live (#935): the task's objective and the chat's title, each read while the PR names it.
    const task = useActorState(defs.TaskActor, () => {
        const id = prOf()?.taskId;
        return viewer.workspaceId && id ? ([taskKeyOf(viewer.workspaceId, id), 'get'] as const) : false;
    }, { live: true });
    const chat = useActorState(defs.Chat, () => {
        const id = prOf()?.chatId;
        return viewer.workspaceId && id ? ([chatKeyOf(viewer.workspaceId, id), 'get'] as const) : false;
    }, { live: true });
    return () => {
        const pr = view.value?.pulls.find((p) => p.number === props.number);
        // No credential for the repo (#915): say how to sign in, not that the PR does not exist.
        const signIn = <PullsSignIn projectId={props.project.id} readiness={view.value?.readiness} />;
        if (!pr) return view.loading ? null : view.value?.readiness === 'needs-sign-in' ? signIn : missing(props.number, 'The project has not read a pull request by that number.');
        const env = pr.autopilot ? directory.lookup(pr.autopilot.agentId).environment : undefined;
        const taskTitle = pr.taskId && task.value?.id === pr.taskId ? task.value.objective : undefined;
        const chatTitle = pr.chatId ? chat.value?.title : undefined;
        const issue = pullIssueOf(pr, taskTitle);
        const linked: PullLinked = {
            ...(taskTitle ? { taskTitle } : {}),
            ...(chatTitle ? { chatTitle } : {}),
            ...(issue ? { issue } : {}),
            ...(env && env.machine !== '—' ? { environment: env } : {})
        };
        const data: PullPageData = { pr, ...(Object.keys(linked).length ? { linked } : {}) };
        const run = view.value?.runs?.[String(pr.number)];
        return (
            <>
                {signIn}
                <PullView projectId={props.project.id} data={data} agentOf={agentOf} now={Date.now()} actions={actions} {...(run ? { run } : {})} />
            </>
        );
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
