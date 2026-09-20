/**
 * The live chat's view model (#34): pure adapters from what the actors
 * return — `Chat.get`, `Chat.history`, `Agent.get`, a Session's event
 * tail — to what the pages already render from the mock workspace
 * (`MockChatSummary`, `MockChatMember`, the Thread's transcript and
 * authors). Nothing here touches a hook or the DOM, so every rule is
 * unit-testable and `LiveChat.tsx` stays wiring.
 */
import { isChatFilePart, isTerminal, parseChatFileUri, type AgentId, type ChatEntry, type ChatFilePart, type ChatId, type MessageId, type ProjectId, type PromptPart, type TaskContract, type TaskId, type WorkdirRef } from '@agentic/core';
import type { AgentView, ChatSummary, InboxNotification, IndexedEntry, SessionInfo, TaskIndexRow } from '@agentic/platform';
import { createTranscript, type AgentCapabilities, type AgentEvent } from '@sigx/ai-agent';
import type { AgentMessage, AgentPart, AgentTranscript, OpenRequest } from '@sigx/ai-agent/app';
import { WIRE_PROTOCOL_VERSION, type SessionTransport, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { hueFor, type AgentHue, type EnvironmentParts, type MessageAuthor } from '@agentic/ui';
import { failureOf, INTERRUPTED_CODE, type FailureState } from '../../components/status';
import { formatTime, USER, type MockChatMember, type MockChatSummary, type MockTaskRow } from '../../mock/workspace';

// ---- identities --------------------------------------------------------------

/** What the pages need to draw an agent: the same fields the mock `AGENTS` carry. */
export interface AgentIdentity {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    /** The config's description — the roster card's line under the name (#35); the mock identities carry none. */
    readonly description?: string;
    readonly hue: AgentHue;
    readonly environment: EnvironmentParts;
    /** The environment it runs in by default (`execution.defaultEnvironmentId`); absent for a platform runtime or none chosen. */
    readonly environmentId?: string;
    readonly configVersion: number;
}

export type AgentLookup = (id: string) => AgentIdentity;

const UNKNOWN_ENVIRONMENT: EnvironmentParts = { machine: '—', runtime: '—', account: '—' };

/** An agent the directory has not loaded (or that no longer exists): its id as the name, the muted first hue. */
export const unknownAgent = (id: string): AgentIdentity => ({ id, name: id, role: '', description: '', hue: 1, environment: UNKNOWN_ENVIRONMENT, configVersion: 0 });

/**
 * `Agent.get()` → identity. The hue is the agent's creation index in the
 * workspace (`hueFor`), so it is stable across pages; the environment line
 * is the agent's default execution (EXE-06: all three parts, always): the
 * platform runtime runs on the platform under the BYO key, a daemon
 * runtime in its default environment under that machine's account.
 */
export function identityOf(view: AgentView, index: number): AgentIdentity {
    const { config } = view;
    const runtime = config.execution.runtime;
    const platform = runtime === 'anthropic-api';
    return {
        id: view.id,
        name: config.name || view.id,
        role: config.role || config.description || '',
        description: config.description,
        hue: hueFor(index),
        environment: {
            machine: platform ? 'platform' : (config.execution.defaultEnvironmentId ?? 'unassigned'),
            runtime,
            account: platform ? 'byo-key' : 'machine'
        },
        ...(!platform && config.execution.defaultEnvironmentId ? { environmentId: config.execution.defaultEnvironmentId } : {}),
        configVersion: view.configVersion
    };
}

/** A lookup over loaded identities with the unknown fallback. */
export function lookupOver(agents: Readonly<Record<string, AgentIdentity>>): AgentLookup {
    return (id) => agents[id] ?? unknownAgent(id);
}

// ---- membership and summaries ------------------------------------------------

const NOBODY: ReadonlySet<string> = new Set();

/**
 * `Chat.get()` → the members as the panel and the composer read them. A
 * member in `waiting` has a request open in this chat (`openRequests`) —
 * it reads WAITING, ahead of its session being active. A member reads
 * ACTIVE while the chat runs a session for it, or while it works a task of
 * this chat's tree (`working`, #258) — a delegated child runs outside the
 * chat, so it never shows in `activeSessions`.
 */
export function membersOf(summary: ChatSummary, waiting: ReadonlySet<string> = NOBODY, working: ReadonlySet<string> = NOBODY): MockChatMember[] {
    return Object.entries(summary.members).map(([agentId, m]) => ({
        agentId,
        status: waiting.has(agentId) ? 'waiting' : summary.activeSessions[agentId] || working.has(agentId) ? 'active' : 'idle',
        ...(summary.coordinator === agentId ? { coordinator: true } : {}),
        history: m.historyFrom === 0 ? { access: 'all' } : { access: 'from', at: m.since },
        ...(m.workdir ? { workdir: m.workdir } : {})
    }));
}

/**
 * The chat's title: the one it was given (`Chat.get().title`, set by
 * `createChat({ title })` or `rename`, #124) when there is one; else its
 * members' names (a direct chat with Atlas is "Atlas"; a group is "Atlas,
 * Forge, Lint"), "New chat" before anyone has joined.
 */
export function chatTitle(members: readonly MockChatMember[], lookup: AgentLookup, title?: string): string {
    if (title) return title;
    return members.length ? members.map((m) => lookup(m.agentId).name).join(', ') : 'New chat';
}

/**
 * The note `Chat.setWorkdir` writes (#190, #193), in names rather than ids:
 * "Forge now works in /src/app (env_work)" / "Forge's working folder was cleared".
 */
export function workdirNote(change: { readonly agentId: AgentId; readonly ref: WorkdirRef | null }, lookup: AgentLookup): string {
    const name = lookup(change.agentId).name;
    return change.ref ? `${name} now works in ${change.ref.path} (${change.ref.environmentId})` : `${name}'s working folder was cleared`;
}

/** The text of a message entry, one line, for a list row. */
export function entryLine(entry: ChatEntry, lookup: AgentLookup): string {
    switch (entry.t) {
        case 'msg': {
            if (entry.workdir) return workdirNote(entry.workdir, lookup);
            const who = entry.author.kind === 'user' ? 'You' : lookup(entry.author.agentId).name;
            const text = entry.parts.map(partText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
            return `${who}: ${text}`;
        }
        case 'status':
            return `${lookup(entry.agentId).name} ${statusText(entry)}`;
        case 'member':
            return `${lookup(entry.agentId).name} ${entry.op === 'add' ? 'joined' : 'left'}`;
        case 'coordinator':
            return entry.agentId ? `${lookup(entry.agentId).name} coordinates` : 'No coordinator';
        case 'rename':
            return `Renamed to ${entry.title.replace(/\s+/g, ' ').trim()}`;
    }
}

/**
 * What a list row says last and when: the newest message when the entries read hold one — a turn ends in session
 * bookkeeping (`ended its session`), which is not what was said — else the newest entry; the time is the newest entry's.
 */
export function lastOf(newest: readonly IndexedEntry[], lookup: AgentLookup): { readonly line: string; readonly at: number } {
    const last = newest[newest.length - 1];
    if (!last) return { line: '', at: 0 };
    let said: IndexedEntry | undefined;
    for (let i = newest.length - 1; i >= 0 && !said; i--) if (newest[i]!.entry.t === 'msg') said = newest[i];
    return { line: entryLine((said ?? last).entry, lookup), at: last.entry.at };
}

/** How many of a chat's newest entries a list row reads: enough to pair a request with its resolution and to count what is unread. */
export const LIST_TAIL = 30;

/** A request a session raised in the chat that has not settled: a `request` status entry without its `request-resolved`. */
export interface OpenChatRequest {
    readonly ref: string;
    readonly agentId: string;
    readonly at: number;
}

/**
 * The requests open in these entries (COL-10 / CHT-09), oldest first. A
 * `request` and its `request-resolved` carry the same `ref`, so the fold
 * is a pairing; a resolution whose request is older than the entries read
 * resolves nothing here, which is right — that request is not in view.
 */
export function openRequests(entries: readonly IndexedEntry[]): OpenChatRequest[] {
    const open = new Map<string, OpenChatRequest>();
    for (const { entry } of entries) {
        if (entry.t !== 'status') continue;
        if (entry.kind === 'request') open.set(entry.ref, { ref: entry.ref, agentId: entry.agentId, at: entry.at });
        else if (entry.kind === 'request-resolved') open.delete(entry.ref);
    }
    return [...open.values()];
}

/** An open question of this chat whose session has left it (#285): answered from its own card, it starts the asker again. */
export interface DetachedQuestion {
    readonly sessionId: string;
    readonly requestId: string;
    readonly agentId: string;
}

/**
 * The chat's open questions no live feed carries (#285): an `ask_user` that answered `pending` outlives its turn
 * and its session, so it leaves `activeSessions` while still open. The chat's `input` statuses say which are open;
 * the unread Inbox row of each says which session asked (a chat status carries no session).
 */
export function detachedQuestions(entries: readonly IndexedEntry[], inbox: readonly InboxNotification[], feeds: readonly { readonly transcript: AgentTranscript }[]): DetachedQuestion[] {
    const live = new Set(feeds.flatMap((f) => Object.keys(f.transcript.requests)));
    const sessionOf = new Map<string, string>();
    for (const n of inbox) if (!n.read && n.ref?.kind === 'session' && n.ref.requestId) sessionOf.set(n.ref.requestId, n.ref.sessionId);
    return openRequests(entries).flatMap((r) => {
        const cut = r.ref.indexOf(':');
        const need = r.ref.slice(0, cut);
        const requestId = r.ref.slice(cut + 1);
        const sessionId = sessionOf.get(requestId);
        return cut > 0 && need === 'input' && !live.has(requestId) && sessionId ? [{ sessionId, requestId, agentId: r.agentId }] : [];
    });
}

/** The agents with a request open in these entries — who reads WAITING in the members panel. */
export const waitingAgents = (entries: readonly IndexedEntry[]): Set<string> => new Set(openRequests(entries).map((r) => r.agentId));

/**
 * How many agent messages arrived since this device last had the chat open.
 * `seen` is the chat's `seq` at that moment (entries below it were on
 * screen); `undefined` — the chat has no marker on this device yet — counts
 * nothing, so a first visit does not paint every chat unread.
 */
export function unreadOf(entries: readonly IndexedEntry[], seen: number | undefined): number {
    if (seen === undefined) return 0;
    let n = 0;
    for (const { seq, entry } of entries) if (seq >= seen && entry.t === 'msg' && entry.author.kind === 'agent') n++;
    return n;
}

/**
 * A chat row for the list: `Chat.get()` plus its newest entries — the last
 * line and the update time, the amber pill while a request is open, the
 * unread count against this device's marker (`seen`, see `read-marks.ts`).
 */
export function chatRow(id: string, summary: ChatSummary, newest: readonly IndexedEntry[], lookup: AgentLookup, seen?: number): MockChatSummary {
    const waiting = waitingAgents(newest);
    const members = membersOf(summary, waiting);
    const last = lastOf(newest, lookup);
    return {
        id,
        title: chatTitle(members, lookup, summary.title),
        members,
        lastLine: last.line,
        unread: unreadOf(newest, seen),
        waiting: waiting.size > 0,
        updatedAt: last.at,
        ...(summary.projectId ? { projectId: summary.projectId } : {})
    };
}

// ---- tasks in this chat --------------------------------------------------------

/** What the context panel draws of a task — the fields of the mock row it reads. */
export type ChatTaskRow = Pick<MockTaskRow, 'id' | 'parentId' | 'depth' | 'status' | 'objective' | 'agentId'>;

/** Most rows the panel's mini-tree lists; "Open tree" shows the rest. */
export const CHAT_TASKS_CAP = 8;

/**
 * The chat's tasks out of the workspace's index (`TaskIndex.list()`), as
 * the mini-tree lists them: a root is a task whose origin is a message of
 * THIS chat (`chatId`); its delegated children carry no `chatId` and hang
 * off it by `parentId`. Depth-first, a chain that is still running before
 * a settled one, newest first within that, a parent's children oldest first
 * (the order they were delegated in); `depth` is the distance from the
 * root. Capped at `cap` rows.
 */
export function chatTasks(rows: readonly TaskIndexRow[], chatId: string, cap: number = CHAT_TASKS_CAP): ChatTaskRow[] {
    const children = new Map<string, TaskIndexRow[]>();
    for (const r of rows) {
        if (r.parentId === undefined) continue;
        const list = children.get(r.parentId);
        if (list) list.push(r);
        else children.set(r.parentId, [r]);
    }
    const running = (r: TaskIndexRow): boolean => !isTerminal(r.status) || (children.get(r.id) ?? []).some(running);
    const roots = rows.filter((r) => r.chatId === chatId && r.parentId === undefined).sort((a, b) => Number(running(b)) - Number(running(a)) || b.createdAt - a.createdAt);
    const out: ChatTaskRow[] = [];
    const visit = (r: TaskIndexRow, depth: number): void => {
        if (out.length >= cap) return;
        out.push({ id: r.id, ...(r.parentId !== undefined ? { parentId: r.parentId } : {}), depth, status: r.status, objective: r.objective, agentId: r.assignee });
        for (const c of [...(children.get(r.id) ?? [])].sort((a, b) => a.createdAt - b.createdAt)) visit(c, depth + 1);
    };
    for (const r of roots) visit(r, 0);
    return out;
}

/** The agents working a task of this chat's tree right now (#258): each `active` row whose chain of parents ends at a root of this chat — the same tree `chatTasks` draws, uncapped, in one pass. */
export function workingAgents(rows: readonly TaskIndexRow[], chatId: string): Set<string> {
    const byId = new Map<string, TaskIndexRow>(rows.map((r) => [r.id, r]));
    const inChat = new Map<string, boolean>();
    const belongs = (r: TaskIndexRow): boolean => {
        const known = inChat.get(r.id);
        if (known !== undefined) return known;
        inChat.set(r.id, false); // a cycle, however unlikely, ends here
        const parent = r.parentId === undefined ? undefined : byId.get(r.parentId);
        const yes = r.parentId === undefined ? r.chatId === chatId : parent !== undefined && belongs(parent);
        inChat.set(r.id, yes);
        return yes;
    };
    const out = new Set<string>();
    for (const r of rows) if (r.status === 'active' && belongs(r)) out.add(r.assignee);
    return out;
}

/** The tasks "Stop task chain" would stop: everything in the panel that has not settled. */
export const stoppable = (tasks: readonly ChatTaskRow[]): ChatTaskRow[] => tasks.filter((t) => !isTerminal(t.status));

/** Where the stop goes: a root that has not settled — `Task.cancel` takes its subtree with it (COL-12) — or a child still running under a settled root. */
export function stopTargets(tasks: readonly ChatTaskRow[]): ChatTaskRow[] {
    const live = new Set(stoppable(tasks).map((t) => t.id as string));
    return tasks.filter((t) => live.has(t.id) && (t.parentId === undefined || !live.has(t.parentId)));
}

/**
 * What a stop could not confirm (COL-12), as the page's error line says it: each `Task.cancel` report names the work
 * it could not stop — by objective where the index knows it, by id otherwise. `null` when every chain stopped.
 */
export function notStoppedLine(reports: readonly { readonly notStopped: readonly string[] }[], rows: readonly Pick<TaskIndexRow, 'id' | 'objective'>[]): string | null {
    const left = [...new Set(reports.flatMap((r) => r.notStopped))];
    if (!left.length) return null;
    return `Could not be stopped: ${left.map((id) => rows.find((r) => r.id === id)?.objective ?? id).join('; ')}`;
}

// ---- the transcript --------------------------------------------------------------

/** `[image "<name>" <uri>]` / `[file "<name>" <uri>]` — an attachment as one line of text; the name or the uri is left out when the part has none. */
function mediaText(kind: 'image' | 'file', name: string | undefined, url: string | undefined): string {
    return `[${[kind, name ? `"${name}"` : '', url && !url.startsWith('data:') ? url : ''].filter(Boolean).join(' ')}]`;
}

/** A part as the text of a list row or a context line. */
export const partText = (p: PromptPart): string => {
    switch (p.type) {
        case 'text':
            return p.text;
        case 'image':
            return mediaText('image', (p as { readonly name?: string }).name, p.url);
        case 'file':
            return mediaText('file', p.name, p.url);
        case 'resource':
            return `[${p.uri}]`;
    }
};

/** Where the browser reads a chat file (`apps/web/src/files/route.ts`, #207). */
export const chatFileHref = (chatId: string, fileId: string): string => `/files/chats/${encodeURIComponent(chatId)}/${encodeURIComponent(fileId)}`;

/**
 * A message part as the thread renders it (#207): text as text; a chat
 * attachment (`agentic-file:`) as an image or file part pointing at the
 * download route, so the Message component shows a thumbnail or a download
 * chip; an inline (`data`) image or file as it is. Any other url is never
 * loaded — it reads as its placeholder text.
 */
function threadPart(p: PromptPart, id: string): AgentPart {
    if (p.type === 'image' || p.type === 'file') {
        const ref = p.url !== undefined ? parseChatFileUri(p.url) : null;
        const name = p.type === 'file' ? p.name : undefined;
        if (ref) {
            const url = chatFileHref(ref.chatId, ref.fileId);
            return p.type === 'image' ? { type: 'image', mediaType: p.mediaType, url } : { type: 'file', mediaType: p.mediaType, url, ...(name ? { filename: name } : {}) };
        }
        if (p.data !== undefined && p.url === undefined) {
            return p.type === 'image' ? { type: 'image', mediaType: p.mediaType, data: p.data } : { type: 'file', mediaType: p.mediaType, data: p.data, ...(name ? { filename: name } : {}) };
        }
    }
    return { type: 'text', id, text: partText(p) };
}

function statusText(entry: Extract<ChatEntry, { t: 'status' }>): string {
    switch (entry.kind) {
        case 'session-started':
            return 'started a session';
        case 'session-ended':
            return 'ended its session';
        case 'typing':
            return 'is typing';
        case 'task':
            return entry.ref ? `task · ${entry.ref}` : 'task';
        case 'task-failed':
            return `could not finish: ${entry.error.code} — ${entry.error.message}`;
        case 'request':
            return entry.ref?.startsWith('input:') ? 'needs an answer' : 'needs an approval';
        case 'request-resolved':
            return entry.ref?.startsWith('input:') ? 'got its answer' : 'got its approval decision';
    }
}

/** `14:02` for an instant — the workspace zone's on the live pages (`time.ts`), the mock workspace's by default. */
export type TimeText = (at: number) => string;

export interface EntryTranscript {
    readonly messages: AgentMessage[];
    readonly authors: Record<string, MessageAuthor>;
}

/**
 * Chat entries → thread rows. A `msg` is a user or assistant message; a
 * `status` entry is an assistant row of the responsible agent (CHT-02)
 * with the status in italics; membership and coordinator entries are not
 * rows (the members panel shows them). The live page passes who the user
 * reads as ("You") and its workspace's clock face.
 */
export function entryTranscript(entries: readonly IndexedEntry[], lookup: AgentLookup, userName: string = USER.name, time: TimeText = formatTime): EntryTranscript {
    const timeOf = (at: number): MessageAuthor['time'] => ({ text: time(at), dateTime: new Date(at).toISOString() });
    const messages: AgentMessage[] = [];
    const authors: Record<string, MessageAuthor> = {};
    for (const { seq, entry } of entries) {
        if (entry.t === 'msg' && entry.workdir) {
            // A folder change is the user's act, shown as a note rather than a message that looks addressed to someone.
            const id = entry.id;
            messages.push({ id, role: 'user', author: userName, parts: [{ type: 'text', id: `${id}:0`, text: `*${workdirNote(entry.workdir, lookup)}*` }] });
            authors[id] = { name: userName, person: true, time: timeOf(entry.at) };
        } else if (entry.t === 'msg') {
            const parts: AgentPart[] = entry.parts.map((p, i) => threadPart(p, `${entry.id}:${i}`));
            if (entry.author.kind === 'user') {
                messages.push({ id: entry.id, role: 'user', author: userName, parts });
                authors[entry.id] = { name: userName, person: true, time: timeOf(entry.at) };
            } else {
                const a = lookup(entry.author.agentId);
                messages.push({ id: entry.id, role: 'assistant', actor: a.id, parts });
                authors[entry.id] = { name: a.name, hue: a.hue, environment: a.environment, time: timeOf(entry.at) };
            }
        } else if (entry.t === 'status') {
            const a = lookup(entry.agentId);
            const id = `status:${seq}`;
            messages.push({ id, role: 'assistant', actor: a.id, parts: [{ type: 'text', id: `${id}:0`, text: `*${statusText(entry)}*` }] });
            authors[id] = { name: a.name, hue: a.hue, environment: a.environment, time: timeOf(entry.at) };
        }
    }
    return { messages, authors };
}

/** A session mid-turn: what is being written right now. */
export const sessionMidTurn = (t: AgentTranscript): boolean => t.state === 'running' || t.state === 'awaiting';

/**
 * The assistant rows a session is producing in its current turn — what the
 * thread shows UNDER the chat's entries while the agent works. Once the
 * turn ends the final message reaches the chat as an entry of its own
 * (architecture §6), so the rows are taken from the session only mid-turn.
 */
export function inFlightMessages(t: AgentTranscript): AgentMessage[] {
    if (!sessionMidTurn(t) || !t.turn) return [];
    const turnId = t.turn.turnId;
    return t.messages.filter((m) => m.role === 'assistant' && m.turnId === turnId && m.parentCallId === undefined);
}

export interface SessionFeed {
    readonly sessionId: string;
    readonly agentId: string;
    readonly transcript: AgentTranscript;
    /** The task the session runs, once its record was read — what "Resume" needs. */
    readonly taskId?: string;
}

/**
 * Fold the chat's rows and every active session's in-flight rows into ONE
 * transcript for the Thread — in place, so the Thread's window patches
 * rather than remounts. Requests come from the sessions (an approval the
 * user must answer, CHT-09); the state is `running` while any session is
 * mid-turn, `awaiting` while one waits on an answer.
 */
export function composeTranscript(target: AgentTranscript, entries: EntryTranscript, feeds: readonly SessionFeed[], lookup: AgentLookup): Record<string, MessageAuthor> {
    const authors: Record<string, MessageAuthor> = { ...entries.authors };
    const messages: AgentMessage[] = [...entries.messages];
    const requests: Record<string, OpenRequest> = {};
    let state: AgentTranscript['state'] = 'idle';
    for (const feed of feeds) {
        const a = lookup(feed.agentId);
        for (const m of inFlightMessages(feed.transcript)) {
            messages.push(m);
            authors[m.id] = { name: a.name, hue: a.hue, environment: a.environment };
        }
        Object.assign(requests, feed.transcript.requests);
        if (feed.transcript.state === 'awaiting') state = 'awaiting';
        else if (feed.transcript.state === 'running' && state !== 'awaiting') state = 'running';
    }
    target.messages = messages;
    target.requests = requests;
    target.state = state;
    return authors;
}

/** A fresh transcript to compose into, keyed by the chat. */
export const chatTranscript = (chatKey: string): AgentTranscript => createTranscript(chatKey);

// ---- failure distinction (OPS-04) ------------------------------------------------

/** The interrupted marker as the transcript folds it: the last turn ended `process_exited` and nothing runs. */
export const feedInterrupted = (t: AgentTranscript): boolean => !sessionMidTurn(t) && t.turn?.stopReason === 'error' && t.turn.error?.code === INTERRUPTED_CODE;

export interface ChatFailure {
    readonly state: FailureState;
    readonly agentId: string;
    /** The feed the failure came from — where "Resume" goes. */
    readonly sessionId?: string;
}

/**
 * The chat's one failure to show under the thread, or `null`: a live feed's
 * word first (its transcript says interrupted, errored or disconnected —
 * `failureOf` over the session signal), else the newest failure status the
 * chat recorded since the user last posted (`task-failed` from the router,
 * the Session's `interrupted:` marker) — stale once an agent answered after
 * it (for a failed task: with a message of other work, since the failed
 * turn's own partial text can land after the router's word), and suppressed
 * while a feed of that agent is mid-turn (a resume in flight). Interrupted
 * work is uncertain (OPS-05).
 */
export function chatFailure(entries: readonly IndexedEntry[], feeds: readonly SessionFeed[]): ChatFailure | null {
    for (const feed of feeds) {
        const t = feed.transcript;
        const session = {
            status: t.state,
            ...(t.error && !t.error.recoverable ? { error: { code: t.error.code, message: t.error.message, recoverable: false } } : {}),
            ...(feedInterrupted(t) ? { interrupted: true } : {})
        };
        const state = failureOf({ session, ...(feed.taskId ? { task: { id: feed.taskId, status: 'active' } } : {}) });
        if (state) return { state, agentId: feed.agentId, sessionId: feed.sessionId };
    }
    const busy = new Set(feeds.filter((f) => sessionMidTurn(f.transcript)).map((f) => f.agentId));
    // Agent messages seen after the entry under consideration, by the task they came from (`''` for none).
    const answered = new Set<string>();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!.entry;
        if (entry.t === 'msg') {
            if (entry.author.kind === 'user') break;
            answered.add(entry.taskId ?? '');
            continue;
        }
        if (entry.t !== 'status' || busy.has(entry.agentId)) continue;
        if (entry.kind === 'task-failed') {
            if ([...answered].some((taskId) => taskId !== entry.ref)) continue;
            const state = failureOf({ task: { id: entry.ref, status: 'failed', error: entry.error } });
            if (state) return { state, agentId: entry.agentId };
        }
        if (entry.kind === 'task' && entry.ref?.startsWith('interrupted:')) {
            if (answered.size) continue;
            const feed = feeds.find((f) => f.agentId === entry.agentId);
            const state = failureOf({ session: { status: 'idle', interrupted: true }, ...(feed?.taskId ? { task: { id: feed.taskId, status: 'active' } } : {}) });
            if (state) return { state, agentId: entry.agentId, ...(feed ? { sessionId: feed.sessionId } : {}) };
        }
    }
    return null;
}

// ---- the session wire ------------------------------------------------------------

/** The slice of the Session actor client the transport needs. */
export interface SessionActorClient {
    get(): Promise<SessionInfo>;
    prompt(input: readonly PromptPart[], turnId: string, output?: unknown, commandId?: string): Promise<SessionCommandReply>;
    respond(requestId: string, decision: unknown, commandId?: string): Promise<SessionCommandReply>;
    cancel(agentId?: string, commandId?: string): Promise<SessionCommandReply>;
    configure(patch: Readonly<Record<string, string>>, commandId?: string): Promise<SessionCommandReply>;
    close(commandId?: string): Promise<SessionCommandReply>;
    tail(from?: { readonly epoch: number; readonly seq: number }): AsyncIterable<AgentEvent>;
}

export type SessionCommandReply = WireReply | { readonly v: number; readonly kind: 'pending'; readonly commandId: string };

/** What the hello frame says when the actor has not recorded the runtime's capabilities yet. */
const UNKNOWN_CAPABILITIES = {
    resume: false,
    fork: false,
    cancel: true,
    steer: false,
    config: false,
    structuredOutput: false,
    promptParts: 'text',
    tools: 'none',
    permissions: 'every-call',
    streamingToolInput: false,
    importTranscript: false,
    listSessions: false,
    subagents: 'none',
    defineAgents: false
} as const satisfies AgentCapabilities;

/**
 * `connectSession`'s transport over the Session actor (architecture §4):
 * commands are the actor's own methods (idempotent by `commandId`, so a
 * retried prompt runs once, OPS-06); the event stream is a `hello` built
 * from `get()` followed by `tail(from)` — the durable log replayed from the
 * cursor, then followed. A daemon-hosted session answers `pending` until
 * its machine replies; the events say what happened, so the client treats
 * it as an acknowledgement.
 */
export function actorSessionTransport(client: SessionActorClient, sessionId: string): SessionTransport {
    const ack = (reply: SessionCommandReply): WireReply => (reply.kind === 'pending' ? { v: WIRE_PROTOCOL_VERSION, kind: 'ack', commandId: reply.commandId } : reply);
    return {
        async send(command: WireCommand): Promise<WireReply> {
            switch (command.type) {
                case 'prompt':
                    return ack(await client.prompt(command.input, command.turnId, command.output, command.commandId));
                case 'respond':
                    return ack(await client.respond(command.requestId, command.decision, command.commandId));
                case 'cancel':
                    return ack(await client.cancel(command.agentId, command.commandId));
                case 'configure':
                    return ack(await client.configure(command.patch, command.commandId));
                case 'close':
                    return ack(await client.close(command.commandId));
                default:
                    return { v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: (command as WireCommand).commandId, code: 'unsupported', message: `unsupported command ${(command as { type: string }).type}` };
            }
        },
        events(from, options): AsyncIterable<WireFrame> {
            const signal = options?.signal;
            return {
                async *[Symbol.asyncIterator]() {
                    const info = await client.get();
                    const agentId = info.spec?.agentId ?? 'agent';
                    yield {
                        v: WIRE_PROTOCOL_VERSION,
                        kind: 'hello',
                        agentId,
                        sessionId,
                        sessionRef: info.ref ?? { agent: agentId, v: 1, id: sessionId },
                        capabilities: info.capabilities ?? UNKNOWN_CAPABILITIES,
                        head: info.head
                    };
                    const iterator = client.tail(from)[Symbol.asyncIterator]();
                    const stop = () => void iterator.return?.();
                    signal?.addEventListener('abort', stop, { once: true });
                    try {
                        for (;;) {
                            const next = await iterator.next();
                            if (next.done || signal?.aborted) return;
                            const event = next.value;
                            yield { v: WIRE_PROTOCOL_VERSION, kind: 'event', epoch: event.epoch, seq: event.seq, event };
                        }
                    } finally {
                        signal?.removeEventListener('abort', stop);
                    }
                }
            };
        }
    };
}

// ---- activation ------------------------------------------------------------------

/**
 * The agents a draft addresses: `@Name` tokens resolved against the members, by name (case-insensitive) or id.
 * A name is matched whole, longest first (#279): the picker inserts it as is — spaces, parentheses, an e-mail's
 * own "@" — so "@Claude Code 2 (…" is never read as a member called "Claude". The result is ids; a later rename
 * never changes whom a sent message addressed.
 */
export function mentionsIn(draft: string, members: readonly MockChatMember[], lookup: AgentLookup): AgentId[] {
    const names: { key: string; id: string }[] = [];
    for (const m of members) names.push({ key: lookup(m.agentId).name.toLowerCase(), id: m.agentId }, { key: m.agentId.toLowerCase(), id: m.agentId });
    names.sort((x, y) => y.key.length - x.key.length);
    const text = draft.toLowerCase();
    const word = /[\p{L}\p{N}_-]/u;
    const out: AgentId[] = [];
    let at = text.indexOf('@');
    while (at !== -1) {
        // A mention starts a word: "andy@ekdahls.net" in running text is an address, not a mention.
        const starts = at === 0 || !word.test(text[at - 1]!);
        const hit = starts ? names.find((n) => n.key !== '' && text.startsWith(n.key, at + 1) && !word.test(text[at + 1 + n.key.length] ?? ' ')) : undefined;
        if (hit && !out.includes(hit.id as AgentId)) out.push(hit.id as AgentId);
        // Resume after a matched name: an "@" inside it belongs to the name.
        at = text.indexOf('@', hit ? at + 1 + hit.key.length : at + 1);
    }
    return out;
}

/** How many earlier messages an activation carries as context. */
export const CONTEXT_WINDOW = 50;

/**
 * The task an activation creates (architecture §6): origin = the user's
 * message, objective = its text, context = the entries the agent may read
 * (`historyFrom`, CHT-04) — the last `CONTEXT_WINDOW` of them, oldest
 * first, each attributed — so the session starts with what was said. The
 * member's working folder for this chat (`Chat.setWorkdir`, #193) rides along
 * as the task's `environmentId` + `workdir`, so the router opens the session
 * there instead of the agent's default.
 *
 * Attachments (#207): the chat-file parts of those messages, then of the
 * triggering message (`attachments`), follow the text in `context` as
 * reference parts (`agentic-file:` URIs, never bytes), each once — the
 * router resolves them for the agent when the turn starts (#205: images
 * inlined, other files noted for `chat_file_read`). The objective stays
 * text; a message of attachments alone reads as their placeholders.
 */
export function activationContract(agentId: AgentId, chatId: ChatId, messageId: MessageId, text: string, visible: readonly IndexedEntry[], lookup: AgentLookup, workdir?: WorkdirRef, attachments: readonly PromptPart[] = [], projectId?: ProjectId): TaskContract {
    const messages = visible.filter((e): e is IndexedEntry & { entry: Extract<ChatEntry, { t: 'msg' }> } => e.entry.t === 'msg').slice(-CONTEXT_WINDOW);
    const lines = messages.map((e) => entryLine(e.entry, lookup));
    const context: PromptPart[] = lines.length ? [{ type: 'text', text: `Chat so far:\n${lines.join('\n')}` }] : [];
    const seen = new Set<string>();
    for (const part of [...messages.flatMap((e) => e.entry.parts), ...attachments]) {
        if (!isChatFilePart(part) || seen.has(part.url)) continue;
        seen.add(part.url);
        context.push(part);
    }
    const objective = text || attachments.map(partText).join(' ');
    // The chat's project rides along (#333): the router resolves its folder for the environment unless the member has its own.
    return { objective, origin: { kind: 'user', chatId, messageId }, assignee: agentId, context, constraints: {}, ...(workdir ? { environmentId: workdir.environmentId, workdir: workdir.path } : {}), ...(projectId ? { projectId } : {}) };
}

/** The entries `agentId` may read: from its `historyFrom` on (CHT-04). */
export function visibleTo(entries: readonly IndexedEntry[], summary: ChatSummary, agentId: string): IndexedEntry[] {
    const from = summary.members[agentId]?.historyFrom ?? Number.POSITIVE_INFINITY;
    return entries.filter((e) => e.seq >= from);
}

/** What `runActivation` needs from the actors — thin so a workers test can hand it HTTP clients. */
export interface ActivationPorts {
    /** `Chat.post`: the message's parts — its text, then its attachments. */
    post(parts: readonly PromptPart[], mentions: readonly AgentId[]): Promise<{ readonly messageId: MessageId; readonly activated: readonly AgentId[] }>;
    createTask(id: TaskId, contract: TaskContract, owner: AgentId): Promise<unknown>;
    run(taskId: TaskId): Promise<unknown>;
    /** A fresh task id per activation. */
    newTaskId(): TaskId;
}

export interface Activation {
    readonly messageId: MessageId;
    readonly tasks: readonly { readonly agentId: AgentId; readonly taskId: TaskId }[];
}

/** The parts a message posts: its text (when there is any), then its attachments. */
export function messageParts(text: string, attachments: readonly PromptPart[] = []): PromptPart[] {
    return [...(text ? [{ type: 'text', text } as const] : []), ...attachments];
}

/** An uploaded chat file as the part a message carries (#207): an `image` part for an image type, a `file` part with its name otherwise. */
export function attachmentPart(file: { readonly name: string; readonly mediaType: string }, uri: string): ChatFilePart {
    return file.mediaType.startsWith('image/') ? { type: 'image', mediaType: file.mediaType, url: uri } : { type: 'file', mediaType: file.mediaType, name: file.name, url: uri };
}

/**
 * Post, then start one task per activated agent and hand each to the
 * router (`Routing.run`, PR #102) — the path from a message to a running
 * session. The post is durable before any task exists; a task that fails
 * to route reports through its own record, never by un-posting.
 */
export async function runActivation(ports: ActivationPorts, input: { chatId: ChatId; text: string; attachments?: readonly PromptPart[]; mentions: readonly AgentId[]; summary: ChatSummary; entries: readonly IndexedEntry[]; lookup: AgentLookup }): Promise<Activation> {
    const attachments = input.attachments ?? [];
    const { messageId, activated } = await ports.post(messageParts(input.text, attachments), input.mentions);
    const tasks: { agentId: AgentId; taskId: TaskId }[] = [];
    for (const agentId of activated) {
        const taskId = ports.newTaskId();
        const contract = activationContract(agentId, input.chatId, messageId, input.text, visibleTo(input.entries, input.summary, agentId), input.lookup, input.summary.members[agentId]?.workdir, attachments, input.summary.projectId);
        await ports.createTask(taskId, contract, agentId);
        await ports.run(taskId);
        tasks.push({ agentId, taskId });
    }
    return { messageId, tasks };
}
