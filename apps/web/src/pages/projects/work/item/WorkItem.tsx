/**
 * `/projects/:id/work/:item` for work that is not a pull request (#739, PRJ-05): the header with the stage stepper
 * (the item's stages, else Ready → Do → Review → Done), who acts next and what they do, the task, chat and session it
 * links to, and — when the item comes from Plan — its done-when checklist, refs and activity (#890). `WorkItemRoute` sends `pr:<n>` to the pull
 * request page instead. On mock data the fixtures; live (#790) the work items the Work view derives (#738), each with
 * its task, chat, session and plan item (`live.ts`).
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import { Checkbox } from '@sigx/zero';
import { formatRef, type Ref, type WorkStageState } from '@agentic/core';
import { AgentTile, EmptyState, Icon, StageTrack, StatusPill, Tag, type Tone } from '@agentic/ui';
import { dataMode } from '../../../../data-mode';
import { AGENTS, formatAge } from '../../../../mock/workspace';
import { clockNow } from '../../../../time';
import type { ProjectPageProps } from '../../layout/types';
import { WorkActionButtons, WorkNotice, type WorkAgentLookup } from '../WorkView';
import type { WorkActions } from '../actions';
import type { WorkTask } from '../model';
import { refIcon, refLabel } from '../../features/plan/shared/model';
import { MOCK_WORK_ITEMS } from './fixtures';
import { useLiveWorkItems } from './live';
import { activityOf, actorLabel, doneWhenProgress, findWorkItem, ownerLabel, refHref, stagesOf, stepsOf, type WorkItemDetail } from './model';
import { chatHref } from '../../../chat/href';

export type WorkItemProps = ProjectPageProps & Define.Prop<'item', string, true>;

/** The mock workspace's agents; an id it does not have is its own name, in the first hue. */
const mockAgent: WorkAgentLookup = (id) => {
    const a = AGENTS.find((x) => x.id === id);
    return { name: a?.name ?? id, hue: a?.hue ?? 1 };
};

const TONE_OF: Readonly<Record<WorkStageState, Tone>> = { working: 'working', 'needs-you': 'needs-you', failed: 'failed', done: 'live' };

/** The page's task as the Work actions read it: its id and status are all `workActionsOf` needs. */
const taskOf = (d: WorkItemDetail): WorkTask[] =>
    d.task ? [{ id: d.task.id as WorkTask['id'], title: d.task.objective, status: d.task.status as WorkTask['status'], assignee: d.task.agentId as WorkTask['assignee'], updatedAt: d.item.updatedAt }] : [];

/** The Work row's buttons on the page (#1040); after one the page goes back to Work, where its Undo shows. */
export interface WorkItemActions {
    readonly actions: WorkActions;
    readonly onDone: () => void;
}

const Header = (d: WorkItemDetail, agentOf: WorkAgentLookup, act?: WorkItemActions) => {
    const { item } = d;
    const agentName = (id: string): string => agentOf(id).name;
    const steps = stepsOf(item);
    return (
        <header data-work-item-head="">
            <h2 data-work-item-title="">{item.title}</h2>
            <p data-work-item-meta="">
                {d.task ? <span data-ref="">{d.task.ref}</span> : null}
                {item.itemRef ? <span data-ref="">{item.itemRef}</span> : null}
                <span data-work-item-age="">{`updated ${formatAge(item.updatedAt, clockNow())}`}</span>
            </p>
            <StageTrack stages={stagesOf(item)} stage={item.stage} state={item.stageState} bare />
            <ol data-work-item-steps="" aria-label="Stages">
                {steps.map((s) => (
                    <li key={s.name} data-step={s.state} data-tone={s.tone} aria-current={s.state === 'current' ? 'step' : undefined}>{s.name}</li>
                ))}
            </ol>
            <div data-work-item-next="">
                {item.owner.kind === 'you'
                    ? <span data-owner="you"><Tag tone="needs-you">YOU</Tag></span>
                    : (
                        <span data-owner="agent">
                            <AgentTile name={agentName(item.owner.agentId)} hue={agentOf(item.owner.agentId).hue} size={20} />
                            <strong>{ownerLabel(item.owner, agentName)}</strong>
                        </span>
                    )}
                <span data-next-step="">{item.nextStep}</span>
                <StatusPill status={item.stageState} tone={TONE_OF[item.stageState]} />
                {act ? <WorkActionButtons item={item} tasks={taskOf(d)} actions={act.actions} onDone={act.onDone} /> : null}
            </div>
        </header>
    );
};

