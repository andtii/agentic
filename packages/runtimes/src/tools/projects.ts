/**
 * `projects` — the coordinator resolves the project a message names and puts
 * the chat in it (#334; COL-02, COL-04, PLG-01).
 *
 * The tool is the thin end: `list` returns the registered projects, `set`
 * calls `ProjectPort.set` (`Chat.setProject` under the agent's principal, which
 * audits it). Matching what the user wrote to a project is the model's job —
 * the description tells it when to look, to pick only a registered project
 * (never a folder on disk) and to ask with `ask_user` when nothing or more
 * than one matches. The one rule the tool enforces itself: a chat already in
 * a project is not moved unless `force` is passed, which the description
 * reserves for an explicit request from the user.
 */

import { defineTool, SchemaValidationError } from '@sigx/ai';
import { z } from 'zod';
import type { ChatId, ProjectId } from '@agentic/core';
import type { ChatProject, ProjectPort, ProjectSummary, ToolCall } from './ports.js';

export const projectsInput = z.object({
    action: z.enum(['list', 'set']).describe('`list` the registered projects, or `set` the project a chat belongs to.'),
    chatId: z.string().min(1).optional().describe('`set`: the chat to put in the project — the id under "This chat" in your instructions.'),
    projectId: z.string().min(1).nullable().optional().describe('`set`: the id of a registered project (from `list`), or null to take the chat out of its project.'),
    force: z.boolean().optional().describe('`set`: also change a chat that is already in a project. Pass it only when the user explicitly asked to switch this chat’s project.')
});

export interface ProjectsListResult {
    readonly projects: readonly ProjectSummary[];
}

export interface ProjectsSetResult {
    readonly chatId: ChatId;
    readonly projectId: ProjectId | null;
    /** The project the chat was in before the call; `null` when it was in none. */
    readonly previous: ChatProject | null;
}

const label = (project: ChatProject): string => (project.name !== undefined ? `"${project.name}" (${project.id})` : project.id);

export function projectsTool(port: ProjectPort | undefined) {
    return defineTool({
        name: 'projects',
        description:
            'The projects registered in this workspace, and the project a chat belongs to. A chat’s project decides the folder every member’s session opens in on its machine and the connectors it gets. ' +
            'Call `list` only when this chat has no project yet and the user’s message names a repository or project (a repo or project name, a path, “the agentic repo”, …); then `set` the single registered project whose name or description matches what they wrote. ' +
            'When none or more than one matches, ask the user with `ask_user`, offering the candidates as choices — never guess, and never pick a folder on disk: only a registered project can be set. ' +
            'A chat already in a project stays there: `set` refuses it unless `force` is true, which you pass only when the user explicitly asked to switch this chat’s project.',
        input: projectsInput,
        annotations: { destructive: false, idempotent: true },
        execute: async (input, ctx): Promise<ProjectsListResult | ProjectsSetResult> => {
            if (!port) throw new Error('projects: projects are not available on this host');
            const call: ToolCall = { callId: ctx.toolCallId, signal: ctx.signal };
            if (input.action === 'list') return { projects: await port.list(call) };
            if (input.chatId === undefined || input.projectId === undefined) {
                throw new SchemaValidationError([{ message: 'set needs chatId and projectId (a project id, or null)', path: [input.chatId === undefined ? 'chatId' : 'projectId'] }], 'projects: set needs chatId and projectId');
            }
            const chatId = input.chatId as ChatId;
            const projectId = input.projectId as ProjectId | null;
            const previous = await port.current(chatId, call);
            // The guard: a chat that is in a project is left alone unless the user asked for the switch (`force`).
            if (previous !== null && previous.id !== projectId && input.force !== true) {
                throw new Error(`projects: chat ${chatId} is already in project ${label(previous)} and stays there. Pass force: true only if the user explicitly asked to switch this chat’s project.`);
            }
            if (previous?.id !== projectId) await port.set(chatId, projectId, call);
            return { chatId, projectId, previous };
        }
    });
}
