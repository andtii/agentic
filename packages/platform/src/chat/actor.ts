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

import { defineActor, topic, type ActorContext, type AnyActorDefinition, type Topic, type TopicEvent } from '@sigx/actors';
import {
    CHAT_FILE_MAX_BYTES,
    CHAT_FILE_SCHEME,
    SESSION_EVENTS_TOPIC,
    chatFileUri,
    createId,
    hasScope,
    isChatFilePart,
    isRequestStatusRef,
    parseChatFileUri,
    resolveActivation,
    workspaceOfKey,
    type AgentId,
    type Author,
    type AutoTitle,
    type ChatEntry,
    type ChatFile,
    type ChatFileStore,
    type ChatId,
    type ChatMember,
    type HistoryAccess,
    type MachineId,
    type MessageId,
    type PostResult,
    type Principal,
    type ProjectId,
    type PromptPart,
    type SessionEvent,
    type SessionId,
    type SessionOptionsPatch,
    type TaskId,
    type WorkdirRef,
    type WorkspaceId
} from '@agentic/core';
import { ServerFnError } from '@sigx/server';
import { recordAudit } from '../audit/port.js';
import { sameWorkspace, workspaceKey } from '../auth/index.js';
import { routingKey } from '../routing/key.js';
import { Workspace } from '../workspace/index.js';
import { ChatPage, pageKey } from './page.js';
import { appendEntry } from './persist.js';
import { MAX_PENDING_UPLOADS, PAGE, PENDING_TTL_MS, WINDOW, applyChatEntry, entryMatches, initialChatState, memberIds, principalKey, visibleFrom, type ChatFileRow, type ChatSessionRow, type ChatState, type IndexedEntry } from './state.js';
import { TITLE_AT_AGENT_MESSAGES, acceptsAutoTitle, agentMessageCount, heuristicTitle, titleInputOf, type ChatTitler } from './titles.js';

/** The topic a Session publishes on for its chat; the Chat actor subscribes under its own key. */
export const sessionEvents = (chatKey: string): Topic<SessionEvent> => topic<SessionEvent>(SESSION_EVENTS_TOPIC, chatKey);

const STATUS_KINDS: ReadonlySet<string> = new Set<Extract<SessionEvent, { kind: 'status' }>['status']>([
    'typing',
    'session-started',
    'session-ended',
    'task',
    'task-failed',
    'request',
    'request-resolved'
]);

/**
 * Check a published payload is a `SessionEvent` before anything is folded:
 * a bad or unknown event throws, so `host.publish` reports a delivery
 * failure instead of persisting `undefined` fields or dropping it silently.
 */
function parseSessionEvent(payload: unknown, chatKey: string): SessionEvent {
    const malformed = (why: string): Error => new Error(`Chat: malformed session event on ${chatKey}: ${why}`);
    if (payload === null || typeof payload !== 'object') throw malformed('not an object');
    const e = payload as Record<string, unknown>;
    if (typeof e.agentId !== 'string' || e.agentId === '') throw malformed('agentId');
    if (typeof e.sessionId !== 'string' || e.sessionId === '') throw malformed('sessionId');
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) throw malformed('at');
    switch (e.kind) {
        case 'status':
            if (typeof e.status !== 'string' || !STATUS_KINDS.has(e.status)) throw malformed(`status "${String(e.status)}"`);
            if (e.ref !== undefined && typeof e.ref !== 'string') throw malformed('ref');
            if (e.status === 'task-failed') {
                const err = e.error as Record<string, unknown> | undefined;
                if (typeof e.ref !== 'string' || e.ref === '') throw malformed('task-failed needs the task id as ref');
                if (!err || typeof err !== 'object' || typeof err.code !== 'string' || typeof err.message !== 'string' || typeof err.recoverable !== 'boolean') throw malformed('task-failed needs an error');
            }
            break;
        case 'message':
            if (!Array.isArray(e.parts) || !e.parts.every((p) => p !== null && typeof p === 'object' && typeof p.type === 'string')) {
                throw malformed('parts');
            }
            if (e.mentions !== undefined && !(Array.isArray(e.mentions) && e.mentions.every((m) => typeof m === 'string'))) {
                throw malformed('mentions');
            }
            if (e.taskId !== undefined && typeof e.taskId !== 'string') throw malformed('taskId');
            break;
        case 'title':
            if (typeof e.title !== 'string' || !e.title.trim()) throw malformed('title');
            break;
        default:
            throw malformed(`unknown kind "${String(e.kind)}"`);
    }
    return payload as SessionEvent;
}

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
    /** The session bound to each agent member (#392): its id, when it began, and the seq of that member's last message. */
    readonly sessions: Readonly<Record<string, ChatSessionRow>>;
    /** The chat's title (#124), absent until `Workspace.createChat({ title })`, `rename` or the chat itself (#460) set one — the pages then title it by its members. */
    readonly title?: string;
    /** How `title` was generated (#460); absent when a person set it. */
    readonly titleAuto?: AutoTitle;
    /** The project the chat belongs to (#332, `setProject`); absent when it is in none. */
    readonly projectId?: ProjectId;
    /** `projectId` with the project's name, when the Workspace still has it — a removed project leaves `projectId` alone. */
    readonly project?: { readonly id: ProjectId; readonly name: string };
    /** The machine the chat runs on (#414, `setMachine`); absent when it names none. */
    readonly machineId?: MachineId;
    /** `machineId` with the machine's name from the Workspace index, while it is listed there — a removed machine leaves `machineId` alone. */
    readonly machine?: { readonly id: MachineId; readonly name: string };
}

