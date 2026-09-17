/**
 * The Chat actor (architecture §4 Chat, §6; CHT-01..08, CHT-11, MEM-11):
 * attributed entries, membership with history access, addressing and the
 * activation rule. It decides WHO a message activates and never runs
 * anything — starting tasks and sessions is the integration's job.
 *
 * Every mutation ends in one durable write inside the turn (`appendEntry`),
 * so a Workers eviction loses nothing. Reads interleave with writes
 * (`methodReentrancy`) and copy what they need before their first `await`.
 */

import { defineActor, topic, type ActorContext, type Topic, type TopicEvent } from '@sigx/actors';
import {
    SESSION_EVENTS_TOPIC,
    createId,
    hasScope,
    resolveActivation,
    type AgentId,
    type Author,
    type ChatEntry,
    type ChatMember,
    type HistoryAccess,
    type MessageId,
    type PostResult,
    type Principal,
    type PromptPart,
    type SessionEvent,
    type SessionId,
    type TaskId
} from '@agentic/core';
import { sameWorkspace } from '../auth/index.js';
import { ChatPage, pageKey } from './page.js';
import { appendEntry } from './persist.js';
import { PAGE, WINDOW, applyChatEntry, entryMatches, initialChatState, memberIds, visibleFrom, type ChatState, type IndexedEntry } from './state.js';

/** The topic a Session publishes on for its chat; the Chat actor subscribes under its own key. */
export const sessionEvents = (chatKey: string): Topic<SessionEvent> => topic<SessionEvent>(SESSION_EVENTS_TOPIC, chatKey);

/** Who a post addresses: specific agents, or `'all'` — the group (CHT-03). */
export type Mentions = readonly AgentId[] | 'all';

export interface PostOptions {
    readonly replyTo?: MessageId;
    readonly taskId?: TaskId;
}

export interface HistoryPage {
    /** Oldest first. */
    readonly entries: readonly IndexedEntry[];
    /** Cursor for the page before this one; `null` when nothing older is visible to the caller. */
    readonly next: number | null;
}

export interface ChatSummary {
    readonly seq: number;
    readonly members: Readonly<Record<string, ChatMember>>;
    readonly coordinator: AgentId | null;
    readonly activeSessions: Readonly<Record<string, SessionId>>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const clampLimit = (limit: number): number => Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit) || DEFAULT_LIMIT));

const principalOf = (ctx: ActorContext<ChatState>): Principal | null => (ctx.principal as Principal | null | undefined) ?? null;

/** Users and external clients post as the workspace user; an agent posts as itself. */
const authorOf = (principal: Principal): Author =>
    principal.kind === 'agent' ? { kind: 'agent', agentId: principal.agentId, sessionId: principal.sessionId } : { kind: 'user' };

const toParts = (input: string | readonly PromptPart[]): readonly PromptPart[] => (typeof input === 'string' ? [{ type: 'text', text: input }] : input);

/** Membership and coordination are the user's call (CHT-04, CHT-07). */
const userOrExternal = (principal: Principal | null): boolean => principal?.kind === 'user' || principal?.kind === 'external';
/** An external client needs the `chats` tool family (§9); every other principal kind passes. */
const chatsScope = (principal: Principal | null): boolean => principal !== null && hasScope(principal, 'chats');
/** Machines never speak in a chat. */
const notMachine = (principal: Principal | null): boolean => principal !== null && principal.kind !== 'machine';

/**
 * Archive full pages while the window has overflowed. A separate step from
 * appending — it talks to another actor — so the reducer stays pure. The
 * page store is idempotent, so a crash between the store and the save
 * simply repeats it next time.
 */
async function archive(ctx: ActorContext<ChatState>): Promise<void> {
    while (ctx.state.window.length >= WINDOW + PAGE) {
        const from = ctx.state.windowFrom;
        const entries = ctx.snapshot(ctx.state.window.slice(0, PAGE));
        await ctx.actor(ChatPage, pageKey(ctx.key, from / PAGE)).store(from, entries);
        ctx.state.window.splice(0, PAGE);
        ctx.state.windowFrom = from + PAGE;
        await ctx.save();
    }
}

