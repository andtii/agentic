/**
 * `/projects/:id/work/:item` for work that is not a pull request (#739, PRJ-05): the header with the stage stepper
 * (the item's stages, else Ready → Do → Review → Done), who acts next and what they do, the task, chat and session it
 * links to, and — when the item comes from Plan — its done-when checklist. `WorkItemRoute` sends `pr:<n>` to the pull
 * request page instead. On mock data the fixtures; live (#790) the work items the Work view derives (#738), each with
 * its task, chat, session and plan item (`live.ts`).
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import type { WorkStageState } from '@agentic/core';
import { AgentTile, EmptyState, StageTrack, StatusPill, Tag, type Tone } from '@agentic/ui';
import { dataMode } from '../../../../data-mode';
import { AGENTS, formatAge } from '../../../../mock/workspace';
import { clockNow } from '../../../../time';
import type { ProjectPageProps } from '../../layout/types';
import type { WorkAgentLookup } from '../WorkView';
import { MOCK_WORK_ITEMS } from './fixtures';
import { useLiveWorkItems } from './live';
import { doneWhenProgress, findWorkItem, ownerLabel, stagesOf, stepsOf, type WorkItemDetail } from './model';

export type WorkItemProps = ProjectPageProps & Define.Prop<'item', string, true>;

/** The mock workspace's agents; an id it does not have is its own name, in the first hue. */
const mockAgent: WorkAgentLookup = (id) => {
    const a = AGENTS.find((x) => x.id === id);
    return { name: a?.name ?? id, hue: a?.hue ?? 1 };
};

const TONE_OF: Readonly<Record<WorkStageState, Tone>> = { working: 'working', 'needs-you': 'needs-you', failed: 'failed', done: 'live' };

const Header = (d: WorkItemDetail, agentOf: WorkAgentLookup) => {
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
            </div>
        </header>
    );
};

const Links = (d: WorkItemDetail) => (
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
            <dd data-link="chat">{d.chat ? <Link to={`/chats/${d.chat.id}`}>{d.chat.title}</Link> : <span data-none="">No chat</span>}</dd>
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
                {list.map((c) => (
                    <li key={c.text} data-checked={c.checked ? 'true' : 'false'}>
                        <input type="checkbox" checked={c.checked} disabled aria-label={c.text} />
                        <span>{c.text}</span>
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
const render = (param: string, d: WorkItemDetail | undefined, agentOf: WorkAgentLookup, pending = false): JSXElement => (
    <section aria-label={d?.item.title ?? param} data-work-item={param} data-plan-backed={d?.plan ? 'true' : undefined}>
        {d
            ? (
                <>
                    {Header(d, agentOf)}
                    <div data-work-item-body="">
                        {DoneWhen(d)}
                        {Links(d)}
                    </div>
                </>
            )
            : pending ? <p data-panel-note="" aria-busy="true">Loading work…</p> : missing(param)}
    </section>
);

const LiveWorkItem = component<WorkItemProps>(({ props }) => {
    const live = useLiveWorkItems(() => props.project);
    return () => {
        const d = findWorkItem(live.details(), props.item);
        return render(props.item, d, live.agentOf, !d && live.loading);
    };
}, { name: 'LiveWorkItem' });

export const WorkItem = component<WorkItemProps>(({ props }) => () => (
    dataMode() === 'live'
        ? <LiveWorkItem project={props.project} item={props.item} />
        : render(props.item, findWorkItem(MOCK_WORK_ITEMS[props.project.id] ?? [], props.item), mockAgent)
), { name: 'WorkItem' });
