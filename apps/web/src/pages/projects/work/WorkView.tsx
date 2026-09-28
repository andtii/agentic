/**
 * `/projects/:id/work` (#738, PRJ-05): everything in flight in the project, one row per work item — its stage track,
 * title and meta, checks, who acts next and their next step, age — grouped Your move, Agents on it, Waiting on CI or a
 * reviewer, Done this week (the last two collapsed). Filters: agent, stage, search. The same view with Git on
 * (Ready → Code → PR → Checks → Review → Merge) and without (Ready → Do → Review → Done): the stages are the
 * features', never named here (docs/design/projects/HANDOFF.md, "Work and pull requests"; boards ProjectCode,
 * ProjectPlain).
 */
import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { Field, Input, Select } from '@sigx/zero';
import type { PlanItem, PullRequest, TaskId, WorkGroup, WorkItem } from '@agentic/core';
import { WORK_STAGES_FALLBACK, workStagesFor } from '@agentic/core';
import { AgentTile, Button, ChecksBar, StageTrack, type AgentHue } from '@agentic/ui';
import { Age } from '../../../components/Age';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { dataMode } from '../../../data-mode';
import { MOCK_NOW } from '../../../mock/workspace';
import { opsAgent } from '../../../mock/ops';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';
import { LiveStartTask } from '../../task/LiveStartTask';
import { openStartTask } from '../../task/start';
import { useLiveWork } from './LiveWork';
import { closeWorkNotice, runPlanItemAction, runWorkAction, undoWorkAction, workHidden, workNotice, type PlanItemWrites, type WorkActions } from './actions';
import { PullsSignIn } from './pull/PullsSignIn';
import { mockWorkFeatures, mockWorkTasks, usePlanItems, usePulls } from './live';
import { WORK_GROUPS, filterWork, groupWork, isStale, planItemActionsOf, planItemOfRow, workActionsOf, workAgentOf, workItemsOf, type WorkAction, type WorkFeatures, type WorkFilter, type WorkTask } from './model';

defineTopbar('project-work', (route) => ({ trail: projectTrail(route, { label: 'Work', href: `/projects/${String(route.params.id)}/work` }) }));

/** Who an agent id is, as a row draws it. */
export type WorkAgentLookup = (id: string) => { readonly name: string; readonly hue: AgentHue };

/** The `:item` a row links to: `pr:<n>` for a pull request (the PR page), else its task or item id. */
export const workItemParam = (item: WorkItem): string => (item.pull !== undefined ? `pr:${item.pull}` : (item.taskId ?? item.id));

const ALL = '*';

export type WorkBoardProps =
    & Define.Prop<'projectId', string, true>
    & Define.Prop<'tasks', readonly WorkTask[], true>
    & Define.Prop<'pulls', readonly PullRequest[], true>
    & Define.Prop<'planItems', readonly PlanItem[], true>
    & Define.Prop<'features', WorkFeatures, true>
    & Define.Prop<'agentOf', WorkAgentLookup, true>
    & Define.Prop<'now', number, true>
    /** "New task" opens the Start task dialog; absent (mock data), the button is disabled. */
    & Define.Prop<'onNewTask', () => void>
    /** What a task row's Retry, Dismiss and Stop call (#1040); absent (mock data), rows have no buttons. */
    & Define.Prop<'actions', WorkActions>
    /** What a plan item row's Reopen, Reassign and Drop call (#1041); absent (mock data), those rows have no buttons. */
    & Define.Prop<'planWrites', PlanItemWrites>
    /** The project's agent members, whom Reassign offers. */
    & Define.Prop<'members', readonly string[]>;

const ACTION_BUTTON: Readonly<Record<WorkAction, { readonly label: string; readonly icon: 'play' | 'close' | 'stop' }>> = {
    retry: { label: 'Retry', icon: 'play' },
    dismiss: { label: 'Dismiss', icon: 'close' },
    stop: { label: 'Stop', icon: 'stop' }
};

/** A task's buttons (#1040): the row's and the work item page's. */
export const WorkActionButtons = component<{ item: WorkItem; tasks: readonly WorkTask[]; actions: WorkActions; onDone?: () => void }>(({ props }) => () => {
    const list = workActionsOf(props.item, props.tasks);
    if (!list.length || !props.item.taskId) return null;
    const taskId = props.item.taskId as TaskId;
    return (
        <span data-work-actions="">
            {list.map((a) => (
                <Button
                    intent="default"
                    icon={ACTION_BUTTON[a].icon}
                    name="work-action"
                    value={a}
                    onClick={() => { void runWorkAction(props.actions, a, taskId, props.item.title).then(() => props.onDone?.()); }}
                >
                    {ACTION_BUTTON[a].label}
                </Button>
            ))}
        </span>
    );
}, { name: 'WorkActionButtons' });