/** Entries `[start, end)` oldest first — the window part copied synchronously, older ones read from pages. */
async function readRange(ctx: ActorContext<ChatState>, start: number, end: number): Promise<IndexedEntry[]> {
    if (start >= end) return [];
    const { windowFrom } = ctx.state;
    const inWindow = Math.max(start, windowFrom);
    // `windowFrom` only grows, so a later archive cannot move a seq below it out of the pages.
    const windowPart = ctx.snapshot(ctx.state.window.slice(inWindow - windowFrom, Math.max(inWindow, end) - windowFrom));
    const out: IndexedEntry[] = [];
    const pageEnd = Math.min(end, windowFrom);
    for (let page = Math.floor(start / PAGE); page * PAGE < pageEnd; page++) {
        const base = page * PAGE;
        const entries = await ctx.actor(ChatPage, pageKey(ctx.key, page)).read();
        for (let i = Math.max(start, base) - base; i < Math.min(pageEnd, base + PAGE) - base; i++) {
            out.push({ seq: base + i, entry: entries[i]! });
        }
    }
    windowPart.forEach((entry, i) => out.push({ seq: inWindow + i, entry }));
    return out;
}

/**
 * Forward-compatible with `ctx.append` (signalxjs/actors#312): the reducer
 * rides along untyped until the pinned release declares `applyEntry`; see
 * `persist.ts` for the fallback that folds and saves today.
 */
const reducer: object = { applyEntry: applyChatEntry };

