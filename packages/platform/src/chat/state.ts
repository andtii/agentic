/**
 * Chat state and its reducer (architecture §4 Chat, §6).
 *
 * The state is a WINDOW: the most recent entries plus a `{seq, at}` index
 * over every entry ever appended. Older entries live in `ChatPage` actors
 * (`page.ts`), one per `PAGE` entries, so a save never rewrites the whole
 * history. `applyChatEntry` is the reducer every entry folds through —
 * pure over `(state, entry)`, which is what lets it double as the
 * `applyEntry` hook of `ctx.append`.
 */

import type { AgentId, ChatEntry, ChatMember, Principal, SessionId } from '@agentic/core';

/** Entries kept in state before the oldest page is archived. */
export const WINDOW = 200;
/** Entries per archived page. `WINDOW` is a multiple of it. */
export const PAGE = 100;

export interface IndexRow {
    readonly seq: number;
    readonly at: number;
}

/** An entry with its position in the chat — the cursor unit of `history`. */
export interface IndexedEntry {
    readonly seq: number;
    readonly entry: ChatEntry;
}

export interface ChatState {
    readonly v: 1;
    /** Index the next entry gets; equals the count of entries ever appended. */
    seq: number;
    /** `seq` of `window[0]`; always a multiple of `PAGE`. */
    windowFrom: number;
    /** The most recent entries, oldest first; at most `WINDOW + PAGE` long. */
    window: ChatEntry[];
    /** `{seq, at}` for every entry ever appended (small: two numbers each). */
    index: IndexRow[];
    /** Agent members keyed by `AgentId`. */
    members: Record<string, ChatMember>;
    coordinator: AgentId | null;
    /** Sessions currently open for this chat, keyed by `AgentId`. */
    activeSessions: Record<string, SessionId>;
    /** The title the last `rename` entry set (#124); absent until one is. Records written before it existed have none. */
    title?: string;
}

export function initialChatState(): ChatState {
    return { v: 1, seq: 0, windowFrom: 0, window: [], index: [], members: {}, coordinator: null, activeSessions: {} };
}

/**
 * Fold one entry into the state in place. Membership, coordinator and
 * active-session bookkeeping are all derived here, so replaying the
 * entries always rebuilds the same state.
 */
export function applyChatEntry(state: ChatState, entry: ChatEntry): void {
    const seq = state.seq++;
    state.window.push(entry);
    state.index.push({ seq, at: entry.at });
    switch (entry.t) {
        case 'msg': {
            // The note `setWorkdir` writes (#190): the member's folder for this chat, or none.
            const member = entry.workdir ? state.members[entry.workdir.agentId] : undefined;
            if (entry.workdir && member) {
                const { workdir: _old, ...rest } = member;
                state.members[entry.workdir.agentId] = entry.workdir.ref ? { ...rest, workdir: entry.workdir.ref } : rest;
            }
            return;
        }
        case 'member':
            if (entry.op === 'add') {
                // `from-now` starts AT the join entry, so the member sees it joined.
                state.members[entry.agentId] = { since: entry.at, historyFrom: entry.historyAccess === 'all' ? 0 : seq };
            } else {
                delete state.members[entry.agentId];
                delete state.activeSessions[entry.agentId];
                if (state.coordinator === entry.agentId) state.coordinator = null;
            }
            return;
        case 'coordinator':
            state.coordinator = entry.agentId;
            return;
        case 'rename':
            state.title = entry.title;
            return;
        case 'status':
            if (entry.kind === 'session-started' && entry.ref) state.activeSessions[entry.agentId] = entry.ref as SessionId;
            else if (entry.kind === 'session-ended') delete state.activeSessions[entry.agentId];
            return;
        default:
            return;
    }
}

export function memberIds(state: ChatState): AgentId[] {
    return Object.keys(state.members) as AgentId[];
}

/**
 * The first entry index `principal` may read (CHT-04): everything for a user
 * or an external client, `historyFrom` for an agent member, and `null` — no
 * entry at all — for an agent that is not a member (fails closed, MEM-11).
 */
export function visibleFrom(state: ChatState, principal: Principal | null): number | null {
    if (!principal) return null;
    if (principal.kind !== 'agent') return 0;
    return state.members[principal.agentId]?.historyFrom ?? null;
}

/** Case-insensitive substring match over the text parts of a message entry. */
export function entryMatches(entry: ChatEntry, needle: string): boolean {
    if (entry.t !== 'msg') return false;
    for (const part of entry.parts) {
        if (part.type === 'text' && part.text.toLowerCase().includes(needle)) return true;
    }
    return false;
}
