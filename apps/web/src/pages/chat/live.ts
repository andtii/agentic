/**
 * The live chat's view model (#34): pure adapters from what the actors
 * return — `Chat.get`, `Chat.history`, `Agent.get`, a Session's event
 * tail — to what the pages already render from the mock workspace
 * (`MockChatSummary`, `MockChatMember`, the Thread's transcript and
 * authors). Nothing here touches a hook or the DOM, so every rule is
 * unit-testable and `LiveChat.tsx` stays wiring.
 */
import type { AgentId, ChatEntry, ChatId, MessageId, PromptPart, TaskContract, TaskId } from '@agentic/core';
import type { AgentView, ChatSummary, IndexedEntry, SessionInfo } from '@agentic/platform';
import { createTranscript, type AgentCapabilities, type AgentEvent } from '@sigx/ai-agent';
import type { AgentMessage, AgentPart, AgentTranscript, OpenRequest } from '@sigx/ai-agent/app';
import { WIRE_PROTOCOL_VERSION, type SessionTransport, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { hueFor, type AgentHue, type EnvironmentParts, type MessageAuthor } from '@agentic/ui';
import { formatTime, USER, type MockChatMember, type MockChatSummary } from '../../mock/workspace';

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
        configVersion: view.configVersion
    };
}

/** A lookup over loaded identities with the unknown fallback. */
export function lookupOver(agents: Readonly<Record<string, AgentIdentity>>): AgentLookup {
    return (id) => agents[id] ?? unknownAgent(id);
}

// ---- membership and summaries ------------------------------------------------

/** `Chat.get()` → the members as the panel and the composer read them. */
export function membersOf(summary: ChatSummary): MockChatMember[] {
    return Object.entries(summary.members).map(([agentId, m]) => ({
        agentId,
        status: summary.activeSessions[agentId] ? 'active' : 'idle',
        ...(summary.coordinator === agentId ? { coordinator: true } : {}),
        history: m.historyFrom === 0 ? { access: 'all' } : { access: 'from', at: m.since }
    }));
}

/**
 * The chat's title: its members' names (a direct chat with Atlas is
 * "Atlas"; a group is "Atlas, Forge, Lint"), "New chat" before anyone has
 * joined. The Chat actor stores no title yet — a named chat is a
 * follow-up on the platform lane (see the PR).
 */
export function chatTitle(members: readonly MockChatMember[], lookup: AgentLookup): string {
    return members.length ? members.map((m) => lookup(m.agentId).name).join(', ') : 'New chat';
}

