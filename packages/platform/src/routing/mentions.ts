/**
 * An agent's `chat_post` @mention activates the mentioned member (#222,
 * CHT-06, COL-06), as a person's post does from the browser: one task per
 * addressed member, whose origin is the message, whose objective is its text
 * and whose context is the chat the member may read (`historyFrom`, CHT-04).
 * This module builds that contract; the tool port (`tools.ts`) decides who
 * may be activated and hands each task to the router.
 */

import { isChatFilePart, type AgentId, type ChatEntry, type ChatId, type ChatMember, type EnvironmentId, type MessageId, type PromptPart, type TaskContract } from '@agentic/core';

import type { IndexedEntry } from '../chat/state.js';

/** How many earlier messages a mention carries as context — the browser's `CONTEXT_WINDOW`. */
export const MENTION_CONTEXT_WINDOW = 50;

type MsgEntry = Extract<ChatEntry, { t: 'msg' }>;

/** One message as a context line: `Name: text`, a file part by its name. */
export function mentionLine(entry: MsgEntry, nameOf: (id: AgentId) => string): string {
    const who = entry.author.kind === 'user' ? 'User' : nameOf(entry.author.agentId);
    const text = entry.parts
        .map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `[file ${p.name}]` : p.type === 'image' ? '[image]' : ''))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    return `${who}: ${text}`;
}

/**
 * The task a mention creates for `member`: the message as objective, the
 * last `MENTION_CONTEXT_WINDOW` messages `member` may read as context (their
 * chat files as reference parts, each once), and the member's folder for
 * this chat as `environmentId` + `workdir` — else `environmentId` when the
 * caller names a fallback (the poster's environment, for an assignee with no
 * default of its own).
 */
export function mentionContract(input: {
    readonly assignee: AgentId;
    readonly chatId: ChatId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly posterName: string;
    readonly member: ChatMember;
    readonly entries: readonly IndexedEntry[];
    readonly nameOf: (id: AgentId) => string;
    readonly fallbackEnvironmentId?: EnvironmentId;
}): TaskContract {
    const { member } = input;
    const messages = input.entries
        .filter((e): e is IndexedEntry & { entry: MsgEntry } => e.entry.t === 'msg' && e.seq >= member.historyFrom && e.entry.id !== input.messageId)
        .slice(-MENTION_CONTEXT_WINDOW);
    const lines = messages.map((e) => mentionLine(e.entry, input.nameOf));
    const context: PromptPart[] = [{ type: 'text', text: `${input.posterName} mentioned you in the chat.${lines.length ? `\n\nChat so far:\n${lines.join('\n')}` : ''}` }];
    const seen = new Set<string>();
    for (const part of messages.flatMap((e) => e.entry.parts)) {
        if (!isChatFilePart(part) || seen.has(part.url)) continue;
        seen.add(part.url);
        context.push(part);
    }
    const where = member.workdir
        ? { environmentId: member.workdir.environmentId, workdir: member.workdir.path }
        : input.fallbackEnvironmentId !== undefined
          ? { environmentId: input.fallbackEnvironmentId }
          : {};
    return {
        objective: input.text,
        origin: { kind: 'user', chatId: input.chatId, messageId: input.messageId },
        assignee: input.assignee,
        context,
        constraints: {},
        ...where
    };
}