const Links = (d: WorkItemDetail, projectId: string) => (
    <section data-work-item-links="" aria-label="Linked">
        <h3>Linked</h3>
        <dl>
            <dt>Task</dt>
            <dd data-link="task">
                {d.task
                    ? <><Link to={`/tasks/${d.task.id}`}>{d.task.objective}</Link> <span data-ref="">{d.task.ref}</span> <StatusPill status={d.task.status} /></>
                    : <span data-none="">No task yet</span>}
            </dd>
            <dt>Chat</dt>
            <dd data-link="chat">{d.chat ? <Link to={chatHref({ id: d.chat.id, projectId })}>{d.chat.title}</Link> : <span data-none="">No chat</span>}</dd>
            <dt>Session</dt>
            <dd data-link="session">{d.sessionId ? <Link to={`/sessions/${d.sessionId}`}>{d.sessionId}</Link> : <span data-none="">No session</span>}</dd>
            {d.plan ? <><dt>Plan</dt><dd data-link="plan">{`${d.plan.title} · ${d.plan.phase} · #${d.plan.item.id}`}</dd></> : null}
        </dl>
    </section>
);

const DoneWhen = (d: WorkItemDetail) => {
    const list = d.plan?.item.doneWhen ?? [];
    if (!list.length) return null;
    return (
        <section data-work-item-done-when="" aria-label="Done when">
            <h3>Done when <small>{doneWhenProgress(list)}</small></h3>
            <ul>
                {list.map((c) => {
                    // Read-only: a work item's done-when is ticked on its plan item; zero binds to a throwaway signal.
                    const bind = signal({ checked: c.checked });
                    return (
                        <li key={c.text} data-checked={c.checked ? 'true' : 'false'}>
                            <Checkbox.Root model={() => bind.checked} name="done-when" disabled>{c.text}</Checkbox.Root>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
};

const RefChip = (ref: Ref, projectId: string) => {
    const body = <><Icon name={refIcon(ref)} size={12} /><span>{refLabel(ref)}</span></>;
    const to = refHref(ref, projectId);
    return (
        <span data-work-item-ref={ref.kind} title={formatRef(ref)}>
            {!to ? body : to.external ? <a href={to.to} target="_blank" rel="noopener noreferrer">{body}</a> : <Link to={to.to}>{body}</Link>}
        </span>
    );
};

const Refs = (d: WorkItemDetail, projectId: string) => {
    const refs = d.plan?.item.refs ?? [];
    if (!refs.length) return null;
    return (
        <section data-work-item-refs="" aria-label="Refs">
            <h3>Refs</h3>
            <div>{refs.map((r) => RefChip(r, projectId))}</div>
        </section>
    );
};

const Activity = (d: WorkItemDetail, agentOf: WorkAgentLookup) => {
    const lines = d.plan ? activityOf(d.plan.item) : [];
    if (!lines.length) return null;
    const now = clockNow();
    return (
        <section data-work-item-activity="" aria-label="History">
            <h3>History</h3>
            <ul>
                {lines.map((a) => (
                    <li key={`${a.at}:${a.text}`}>
                        <span data-activity-line=""><strong>{actorLabel(a.actor, (id) => agentOf(id).name)}</strong> {a.text}</span>
                        <span data-activity-age="">{formatAge(a.at, now)}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
};

const missing = (item: string) => (
    <EmptyState variant="generic" title="No work item with that id" caption={`Nothing in this project is called ${item}.`} />
);

/** The page over one detail, or the not-found state; `pending` while the live reads have not landed. */
const render = (projectId: string, param: string, d: WorkItemDetail | undefined, agentOf: WorkAgentLookup, pending = false, act?: WorkItemActions): JSXElement => (
    <section aria-label={d?.item.title ?? param} data-work-item={param} data-plan-backed={d?.plan ? 'true' : undefined}>
        {d
            ? (
                <>
                    {Header(d, agentOf, act)}
                    <div data-work-item-body="">
                        {DoneWhen(d)}
                        {Refs(d, projectId)}
                        {Activity(d, agentOf)}
                        {Links(d, projectId)}
                    </div>
                </>
            )
            : pending ? <p data-panel-note="" aria-busy="true">Loading work…</p> : missing(param)}
    </section>
);

const LiveWorkItem = component<WorkItemProps>(({ props }) => {
    const live = useLiveWorkItems(() => props.project);
    const router = useRouter();
    const act: WorkItemActions | undefined = live.actions ? { actions: live.actions, onDone: () => { void router.push(`/projects/${props.project.id}/work`); } } : undefined;
    return () => {
        const d = findWorkItem(live.details(), props.item);
        return (
            <>
                {render(props.project.id, props.item, d, live.agentOf, !d && live.loading, act)}
                <WorkNotice />
            </>
        );
    };
}, { name: 'LiveWorkItem' });

export const WorkItem = component<WorkItemProps>(({ props }) => () => (
    dataMode() === 'live'
        ? <LiveWorkItem project={props.project} item={props.item} />
        : render(props.project.id, props.item, findWorkItem(MOCK_WORK_ITEMS[props.project.id] ?? [], props.item), mockAgent)
), { name: 'WorkItem' });
