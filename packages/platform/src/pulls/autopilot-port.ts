/**
 * The platform half of an `AutopilotPort` (#820; PRJ-09): what the Pulls actor's autopilot acts through, bound to a
 * workspace. The app adds the merge (the git feature's `PullProvider.merge`) — the only half that knows a provider.
 *
 * - `startTurn`: posts the autopilot's text in the PR's chat addressed to the agent (`Chat.post` with the agent as
 *   the one mention), starts the agent's task from that message (`mentionContract`, as a person's mention does),
 *   hands it to the router (`Routing.run`, one-way) and returns the task's id — the Pulls actor ends the turn when
 *   that task ends (#858). The agent must be a member of the chat; otherwise the turn throws and
 *   the autopilot stops.
 * - `yourMove`: one Inbox row, one-way (`{repo}#{n} needs you`, the stop's line, deep-linked to the PR's task, else
 *   chat, else session).
 * - `askMerge`: one Inbox row saying the agent asks to merge — answered with `Pulls.answerMerge`.
 */
import { createId, type AgentId, type ApprovalRule, type ChatId, type NotificationRef, type PullRequest, type TaskId, type WorkspaceId } from '@agentic/core';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { inboxKey } from '../notify/inbox.js';
import type { NotificationInput } from '../notify/types.js';
import { mentionContract, MENTION_CONTEXT_WINDOW } from '../routing/mentions.js';
import { routingKey } from '../routing/key.js';
import { TaskActor, taskKey } from '../task/index.js';
import type { AutopilotPort, AutopilotStop } from './autopilot.js';

/** A merge the autopilot wants: asked of you before it runs, when its rule says `ask`. */
export interface AutopilotMergeAsk {
    readonly agentId: AgentId;
    readonly rule: ApprovalRule;
    readonly pr: PullRequest;
}

/** The actor's port: `AutopilotPort` plus how an `ask` merge reaches you. */
export interface PullsAutopilotPort extends AutopilotPort {
    /** Tell the user the agent asks to merge (`Pulls.answerMerge` answers it). Never a gate: a throw is ignored. */
    askMerge?(ask: AutopilotMergeAsk): Promise<void>;
}

export interface ChatAutopilotOptions {
    readonly workspaceId: WorkspaceId;
    /** The Routing definition, as a thunk like the other actor ports. */
    readonly routing: () => AnyActorDefinition;
    /** The Inbox definition; absent → no rows. */
    readonly inbox?: () => AnyActorDefinition;
}

interface RouterClient {
    run(taskId: TaskId): Promise<unknown>;
}
interface InboxClient {
    push(input: NotificationInput): Promise<unknown>;
}

/** `{repo name}#{n}`, the name every PR row uses. */
export const pullName = (pr: Pick<PullRequest, 'repo' | 'number'>): string => `${pr.repo.slice(pr.repo.indexOf('/') + 1)}#${pr.number}`;

function refOf(pr: Pick<PullRequest, 'taskId' | 'chatId' | 'sessionId'>): NotificationRef | undefined {
    if (pr.taskId !== undefined) return { kind: 'task', taskId: pr.taskId };
    if (pr.chatId !== undefined) return { kind: 'chat', chatId: pr.chatId };
    if (pr.sessionId !== undefined) return { kind: 'session', sessionId: pr.sessionId };
    return undefined;
}

/** The Inbox row for a stop: the next move is yours. */
export function autopilotStopRow(pr: PullRequest, stop: AutopilotStop): NotificationInput {
    const ref = refOf(pr);
    return { kind: 'input', title: `${pullName(pr)} needs you`, body: stop.detail, ...(ref ? { ref } : {}) };
}

/** The Inbox row for a merge the agent asks for. */
export function autopilotMergeRow(ask: AutopilotMergeAsk): NotificationInput {
    const ref = refOf(ask.pr);
    return {
        kind: 'input',
        title: `${pullName(ask.pr)}: ${ask.agentId} asks to merge`,
        body: `${ask.pr.title} · green and approved. Approve or decline the merge on the pull request (rule ${ask.rule.id}).`,
        ...(ref ? { ref } : {})
    };
}

/** The chat-and-inbox half of the autopilot's port for one workspace; the app spreads its `merge` over it. */
export function chatAutopilotPort(options: ChatAutopilotOptions): Omit<PullsAutopilotPort, 'merge'> {
    const { workspaceId } = options;
    const driver = asPrincipal(userPrincipal(workspaceId, workspaceId));
    const push = async (row: NotificationInput): Promise<void> => {
        const def = options.inbox?.();
        if (!def) return;
        try {
            await (actor(def, inboxKey(workspaceId)).with({ context: driver, oneWay: true }) as unknown as InboxClient).push(row);
        } catch {
            // A notification is never a gate on the autopilot.
        }
    };
    return {
        async startTurn({ agentId, chatId, text }) {
            const chat = actor(Chat, `${workspaceId}:chat:${chatId as ChatId}`).with({ context: driver });
            // Checked before the post: a turn that cannot start leaves nothing in the chat.
            const summary = await chat.get();
            const member = summary.members[agentId];
            if (!member) throw new Error(`${agentId} is not a member of chat ${chatId}`);
            const { messageId } = await chat.post(text, [agentId]);
            const { entries } = await chat.history(null, MENTION_CONTEXT_WINDOW + 1);
            const contract = mentionContract({
                assignee: agentId,
                chatId,
                messageId,
                text,
                posterName: 'Autopilot',
                member,
                entries,
                nameOf: (id) => id,
                ...(summary.machineId ? { machineId: summary.machineId } : {})
            });
            const taskId = createId('task') as TaskId;
            await actor(TaskActor, taskKey(workspaceId, taskId)).with({ context: driver }).create(contract, { owner: agentId });
            // A hand-off, one-way (#492): the Pulls turn never waits on the placement — the task's record says how it went.
            const router = actor(options.routing(), routingKey(workspaceId)).with({ context: driver, oneWay: true }) as unknown as RouterClient;
            await router.run(taskId);
            // The Pulls actor keeps it on the turn: the task's end is the turn's end (#858).
            return { taskId };
        },
        async yourMove({ pr, stop }) {
            await push(autopilotStopRow(pr, stop));
        },
        async askMerge(ask) {
            await push(autopilotMergeRow(ask));
        }
    };
}

