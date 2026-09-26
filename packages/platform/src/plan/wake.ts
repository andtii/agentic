/**
 * Waking a plan notice's addressee (#938): a notice (lease ran out, touches overlap, handoff, moved) used to wait on
 * the Plan actor until its addressee made its own next plan call, so nobody was woken. Now the actor hands each new
 * notice not addressed to the caller to a `PlanWakePort` once its turn is saved:
 *
 * - **An agent** gets a chat message addressed to it, as the PR autopilot does (`chatAutopilotPort.startTurn`):
 *   posted in the first chat of the candidates it is a member of — the chats of the tasks working the items, then
 *   the plan's own chat — with a task started from that message (`mentionContract`) and handed to the router,
 *   one-way. No chat it is a member of → not woken; the notice waits for its next plan call as before.
 * - **A person** gets one Inbox row.
 *
 * A woken notice is taken off the actor, so it is not delivered twice. Never a gate: a failure leaves the notice
 * waiting.
 */
import { createId, type AgentId, type ChatId, type PlanActor, type ProjectId, type TaskId, type WorkspaceId } from '@agentic/core';
import { actor, defineActor, type AnyActorDefinition } from '@sigx/actors';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { Inbox, inboxKey } from '../notify/inbox.js';
import type { NotificationInput } from '../notify/types.js';
import { routingKey, ROUTING_TYPE } from '../routing/key.js';
import { mentionContract, MENTION_CONTEXT_WINDOW } from '../routing/mentions.js';
import { TaskActor, taskKey } from '../task/index.js';
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
    /** Wake `wake.to` with its notices; `true` when they reached it (they are then taken off the actor). */
    wake(wake: PlanWake): Promise<boolean>;
}

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

/** The Inbox row for a person's notices. */
export function planWakeRow(notices: readonly PlanNotice[], chatId?: ChatId): NotificationInput {
    const first = notices[0]!;
    return {
        kind: 'input',
        title: notices.length === 1 ? `Plan #${first.itemId}: ${first.kind === 'handoff' ? 'handed off' : first.kind === 'lease-expired' ? 'lease ran out' : first.kind === 'touches' ? 'touches overlap' : 'moved'}` : `${notices.length} plan notices`,
        body: notices.map((n) => n.text).join('\n'),
        ...(chatId !== undefined ? { ref: { kind: 'chat', chatId } } : {})
    };
}

/** The production wake: a chat message (and a task) for an agent, an Inbox row for a person. */
export function chatPlanWake(options: ChatPlanWakeOptions = {}): PlanWakePort {
    return {
        async wake({ workspaceId, to, notices, tasks, chats }) {
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
            for (const chatId of candidates) {
                const chat = actor(Chat, `${workspaceId}:chat:${chatId}`).with({ context: driver });
                const summary = await chat.get().catch(() => undefined);
                const member = summary?.members[agentId];
                if (!summary || !member) continue;
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
            }
            return false;
        }
    };
}