export const Chat = defineActor({
    ...reducer,
    type: 'Chat',
    authorize: [sameWorkspace, chatsScope],
    methodAuthorize: {
        post: [notMachine],
        addAgent: [userOrExternal],
        removeAgent: [userOrExternal],
        setCoordinator: [userOrExternal]
    },
    methodReentrancy: { get: 'always', history: 'always', search: 'always' },
    state: initialChatState,
    methods: (ctx: ActorContext<ChatState>) => ({
        /**
         * Store a message and say who it activates (CHT-06): the mentioned
         * members, else the coordinator, else the sole agent member, else
         * nobody. `'all'` addresses every agent member. An agent's own post
         * never activates itself.
         */
        async post(input: string | readonly PromptPart[], mentions: Mentions = [], options: PostOptions = {}): Promise<PostResult> {
            const principal = principalOf(ctx);
            if (!principal) throw new Error('Chat.post: no principal');
            const author = authorOf(principal);
            const members = memberIds(ctx.state);
            const addressed = mentions === 'all' ? members : mentions;
            const activated = resolveActivation(addressed, members, ctx.state.coordinator).filter((id) => author.kind !== 'agent' || id !== author.agentId);
            const messageId = createId('msg') as MessageId;
            const taskId = options.taskId ?? (principal.kind === 'agent' ? principal.taskId : undefined);
            const entry: ChatEntry = {
                t: 'msg',
                id: messageId,
                author,
                parts: toParts(input),
                at: Date.now(),
                mentions: [...addressed],
                ...(options.replyTo ? { replyTo: options.replyTo } : {}),
                ...(author.kind === 'agent' ? { sessionId: author.sessionId } : {}),
                ...(taskId ? { taskId } : {})
            };
            await archive(ctx);
            await appendEntry(ctx, entry);
            return { messageId, activated };
        },

        /** Add an agent; `'all'` opens the whole history, `'from-now'` starts at the join (CHT-04). Idempotent. */
        async addAgent(agentId: AgentId, access: HistoryAccess = 'from-now'): Promise<ChatMember> {
            const existing = ctx.state.members[agentId];
            if (existing) return ctx.snapshot(existing);
            await archive(ctx);
            await appendEntry(ctx, { t: 'member', op: 'add', agentId, historyAccess: access, at: Date.now() });
            return ctx.snapshot(ctx.state.members[agentId]!);
        },

        /** Remove an agent; also drops its active session and, if it was the coordinator, the coordinator. */
        async removeAgent(agentId: AgentId): Promise<boolean> {
            const member = ctx.state.members[agentId];
            if (!member) return false;
            await archive(ctx);
            await appendEntry(ctx, { t: 'member', op: 'remove', agentId, historyAccess: member.historyFrom === 0 ? 'all' : 'from-now', at: Date.now() });
            return true;
        },

        /** Name the coordinator (CHT-07) — a member, or `null` for none. */
        async setCoordinator(agentId: AgentId | null): Promise<void> {
            if (agentId !== null && !ctx.state.members[agentId]) throw new Error(`Chat.setCoordinator: ${agentId} is not a member`);
            if (ctx.state.coordinator === agentId) return;
            await archive(ctx);
            await appendEntry(ctx, { t: 'coordinator', agentId, at: Date.now() });
        },

        async get(): Promise<ChatSummary> {
            const { seq, members, coordinator, activeSessions } = ctx.state;
            return ctx.snapshot({ seq, members, coordinator, activeSessions });
        },

        /**
         * Page backwards through the entries the caller may read (CHT-04,
         * CHT-10): `cursor` is exclusive, `null` starts at the newest.
         */
        async history(cursor: number | null = null, limit: number = DEFAULT_LIMIT): Promise<HistoryPage> {
            const from = visibleFrom(ctx.state, principalOf(ctx));
            if (from === null) return { entries: [], next: null };
            const end = cursor === null ? ctx.state.seq : Math.min(Math.max(0, Math.floor(cursor)), ctx.state.seq);
            const start = Math.max(from, end - clampLimit(limit));
            const entries = await readRange(ctx, start, end);
            return { entries, next: start > from ? start : null };
        },

        /** Newest-first substring scan over the message text the caller may read. */
        async search(q: string, limit: number = 20): Promise<IndexedEntry[]> {
            const needle = q.trim().toLowerCase();
            const from = visibleFrom(ctx.state, principalOf(ctx));
            if (!needle || from === null) return [];
            const max = clampLimit(limit);
            const hits: IndexedEntry[] = [];
            const { windowFrom } = ctx.state;
            const window = ctx.snapshot(ctx.state.window);
            for (let i = window.length - 1; i >= 0 && hits.length < max; i--) {
                const seq = windowFrom + i;
                if (seq < from) return hits;
                if (entryMatches(window[i]!, needle)) hits.push({ seq, entry: window[i]! });
            }
            for (let page = windowFrom / PAGE - 1; page >= 0 && hits.length < max; page--) {
                const base = page * PAGE;
                if (base + PAGE <= from) break;
                const entries = await ctx.actor(ChatPage, pageKey(ctx.key, page)).read();
                for (let i = entries.length - 1; i >= 0 && hits.length < max; i--) {
                    const seq = base + i;
                    if (seq < from) break;
                    if (entryMatches(entries[i]!, needle)) hits.push({ seq, entry: entries[i]! });
                }
            }
            return hits;
        }
    }),
    subscriptions: {
        /**
         * What a Session tells its chat (CHT-11): status and FINAL messages,
         * never deltas. `typing` is ephemeral — the UI tails the Session —
         * so it is not made durable here.
         */
        [SESSION_EVENTS_TOPIC]: async (ctx: ActorContext<ChatState>, event: TopicEvent) => {
            const e = event.payload as SessionEvent | null;
            if (!e || typeof e !== 'object' || !('kind' in e)) throw new Error(`Chat: malformed session event on ${ctx.key}`);
            if (e.kind === 'status') {
                if (e.status === 'typing') return;
                await archive(ctx);
                await appendEntry(ctx, { t: 'status', agentId: e.agentId, kind: e.status, ref: e.ref ?? e.sessionId, at: e.at });
            } else if (e.kind === 'message') {
                await archive(ctx);
                await appendEntry(ctx, {
                    t: 'msg',
                    id: createId('msg') as MessageId,
                    author: { kind: 'agent', agentId: e.agentId, sessionId: e.sessionId },
                    parts: e.parts,
                    at: e.at,
                    mentions: e.mentions ?? [],
                    sessionId: e.sessionId,
                    ...(e.taskId ? { taskId: e.taskId } : {})
                });
            }
        }
    }
});