/** A title is one line of at most this many characters; `rename` trims and rejects the rest. */
export const MAX_TITLE_LENGTH = 120;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const clampLimit = (limit: number): number => Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit) || DEFAULT_LIMIT));

const principalOf = (ctx: ActorContext<ChatState>): Principal | null => (ctx.principal as Principal | null | undefined) ?? null;

/** The slice of the Routing actor a removal reaches (`defineRoutingActor`, #399), one-way. */
interface RoutingClient {
    endSession(chatId: ChatId, agentId: AgentId, reason: string, sessionId?: SessionId): Promise<void>;
    chatReleased(chatId: ChatId, projectId: ProjectId, reason: 'project-changed'): Promise<void>;
}

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

/** `by` on an audit record: who called. */
const principalLabel = (principal: Principal): string => {
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
};

/** The `{chatId}` of a `{ws}:chat:{chatId}` key. */
function chatIdOfKey(key: string): ChatId {
    const marker = ':chat:';
    const i = key.indexOf(marker);
    return (i < 0 ? key : key.slice(i + marker.length)) as ChatId;
}

/** An `image` / `file` part whose url claims the `agentic-file:` scheme — well-formed or not. */
const claimsChatFile = (part: PromptPart): part is Extract<PromptPart, { type: 'image' | 'file' }> => (part.type === 'image' || part.type === 'file') && typeof part.url === 'string' && part.url.startsWith(CHAT_FILE_SCHEME);

/** CHT-04 for a file: the caller may see the message it was (last) posted in. */
function canSeeFile(state: ChatState, principal: Principal | null, row: ChatFileRow): boolean {
    const from = visibleFrom(state, principal);
    return from !== null && row.seq >= from;
}

const pendingLive = (at: number, now: number): boolean => now - at < PENDING_TTL_MS;

/**
 * Check the chat-file parts of a post (#203) and return the file ids of the
 * pending uploads it posts. Each part must name THIS chat and a file that is
 * either the caller's own pending upload or already posted in a message the
 * caller can see (a re-share), with the file's own media type. Throws on the
 * first part that fails — nothing is stored.
 */
function checkFileParts(state: ChatState, chatId: ChatId, principal: Principal, parts: readonly PromptPart[], now: number): string[] {
    const posting: string[] = [];
    const me = principalKey(principal);
    for (const part of parts) {
        if (!claimsChatFile(part)) continue;
        if (!isChatFilePart(part)) throw new ServerFnError(400, `Chat.post: malformed file reference ${String((part as { url?: unknown }).url)}`);
        const ref = parseChatFileUri(part.url)!;
        if (ref.chatId !== chatId) throw new ServerFnError(400, `Chat.post: ${part.url} belongs to another chat`);
        const pending = state.pending?.[ref.fileId];
        const known = state.files?.[ref.fileId];
        let mediaType: string;
        if (pending && pending.by === me && pendingLive(pending.at, now)) {
            mediaType = pending.file.mediaType;
            if (!posting.includes(ref.fileId)) posting.push(ref.fileId);
        } else if (known) {
            if (!canSeeFile(state, principal, known)) throw new ServerFnError(403, `Chat.post: ${part.url} is in a message the caller cannot see`);
            mediaType = known.mediaType;
        } else {
            throw new ServerFnError(404, `Chat.post: no file ${part.url} in this chat`);
        }
        if (part.mediaType !== mediaType) throw new ServerFnError(400, `Chat.post: ${part.url} is ${mediaType}, not ${part.mediaType}`);
    }
    return posting;
}

