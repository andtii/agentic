/**
 * A late answer reaches the agent that asked (#285, #396; COL-06, CHT-09, OPS-06). `ask_user` in a chat answers
 * `pending` once its quick window passes: the agent ends its turn, the question stays open on the Session, the
 * asking task stays `waiting {input}` on a route parked `waiting-answer`, and the Session hands the answer here
 * (`SessionPorts.answered`) once no turn runs. The answer is posted in the chat as the person who gave it, mentioning
 * the asker — so it is never silently dropped — and then:
 *
 * - **the chat path steers** (`Routing.deliverAnswer`): the answer is prompted into the asker's own live session as
 *   a new user message, under the asking task, through the same seam a chat message takes (`steerOrPrompt`) — no new
 *   task, and the engine conversation the question lives in carries on;
 * - **the follow-up task** (`createAnswerFollowUp`'s original path) stays for an answer no route can take — the
 *   asking task settled (cancelled, failed with its session) or the session was ended: that post is the origin of a
 *   new task for the asker, which continues the asking session's engine conversation when the placement allows
 *   (`TaskContract.resumeFrom`).
 *
 * A step that fails throws `AnswerDeliveryError` naming it (`post` / `deliver` / `create` / `run`) with the cause,
 * and what an earlier attempt already did (`posted`): the Session retries the hand-over on a reminder and says the
 * step and the cause in the chat only once its attempts are spent.
 */

import type { AgentId, MessageId, Principal, PromptPart, SessionId, TaskContract, TaskId } from '@agentic/core';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { isServerFnError, ServerFnError } from '@sigx/server';

import { AgentActor, agentKey } from '../agent/index.js';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import type { AnswerFollowUp } from '../session/ports.js';
import { TaskActor, taskKey } from '../task/index.js';
import type { AnswerDelivery } from './actor.js';
import { MENTION_CONTEXT_WINDOW, mentionContract } from './mentions.js';
import { routingKey } from './key.js';
import { agentChatKey } from './tools.js';

export interface AnswerFollowUpOptions {
    /** The Routing actor definition — where the answer is delivered, and the asker's new task placed when it cannot be. */
    readonly routing: () => AnyActorDefinition;
}

/** The step of a hand-over that failed (#396): the chat post, the steer, the follow-up task's creation, its placement. */
export type AnswerStep = 'post' | 'deliver' | 'create' | 'run';

/**
 * Why a late answer was not delivered (#396), named: `message` reads `{step}:{cause}` — what the chat says as
 * `answer-not-delivered:{step}:{cause}` — and `data` carries the same plus what an earlier step already did. A
 * `ServerFnError`, so it keeps its shape across an actor hop; the cause is the thrown error's message (a
 * `ServerFnError`'s survives the wire, anything else is `@sigx/server`'s "Internal error" mask — the step still names
 * where it happened) and is logged here with the error itself.
 */
export class AnswerDeliveryError extends ServerFnError {
    readonly step: AnswerStep;
    readonly cause: string;
    /** The chat message this attempt (or an earlier one) posted the answer as — not posted again on a retry. */
    readonly posted?: MessageId;
    constructor(step: AnswerStep, cause: unknown, posted?: MessageId) {
        const message = cause instanceof Error ? cause.message : String(cause);
        super(isServerFnError(cause) ? cause.status : 500, `${step}:${message}`, { code: 'answer-not-delivered', step, cause: message, ...(posted ? { posted } : {}) });
        this.name = 'AnswerDeliveryError';
        this.step = step;
        this.cause = message;
        if (posted) this.posted = posted;
    }
}

/** The follow-up task of one answered question — deterministic, so a replayed answer starts the asker once. */
export function answerTaskId(sessionId: SessionId, requestId: string): TaskId {
    return `task_ans_${sessionId}_${requestId.replace(/[^A-Za-z0-9_-]/g, '_')}` as TaskId;
}

/** The chat message that carries the answer: who asked what, and what was answered. */
export function answerPostText(askerName: string, question: string, answer: string): string {
    return `@${askerName} — re: “${question}” → ${answer}`;
}

/** The answer as the asker reads it — the follow-up's objective, and the message steered into the asking session. */
export function answerObjective(question: string, answer: string): string {
    return `The answer to your question “${question}”: ${answer}`;
}

/**
 * What the asking session is prompted with (#396): the answer, and that the work goes on — the engine still holds
 * the question and everything before it, so nothing is repeated.
 */
export function answerPrompt(question: string, answer: string): PromptPart[] {
    return [{ type: 'text', text: `${answerObjective(question, answer)}\n\nContinue the work you were doing when you asked.` }];
}

/**
 * The asker's new task: the answer as objective, and as context the question, the answer and the chat since
 * (as a mention carries it) — enough to carry on fresh when the engine conversation cannot be resumed.
 */
export function answerContract(input: Parameters<typeof mentionContract>[0] & { readonly question: string; readonly choices?: readonly string[]; readonly answer: string; readonly answererName: string; readonly resumeFrom: SessionId }): TaskContract {
    const base = mentionContract(input);
    const [chat, ...files] = base.context;
    const history = chat?.type === 'text' ? chat.text.replace(/^.*mentioned you in the chat\.\n*/, '') : '';
    const asked = [`Question: ${input.question}`, ...(input.choices?.length ? [`Choices: ${input.choices.join(' / ')}`] : []), `Answer: ${input.answer}`].join('\n');
    const text = `${input.answererName} answered the question you asked with ask_user.\n\n${asked}\n\nContinue the work you were doing when you asked.${history ? `\n\n${history}` : ''}`;
    return { ...base, objective: answerObjective(input.question, input.answer), context: [{ type: 'text', text }, ...files], resumeFrom: input.resumeFrom };
}