/** Where Decide goes (#1041): the item on the Plan page, where its options are. */
export const planItemHref = (projectId: string, itemId: number): string => `/projects/${projectId}/plan?item=${itemId}`;

export interface PlanItemButtonsProps {
    item: WorkItem;
    planItems: readonly PlanItem[];
    projectId: string;
    writes: PlanItemWrites;
    members: readonly string[];
    agentOf: WorkAgentLookup;
    onDone?: () => void;
}

/**
 * A plan item's buttons (#1041), the row's and the work item page's: stuck → Reopen, Reassign (a member picker) and
 * Drop (with an optional reason); needs-you → Decide (the item on the Plan page) and Drop.
 */
export const PlanItemActionButtons = component<PlanItemButtonsProps>(({ props }) => {
    const st = signal({ open: '' as '' | 'reassign' | 'drop', reason: '' });
    return () => {
        const list = planItemActionsOf(props.item, props.planItems);
        const p = planItemOfRow(props.item, props.planItems);
        if (!list.length || !p) return null;
        const target = { itemId: p.id, title: p.title, state: p.state };
        const done = (ok: boolean): void => {
            if (!ok) return;
            st.open = '';
            st.reason = '';
            props.onDone?.();
        };
        const current = p.assignee?.kind === 'agent' ? p.assignee.agentId : undefined;
        const others = props.members.filter((id) => id !== current);
        return (
            <span data-work-actions="" data-plan-item-actions={p.id}>
                {list.map((a) => a === 'decide'
                    ? <span data-work-plan-action="decide"><Link to={planItemHref(props.projectId, p.id)}>Decide</Link></span>
                    : (
                        <Button
                            intent="default"
                            icon={a === 'reopen' ? 'play' : a === 'reassign' ? 'agents' : 'close'}
                            name="work-plan-action"
                            value={a}
                            onClick={() => {
                                if (a === 'reopen') void runPlanItemAction(props.writes, 'reopen', target).then(done);
                                else st.open = st.open === a ? '' : a;
                            }}
                        >
                            {a === 'reopen' ? 'Reopen' : a === 'reassign' ? 'Reassign' : 'Drop'}
                        </Button>
                    ))}
                {st.open === 'reassign'
                    ? (
                        <span data-work-reassign="" role="group" aria-label={`Reassign #${p.id} to`}>
                            {others.length
                                ? others.map((id) => {
                                    const a = props.agentOf(id);
                                    return (
                                        <Button intent="default" name="work-reassign" value={id} onClick={() => { void runPlanItemAction(props.writes, 'reassign', target, { to: { kind: 'agent', agentId: id as never }, toName: a.name }).then(done); }}>
                                            <AgentTile name={a.name} hue={a.hue} size={18} />{a.name}
                                        </Button>
                                    );
                                })
                                : <span data-work-note="">No other member to hand it to</span>}
                        </span>
                    )
                    : null}
                {st.open === 'drop'
                    ? (
                        <form data-work-drop="" onSubmit={(e: Event) => { e.preventDefault(); void runPlanItemAction(props.writes, 'drop', target, { note: st.reason }).then(done); }}>
                            <Input.Root model={() => st.reason} autocomplete="off">
                                <Input.Label visuallyHidden>{`Why drop #${p.id}?`}</Input.Label>
                                <Input.Control>
                                    <Input.Input data-work-drop-reason="" placeholder="Why? e.g. superseded by #18" />
                                </Input.Control>
                            </Input.Root>
                            <Button intent="danger" type="submit" name="work-drop-confirm">{`Drop #${p.id}`}</Button>
                        </form>
                    )
                    : null}
            </span>
        );
    };
}, { name: 'PlanItemActionButtons' });

/** The notice under the last action: what was done, with Undo while it can be undone, or what failed. */
export const WorkNotice = component(() => () => {
    if (!workNotice.text && !workNotice.error) return null;
    return (
        <div data-work-notice="" role="status" data-error={workNotice.error ? 'true' : undefined}>
            <span>{workNotice.error || workNotice.text}</span>
            {workNotice.undo ? <Button intent="default" name="work-undo" onClick={() => { void undoWorkAction(); }}>Undo</Button> : null}
            <Button intent="icon" icon="close" label="Close" onClick={() => closeWorkNotice()} />
        </div>
    );
}, { name: 'WorkNotice' });

interface WorkRowPlan {
    readonly items: readonly PlanItem[];
    readonly writes: PlanItemWrites;
    readonly members: readonly string[];
}

