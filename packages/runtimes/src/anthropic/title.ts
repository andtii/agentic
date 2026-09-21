/**
 * `generateChatTitle` — a short title for a chat from its first messages (#460),
 * one model call with no tools, for the runtimes that do not title their own
 * conversations (the platform-hosted `anthropic-api` runtime runs the loop
 * itself, so nothing else names the chat). Claude Code and Copilot title theirs;
 * the daemon reports those instead, and the platform never calls this for them
 * while such a title stands.
 */

import { generateText, type LanguageModel } from '@sigx/ai';
import { anthropic } from '@sigx/ai-anthropic';

/** The model a title costs: the cheapest current one — a title is a few words from a few hundred tokens. */
export const TITLE_MODEL = 'claude-haiku-4-5';

/** A generated title is at most this long; the model is asked for far less. */
export const TITLE_MAX_LENGTH = 60;

/** How much of each message the prompt carries. */
export const TITLE_MESSAGE_CHARS = 600;

export interface ChatTitleMessage {
    readonly role: 'user' | 'agent';
    /** The agent's name, for a group chat. */
    readonly name?: string;
    readonly text: string;
}

export interface ChatTitleInput {
    /** The chat's first messages, oldest first. */
    readonly messages: readonly ChatTitleMessage[];
}

export const TITLE_SYSTEM_PROMPT =
    'You title conversations for a list of chats. Reply with the title only: two to six words, sentence case, no quotes, no trailing period, no preamble. Name what the conversation is about — the task, the subject, the decision — not who is talking or that it is a chat.';

const cut = (text: string): string => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > TITLE_MESSAGE_CHARS ? `${one.slice(0, TITLE_MESSAGE_CHARS - 1).trimEnd()}…` : one;
};

/** The prompt: the messages as a labelled transcript. */
export function titlePrompt(input: ChatTitleInput): string {
    const lines = input.messages.filter((m) => m.text.trim()).map((m) => `${m.role === 'user' ? 'User' : (m.name ?? 'Agent')}: ${cut(m.text)}`);
    return `Title this conversation.\n\n${lines.join('\n')}`;
}

/**
 * What the model said, as a title: the first non-empty line, quotes and a trailing period stripped, whitespace
 * collapsed, cut to `TITLE_MAX_LENGTH`; `undefined` when nothing usable is left.
 */
export function cleanTitle(text: string): string | undefined {
    const line = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !/^title:?$/i.test(l));
    if (!line) return undefined;
    let title = line
        .replace(/^title:\s*/i, '')
        .replace(/^["'“”‘’`*_]+|["'“”‘’`*_.。]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (title.length > TITLE_MAX_LENGTH) title = `${title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
    return title || undefined;
}

/** The `LanguageModel` a title is generated on, with the workspace's own key. */
export function chatTitleModel(apiKey: string): LanguageModel {
    return anthropic({ apiKey }).model(TITLE_MODEL);
}

/**
 * One call, no tools, a few output tokens; `undefined` when there is nothing to title or the model gave nothing
 * usable. A provider error propagates — the caller decides whether a title is worth a retry (the platform's
 * Chat actor logs it and leaves the heuristic title standing).
 */
export async function generateChatTitle(model: LanguageModel, input: ChatTitleInput, signal?: AbortSignal): Promise<string | undefined> {
    if (!input.messages.some((m) => m.text.trim())) return undefined;
    const result = await generateText({
        model,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: titlePrompt(input) }],
        maxTokens: 40,
        temperature: 0.2,
        ...(signal ? { signal } : {})
    });
    return cleanTitle(result.text);
}
