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

import { isChatFilePart, parseChatFileUri, type AgentId, type ChatEntry, type ChatFile, type ChatMember, type MessageId, type Principal, type ProjectId, type SessionId } from '@agentic/core';

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

/**
 * A file posted into the chat (#203): the message it was last posted in —
 * `seq` is what visibility is decided on (CHT-04) — and what the file is.
 * A re-share moves `entryId`/`seq` to the newer message: history access is
 * "from a seq on", so the newest posting is the most widely visible one.
 */
export interface ChatFileRow {
    readonly entryId: MessageId;
    readonly seq: number;
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: number;
    /** When it was uploaded. */
    readonly at: number;
}

/** An upload not yet posted (`Chat.registerUpload`): only its uploader may post or read it. */
export interface PendingUpload {
    readonly file: ChatFile;
    /** `principalKey` of the uploader. */
    readonly by: string;
    /** When it was registered — the pending entry is forgotten `PENDING_TTL_MS` later. */
    readonly at: number;
}

/**
 * The execution session bound to one agent member of this chat (#392, CHT-11):
 * one live session per (chat, agent), so the router finds it instead of
 * minting a new one. Created by a `session-started` status entry carrying a
 * `ref`, replaced by a later one, dropped by `session-ended` or by the
 * member's removal.
 */
export interface ChatSessionRow {
    readonly sessionId: SessionId;
    /** `at` of the `session-started` entry that created the row. */
    readonly since: number;
    /**
     * The watermark: `seq` of the last `msg` this member authored, so every
     * entry after it is what its engine has not seen. `0` until it has
     * answered once in this session — the router then sends from the
     * member's `historyFrom`. Only the member's own messages move it.
     */
    readonly seenSeq: number;
}

/** Most uploads one principal may hold pending in one chat. */
export const MAX_PENDING_UPLOADS = 50;
/** A pending upload older than this is forgotten; the store's orphan sweep (`sweepOrphans`) must use at least this age. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

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
    /** The session bound to each agent member, keyed by `AgentId` (#392): absent while the member has none. */
    sessions: Record<string, ChatSessionRow>;
    /** The title the last `rename` entry set (#124); absent until one is. Records written before it existed have none. */
    title?: string;
    /** The project the last `project` note put the chat in (#332, `Chat.setProject`); absent until one does, or after one clears it. */
    projectId?: ProjectId;
    /**
     * Every file ever posted, keyed by file id (#203). Kept in the actor's own state, never in the
     * window, so it outlives archiving. Absent until the first file is posted.
     */
    files?: Record<string, ChatFileRow>;
    /** Uploads registered but not posted yet, keyed by file id. Absent until the first upload. */
    pending?: Record<string, PendingUpload>;
}

export function initialChatState(): ChatState {
    return { v: 1, seq: 0, windowFrom: 0, window: [], index: [], members: {}, coordinator: null, sessions: {} };
}

/**
 * Fold one entry into the state in place. Membership, coordinator and
 * session bookkeeping — the binding and its watermark — are all derived
 * here, so replaying the entries always rebuilds the same state.
 */
export function applyChatEntry(state: ChatState, entry: ChatEntry): void {
    const seq = state.seq++;
    state.window.push(entry);
    state.index.push({ seq, at: entry.at });
    switch (entry.t) {
        case 'msg': {
            indexFiles(state, entry, seq);
            // The member's own final answer (#392): everything after it is what its engine has not seen.
            // Only the BOUND session's message moves it — a late answer from a replaced session is not what the new one saw.
            if (entry.author.kind === 'agent') {
                const row = state.sessions[entry.author.agentId];
                if (row && entry.author.sessionId === row.sessionId) state.sessions[entry.author.agentId] = { ...row, seenSeq: seq };
            }
            // The note `setWorkdir` writes (#190): the member's folder for this chat, or none.
            const member = entry.workdir ? state.members[entry.workdir.agentId] : undefined;
            if (entry.workdir && member) {
                const { workdir: _old, ...rest } = member;
                state.members[entry.workdir.agentId] = entry.workdir.ref ? { ...rest, workdir: entry.workdir.ref } : rest;
            }
            // The note `setProject` writes (#332): the chat's project from here on, or none.
            if (entry.project) {
                if (entry.project.id === null) delete state.projectId;
                else state.projectId = entry.project.id;
            }
            return;
        }
        case 'member':
            if (entry.op === 'add') {
                // `from-now` starts AT the join entry, so the member sees it joined.
                state.members[entry.agentId] = { since: entry.at, historyFrom: entry.historyAccess === 'all' ? 0 : seq };
            } else {
                delete state.members[entry.agentId];
                delete state.sessions[entry.agentId];
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
            // The binding (#392): a start with a ref creates or replaces the member's row, an end drops it.
            if (entry.kind === 'session-started' && entry.ref) state.sessions[entry.agentId] = { sessionId: entry.ref as SessionId, since: entry.at, seenSeq: 0 };
            else if (entry.kind === 'session-ended') delete state.sessions[entry.agentId];
            return;
        default:
            return;
    }
}

/**
 * Index the chat-file parts of a message (#203): a pending upload moves to
 * `files`, a file already indexed (a re-share) moves to this newer message.
 * Anything else is ignored — `Chat.post` validated the parts, and the fold
 * never makes readable a file this state does not know. Pure over the
 * state and the entry, so a replay rebuilds the same index.
 */
function indexFiles(state: ChatState, entry: Extract<ChatEntry, { t: 'msg' }>, seq: number): void {
    for (const part of entry.parts) {
        if (!isChatFilePart(part)) continue;
        const ref = parseChatFileUri(part.url)!;
        const pending = state.pending?.[ref.fileId];
        const known = state.files?.[ref.fileId];
        if (pending && pending.file.chatId === ref.chatId) {
            const { file } = pending;
            (state.files ??= {})[ref.fileId] = { entryId: entry.id, seq, name: file.name, mediaType: file.mediaType, bytes: file.bytes, at: file.at };
            delete state.pending![ref.fileId];
        } else if (known) {
            state.files![ref.fileId] = { ...known, entryId: entry.id, seq };
        }
    }
}

/** A principal as a stable string — who a pending upload belongs to. */
export function principalKey(principal: Principal): string {
    switch (principal.kind) {
        case 'user':
            return `user:${principal.userId}`;
        case 'external':
            return `external:${principal.clientId}`;
        case 'agent':
            return `agent:${principal.agentId}`;
        case 'machine':
            return `machine:${principal.machineId}`;
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