const WorkRow = component<{ item: WorkItem; projectId: string; tasks: readonly WorkTask[]; pulls: readonly PullRequest[]; agentOf: WorkAgentLookup; now: number; actions?: WorkActions; plan?: WorkRowPlan }>(({ props }) => () => {
    const i = props.item;
    const pr = i.pull !== undefined ? props.pulls.find((p) => p.number === i.pull) : undefined;
    const task = i.taskId ? props.tasks.find((t) => t.id === i.taskId) : undefined;
    const doer = workAgentOf(i, props.tasks, props.pulls);
    const doerView = doer ? props.agentOf(doer) : undefined;
    const branch = pr?.head ?? task?.branch;
    const stale = isStale(i, props.now);
    return (
        <li data-work-row={i.id} data-group={i.group} data-state={i.stageState}>
            <StageTrack stages={i.stages} stage={i.stage} state={i.stageState} />
            <div data-work-main>
                <span data-work-title title={i.title}><Link to={`/projects/${props.projectId}/work/${workItemParam(i)}`}>{i.title}</Link></span>
                <span data-work-meta>
                    {i.taskId ? <span data-work-task>{i.taskId}</span> : null}
                    {i.itemRef ? <span data-work-ref>{i.itemRef}</span> : null}
                    {doerView ? <AgentTile name={doerView.name} hue={doerView.hue} size={18} /> : null}
                    {pr ? <span data-work-pull>{`#${pr.number}`}</span> : null}
                    {branch ? <span data-work-branch>{pr ? branch : `branch ${branch}`}</span> : null}
                    {!pr && branch && i.stages.includes('PR') ? <span data-work-note>no PR yet</span> : null}
                    {pr?.autopilot ? <span data-work-tag="autopilot">autopilot</span> : null}
                    {pr?.mergeable === false ? <span data-work-conflict>{pr.after !== undefined ? `conflicts with #${pr.after}` : 'conflicts'}</span> : null}
                </span>
            </div>
            <div data-work-delivery>
                {pr ? (pr.checks.length ? <ChecksBar checks={pr.checks} /> : <span data-work-note>{pr.mergeable === false ? 'not run · blocked' : 'not run'}</span>) : <span data-work-none aria-label="No checks">—</span>}
            </div>
            <div data-work-owner>
                {i.owner.kind === 'you'
                    ? <span data-work-you>YOU</span>
                    : (() => {
                        const a = props.agentOf(i.owner.agentId);
                        return <span data-work-agent><AgentTile name={a.name} hue={a.hue} size={20} /><strong>{a.name}</strong></span>;
                    })()}
                <span data-work-next title={i.nextStep}>{i.nextStep}</span>
                {props.actions ? <WorkActionButtons item={i} tasks={props.tasks} actions={props.actions} /> : null}
                {props.plan ? <PlanItemActionButtons item={i} planItems={props.plan.items} projectId={props.projectId} writes={props.plan.writes} members={props.plan.members} agentOf={props.agentOf} /> : null}
            </div>
            <Age at={i.updatedAt} now={props.now} class={stale ? 'is-stale' : undefined} />
        </li>
    );
}, { name: 'WorkRow' });

