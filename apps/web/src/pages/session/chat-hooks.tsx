/**
 * The chat hooks a session's Changes and Files views plug into (#565), in both
 * data modes:
 * - `ask`: a question about a line posts to the chat the session belongs to,
 *   addressed to the session's agent only, with the hunk attached as a
 *   `resource` part (live: `runActivation`, as the chat's own composer does);
 * - `mention`: opens that chat with `@file:<path>` in its composer;
 * - `fileActions`: "Edited by <agent> <Tool>" in a file's header — the last
 *   call that wrote it, as the runtime's extractor reads the calls.
 * Which calls write files is `filesTouched`'s (`@agentic/runtimes`), per
 * runtime; nothing here knows a tool name.
 */
import type { JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import type { AgentId, ChatId, PromptPart } from '@agentic/core';
import type { ChatSummary, HistoryPage } from '@agentic/platform';
import type { ToolCallLike } from '@agentic/runtimes';
import { AgentTile, type AgentHue } from '@agentic/ui';
import { postToMockChat } from '../../mock/chat-posts';
import { chatSessionOf, loadChat, type MockSessionView } from '../../mock/workspace';
import { CONTEXT_WINDOW, runActivation, type ActivationPorts, type AgentIdentity, type AgentLookup } from '../chat/live';
import { relativeToRoot, transcriptHref, type LineQuestion, type SessionFiles } from './files';
import { lastTouches, mentionHref, questionParts } from './references';

/** What `askInChat` needs from the actors: the chat's summary and recent entries, and the activation's own ports. */
export type AskPorts = ActivationPorts & {
    get(): Promise<ChatSummary>;
    history(cursor: number | null, limit: number): Promise<HistoryPage>;
};

/**
 * Post `question` to chat `chatId` for agent `agentId` and activate that agent alone: its text, then the code
 * reference. An agent that is no longer a member cannot be asked there — refused, never re-addressed to the
 * chat's coordinator.
 */
export async function askInChat(ports: AskPorts, input: { chatId: string; sessionId: string; agentId: string; question: LineQuestion; lookup: AgentLookup; hosted?: (machineId: string, environmentId: string) => boolean }): Promise<void> {
    const summary = await ports.get();
    const name = input.lookup(input.agentId).name;
    if (!summary.members[input.agentId]) throw new Error(`${name} is no longer in this chat — add them back to ask about this line.`);
    const page = await ports.history(null, CONTEXT_WINDOW);
    const [text, reference] = questionParts(input.sessionId, input.question) as [Extract<PromptPart, { type: 'text' }>, PromptPart];
    await runActivation(
        ports,
        { chatId: input.chatId as ChatId, text: text.text, attachments: [reference], mentions: [input.agentId as AgentId], summary, entries: page.entries, lookup: input.lookup, ...(input.hosted ? { hosted: input.hosted } : {}) }
    );
}

/** "Edited by <tile> Edit" (and the time, when known) — linking to where the call can be read. */
export const EditedBy = (props: { agent: { name: string; hue?: AgentHue }; tool: string; href: string; time?: string }): JSXElement => (
    <span data-file-edited>
        <span data-file-edited-label>Edited by</span>
        <AgentTile name={props.agent.name} {...(props.agent.hue ? { hue: props.agent.hue } : {})} size={18} />
        <Link to={props.href}>{props.time ? `${props.tool} at ${props.time}` : props.tool}</Link>
    </span>
);

/**
 * The `fileActions` hook over the calls a session made: for a file (relative to `root`) the last call that wrote
 * it. `calls` in order; each call's path is as the call gave it (absolute), so it is matched relative to `root`.
 */
export function editedByActions<C extends ToolCallLike>(input: { root: string; runtime: string | undefined; calls: readonly C[]; agent: { name: string; hue?: AgentHue }; href: (call: C) => string; time?: (call: C) => string | undefined }): ((path: string) => JSXElement | null) | undefined {
    const touches = lastTouches(input.runtime, input.calls);
    if (!touches.size) return undefined;
    const byPath = new Map<string, C>();
    for (const [path, call] of touches) {
        const rel = relativeToRoot(input.root, path);
        if (rel) byPath.set(rel, call);
    }
    if (!byPath.size) return undefined;
    return (path) => {
        const call = byPath.get(path);
        if (!call) return null;
        const time = input.time?.(call);
        return <EditedBy agent={input.agent} tool={call.name} href={input.href(call)} {...(time ? { time } : {})} />;
    };
}

/** The mock workspace's hooks: questions post into the mock chat, mentions open it, edits come from its tool calls. */
export function mockChatHooks(v: MockSessionView, agent: Pick<AgentIdentity, 'name' | 'hue' | 'environment'>, navigate?: (href: string) => void): Pick<SessionFiles, 'ask' | 'mention' | 'fileActions'> {
    const chatId = v.chatId;
    if (!chatId) return {};
    const chat = loadChat(chatId);
    // The agent's calls in the chat are this session's when it is the one the agent runs there.
    const mine = chatSessionOf(chatId, v.agentId)?.id === v.id;
    const messages = mine ? (chat?.transcript.messages.filter((m) => m.role === 'assistant' && m.actor === v.agentId) ?? []) : [];
    const calls = messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool' ? [{ name: p.name, input: p.input, messageId: m.id }] : [])));
    const fileActions = editedByActions({
        root: v.cwd,
        runtime: agent.environment.runtime,
        calls,
        agent: { name: agent.name, hue: agent.hue },
        href: () => `/chats/${chatId}`,
        time: (c) => chat?.authors[c.messageId]?.time?.text
    });
    return {
        ask: async (q) => { postToMockChat(chatId, questionParts(v.id, q)); },
        ...(navigate ? { mention: (path: string) => navigate(mentionHref(chatId, v.id, path)) } : {}),
        ...(fileActions ? { fileActions } : {})
    };
}

/** A live session's `fileActions` from its log's `tool-call` events: the Transcript page is where a call is read. */
export function liveEditedBy(input: { id: string; root: string; runtime: string | undefined; events: readonly { readonly type: string }[]; agent: { name: string; hue?: AgentHue } }): ((path: string) => JSXElement | null) | undefined {
    const calls = input.events.flatMap((e) => (e.type === 'tool-call' ? [e as unknown as ToolCallLike & { readonly callId: string }] : []));
    return editedByActions({ root: input.root, runtime: input.runtime, calls, agent: input.agent, href: () => transcriptHref(input.id) });
}
