/**
 * A request sent from a chat hears back in that chat (#839; PRJ-16; docs/design/projects/HANDOFF.md "Project manager
 * and requests", the PMChat board): the receiving manager's triage reply, the result once it is accepted
 * (`SignalX#14 · accepted`), the reason when it is declined and the question when the sender is asked for more are
 * each posted into the request's `fromChat`.
 *
 * - `requestReplyText()` is pure: which change says something in the requester's chat, and what. Only `triaged`,
 *   `accepted`, `declined` and `asked` do; a request without a `fromChat` hears back nowhere.
 * - `RequestReplyPort` carries the post. The production port (`chatRequestReplies`) posts over the Requests actor's
 *   own hop, so the message is authored by whoever made the change: the manager agent for its triage (the reply in
 *   its own voice), the person or the manager who resolved it. The post names no one, so it activates nobody.
 * - The request card (#762) reads the request live and updates in place as the item moves; these posts are the
 *   thread's record of what was said.
 */
import { actorKey, type ChatId, type ProjectId, type WorkspaceId } from '@agentic/core';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { Chat } from '../chat/actor.js';
import type { RequestChange, RequestView } from './rules.js';

/** What one change posts into the requester's chat. */
export interface RequestReply {
    readonly workspaceId: WorkspaceId;
    /** The receiving project. */
    readonly projectId: ProjectId;
    readonly chatId: ChatId;
    readonly op: RequestChange['op'];
    readonly text: string;
    readonly request: RequestView;
}

/** How a reply reaches the requester's chat. */
export interface RequestReplyPort {
    post(hop: RequestReplyHop, reply: RequestReply): Promise<void>;
}

/** How the port reaches the chat: the Requests actor's own `ctx.actor`, carrying the caller. */
export interface RequestReplyHop {
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClient<D>;
}

const quoted = (r: Pick<RequestView, 'id' | 'title'>): string => `"${r.title}" (${r.id})`;

/**
 * What the requester's chat reads after `change`, or `null` when the change says nothing there:
 *
 * - `triaged`: the manager's own reply text.
 * - `accepted`: `SignalX#14 · accepted: "batch() drops updates…" (req_1)`.
 * - `declined`: `SignalX declined "…" (req_1): <reason>`.
 * - `asked`: `SignalX asks about "…" (req_1): <question>`.
 */
export function requestReplyText(projectName: string, change: Pick<RequestChange, 'op'>, request: RequestView): string | null {
    if (!request.fromChat) return null;
    switch (change.op) {
        case 'triaged': {
            const reply = request.triage?.reply?.trim();
            return reply ? reply : null;
        }
        case 'accepted':
            return request.resultItem === undefined ? null : `${projectName}#${request.resultItem} · accepted: ${quoted(request)}`;
        case 'declined':
            return `${projectName} declined ${quoted(request)}${request.declineReason ? `: ${request.declineReason}` : '.'}`;
        case 'asked':
            return `${projectName} asks about ${quoted(request)}${request.question ? `: ${request.question}` : '.'}`;
        default:
            return null;
    }
}

/** The reply for `change`, or `null` when it posts nothing. */
export function requestReplyFor(workspaceId: WorkspaceId, projectId: ProjectId, projectName: string, change: Pick<RequestChange, 'op'>, request: RequestView): RequestReply | null {
    const text = requestReplyText(projectName, change, request);
    if (text === null || !request.fromChat) return null;
    return { workspaceId, projectId, chatId: request.fromChat, op: change.op, text, request };
}

/** The production port: `Chat.post` on the requester's chat, as the caller, mentioning no one. */
export const chatRequestReplies: RequestReplyPort = {
    async post(hop, reply) {
        await hop.actor(Chat, actorKey(reply.workspaceId, 'chat', reply.chatId)).post(reply.text, []);
    }
};

/** No replies (a deployment without chats). */
export const NO_REQUEST_REPLIES: RequestReplyPort = { async post() {} };