/** The Work board over its inputs — mock and live render this. */
export const WorkBoard = component<WorkBoardProps>(({ props }) => {
    const st = signal({ agent: ALL as string | null, stage: ALL as string | null, q: '', open: { 'your-move': true, agents: true, waiting: false, done: false } as Record<WorkGroup, boolean> });
    const filter = (): WorkFilter => ({ agent: st.agent && st.agent !== ALL ? st.agent : '', stage: st.stage && st.stage !== ALL ? st.stage : '', q: st.q });
    return () => {
        const { pulls, now } = props;
        // A row just stopped or dismissed leaves at once, before the index catches up (#1040).
        const hidden = workHidden.ids;
        const tasks = hidden.length ? props.tasks.filter((t) => !hidden.includes(t.id)) : props.tasks;
        const planItems = hidden.length ? props.planItems.filter((i) => !hidden.includes(`item:${i.id}`)) : props.planItems;
        const all = workItemsOf(tasks, pulls, planItems, props.features, now);
        const plan: WorkRowPlan | undefined = props.planWrites ? { items: planItems, writes: props.planWrites, members: props.members ?? [] } : undefined;
        const stages = workStagesFor(props.features.enabled, props.features.uiOf);
        const plain = stages === WORK_STAGES_FALLBACK;
        const f = filter();
        const shown = filterWork(all, f, tasks, pulls);
        const groups = groupWork(shown);
        const counts = groupWork(all);
        const agentIds = [...new Set(all.map((i) => workAgentOf(i, tasks, pulls)).filter((a): a is NonNullable<typeof a> => a !== undefined))];
        const agents = [{ id: ALL, name: 'all' }, ...agentIds.map((id) => ({ id, name: props.agentOf(id).name }))];
        const stageItems = [{ id: ALL, name: 'all' }, ...stages.map((s) => ({ id: s, name: s }))];
        return (
            <div data-work>
                <header data-work-head>
                    <p data-work-counts>{`${counts['your-move'].length} your move · ${counts.agents.length} with agents`}</p>
                    <Button intent="primary" icon="plus" disabled={!props.onNewTask} onClick={() => props.onNewTask?.()}>New task</Button>
                </header>
                <div data-work-filters>
                    <Input.Root model={() => st.q} type="search" autocomplete="off">
                        <Input.Label visuallyHidden>Search work</Input.Label>
                        <Input.Control>
                            <Input.Input placeholder={plain ? 'Search tasks' : 'Search tasks, branches, #PR'} />
                        </Input.Control>
                    </Input.Root>
                    <Field.Root data-work-filter="agent">
                        <Field.Label>Agent</Field.Label>
                        <Select.Root model={() => st.agent} items={agents} itemValue={(a) => a.id} itemLabel={(a) => a.name} name="work-agent" />
                    </Field.Root>
                    <Field.Root data-work-filter="stage">
                        <Field.Label>Stage</Field.Label>
                        <Select.Root model={() => st.stage} items={stageItems} itemValue={(s) => s.id} itemLabel={(s) => s.name} name="work-stage" />
                    </Field.Root>
                    {plain ? null : <p data-work-stages>{`Stages: ${stages.join(' → ')}`}</p>}
                </div>
                {WORK_GROUPS.map((g) => {
                    const rows = groups[g.id];
                    // Your move and Agents on it always show; the collapsed groups only once they hold something.
                    if (!rows.length && g.collapsed) return null;
                    const open = st.open[g.id];
                    return (
                        <section data-work-group={g.id} aria-label={g.label}>
                            <button type="button" data-work-group-head aria-expanded={open ? 'true' : 'false'} onClick={() => { st.open = { ...st.open, [g.id]: !open }; }}>
                                <span data-work-group-title>{g.label}</span>
                                <span data-work-group-count>{rows.length}</span>
                                {g.note ? <span data-work-group-note>{g.note}</span> : null}
                            </button>
                            {open
                                ? rows.length
                                    ? <ul data-work-rows>{rows.map((item) => <WorkRow item={item} projectId={props.projectId} tasks={tasks} pulls={pulls} agentOf={props.agentOf} now={now} {...(props.actions ? { actions: props.actions } : {})} {...(plan ? { plan } : {})} />)}</ul>
                                    : <p data-work-empty>{g.id === 'your-move' ? 'Nothing waits on you.' : 'No agent is on anything here.'}</p>
                                : null}
                        </section>
                    );
                })}
                <WorkNotice />
                {plain ? <p data-work-footnote>{`No stage feature here: work items move ${stages.join(' → ')}. Same view, same groups.`}</p> : null}
            </div>
        );
    };
}, { name: 'WorkBoard' });

const mockAgent: WorkAgentLookup = (id) => {
    const a = opsAgent(id);
    return { name: a.name, hue: a.hue };
};

const MockWork = component<ProjectPageProps>(({ props }) => {
    const pulls = usePulls(props.project.id);
    const planItems = usePlanItems(props.project.id);
    return () => (
        <WorkBoard
            projectId={props.project.id}
            tasks={mockWorkTasks(props.project.id)}
            pulls={pulls()}
            planItems={planItems()}
            features={mockWorkFeatures(props.project)}
            agentOf={mockAgent}
            now={MOCK_NOW}
        />
    );
}, { name: 'MockWork' });

const LiveWork = component<ProjectPageProps>(({ props }) => {
    const live = useLiveWork(() => props.project);
    const actions = live.actions;
    const planWrites = live.planWrites;
    return () => (
        <>
            {live.loading && !live.tasks().length ? <p data-panel-note aria-busy="true">Loading work…</p> : null}
            <PullsSignIn projectId={props.project.id} readiness={live.pullsReadiness()} />
            <WorkBoard
                projectId={props.project.id}
                tasks={live.tasks()}
                pulls={live.pulls()}
                planItems={live.planItems()}
                features={live.features()}
                agentOf={live.agentOf}
                now={Date.now()}
                onNewTask={() => openStartTask()}
                {...(actions ? { actions } : {})}
                {...(planWrites ? { planWrites, members: props.project.members.agentIds } : {})}
            />
            <LiveStartTask />
        </>
    );
}, { name: 'LiveWork' });

export const ProjectWork = component<ProjectPageProps>(({ props }) => () => (
    <Page title="Work" page="project-work">
        {dataMode() === 'live' ? <LiveWork project={props.project} /> : <MockWork project={props.project} />}
    </Page>
), { name: 'ProjectWork' });
