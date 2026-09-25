/**
 * A request in the chat that started it (#762; PRJ-16; board `PMChat`): the request card — `Request to SignalX`, its
 * state pill following the request in place (`NOVA TRIAGING`, `NEEDS YOU`, `ACCEPTED → SIGNALX#14`), the title, the
 * refs and "See triage" into the target's Requests inbox — then, once accepted, a divider (`accepted in SignalX ·
 * 14:09`) and the result card: the filed item, the chat project's items that wait on it, and Track → Links.
 *
 * `ChatRequestsFrom` is the live source: one per project the chat's visitors come from, reading that project's
 * `Requests.from(chatProject)` live, keeping this chat's requests (`chatRequests`) and reporting them up for the
 * Across projects card.
 */
import { component, effect, onUnmounted, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { useActorState } from '@sigx/actors/app';
import type { ProjectId, ProjectRequest } from '@agentic/core';
import { chatRequests, projectItemRef, requestCardState } from '@agentic/platform';
import { Icon, StatusPill } from '@agentic/ui';
import { useActorDefs } from '../../../actors/defs';
import { requestsKeyOf } from '../../../actors/keys';
import { refIcon, refLabel } from '../../projects/features/plan/shared/model';
import { requestPill } from '../../projects/requests/model';

export type RequestCardProps =
    & Define.Prop<'request', ProjectRequest, true>
    /** The project it was sent to, by name (`SignalX`). */
    & Define.Prop<'toProjectName', string, true>
    /** That project's manager, by name (`Nova`) — the TRIAGING pill names it. */
    & Define.Prop<'managerName', string, true>
    /** The chat's project, by name: its items a request names wait on the filed one. */
    & Define.Prop<'homeProjectName', string>
    /** `14:09` for an instant, in the workspace zone. */
    & Define.Prop<'time', (at: number) => string, true>;

export const RequestCard = component<RequestCardProps>(({ props }) => () => {
    const r = props.request;
    const pill = requestPill(r.state, props.managerName);
    const card = requestCardState(r, props.toProjectName, props.managerName);
    const home = props.homeProjectName?.toLowerCase();
    const waiting = home ? r.refs.flatMap((ref) => (ref.kind === 'project-item' && ref.project.toLowerCase() === home ? [projectItemRef(ref.project, ref.n)] : [])) : [];
    const filed = r.state === 'accepted' && r.resultItem !== undefined ? projectItemRef(props.toProjectName, r.resultItem) : undefined;
    return (
        <div data-chat-request={r.state}>
            <article data-requests-triage="" aria-label={`Request to ${props.toProjectName}: ${r.title}`}>
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
            </article>
            {filed ? (
                <>
                    <p data-chat-request-divider="" data-requests-mono="" role="separator">accepted in {props.toProjectName} · {props.time(r.updatedAt)}</p>
                    <article data-requests-triage="" data-chat-request-result="" aria-label={`Filed as ${filed}`}>
                        <div data-requests-row-meta="">
                            <span data-requests-chip="project"><Icon name="folder" size={12} />{filed}</span>
                            <span data-requests-dim="">{r.triage?.proposedItem?.title ?? r.title}</span>
                            <span data-requests-detail-age=""><Link to="/projects/links">Track</Link></span>
                        </div>
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
    & Define.Prop<'onRequests', (projectId: ProjectId, requests: readonly ProjectRequest[]) => void>;

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
    return (): JSXElement => (
        <>
            {mine().map((r) => (
                <div key={`${props.projectId}:${r.id}`} data-chat-question>
                    <RequestCard request={r} toProjectName={props.projectName} managerName={props.managerName} {...(props.homeProjectName ? { homeProjectName: props.homeProjectName } : {})} time={props.time} />
                </div>
            ))}
        </>
    );
}, { name: 'ChatRequestsFrom' });
