/**
 * Waking a plan notice's addressee (#938): a notice (lease ran out, touches overlap, handoff, moved, ready work #981)
 * used to wait on the Plan actor until its addressee made its own next plan call, so nobody was woken. Now the actor
 * hands each new notice not addressed to the caller to a `PlanWakePort` once its turn is saved:
 *
 * - **An agent** gets a chat message addressed to it, as the PR autopilot does (`chatAutopilotPort.startTurn`):
 *   posted in the first chat of the candidates it is a member of — the chats of the tasks working the items, then
 *   the plan's own chat — with a task started from that message (`mentionContract`) and handed to the router,
 *   one-way. No chat it is a member of → not woken; the notice waits for its next plan call as before — except what
 *   a person caused (#1043: an `answer` to its question, a `mention` in a note), which opens a project chat with the
 *   agent ("Plan #n") and posts there; the actor tries that chat first next time.
 * - **A person** gets one Inbox row.
 *
 * A woken notice is taken off the actor, so it is not delivered twice. Never a gate: a failure leaves the notice
 * waiting.
 */
import { createId, type AgentId, type ChatId, type PlanActor, type ProjectId, type TaskId, type WorkspaceId } from '@agentic/core';
import { actor, defineActor, type AnyActorDefinition } from '@sigx/actors';
import { asPrincipal, userPrincipal, workspaceKey } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { Inbox, inboxKey } from '../notify/inbox.js';
import type { NotificationInput } from '../notify/types.js';
import { routingKey, ROUTING_TYPE } from '../routing/key.js';
import { mentionContract, MENTION_CONTEXT_WINDOW } from '../routing/mentions.js';
import { TaskActor, taskKey } from '../task/index.js';
import { Workspace } from '../workspace/index.js';
import type { PlanNotice } from './rules.js';

/** One addressee's new notices, and where it might be reached. */
export interface PlanWake {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    readonly to: PlanActor;
    readonly notices: readonly PlanNotice[];
    /** Tasks working (or that worked) the items, most relevant first: their chats are tried first. */
    readonly tasks: readonly TaskId[];
    /** Chats to try after the tasks' (the plans' own chats). */
    readonly chats: readonly ChatId[];
}

export interface PlanWakePort {
    /** Wake `wake.to` with its notices: whether they reached it (they are then taken off the actor). */
    wake(wake: PlanWake): Promise<PlanWakeResult>;
}

/**
 * `true` when the notices reached their addressee. `{ chatId, reached }` when the wake opened a chat for it (#1043): the
 * actor keeps that chat and offers it next time, whether or not this post got through — so a retry opens no second one.
 */
export type PlanWakeResult = boolean | { readonly chatId: ChatId; readonly reached: boolean };

/** The notices a person caused, which open a chat with an agent no other chat reaches (#1043). */
const OPENS_CHAT: ReadonlySet<PlanNotice['kind']> = new Set(['answer', 'mention']);

/** Nobody is woken: notices wait for their addressee's next plan call. */
export const NO_PLAN_WAKE: PlanWakePort = { wake: async () => false };

export interface ChatPlanWakeOptions {
    /** The Routing definition. Default: a reference by type — the host runs the app's own. */
    readonly routing?: () => AnyActorDefinition;
    /** The Inbox definition. Default: `Inbox`, by type as well. */
    readonly inbox?: () => AnyActorDefinition;
}

/** Only its `type` matters for a hop: the host runs the app's own Routing definition. */
let routingRef: AnyActorDefinition | undefined;
const routingByType = (): AnyActorDefinition =>
    (routingRef ??= defineActor({ type: ROUTING_TYPE, state: () => ({}), methods: () => ({ async run(_taskId: TaskId): Promise<void> {} }) }) as unknown as AnyActorDefinition);

interface RouterClient {
    run(taskId: TaskId): Promise<unknown>;
}
interface InboxClient {
    push(input: NotificationInput): Promise<unknown>;
}

/** The text of a wake: one line per notice. */
export function planWakeText(notices: readonly PlanNotice[]): string {
    return notices.length === 1 ? `Plan: ${notices[0]!.text}` : ['Plan notices:', ...notices.map((n) => `- #${n.itemId}: ${n.text}`)].join('\n');
}

