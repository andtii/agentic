/**
 * "Start task" (#193): one agent, one objective, optionally a folder — the
 * way to start work without writing in a chat first (AGT-05: "you can
 * override it when starting work"). It is a chat all the same: the task
 * needs an origin a person can follow up in, so the dialog opens a chat
 * with the agent (titled by the objective), sets the agent's folder there
 * (`Chat.setWorkdir`, which also picks the environment) and posts the
 * objective — the same activation a message would start, through the
 * router. The page then opens that chat.
 */
import { signal } from 'sigx';
import { actor } from '@sigx/actors';
import { createId, type AgentId, type ChatId, type TaskId, type WorkdirRef } from '@agentic/core';
import type { ActorDefs } from '../../actors/defs';
import { chatKeyOf, routingKeyOf, taskKeyOf, workspaceKeyOf } from '../../actors/keys';
import { runActivation, type AgentLookup } from '../chat/live';

/** The topbar's "Start task" raises it — on an agent's page with that agent chosen. */
export const startTaskRequest = signal({ open: false, agentId: '' });
export const openStartTask = (agentId = ''): void => {
    startTaskRequest.agentId = agentId;
    startTaskRequest.open = true;
};
export const closeStartTask = (): void => { startTaskRequest.open = false; };

export interface StartTaskInput {
    readonly agentId: string;
    readonly objective: string;
    /** Where it runs; `null` = the agent's default environment and folder. */
    readonly workdir: WorkdirRef | null;
}

export type StartTaskErrors = Partial<Record<'agentId' | 'objective', string>>;

export function validateStartTask(input: StartTaskInput): StartTaskErrors {
    const errors: StartTaskErrors = {};
    if (!input.agentId) errors.agentId = 'Pick the agent that does it.';
    if (!input.objective.trim()) errors.objective = 'Say what it should do.';
    return errors;
}

/** A chat title from the objective: its first line, at most 60 characters. */
export function titleOf(objective: string): string {
    const line = objective.trim().split('\n')[0]!.trim();
    return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

/** Open the chat, set the folder, post the objective; resolves to the chat and the task it started. */
export async function startTaskWith(defs: ActorDefs, ws: string, input: StartTaskInput, lookup: AgentLookup): Promise<{ readonly chatId: string; readonly taskId: string | null }> {
    const agentId = input.agentId as AgentId;
    const objective = input.objective.trim();
    const { chatId } = await actor(defs.Workspace, workspaceKeyOf(ws)).createChat({ title: titleOf(objective) });
    const chat = actor(defs.Chat, chatKeyOf(ws, chatId));
    await chat.addAgent(agentId, 'all');
    await chat.setCoordinator(agentId);
    if (input.workdir) await chat.setWorkdir(agentId, input.workdir);
    const summary = await chat.get();
    const { tasks } = await runActivation(
        {
            post: (text, mentions) => chat.post(text, mentions),
            createTask: (id, contract, owner) => actor(defs.TaskActor, taskKeyOf(ws, id)).create(contract, { owner }),
            run: (taskId) => actor(defs.Routing, routingKeyOf(ws)).run(taskId),
            newTaskId: () => createId('task') as TaskId
        },
        { chatId: chatId as ChatId, text: objective, mentions: [agentId], summary, entries: [], lookup }
    );
    return { chatId, taskId: tasks[0]?.taskId ?? null };
}