/** The text of a message entry, one line, for a list row. */
export function entryLine(entry: ChatEntry, lookup: AgentLookup): string {
    switch (entry.t) {
        case 'msg': {
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
    }
}

/** A chat row for the list: `Chat.get()` plus its newest entries (the last line and the update time). */
export function chatRow(id: string, summary: ChatSummary, newest: readonly IndexedEntry[], lookup: AgentLookup): MockChatSummary {
    const members = membersOf(summary);
    const last = newest[newest.length - 1];
    return {
        id,
        title: chatTitle(members, lookup),
        members,
        lastLine: last ? entryLine(last.entry, lookup) : '',
        unread: 0,
        waiting: false,
        updatedAt: last?.entry.at ?? 0
    };
}

// ---- the transcript --------------------------------------------------------------

const partText = (p: PromptPart): string => {
    switch (p.type) {
        case 'text':
            return p.text;
        case 'image':
            return '[image]';
        case 'file':
            return `[file${p.name ? ` ${p.name}` : ''}]`;
        case 'resource':
            return `[${p.uri}]`;
    }
};

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

const timeOf = (at: number): MessageAuthor['time'] => ({ text: formatTime(at), dateTime: new Date(at).toISOString() });

export interface EntryTranscript {
    readonly messages: AgentMessage[];
    readonly authors: Record<string, MessageAuthor>;
}

/**
 * Chat entries → thread rows. A `msg` is a user or assistant message; a
 * `status` entry is an assistant row of the responsible agent (CHT-02)
 * with the status in italics; membership and coordinator entries are not
 * rows (the members panel shows them).
 */
export function entryTranscript(entries: readonly IndexedEntry[], lookup: AgentLookup, userName = USER.name): EntryTranscript {
    const messages: AgentMessage[] = [];
    const authors: Record<string, MessageAuthor> = {};
    for (const { seq, entry } of entries) {
        if (entry.t === 'msg') {
            const parts: AgentPart[] = entry.parts.map((p, i) => ({ type: 'text', id: `${entry.id}:${i}`, text: partText(p) }));
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

/** The agents a draft addresses: `@Name` tokens resolved against the members, by name (case-insensitive) or id. */
export function mentionsIn(draft: string, members: readonly MockChatMember[], lookup: AgentLookup): AgentId[] {
    const byName = new Map<string, string>();
    for (const m of members) {
        byName.set(lookup(m.agentId).name.toLowerCase(), m.agentId);
        byName.set(m.agentId.toLowerCase(), m.agentId);
    }
    const out: AgentId[] = [];
    for (const match of draft.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
        const id = byName.get(match[1]!.toLowerCase());
        if (id && !out.includes(id as AgentId)) out.push(id as AgentId);
    }
    return out;
}

/** How many earlier messages an activation carries as context. */
export const CONTEXT_WINDOW = 50;

/**
 * The task an activation creates (architecture §6): origin = the user's
 * message, objective = its text, context = the entries the agent may read
 * (`historyFrom`, CHT-04) — the last `CONTEXT_WINDOW` of them, oldest
 * first, each attributed — so the session starts with what was said.
 */
export function activationContract(agentId: AgentId, chatId: ChatId, messageId: MessageId, text: string, visible: readonly IndexedEntry[], lookup: AgentLookup): TaskContract {
    const lines = visible
        .filter((e): e is IndexedEntry & { entry: Extract<ChatEntry, { t: 'msg' }> } => e.entry.t === 'msg')
        .slice(-CONTEXT_WINDOW)
        .map((e) => entryLine(e.entry, lookup));
    const context: PromptPart[] = lines.length ? [{ type: 'text', text: `Chat so far:\n${lines.join('\n')}` }] : [];
    return { objective: text, origin: { kind: 'user', chatId, messageId }, assignee: agentId, context, constraints: {} };
}

/** The entries `agentId` may read: from its `historyFrom` on (CHT-04). */
export function visibleTo(entries: readonly IndexedEntry[], summary: ChatSummary, agentId: string): IndexedEntry[] {
    const from = summary.members[agentId]?.historyFrom ?? Number.POSITIVE_INFINITY;
    return entries.filter((e) => e.seq >= from);
}

/** What `runActivation` needs from the actors — thin so a workers test can hand it HTTP clients. */
export interface ActivationPorts {
    post(text: string, mentions: readonly AgentId[]): Promise<{ readonly messageId: MessageId; readonly activated: readonly AgentId[] }>;
    createTask(id: TaskId, contract: TaskContract, owner: AgentId): Promise<unknown>;
    run(taskId: TaskId): Promise<unknown>;
    /** A fresh task id per activation. */
    newTaskId(): TaskId;
}

export interface Activation {
    readonly messageId: MessageId;
    readonly tasks: readonly { readonly agentId: AgentId; readonly taskId: TaskId }[];
}

/**
 * Post, then start one task per activated agent and hand each to the
 * router (`Routing.run`, PR #102) — the path from a message to a running
 * session. The post is durable before any task exists; a task that fails
 * to route reports through its own record, never by un-posting.
 */
export async function runActivation(ports: ActivationPorts, input: { chatId: ChatId; text: string; mentions: readonly AgentId[]; summary: ChatSummary; entries: readonly IndexedEntry[]; lookup: AgentLookup }): Promise<Activation> {
    const { messageId, activated } = await ports.post(input.text, input.mentions);
    const tasks: { agentId: AgentId; taskId: TaskId }[] = [];
    for (const agentId of activated) {
        const taskId = ports.newTaskId();
        const contract = activationContract(agentId, input.chatId, messageId, input.text, visibleTo(input.entries, input.summary, agentId), input.lookup);
        await ports.createTask(taskId, contract, agentId);
        await ports.run(taskId);
        tasks.push({ agentId, taskId });
    }
    return { messageId, tasks };
}
