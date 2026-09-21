/**
 * How a chat titles itself (#460). Three sources, in order of trust:
 *
 * - `heuristic`: the first line of the first user message, the moment it is
 *   posted — free, and every runtime gets it;
 * - `model`: the platform's own short model call over the first messages, for
 *   runtimes that do not title their conversations (`ChatTitler`, a port);
 * - `runtime`: what the session's runtime calls the conversation (Claude Code's
 *   auto-title, Copilot's `session.title_changed`), reported through the
 *   daemon and the Session as a `title` session event.
 *
 * A later source replaces an earlier one; a runtime title is replaced only by
 * the same session's next one, so two members' runtimes never fight over the
 * name. A title a person set (`rename`, `createChat({ title })`) is final.
 */

import type { AutoTitle, ChatEntry, PromptPart, SessionId, WorkspaceId } from '@agentic/core';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, chatTitleModel, generateChatTitle, type ChatTitleInput, type ChatTitleMessage, type PlatformAgentDeps } from '@agentic/runtimes';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import { registryKey } from '../registry/key.js';
import type { ChatState } from './state.js';

/** A heuristic title is at most this long: one line of the list. */
export const HEURISTIC_TITLE_LENGTH = 60;

/** After which agent messages the platform asks its model for a title: the first reply, and once more when the chat has become something. */
export const TITLE_AT_AGENT_MESSAGES: readonly number[] = [1, 8];

/** How many of the first messages the model sees. */
export const TITLE_INPUT_MESSAGES = 8;

const RANK: Readonly<Record<AutoTitle['source'], number>> = { heuristic: 0, model: 1, runtime: 2 };

/** A note `setWorkdir` / `setProject` / `setMachine` wrote (#190, #332, #414): bookkeeping in the thread, not something said. */
const isNote = (entry: Extract<ChatEntry, { t: 'msg' }>): boolean => entry.workdir !== undefined || entry.project !== undefined || entry.machine !== undefined;

const textOf = (parts: readonly PromptPart[]): string =>
    parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .filter(Boolean)
        .join(' ');

/** The first non-empty line of what was said, at most `HEURISTIC_TITLE_LENGTH` characters; `undefined` when nothing was. */
export function heuristicTitle(parts: readonly PromptPart[]): string | undefined {
    const line = textOf(parts)
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .find(Boolean);
    if (!line) return undefined;
    return line.length > HEURISTIC_TITLE_LENGTH ? `${line.slice(0, HEURISTIC_TITLE_LENGTH - 1).trimEnd()}…` : line;
}

/**
 * Whether a generated title from `source` may replace the title in force: always when there is none; never when a
 * person set it; a better-ranked source replaces a lesser one; a runtime title replaces an earlier one only from
 * the same session (`sessionId`).
 */
export function acceptsAutoTitle(state: Pick<ChatState, 'title' | 'titleAuto'>, source: AutoTitle['source'], sessionId?: SessionId): boolean {
    if (state.title === undefined) return true;
    const current = state.titleAuto;
    if (!current) return false;
    if (current.source === 'runtime') return source === 'runtime' && current.sessionId !== undefined && current.sessionId === sessionId;
    return RANK[source] >= RANK[current.source];
}

/** The user's and agents' messages in the window, notes left out. */
function spoken(state: Pick<ChatState, 'window'>): Extract<ChatEntry, { t: 'msg' }>[] {
    const out: Extract<ChatEntry, { t: 'msg' }>[] = [];
    for (const entry of state.window) if (entry.t === 'msg' && !isNote(entry)) out.push(entry);
    return out;
}

/** How many agent messages the window holds — the count `TITLE_AT_AGENT_MESSAGES` is checked against. */
export function agentMessageCount(state: Pick<ChatState, 'window'>): number {
    return spoken(state).filter((m) => m.author.kind === 'agent').length;
}

/** The first messages as the model sees them (`ChatTitleInput`), named by `agentName` when it knows the member. */
export function titleInputOf(state: Pick<ChatState, 'window'>, agentName: (agentId: string) => string | undefined = () => undefined): ChatTitleInput {
    const messages: ChatTitleMessage[] = [];
    for (const m of spoken(state).slice(0, TITLE_INPUT_MESSAGES)) {
        const text = textOf(m.parts).trim();
        if (!text) continue;
        if (m.author.kind === 'user') messages.push({ role: 'user', text });
        else {
            const name = agentName(m.author.agentId);
            messages.push({ role: 'agent', ...(name ? { name } : {}), text });
        }
    }
    return { messages };
}

/**
 * The port the Chat actor titles through (`ChatOptions.titles`): a title for the messages, or `undefined` when the
 * workspace cannot have one right now — no key, plugin off — which leaves the heuristic title standing. Throws
 * only for a failed call; the actor logs and moves on.
 */
export type ChatTitler = (workspaceId: WorkspaceId, input: ChatTitleInput, signal?: AbortSignal) => Promise<string | undefined>;

export interface ChatTitlerOptions {
    /** The Registry definition, as a thunk like the other actor ports. */
    readonly registry: () => AnyActorDefinition;
    /** The model to title on; default the workspace's `anthropic-api` key on `TITLE_MODEL`. Tests pass a `mockModel`. */
    readonly model?: PlatformAgentDeps['model'];
}

interface RegistrySecrets {
    openSecret(name: string, pluginId: string): Promise<string>;
}

/** A Registry refusal that means "no title right now", not "something broke": no secret, no plugin, plugin off. */
const noKey = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : '';
    return /\[registry\] (no secret "|plugin ".*" is (not installed|disabled))/.test(message);
};

/**
 * The default titler: the workspace's own Anthropic key from the Registry (`openSecret`, as the workspace owner
 * — the Registry audits the open like a session's), then `generateChatTitle` on `TITLE_MODEL`. The same key the
 * `anthropic-api` runtime runs on (architecture §5a): a workspace without one titles heuristically.
 */
export function createChatTitler(options: ChatTitlerOptions): ChatTitler {
    return async (workspaceId, input, signal) => {
        let model = options.model;
        if (!model) {
            const registry = actor(options.registry(), registryKey(workspaceId)).with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)) }) as unknown as RegistrySecrets;
            let apiKey: string;
            try {
                apiKey = await registry.openSecret(ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID);
            } catch (e) {
                if (noKey(e)) return undefined;
                throw e;
            }
            model = chatTitleModel(apiKey);
        }
        return generateChatTitle(model, input, signal);
    };
}