/** The slice of the Routing actor a hand-over drives. */
interface AnswerRouter {
    run(taskId: TaskId): Promise<unknown>;
    deliverAnswer(sessionId: SessionId, requestId: string, input: readonly PromptPart[]): Promise<AnswerDelivery>;
    questionCancelled(sessionId: SessionId, requestId: string): Promise<void>;
}

/**
 * `SessionPorts.answered` over the actors: post the answer, steer it into the asker's live session under the asking
 * task, else create the asker's follow-up task and place it. Throws `AnswerDeliveryError` for what could not be done.
 */
export function createAnswerFollowUp(options: AnswerFollowUpOptions): (followUp: AnswerFollowUp) => Promise<void> {
    return async (f) => {
        const { workspaceId } = f;
        // The router and the task are the platform's doing (the Schedule path's driver); the post is the answerer's word.
        const driver = userPrincipal(workspaceId, workspaceId);
        const as = <D extends AnyActorDefinition>(def: D, key: string, p: Principal = driver): ActorClientWith<D> => actor(def, key).with({ context: asPrincipal(p) }) as ActorClientWith<D>;
        const task = (id: TaskId) => as(TaskActor, taskKey(workspaceId, id));
        const router = as(options.routing(), routingKey(workspaceId)) as unknown as AnswerRouter;
        let posted = f.posted;
        /** One step of the hand-over: a failure is named after it, with what is already done, and logged with its cause. */
        const step = async <T>(name: AnswerStep, fn: () => Promise<T>): Promise<T> => {
            try {
                return await fn();
            } catch (e) {
                console.warn(`[routing] answer to ${f.requestId} of session ${f.sessionId} not delivered at "${name}":`, e);
                throw new AnswerDeliveryError(name, e, posted);
            }
        };
        const run = (id: TaskId): Promise<void> =>
            step('run', async () => {
                try {
                    await router.run(id);
                } catch (e) {
                    // Already placed or settled (a replayed answer): the task stands as it is.
                    if (!(isServerFnError(e) && e.status === 409)) throw e;
                }
            });

        // A dismissed question (#396): the task waiting on it is released as it stands; nothing is posted, nobody started.
        if (f.cancelled) return step('deliver', () => router.questionCancelled(f.sessionId, f.requestId));

        const id = answerTaskId(f.sessionId, f.requestId);
        // Only "never created" means no follow-up yet; any other failure is real and must not start a second one.
        const exists = await step('create', () =>
            task(id)
                .get()
                .then(
                    () => true,
                    (e: unknown) => {
                        if ((e as { code?: unknown } | null)?.code === 'not-created' || (isServerFnError(e) && e.status === 404)) return false;
                        throw e;
                    }
                )
        );
        if (exists) return run(id);

        // The answer in the thread, once: a retried hand-over carries the message an earlier attempt posted.
        const asker = await step('post', () => as(AgentActor, agentKey(workspaceId, f.agentId)).get());
        const askerName = asker.config.name || f.agentId;
        if (!posted) {
            const poster = f.answeredBy.kind === 'user' || f.answeredBy.kind === 'external' ? f.answeredBy : driver;
            const chat = as(Chat, agentChatKey(workspaceId, f.chatId), poster);
            posted = (await step('post', () => chat.post(answerPostText(askerName, f.question, f.answer), [f.agentId]))).messageId as MessageId;
        }

        // The chat path (#396): the asking task's route takes the answer into the asker's own live session.
        const delivery = await step('deliver', () => router.deliverAnswer(f.sessionId, f.requestId, answerPrompt(f.question, f.answer)));
        if (delivery.delivered) return;

        // No route waits on the question: the asker is started again with a follow-up task, from the post.
        await step('create', async () => {
            const summary = await as(Chat, agentChatKey(workspaceId, f.chatId)).get();
            const member = summary.members[f.agentId];
            if (!member) throw new Error(`${askerName} is no longer a member of this chat; the answer is posted, nobody was started`);
            const { entries } = await as(Chat, agentChatKey(workspaceId, f.chatId)).history(null, MENTION_CONTEXT_WINDOW + 1);
            const names = new Map<AgentId, string>([[f.agentId, askerName]]);
            const asking = f.taskId ? await task(f.taskId).get().catch(() => undefined) : undefined;
            const contract = answerContract({
                assignee: f.agentId,
                chatId: f.chatId,
                messageId: posted!,
                text: f.answer,
                posterName: 'User',
                member,
                entries,
                nameOf: (a) => names.get(a) ?? a,
                ...(f.environmentId ? { fallbackEnvironmentId: f.environmentId } : {}),
                question: f.question,
                ...(f.choices ? { choices: f.choices } : {}),
                answer: f.answer,
                answererName: 'The user',
                resumeFrom: f.sessionId
            });
            await task(id).create(contract, { owner: f.agentId, depth: asking?.depth ?? 0 });
        });
        await run(id);
    };
}