/**
 * The parts of an agent's final message (a session event) as the chat keeps
 * them: a chat-file part stays only when it names a file of this chat that
 * the agent can see, with its own media type — the rest become
 * `[file unavailable]`, so a session event can never make a file readable.
 */
function agentParts(state: ChatState, chatId: ChatId, agentId: AgentId, parts: readonly PromptPart[]): readonly PromptPart[] {
    if (!parts.some(claimsChatFile)) return parts;
    const from = state.members[agentId]?.historyFrom;
    return parts.map((part): PromptPart => {
        if (!claimsChatFile(part)) return part;
        const ref = isChatFilePart(part) ? parseChatFileUri(part.url) : null;
        const row = ref && ref.chatId === chatId ? state.files?.[ref.fileId] : undefined;
        const ok = row !== undefined && from !== undefined && row.seq >= from && row.mediaType === part.mediaType;
        return ok ? part : { type: 'text', text: '[file unavailable]' };
    });
}

/** Checks `registerUpload` applies to the record the upload route hands in. */
function checkUpload(file: ChatFile, chatId: ChatId): void {
    const bad = (why: string): never => {
        throw new ServerFnError(400, `Chat.registerUpload: ${why}`);
    };
    if (file === null || typeof file !== 'object') bad('a file record is required');
    if (file.chatId !== chatId) bad(`the file belongs to chat ${String(file.chatId)}, not ${chatId}`);
    if (typeof file.id !== 'string' || parseChatFileUri(chatFileUri(chatId, file.id)) === null) bad(`"${String(file.id)}" is not a file id`);
    if (typeof file.name !== 'string' || !file.name.trim()) bad('a file name is required');
    if (typeof file.mediaType !== 'string' || !file.mediaType.trim()) bad('a media type is required');
    if (typeof file.at !== 'number' || !Number.isFinite(file.at)) bad('an upload time is required');
    if (typeof file.bytes !== 'number' || !Number.isInteger(file.bytes) || file.bytes < 0) bad('a byte size is required');
    if (file.bytes > CHAT_FILE_MAX_BYTES) throw new ServerFnError(413, `Chat.registerUpload: ${file.bytes} bytes is over the ${CHAT_FILE_MAX_BYTES}-byte limit`);
}

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

/**
 * `get()`: the summary, copied before the first await. The project's name rides along while the Workspace
 * still has the project (#332), the machine's while the index lists it (#414); a removed one — or a
 * Workspace that cannot be read — leaves the id alone. Both are read on the Workspace, never on the
 * Machine actor: whether the machine is online is the caller's to read.
 */
async function summaryOf(ctx: ActorContext<ChatState>): Promise<ChatSummary> {
    const { seq, members, coordinator, sessions, title, titleAuto, projectId, machineId } = ctx.state;
    let summary: ChatSummary = ctx.snapshot({ seq, members, coordinator, sessions, ...(title === undefined ? {} : { title }), ...(titleAuto === undefined ? {} : { titleAuto }), ...(projectId === undefined ? {} : { projectId }), ...(machineId === undefined ? {} : { machineId }) });
    if (projectId === undefined && machineId === undefined) return summary;
    const workspace = ctx.actor(Workspace, workspaceKey(workspaceOfKey(ctx.key) as WorkspaceId));
    if (projectId !== undefined) {
        try {
            const project = (await workspace.projects()).find((p) => p.id === projectId);
            if (project) summary = { ...summary, project: { id: project.id, name: project.name } };
        } catch {
            // The id stays; the name is a courtesy.
        }
    }
    if (machineId !== undefined) {
        try {
            const machine = (await workspace.listMachines()).find((m) => m.id === machineId);
            if (machine) summary = { ...summary, machine: { id: machine.id, name: machine.name } };
        } catch {
            // Likewise.
        }
    }
    return summary;
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

/** What the Chat actor is composed with. */
export interface ChatOptions {
    /**
     * Where attachment bytes live (#203) — R2 in the web app. `post` calls
     * `markPosted` when a pending upload goes into a message, so the orphan
     * sweep keeps it. Absent: `registerUpload` and a `post` of a pending upload answer 501 — a host without a store takes no uploads.
     */
    readonly files?: ChatFileStore;
    /**
     * The Routing actor definition (`defineRoutingActor`), as a thunk like
     * `MachinePorts.routing`. When set, `removeAgent` tells the router — one-way,
     * as the caller — to end the session the chat bound to the leaving member
     * (`Routing.endSession`, #399), so removal ends the agent's session for
     * that chat (§6). Absent: the binding is dropped and the session lives on.
     * `setProject` tells it, one-way, when the chat leaves a project
     * (`Routing.chatReleased`, #623), so the project's feature plugins can tidy up.
     */
    readonly routing?: () => AnyActorDefinition;
    /**
     * Titles a chat from its first messages (#460, `createChatTitler`) for the runtimes that do not title their own
     * conversations: asked in the `title` task after the agent messages `TITLE_AT_AGENT_MESSAGES` name, while no
     * runtime title stands and no person has named the chat. Absent: the heuristic title (the first user line) stays
     * until a runtime reports one.
     */
    readonly titles?: ChatTitler;
}

/** The generated title `auto` names, when it may replace what stands (`acceptsAutoTitle`) and it is news: one `rename` entry. */
async function autoRename(ctx: ActorContext<ChatState>, title: string, auto: AutoTitle): Promise<void> {
    const next = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH).trim();
    if (!next || !acceptsAutoTitle(ctx.state, auto.source, auto.sessionId) || ctx.state.title === next) return;
    await archive(ctx);
    await appendEntry(ctx, { t: 'rename', title: next, at: Date.now(), auto });
}