const NOTICE_TITLES: Record<PlanNotice['kind'], string> = {
    handoff: 'handed off',
    'lease-expired': 'lease ran out',
    touches: 'touches overlap',
    reassigned: 'moved',
    ready: 'ready for you',
    done: 'done',
    'needs-you': 'needs a person',
    idle: 'member idle',
    stalled: 'member stalled',
    answer: 'answered',
    mention: 'mentioned you',
    dropped: 'dropped'
};

/** The Inbox row for a person's notices. */
export function planWakeRow(notices: readonly PlanNotice[], chatId?: ChatId): NotificationInput {
    const first = notices[0]!;
    return {
        kind: 'input',
        title: notices.length === 1 ? `Plan #${first.itemId}: ${NOTICE_TITLES[first.kind]}` : `${notices.length} plan notices`,
        body: notices.map((n) => n.text).join('\n'),
        ...(chatId !== undefined ? { ref: { kind: 'chat', chatId } } : {})
    };
}

/** The production wake: a chat message (and a task) for an agent, an Inbox row for a person. */
export function chatPlanWake(options: ChatPlanWakeOptions = {}): PlanWakePort {
    return {
        async wake({ workspaceId, projectId, to, notices, tasks, chats }) {
            if (!notices.length) return false;
            const driver = asPrincipal(userPrincipal(workspaceId, workspaceId));
            const candidates: ChatId[] = [];
            for (const taskId of tasks) {
                const view = await actor(TaskActor, taskKey(workspaceId, taskId))
                    .with({ context: driver })
                    .get()
                    .catch(() => undefined);
                if (view?.origin.kind === 'user' && !candidates.includes(view.origin.chatId)) candidates.push(view.origin.chatId);
            }
            for (const chatId of chats) if (!candidates.includes(chatId)) candidates.push(chatId);

            if (to.kind === 'user') {
                const def = (options.inbox ?? (() => Inbox as unknown as AnyActorDefinition))();
                await (actor(def, inboxKey(workspaceId)).with({ context: driver }) as unknown as InboxClient).push(planWakeRow(notices, candidates[0]));
                return true;
            }
            const agentId: AgentId = to.agentId;
            const text = planWakeText(notices);
            const chatOf = (chatId: ChatId) => actor(Chat, `${workspaceId}:chat:${chatId}`).with({ context: driver });
            /** Post the notices to the agent in `chatId` and start its turn there; `false` when it is not a member. */
            const postIn = async (chatId: ChatId): Promise<boolean> => {
                const chat = chatOf(chatId);
                const summary = await chat.get().catch(() => undefined);
                const member = summary?.members[agentId];
                if (!summary || !member) return false;
                const { messageId } = await chat.post(text, [agentId]);
                const { entries } = await chat.history(null, MENTION_CONTEXT_WINDOW + 1);
                const contract = mentionContract({
                    assignee: agentId,
                    chatId,
                    messageId,
                    text,
                    posterName: 'Plan',
                    member,
                    entries,
                    nameOf: (id) => id,
                    ...(summary.machineId ? { machineId: summary.machineId } : {})
                });
                const taskId = createId('task') as TaskId;
                await actor(TaskActor, taskKey(workspaceId, taskId)).with({ context: driver }).create(contract, { owner: agentId });
                const router = actor((options.routing ?? routingByType)(), routingKey(workspaceId)).with({ context: driver, oneWay: true }) as unknown as RouterClient;
                await router.run(taskId);
                return true;
            };
            for (const chatId of candidates) if (await postIn(chatId)) return true;
            // What a person caused reaches the agent anyway: a project chat with it, remembered by the actor.
            if (!notices.some((n) => OPENS_CHAT.has(n.kind))) return false;
            const { chatId } = await actor(Workspace, workspaceKey(workspaceId))
                .with({ context: driver })
                .createChat({ projectId, title: `Plan #${notices.find((n) => OPENS_CHAT.has(n.kind))!.itemId}` });
            try {
                const chat = chatOf(chatId);
                await chat.addAgent(agentId, 'all');
                await chat.setCoordinator(agentId);
                return { chatId, reached: await postIn(chatId) };
            } catch (error) {
                console.warn(`[plan] posting to the chat opened for ${agentId} failed:`, error);
                return { chatId, reached: false };
            }
        }
    };
}
