/** `chat_post` and `ask_user` — the agent's voice in the chat (CHT-08, COL-06). */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import type { AgentId } from '@agentic/core';
import type { ChatPort } from './ports.js';

export const chatPostInput = z.object({
    text: z.string().min(1).describe('The message, in markdown.'),
    mentions: z.array(z.string()).optional().describe('Agent ids to address; a mentioned collaborator is activated.')
});

export const askUserInput = z.object({
    question: z.string().min(1).describe('One clear question.'),
    choices: z.array(z.string().min(1)).min(2).optional().describe('Offer these answers when the question is a choice.')
});

export function chatPostTool(port: ChatPort) {
    return defineTool({
        name: 'chat_post',
        description: 'Post a message into the chat this task came from, in your name. Use it to share a result or to address another agent; it does not wait for a reply.',
        input: chatPostInput,
        annotations: { idempotent: false },
        execute: (input, ctx) => port.post({ text: input.text, mentions: (input.mentions ?? []) as AgentId[] }, { callId: ctx.toolCallId, signal: ctx.signal })
    });
}

export function askUserTool(port: ChatPort) {
    return defineTool({
        name: 'ask_user',
        description: 'Ask the user a question and wait for the answer. Use it when you cannot proceed without a decision only they can make; otherwise state your assumption and go on.',
        input: askUserInput,
        annotations: { idempotent: false },
        execute: (input, ctx) => port.ask({ question: input.question, ...(input.choices ? { choices: input.choices } : {}) }, { callId: ctx.toolCallId, signal: ctx.signal })
    });
}
