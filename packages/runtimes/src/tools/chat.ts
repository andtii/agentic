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

/**
 * The array parameters of `chat_post` a model can leak into `text` (#599), each with the shape its values must have to
 * be taken — the same as the input schema's for attachments, an agent id for a mention.
 */
const LEAKABLE = { mentions: z.array(z.string().regex(/^agent_[A-Za-z0-9_-]+$/)).min(1), attachments: z.array(chatFileUriInput).min(1) } as const;
type Leaked = Partial<Record<keyof typeof LEAKABLE, string[]>>;
const PARAMETER_OPEN = /<parameter name="([A-Za-z_]+)">/g;

/**
 * Parameters a model wrote INTO `text` as its own tool-call markup instead of as keys (#599): the text value ends
 * with its last `</text>`, then one or more `<parameter name="mentions">["agent_…"]` blocks (closed or not). Recovered only
 * when everything after that `</text>` is such blocks, each a known array parameter whose value is a JSON array of
 * well-formed values (agent ids, `agentic-file:` URIs) — anything else is the agent's own text and is left alone.
 */
export function recoverLeakedParameters(text: string): { text: string; leaked: Leaked } | undefined {
    const end = text.lastIndexOf('</text>');
    if (end < 0) return undefined;
    const tail = text.slice(end + '</text>'.length);
    const opens = [...tail.matchAll(PARAMETER_OPEN)];
    if (opens.length === 0 || tail.slice(0, opens[0]!.index).trim() !== '') return undefined;
    const leaked: Leaked = {};
    for (const [i, open] of opens.entries()) {
        const name = open[1] as keyof typeof LEAKABLE;
        if (!Object.hasOwn(LEAKABLE, name) || leaked[name]) return undefined;
        const raw = tail
            .slice(open.index + open[0].length, opens[i + 1]?.index ?? tail.length)
            .trim()
            .replace(/<\/parameter>$/, '')
            .trim();
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            return undefined;
        }
        const parsed = LEAKABLE[name].safeParse(value);
        if (!parsed.success) return undefined;
        leaked[name] = parsed.data;
    }
    const kept = text.slice(0, end).trimEnd();
    return kept === '' ? undefined : { text: kept, leaked };
}

export function chatPostTool(port: ChatPort) {
    return defineTool({
        name: 'chat_post',
        description: 'Post a message into the chat this task came from, in your name. Each agent id in `mentions` gets a task of its own and answers in the chat when its turn ends; the result lists who was started (`activated`) and who was not, and why (`notActivated`). It does not wait for the reply: use `delegate` when you need the answer back as a tool result. Attach files from the chat by their agentic-file: URIs.',
        input: chatPostInput,
        annotations: { idempotent: false },
        execute: (input, ctx) => {
            // A model that wrote its mentions into the text (#599) would otherwise post the markup and start nobody.
            const recovered = input.mentions === undefined && input.attachments === undefined ? recoverLeakedParameters(input.text) : undefined;
            const text = recovered?.text ?? input.text;
            const mentions = input.mentions ?? recovered?.leaked.mentions ?? [];
            const attachments = input.attachments ?? recovered?.leaked.attachments;
            return port.post({ text, mentions: mentions as AgentId[], ...(attachments?.length ? { attachments } : {}) }, { callId: ctx.toolCallId, signal: ctx.signal });
        }
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
