/**
 * A late answer starts the asker again (#285, COL-06, CHT-09). `ask_user` in a
 * chat answers `pending` once its quick window passes: the agent ends its turn,
 * the question stays open on the (closed) Session, and the Session hands the
 * answer here (`SessionPorts.answered`). The answer is posted in the chat as the
 * person who gave it, mentioning the asker — so it is never silently dropped —
 * and that message is the origin of a new task for the asker, which continues
 * the asking session's engine conversation when the placement allows
 * (`TaskContract.resumeFrom`).
 */

import type { AgentId, MessageId, Principal, SessionId, TaskContract, TaskId } from '@agentic/core';
import { actor, type ActorClientWith, type AnyActorDefinition } from '@sigx/actors';
import { isServerFnError } from '@sigx/server';

import { AgentActor, agentKey } from '../agent/index.js';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import type { AnswerFollowUp } from '../session/ports.js';
import { TaskActor, taskKey } from '../task/index.js';
import { MENTION_CONTEXT_WINDOW, mentionContract } from './mentions.js';
import { routingKey } from './key.js';
import { agentChatKey } from './tools.js';

export interface AnswerFollowUpOptions {
    /** The Routing actor definition — where the asker's new task is placed. */
    readonly routing: () => AnyActorDefinition;
}

/** The follow-up task of one answered question — deterministic, so a replayed answer starts the asker once. */
export function answerTaskId(sessionId: SessionId, requestId: string): TaskId {
    return `task_ans_${sessionId}_${requestId.replace(/[^A-Za-z0-9_-]/g, '_')}` as TaskId;
}

/** The chat message that carries the answer: who asked what, and what was answered. */
export function answerPostText(askerName: string, question: string, answer: string): string {
    return `@${askerName} — re: “${question}” → ${answer}`;
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
    return { ...base, objective: `The answer to your question “${input.question}”: ${input.answer}`, context: [{ type: 'text', text }, ...files], resumeFrom: input.resumeFrom };
}

/** `SessionPorts.answered` over the actors: post the answer, create the asker's task, place it. Throws what could not be done. */
export function createAnswerFollowUp(options: AnswerFollowUpOptions): (followUp: AnswerFollowUp) => Promise<void> {
    return async (f) => {
        const { workspaceId } = f;
        // The router and the task are the platform's doing (the Schedule path's driver); the post is the answerer's word.
        const driver = userPrincipal(workspaceId, workspaceId);
        const as = <D extends AnyActorDefinition>(def: D, key: string, p: Principal = driver): ActorClientWith<D> => actor(def, key).with({ context: asPrincipal(p) }) as ActorClientWith<D>;
        const task = (id: TaskId) => as(TaskActor, taskKey(workspaceId, id));
        const router = as(options.routing(), routingKey(workspaceId)) as unknown as { run(taskId: TaskId): Promise<unknown> };
        const run = async (id: TaskId): Promise<void> => {
            try {
                await router.run(id);
            } catch (e) {
                // Already placed or settled (a replayed answer): the task stands as it is.
                if (!(isServerFnError(e) && e.status === 409)) throw e;
            }
        };

        const id = answerTaskId(f.sessionId, f.requestId);
        const exists = await task(id)
            .get()
            .then(
                () => true,
                () => false
            );
        if (exists) return run(id);

        const asker = await as(AgentActor, agentKey(workspaceId, f.agentId)).get();
        const askerName = asker.config.name || f.agentId;
        const poster = f.answeredBy.kind === 'user' || f.answeredBy.kind === 'external' ? f.answeredBy : driver;
        const chat = as(Chat, agentChatKey(workspaceId, f.chatId), poster);
        const { messageId } = await chat.post(answerPostText(askerName, f.question, f.answer), [f.agentId]);

        const summary = await as(Chat, agentChatKey(workspaceId, f.chatId)).get();
        const member = summary.members[f.agentId];
        if (!member) throw new Error(`${askerName} is no longer a member of this chat; the answer is posted, nobody was started`);
        const { entries } = await as(Chat, agentChatKey(workspaceId, f.chatId)).history(null, MENTION_CONTEXT_WINDOW + 1);
        const names = new Map<AgentId, string>([[f.agentId, askerName]]);
        const asking = f.taskId ? await task(f.taskId).get().catch(() => undefined) : undefined;
        const contract = answerContract({
            assignee: f.agentId,
            chatId: f.chatId,
            messageId: messageId as MessageId,
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
        await run(id);
    };
}