/**
 * After a message is folded (#460): the first user message names an untitled chat at once; the agent messages
 * `TITLE_AT_AGENT_MESSAGES` count start the `title` task when a model title may still replace what stands.
 */
async function afterMessage(ctx: ActorContext<ChatState>, entry: Extract<ChatEntry, { t: 'msg' }>, titles: ChatTitler | undefined): Promise<void> {
    if (entry.workdir || entry.project || entry.machine) return; // a note, not something said
    if (entry.author.kind === 'user') {
        if (ctx.state.title !== undefined) return;
        const title = heuristicTitle(entry.parts);
        if (title) await autoRename(ctx, title, { source: 'heuristic' });
        return;
    }
    if (!titles || !TITLE_AT_AGENT_MESSAGES.includes(agentMessageCount(ctx.state)) || !acceptsAutoTitle(ctx.state, 'model')) return;
    await ctx.tasks.start('title', {});
}

/**
 * Build the Chat actor over its ports. `Chat` is the definition without a
 * file store or a router; an app with them registers `defineChatActor({ files, routing })`
 * in its place (the actor type is `'Chat'` either way, so every `actor(Chat, …)`
 * client reaches the registered one).
 */
export function defineChatActor(ports: ChatOptions = {}) {
    return defineActor({
        ...reducer,
        type: 'Chat',
        authorize: [sameWorkspace, chatsScope],
        methodAuthorize: {
            post: [notMachine],
            addAgent: [userOrExternal],
            removeAgent: [userOrExternal],
            setCoordinator: [userOrExternal],
            rename: [userOrExternal],
            setWorkdir: [userOrExternal],
            setOptions: [userOrExternal],
            // Users, external clients and member agents; a non-member agent is refused inside the method (a policy sees no state).
            setProject: [notMachine],
            setMachine: [notMachine],
            registerUpload: [userOrExternal],
            fileAccess: [notMachine]
        },
        methodReentrancy: { get: 'always', history: 'always', search: 'always', fileAccess: 'always' },
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
                const parts = toParts(input);
                const chatId = chatIdOfKey(ctx.key);
                // Attachments (#203): every file part is checked before anything is stored; the uploads it posts are marked in the store first.
                const posting = checkFileParts(ctx.state, chatId, principal, parts, Date.now());
                if (posting.length > 0) {
                    // No store, no way to keep the bytes from the orphan sweep: a pending upload is never posted without one.
                    if (!ports.files) throw new ServerFnError(501, 'Chat.post: this deployment has no file store; attachments are not available');
                    const workspaceId = workspaceOfKey(ctx.key) as WorkspaceId;
                    for (const fileId of posting) await ports.files.markPosted(workspaceId, chatId, fileId);
                }
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
                    parts,
                    at: Date.now(),
                    mentions: [...addressed],
                    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
                    ...(author.kind === 'agent' ? { sessionId: author.sessionId } : {}),
                    ...(taskId ? { taskId } : {})
                };
                await archive(ctx);
                await appendEntry(ctx, entry);
                await afterMessage(ctx, entry, ports.titles);
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

            /**
             * Remove an agent: the entry drops its membership, its session binding and, if it was the coordinator,
             * the coordinator. The session itself is ended by the router (#399, `ChatOptions.routing`) — told one-way
             * with the id the binding held, since the entry has just dropped it, and after the entry so a fresh
             * activation can never rebind the leaving member.
             */
            async removeAgent(agentId: AgentId): Promise<boolean> {
                const member = ctx.state.members[agentId];
                if (!member) return false;
                const bound = ctx.state.sessions[agentId]?.sessionId;
                await archive(ctx);
                await appendEntry(ctx, { t: 'member', op: 'remove', agentId, historyAccess: member.historyFrom === 0 ? 'all' : 'from-now', at: Date.now() });
                const routing = bound !== undefined ? ports.routing?.() : undefined;
                if (routing && bound !== undefined) {
                    const chatId = chatIdOfKey(ctx.key);
                    const router = ctx.actor(routing, routingKey(workspaceOfKey(ctx.key) as WorkspaceId)).with({ oneWay: true }) as unknown as RoutingClient;
                    await router.endSession(chatId, agentId, `${agentId} was removed from chat ${chatId}`, bound).catch(() => undefined);
                }
                return true;
            },

            /** Name the coordinator (CHT-07) — a member, or `null` for none. */
            async setCoordinator(agentId: AgentId | null): Promise<void> {
                if (agentId !== null && !ctx.state.members[agentId]) throw new Error(`Chat.setCoordinator: ${agentId} is not a member`);
                if (ctx.state.coordinator === agentId) return;
                await archive(ctx);
                await appendEntry(ctx, { t: 'coordinator', agentId, at: Date.now() });
            },

            /**
             * Set the chat's title (#124): whitespace collapsed and trimmed, at
             * most `MAX_TITLE_LENGTH` characters; a blank title is rejected, not
             * stored, so `get().title` is either a name or absent. Idempotent.
             * `Workspace.createChat({ title })` calls this over a hop for the
             * first title; the user renames the rest.
             */
            async rename(title: string): Promise<void> {
                const next = title.replace(/\s+/g, ' ').trim();
                if (!next) throw new Error('Chat.rename: title is required');
                if (next.length > MAX_TITLE_LENGTH) throw new Error(`Chat.rename: title is longer than ${MAX_TITLE_LENGTH} characters`);
                // The same title again is no entry — unless a generated one (#460): a person keeping it makes it theirs, final.
                if (ctx.state.title === next && !ctx.state.titleAuto) return;
                await archive(ctx);
                await appendEntry(ctx, { t: 'rename', title: next, at: Date.now() });
            },

            /**
             * Pick the folder `agentId` works in for this chat (#190), or clear it with
             * `null`: stored on the member (`get().members[agentId].workdir`) and copied
             * into the task of its next activation — a running session keeps its folder.
             * The change is written as a visible note in the thread (a user message
             * carrying `workdir`, activating nobody). Members only (404); the path is
             * checked against the environment's roots when a task runs there.
             */
            async setWorkdir(agentId: AgentId, ref: WorkdirRef | null): Promise<ChatMember> {
                const member = ctx.state.members[agentId];
                if (!member) throw new ServerFnError(404, `Chat.setWorkdir: ${agentId} is not a member`);
                if (ref !== null && (typeof ref?.environmentId !== 'string' || !ref.environmentId.trim() || typeof ref.path !== 'string' || !ref.path.trim())) {
                    throw new ServerFnError(400, 'Chat.setWorkdir: a folder needs an environmentId and a path');
                }
                const next: WorkdirRef | null = ref === null ? null : { environmentId: ref.environmentId.trim() as WorkdirRef['environmentId'], path: ref.path.trim() };
                const current = member.workdir;
                if (next === null ? current === undefined : current?.environmentId === next.environmentId && current.path === next.path) return ctx.snapshot(member);
                const text = next === null ? `Working folder for ${agentId} cleared` : `Working folder for ${agentId} → ${next.path} on ${next.environmentId}`;
                await archive(ctx);
                await appendEntry(ctx, { t: 'msg', id: createId('msg') as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text }], at: Date.now(), mentions: [], workdir: { agentId, ref: next } });
                return ctx.snapshot(ctx.state.members[agentId]!);
            },

            /**
             * Set a member's model or permission mode for this chat (#453), or clear one back to the agent's config with
             * `null`: folded onto the member (`get().members[agentId].options`). The router reads it when it places the
             * member's next turn — a fresh session opens with it, a live one is configured to it before the prompt, a
             * turn already running keeps what it runs with (AGT-07). Written as a visible note (a user message carrying
             * `options`, activating nobody). Members only (404); a key other than `model` / `permissionMode`, or a value
             * that is not text, is 400. Whether the environment allows the mode is judged where it runs.
             */
            async setOptions(agentId: AgentId, patch: SessionOptionsPatch): Promise<ChatMember> {
                const member = ctx.state.members[agentId];
                if (!member) throw new ServerFnError(404, `Chat.setOptions: ${agentId} is not a member`);
                const next: Record<string, string | null> = {};
                for (const [key, value] of Object.entries(patch ?? {})) {
                    if (key !== 'model' && key !== 'permissionMode') throw new ServerFnError(400, `Chat.setOptions: unknown option ${key}`);
                    if (value === undefined) continue;
                    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 256)) throw new ServerFnError(400, `Chat.setOptions: ${key} must be a name or null`);
                    // Unchanged keys are left out, so an idempotent call writes nothing.
                    if ((value === null ? undefined : value.trim()) !== member.options?.[key]) next[key] = value === null ? null : value.trim();
                }
                if (!Object.keys(next).length) return ctx.snapshot(member);
                const label = (key: string) => (key === 'model' ? 'Model' : 'Permission mode');
                const text = Object.entries(next)
                    .map(([key, value]) => (value === null ? `${label(key)} for ${agentId} back to its default` : `${label(key)} for ${agentId} → ${value}`))
                    .join('; ');
                await archive(ctx);
                await appendEntry(ctx, { t: 'msg', id: createId('msg') as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text }], at: Date.now(), mentions: [], options: { agentId, patch: next } });
                return ctx.snapshot(ctx.state.members[agentId]!);
            },

            /**
             * Put the chat in a project (#332), or in none with `null`: the router reads the
             * project's folder for each member's environment unless the member has its own
             * (`setWorkdir`), and every session in it gets the project's connectors and
             * feature plugins. Written as a visible note in the thread (a user message carrying
             * `project`, activating nobody), so the fold keeps the last one. Users, external
             * clients and member agents (a non-member agent is 403); an unknown project is 400.
             * Idempotent. Recorded as `chat.project-set`. Leaving a project tells the router
             * (`Routing.chatReleased`, #623), so the project's feature plugins can tidy up.
             */
            async setProject(projectId: ProjectId | null): Promise<ChatSummary> {
                const principal = principalOf(ctx);
                if (!principal) throw new Error('Chat.setProject: no principal');
                if (principal.kind === 'agent' && !ctx.state.members[principal.agentId]) throw new ServerFnError(403, `Chat.setProject: ${principal.agentId} is not a member of this chat`);
                if (projectId !== null && (typeof projectId !== 'string' || !projectId.trim())) throw new ServerFnError(400, 'Chat.setProject: a project id or null is required');
                const workspaceId = workspaceOfKey(ctx.key) as WorkspaceId;
                let name: string | undefined;
                if (projectId !== null) {
                    const project = (await ctx.actor(Workspace, workspaceKey(workspaceId)).projects()).find((p) => p.id === projectId);
                    if (!project) throw new ServerFnError(400, `Chat.setProject: no project ${projectId} in this workspace`);
                    name = project.name;
                }
                const left = ctx.state.projectId ?? null;
                if (left === projectId) return summaryOf(ctx);
                const text = projectId === null ? 'Project cleared' : `Project → ${name}`;
                await archive(ctx);
                const at = Date.now();
                await appendEntry(ctx, { t: 'msg', id: createId('msg') as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text }], at, mentions: [], project: { id: projectId } });
                const chatId = chatIdOfKey(ctx.key);
                await recordAudit(ctx, workspaceId, {
                    key: `${ctx.key}:project:${ctx.state.seq - 1}`,
                    kind: 'chat.project-set',
                    at,
                    by: principalLabel(principal),
                    summary: projectId === null ? `chat ${chatId} left its project` : `chat ${chatId} put in project ${name} (${projectId})`,
                    data: { chatId, projectId, ...(name !== undefined ? { name } : {}) }
                });
                // The project it left hears it (#623), one-way and best effort: its feature plugins tidy up after the chat.
                const routing = left !== null ? ports.routing?.() : undefined;
                if (routing && left !== null) {
                    const router = ctx.actor(routing, routingKey(workspaceId)).with({ oneWay: true }) as unknown as RoutingClient;
                    await router.chatReleased(chatId, left, 'project-changed').catch(() => undefined);
                }
                return summaryOf(ctx);
            },

            /**
             * Run the chat on a machine (#414), or on none with `null`: the activation contract
             * copies it into each member's next task as `machineId`, where the router resolves
             * the member's account on that machine. Applies from the next activation — a
             * session running elsewhere finishes its turn there, and the placement move gives the
             * member a fresh session on the new machine (#393). Written as a visible note in the
             * thread (a user message carrying `machine`, activating nobody), so the fold keeps
             * the last one. Users, external clients and member agents (a non-member agent is
             * 403); a machine the Workspace index does not list as paired is 400. Idempotent.
             * Recorded as `chat.machine-set`.
             */
            async setMachine(machineId: MachineId | null): Promise<ChatSummary> {
                const principal = principalOf(ctx);
                if (!principal) throw new Error('Chat.setMachine: no principal');
                if (principal.kind === 'agent' && !ctx.state.members[principal.agentId]) throw new ServerFnError(403, `Chat.setMachine: ${principal.agentId} is not a member of this chat`);
                if (machineId !== null && (typeof machineId !== 'string' || !machineId.trim())) throw new ServerFnError(400, 'Chat.setMachine: a machine id or null is required');
                const workspaceId = workspaceOfKey(ctx.key) as WorkspaceId;
                let name: string | undefined;
                if (machineId !== null) {
                    const machine = (await ctx.actor(Workspace, workspaceKey(workspaceId)).listMachines()).find((m) => m.id === machineId && m.status === 'paired');
                    if (!machine) throw new ServerFnError(400, `Chat.setMachine: no paired machine ${machineId} in this workspace`);
                    name = machine.name;
                }
                if ((ctx.state.machineId ?? null) === machineId) return summaryOf(ctx);
                const text = machineId === null ? 'Machine cleared' : `Machine → ${name}`;
                await archive(ctx);
                const at = Date.now();
                await appendEntry(ctx, { t: 'msg', id: createId('msg') as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text }], at, mentions: [], machine: { id: machineId } });
                const chatId = chatIdOfKey(ctx.key);
                await recordAudit(ctx, workspaceId, {
                    key: `${ctx.key}:machine:${ctx.state.seq - 1}`,
                    kind: 'chat.machine-set',
                    at,
                    by: principalLabel(principal),
                    summary: machineId === null ? `chat ${chatId} runs on no particular machine` : `chat ${chatId} runs on machine ${name} (${machineId})`,
                    data: { chatId, machineId, ...(name !== undefined ? { name } : {}) }
                });
                return summaryOf(ctx);
            },

            /**
             * Record an upload the web route stored (#203): pending, and readable by
             * its uploader only, until a `post` of theirs references it. Users and
             * external clients only; at most `MAX_PENDING_UPLOADS` per uploader,
             * and a pending upload is forgotten after `PENDING_TTL_MS`. Idempotent
             * for the same uploader and id. A Chat without a file store takes no
             * uploads (501).
             */
            async registerUpload(file: ChatFile): Promise<ChatFile> {
                const principal = principalOf(ctx);
                if (!principal) throw new Error('Chat.registerUpload: no principal');
                if (!ports.files) throw new ServerFnError(501, 'Chat.registerUpload: this deployment has no file store; attachments are not available');
                const chatId = chatIdOfKey(ctx.key);
                checkUpload(file, chatId);
                const me = principalKey(principal);
                const now = Date.now();
                if (ctx.state.files?.[file.id]) throw new ServerFnError(409, `Chat.registerUpload: file ${file.id} is already posted`);
                const existing = ctx.state.pending?.[file.id];
                if (existing && pendingLive(existing.at, now)) {
                    if (existing.by !== me) throw new ServerFnError(409, `Chat.registerUpload: file ${file.id} is already registered`);
                    return ctx.snapshot(existing.file);
                }
                const pending = (ctx.state.pending ??= {});
                for (const [id, p] of Object.entries(pending)) if (!pendingLive(p.at, now)) delete pending[id];
                if (Object.values(pending).filter((p) => p.by === me).length >= MAX_PENDING_UPLOADS) {
                    throw new ServerFnError(429, `Chat.registerUpload: ${MAX_PENDING_UPLOADS} uploads are already waiting to be posted`);
                }
                const record: ChatFile = { id: file.id, chatId, name: file.name.trim(), mediaType: file.mediaType.trim(), bytes: file.bytes, at: file.at };
                pending[file.id] = { file: record, by: me, at: now };
                await ctx.save();
                return ctx.snapshot(record);
            },

            /**
             * Who may read a file (#203, CHT-04, MEM-11): a pending upload, its
             * uploader only; a posted file, whoever may see the message it was
             * posted in — users and external clients always, a member agent from
             * its `historyFrom` on, anyone else `null` (fails closed).
             */
            async fileAccess(fileId: string): Promise<ChatFile | null> {
                const principal = principalOf(ctx);
                if (!principal || typeof fileId !== 'string') return null;
                const chatId = chatIdOfKey(ctx.key);
                const pending = ctx.state.pending?.[fileId];
                if (pending) return pending.by === principalKey(principal) && pendingLive(pending.at, Date.now()) ? ctx.snapshot(pending.file) : null;
                const row = ctx.state.files?.[fileId];
                if (!row || !canSeeFile(ctx.state, principal, row)) return null;
                return { id: fileId, chatId, name: row.name, mediaType: row.mediaType, bytes: row.bytes, at: row.at };
            },

            async get(): Promise<ChatSummary> {
                return summaryOf(ctx);
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
                const e = parseSessionEvent(event.payload, ctx.key);
                if (e.kind === 'status') {
                    if (e.status === 'typing') return;
                    await archive(ctx);
                    if (e.status === 'request' || e.status === 'request-resolved') {
                        // A request status is only useful paired: the ref is the contract (`RequestStatusRef`), not a session id.
                        if (!isRequestStatusRef(e.ref)) throw new Error(`Chat: malformed session event on ${ctx.key}: ${e.status} needs an approval:/input: ref`);
                        await appendEntry(ctx, { t: 'status', agentId: e.agentId, kind: e.status, ref: e.ref, at: e.at });
                    } else if (e.status === 'task-failed') {
                        // A failure names its task and says why (OPS-04); `parseSessionEvent` checked both.
                        await appendEntry(ctx, { t: 'status', agentId: e.agentId, kind: 'task-failed', ref: e.ref as TaskId, error: e.error!, at: e.at });
                    } else {
                        // The binding names the member's live session (#392): the end of any other — a replaced session's late
                        // ack, a second word of the same end (#399) — is no news for this chat and is not written, so it can
                        // never drop the row of the session that took its place.
                        if (e.status === 'session-ended' && ctx.state.sessions[e.agentId]?.sessionId !== e.sessionId) return;
                        await appendEntry(ctx, { t: 'status', agentId: e.agentId, kind: e.status, ref: e.ref ?? e.sessionId, at: e.at });
                    }
                } else if (e.kind === 'title') {
                    // The runtime's own title for the conversation (#460): only the member's bound session speaks for it (#392),
                    // and it replaces a generated title — never one a person set, nor another session's runtime title.
                    if (ctx.state.sessions[e.agentId]?.sessionId !== e.sessionId) return;
                    await autoRename(ctx, e.title, { source: 'runtime', sessionId: e.sessionId as SessionId });
                } else {
                    await archive(ctx);
                    const entry: ChatEntry = {
                        t: 'msg',
                        id: createId('msg') as MessageId,
                        author: { kind: 'agent', agentId: e.agentId, sessionId: e.sessionId },
                        parts: agentParts(ctx.state, chatIdOfKey(ctx.key), e.agentId as AgentId, e.parts),
                        at: e.at,
                        mentions: e.mentions ?? [],
                        sessionId: e.sessionId,
                        ...(e.taskId ? { taskId: e.taskId } : {})
                    };
                    await appendEntry(ctx, entry);
                    await afterMessage(ctx, entry, ports.titles);
                }
            }
        },
        tasks: (ctx) => ({
            /**
             * Ask the titler for a title over the first messages (#460), outside any turn — a model call never holds the
             * chat. Single-flight; started by `afterMessage`, and checked again before writing: a runtime title or a
             * rename that landed meanwhile wins. A titler that answers nothing (no key) or fails leaves the title as it
             * is — a title is a courtesy, never an error in the thread.
             */
            async title(): Promise<void> {
                const snap = ctx.snapshot();
                if (!ports.titles || !acceptsAutoTitle(snap, 'model')) return;
                const workspaceId = workspaceOfKey(ctx.key) as WorkspaceId;
                let title: string | undefined;
                try {
                    title = await ports.titles(workspaceId, titleInputOf(snap), ctx.abortSignal);
                } catch (e) {
                    console.warn(`[chat] titling ${ctx.key} failed:`, e instanceof Error ? e.message : e);
                    return;
                }
                if (!title) return;
                await ctx.turn((c) => autoRename(c, title, { source: 'model' }));
            }
        })
    });
}

/** The Chat actor without a file store — the type clients address, and the host definition where no uploads exist. */
export const Chat = defineChatActor();
