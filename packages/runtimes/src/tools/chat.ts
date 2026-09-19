/** `chat_post` and `ask_user` — the agent's voice in the chat (CHT-08, COL-06). */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import type { AgentId } from '@agentic/core';
import { chatFileUriInput } from './chatFile.js';
import type { ChatPort } from './ports.js';

export const chatPostInput = z.object({
    text: z.string().min(1).describe('The message, in markdown.'),
    mentions: z.array(z.string()).optional().describe('Agent ids (agent_…) to address; each mentioned collaborator is started on this message.'),
    attachments: z.array(chatFileUriInput).optional().describe('agentic-file: URIs of files from this chat to attach to the message.')
});

export const askUserInput = z.object({
    question: z.string().min(1).describe('One clear question.'),
    choices: z.array(z.string().min(1)).min(2).optional().describe('Offer these answers when the question is a choice.')
});

export function chatPostTool(port: ChatPort) {
    return defineTool({
        name: 'chat_post',
        description: 'Post a message into the chat this task came from, in your name. Each agent id in `mentions` gets a task of its own and answers in the chat when its turn ends; the result lists who was started (`activated`) and who was not, and why (`notActivated`). It does not wait for the reply: use `delegate` when you need the answer back as a tool result. Attach files from the chat by their agentic-file: URIs.',
        input: chatPostInput,
        annotations: { idempotent: false },
        execute: (input, ctx) =>
            port.post(
                { text: input.text, mentions: (input.mentions ?? []) as AgentId[], ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
                { callId: ctx.toolCallId, signal: ctx.signal }
            )
    });
}

export function askUserTool(port: ChatPort) {
    return defineTool({
        name: 'ask_user',
        description:
            'Ask the user a question. Use it when you cannot proceed without a decision only they can make; otherwise state your assumption and go on. A quick answer comes back as `answer`. If the result is `status: "pending"`, the user has not answered yet: end your turn now, saying you are waiting on that question — do not ask again or guess. When the user answers, you are started again in this chat with the question and the answer, and continue the work from there.',
        input: askUserInput,
        annotations: { idempotent: false },
        execute: (input, ctx) => port.ask({ question: input.question, ...(input.choices ? { choices: input.choices } : {}) }, { callId: ctx.toolCallId, signal: ctx.signal })
    });
}
