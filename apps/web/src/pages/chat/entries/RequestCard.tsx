/**
 * A request in the chat that started it (#762; PRJ-16; board `PMChat`): the request card — `Request to SignalX`, its
 * state pill following the request in place (`NOVA TRIAGING`, `NEEDS YOU`, `ACCEPTED → SIGNALX#14`), the title, the
 * refs and "See triage" into the target's Requests inbox — then, once accepted, a divider (`accepted in SignalX ·
 * 14:09`) and the result card: the filed item, the chat project's items that wait on it, and Track → Links.
 *
 * #870: the thread places the two halves by time — `part="request"` at the request's creation, `part="result"` (the
 * divider and the result card, nothing before the accept) at its accept; with no `part` the card draws both.
 *
 * #931: the divider names who accepted (`you accepted in SignalX`, `Nova accepted in SignalX`), and the result card
 * reads the filed item live from its project's Plan — its state and PR (`Forge working · PR signalx#88`) — not the
 * request's state.
 *
 * `ChatRequestsFrom` is the live source: one per project the chat's visitors come from, reading that project's
 * `Requests.from(chatProject)` live, keeping this chat's requests (`chatRequests`) and reporting them up for the
 * Across projects card.
 */
import { component, effect, onUnmounted, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { useActorState } from '@sigx/actors/app';
import type { AgentId, PlanActor, PlanItem, PlanItemState, ProjectId, ProjectRequest } from '@agentic/core';
import { chatRequests, projectItemRef, requestCardState } from '@agentic/platform';
import { Icon, StatusPill } from '@agentic/ui';
import { useActorDefs } from '../../../actors/defs';
import { requestsKeyOf } from '../../../actors/keys';
import { refIcon, refLabel } from '../../projects/features/plan/shared/model';
import { requestPill } from '../../projects/requests/model';
import { usePlanItems } from '../../projects/work/live';

/** An agent's display name by id, when the caller can resolve it. */
export type AgentNameOf = (agentId: AgentId) => string | undefined;

const STATE_WORD: Readonly<Record<PlanItemState, string>> = { ready: 'ready', claimed: 'working', 'needs-you': 'needs you', blocked: 'blocked', done: 'done', stuck: 'stuck' };

/**
 * A linked item's live line (#931): who has it and its state, then its latest PR in the project's ref form —
 * `Forge working · PR signalx#88`, `blocked`, `done · PR signalx#88`. A name only when `agentName` resolves it.
 */
export function linkedItemLine(item: Pick<PlanItem, 'state' | 'claim' | 'assignee' | 'refs'>, projectName: string, agentName?: AgentNameOf): string {
    const busy = item.state === 'claimed' || item.state === 'stuck';
    const who = busy ? (item.claim?.agentId ?? (item.assignee?.kind === 'agent' ? item.assignee.agentId : undefined)) : undefined;
    const name = who && agentName ? agentName(who) : undefined;
    const pr = [...item.refs].reverse().find((ref) => ref.kind === 'pr');
    const state = name ? `${name} ${STATE_WORD[item.state]}` : STATE_WORD[item.state];
    return pr?.kind === 'pr' ? `${state} · PR ${projectItemRef(projectName, pr.n)}` : state;
}

/** The requester's divider (#931): who accepted — a person is `you`, an agent is the manager — and where. */
export function acceptedByText(r: ProjectRequest, toProjectName: string, managerName: string): string {
    const by = (r as ProjectRequest & { acceptedBy?: PlanActor }).acceptedBy;
    const who = by?.kind === 'user' ? 'you ' : by?.kind === 'agent' ? `${managerName} ` : '';
    return `${who}accepted in ${toProjectName}`;
}

type FiledItemProps =
    & Define.Prop<'projectId', ProjectId, true>
    & Define.Prop<'n', number, true>
    & Define.Prop<'projectName', string, true>
    & Define.Prop<'agentName', AgentNameOf>;

/** The filed item's live line, read from its project's Plan; nothing until the item is there. */
const FiledItem = component<FiledItemProps>(({ props }) => {
    const items = usePlanItems(() => props.projectId);
    return () => {
        const item = items().find((i) => i.id === props.n);
        return item ? <span data-requests-mono="" data-chat-request-item={item.state}>{linkedItemLine(item, props.projectName, props.agentName)}</span> : null;
    };
}, { name: 'ChatRequestFiledItem' });

export type RequestCardProps =
    & Define.Prop<'request', ProjectRequest, true>
    /** The project it was sent to, by name (`SignalX`). */
    & Define.Prop<'toProjectName', string, true>
    /** That project's manager, by name (`Nova`) — the TRIAGING pill names it. */
    & Define.Prop<'managerName', string, true>
    /** The chat's project, by name: its items a request names wait on the filed one. */
    & Define.Prop<'homeProjectName', string>
    /** `14:09` for an instant, in the workspace zone. */
    & Define.Prop<'time', (at: number) => string, true>
    /** One half (#870): the request card, or the accept divider and result card; both by default. */
    & Define.Prop<'part', 'request' | 'result'>
    /** Names the agent working the filed item (#931); without it the live line says only the state. */
    & Define.Prop<'agentName', AgentNameOf>;

/** The request's accept, once it is filed: when the divider and the result card happened. */
export function acceptedAt(r: ProjectRequest): number | undefined {
    return r.state === 'accepted' && r.resultItem !== undefined ? r.updatedAt : undefined;
}

export const RequestCard = component<RequestCardProps>(({ props }) => () => {
    const r = props.request;
    const pill = requestPill(r.state, props.managerName);
    const card = requestCardState(r, props.toProjectName, props.managerName);
    const home = props.homeProjectName?.toLowerCase();
    const waiting = home ? r.refs.flatMap((ref) => (ref.kind === 'project-item' && ref.project.toLowerCase() === home ? [projectItemRef(ref.project, ref.n)] : [])) : [];
    const filed = acceptedAt(r) !== undefined ? projectItemRef(props.toProjectName, r.resultItem!) : undefined;
    const request = props.part !== 'result';
    const result = props.part !== 'request' && filed !== undefined;
    if (!request && !result) return null;
    return (
        <div data-chat-request={r.state}>
            {request ? <article data-requests-triage="" aria-label={`Request to ${props.toProjectName}: ${r.title}`}>
                <header data-requests-triage-head="">
                    <Icon name="send" size={14} />
                    <span data-requests-dim="">Request to {props.toProjectName}</span>
                    <span data-requests-why="">
                        <StatusPill status={r.state} label={card.label} tone={pill.tone} hollow={pill.hollow} />
                    </span>
                </header>
                <span data-requests-triage-title="">{r.title}</span>
                <div data-requests-row-meta="">
                    {r.refs.length ? <span data-requests-refs="">{r.refs.map((ref) => <span data-requests-ref={ref.kind}><Icon name={refIcon(ref)} size={12} />{refLabel(ref)}</span>)}</span> : null}
                    <span data-requests-detail-age=""><Link to={`/projects/${encodeURIComponent(r.toProject)}/requests`}>See triage</Link></span>
                </div>
            </article> : null}
            {result ? (
                <>
                    <p data-chat-request-divider="" data-requests-mono="" role="separator">{acceptedByText(r, props.toProjectName, props.managerName)} · {props.time(r.updatedAt)}</p>
                    <article data-requests-triage="" data-chat-request-result="" aria-label={`Filed as ${filed}`}>
                        <div data-requests-row-meta="">
                            <span data-requests-chip="project"><Icon name="folder" size={12} />{filed}</span>
                            <span data-requests-dim="">{r.triage?.proposedItem?.title ?? r.title}</span>
                            <span data-requests-detail-age=""><Link to="/projects/links">Track</Link></span>
                        </div>
                        <FiledItem projectId={r.toProject} n={r.resultItem!} projectName={props.toProjectName} {...(props.agentName ? { agentName: props.agentName } : {})} />
                        {waiting.length ? <span data-requests-mono="">{waiting.join(', ')} {waiting.length === 1 ? 'waits' : 'wait'} on it</span> : null}
                    </article>
                </>
            ) : null}
        </div>
    );
}, { name: 'ChatRequestCard' });

export type ChatRequestsFromProps =
    & Define.Prop<'workspaceId', string, true>
    & Define.Prop<'chatId', string, true>
    /** The chat's project: the sender side of `Requests.from`. */
    & Define.Prop<'chatProjectId', ProjectId, true>
    & Define.Prop<'homeProjectName', string>
    /** The project the requests went to, its name, and its manager's name. */
    & Define.Prop<'projectId', ProjectId, true>
    & Define.Prop<'projectName', string, true>
    & Define.Prop<'managerName', string, true>
    & Define.Prop<'time', (at: number) => string, true>
    /** This chat's requests to `project`, oldest first, whenever the live read changes. */
    & Define.Prop<'onRequests', (projectId: ProjectId, requests: readonly ProjectRequest[]) => void>
    /** Read and report only (#870): the thread draws the cards, placed by time. Default false. */
    & Define.Prop<'headless', boolean>;

/** The live read of this chat's requests to one project, drawn as request cards. */
export const ChatRequestsFrom = component<ChatRequestsFromProps>(({ props }) => {
    const defs = useActorDefs();
    const read = useActorState(defs.Requests, () => [requestsKeyOf(props.workspaceId, props.projectId), 'from', props.chatProjectId] as const, { live: true });
    const mine = (): ProjectRequest[] => chatRequests(read.value ?? [], props.chatId);
    const stop = effect(() => {
        const list = mine();
        props.onRequests?.(props.projectId, list);
    });
    onUnmounted(() => {
        stop();
        props.onRequests?.(props.projectId, []);
    });
    return (): JSXElement => (props.headless ? null : (
        <>
            {mine().map((r) => (
                <div key={`${props.projectId}:${r.id}`} data-chat-question>
                    <RequestCard request={r} toProjectName={props.projectName} managerName={props.managerName} {...(props.homeProjectName ? { homeProjectName: props.homeProjectName } : {})} time={props.time} />
                </div>
            ))}
        </>
    ));
}, { name: 'ChatRequestsFrom' });
