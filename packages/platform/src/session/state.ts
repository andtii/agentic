/**
 * Session actor state and the entry reducer behind `ctx.append`.
 *
 * The record is the event log itself: every `AgentEvent` is one `ev`
 * entry, folded in append order by `applySessionEntry`, which must be a
 * pure function of (state, entry) — it runs once live and again on every
 * activation replaying the record's log. No clock, no ids in here.
 *
 * Only a WINDOW of the log stays in the record (#198): a Durable Object
 * value is capped at 2 MB, and a long daemon turn streams megabytes. Once
 * the window passes `WINDOW_BYTES` the actor stores its oldest slice in a
 * `SessionPage` and appends a `roll` entry that drops it here — so a
 * replay folds the same window. What whole-history readers need (requests
 * and their decisions, turn boundaries, the calls requests ask about) is
 * kept in `index`; `knownEvents` is that index before the window, then
 * the window.
 *
 * The record itself is bounded (#391): the index carries no prompt (a
 * `turn-start` is indexed stripped of its `input`, with a byte count) and
 * keeps only the last `INDEX_TURNS` turns, a replied command forgets its
 * input, and a single-record reader (`findEvent`, `requestById`) scans
 * newest-first without materialising the log.
 */

import type { Correction, Principal, SessionId, TaskId, TaskOutcome, WorkspaceId } from '@agentic/core';
import type { AgentCapabilities, AgentEvent, AgentTranscript, EventCursor, PromptPart, SessionRef } from '@sigx/ai-agent';
import type { WireCommand, WireReply } from '@sigx/ai-agent/wire';

import type { SessionOpenSpec } from './ports.js';

type RequestEvent = Extract<AgentEvent, { type: 'request' }>;
type RequestResolvedEvent = Extract<AgentEvent, { type: 'request-resolved' }>;

/** What the last finished turn taught (architecture §8): the outcome the plugin saw and what it proposed. */
export interface LearningRecord {
    readonly turnId: string;
    readonly at: number;
    readonly status: TaskOutcome['status'];
    readonly verification: TaskOutcome['verification'];
    /** Memory proposals the plugin applied. */
    readonly written: number;
    /** Instruction proposals parked for review. */
    readonly parked: number;
    /** Learning failed; the turn itself did not. */
    readonly error?: string;
}

/** A correction made through `correct` — the lesson itself lives in memory with its provenance. */
export interface CorrectionRecord {
    readonly messageId: string;
    readonly what: Correction['what'];
    readonly by: Correction['by'];
    readonly at: number;
    readonly written: number;
    readonly parked: number;
}

/** UTF-8 JSON bytes the window may hold before its oldest slice is paged out. */
export const WINDOW_BYTES = 512 * 1024;
/** About how many UTF-8 JSON bytes one page takes from the window. */
export const PAGE_BYTES = 256 * 1024;

/** One archived slice of the log: `SessionPage` `{sessionKey}:p{page}`, its first and last cursors. */
export interface SessionPageMeta {
    readonly page: number;
    readonly count: number;
    readonly first: EventCursor;
    readonly last: EventCursor;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting' | 'closed' | 'error' | 'disconnected';

/** `local`: the actor drives an in-process `AgentSession`; `remote`: a daemon does and forwards frames. */
export type SessionMode = 'local' | 'remote';

/**
 * The turn in flight — what a restarted driver reads to know a turn was cut short.
 * The turn, not the session, is what a task owns (#390): `taskId` is the task this
 * turn works, from the prompt that started it, else the task the session opened with.
 */
export interface RunningTurn {
    readonly turnId: string;
    readonly commandId: string;
    readonly input: readonly PromptPart[];
    readonly startedAt: number;
    readonly taskId?: TaskId;
}

/**
 * One command by its idempotency key: what was sent while its reply is out and, once known, the reply.
 * A replied command forgets its input (#391): `command` — a prompt carries the whole prompt, images
 * inlined — is dropped, and only the id, the type and the reply stay for the retry to answer with.
 * `taskId` is record-level — the task a prompt was sent for (#390) — never part of the `WireCommand`
 * itself, so a daemon's ack (`commandReplied`) starts the turn under the right task; it survives the reply.
 */
export interface CommandRecord {
    readonly commandId: string;
    readonly type: WireCommand['type'];
    readonly at: number;
    /** The command as sent — until its reply is known. */
    readonly command?: WireCommand;
    readonly reply?: WireReply;
    readonly taskId?: TaskId;
}

/** A `turn-start` as the index holds it (#391): the prompt stays in the window or a page; here only what it weighed. */
export interface IndexedTurnStart {
    readonly type: 'turn-start';
    readonly turnId: string;
    readonly epoch: number;
    readonly seq: number;
    readonly sessionId: string;
    /** UTF-8 JSON bytes of the whole event. */
    readonly bytes: number;
}

/** What the index holds: an indexed event as it was, or a `turn-start` without its prompt. */
export type IndexEntry = AgentEvent | IndexedTurnStart;

/** Turn-starts the index keeps: older entries leave it on a roll, and `eventsSince` reaches the pages for them. */
export const INDEX_TURNS = 64;

export interface SessionState {
    opened: boolean;
    spec?: SessionOpenSpec;
    mode?: SessionMode;
    ref?: SessionRef;
    capabilities?: AgentCapabilities;
    status: SessionStatus;
    /** The last `(epoch, seq)` in `events`. */
    head: EventCursor;
    /** The recent end of the durable event log, in `(epoch, seq)` order (= `EventLogStore`); older events are in `pages`. */
    events: AgentEvent[];
    /** JSON bytes of `events`, kept per event (never recomputed while it grows). */
    windowBytes?: number;
    /** The slices paged out of `events`, oldest first. */
    pages?: SessionPageMeta[];
    /** How many events `pages` hold. */
    archived?: number;
    /**
     * Every `request`, `request-resolved`, `turn-start` (stripped of its prompt) and `turn-end`, and the `tool-call`
     * a request asks about, in cursor order — for the last `INDEX_TURNS` turns; whole-history readers never read a page.
     */
    index?: IndexEntry[];
    /** Snapshot taken at every turn end (= `TranscriptStore`). */
    transcript?: AgentTranscript;
    running?: RunningTurn;
    /** Unresolved `request` ids. */
    openRequests: string[];
    commands: Record<string, CommandRecord>;
    /** Oldest first; `commands` is capped to `MAX_COMMANDS` by dropping from here. */
    commandOrder: string[];
    /** A daemon replay that could not be filled (OPS-04): the stream resumed at `resumeAt`. */
    gap?: { readonly from: EventCursor; readonly resumeAt: EventCursor; readonly at: number };
    closedAt?: number;
    /** The last finished turn's learning, when the actor has learning ports. */
    learning?: LearningRecord;
    /** Corrections made on this session's messages, oldest first. */
    corrections?: CorrectionRecord[];
    /**
     * Requests the PLATFORM raised (`raiseInput`, #122) rather than the runtime — `respond` settles
     * these itself, since the live `AgentSession` does not know them.
     */
    platformRequests?: string[];
    /**
     * Platform requests whose tool call stopped waiting (#285): `ask_user` answered `pending`. With the session
     * closed, every open platform request counts as detached too. An answer to one re-activates the asker.
     */
    detachedRequests?: string[];
    /** Answers to detached requests that came while the session was still open: handed to `answered` when it closes (#285). */
    answeredDetached?: DetachedAnswer[];
}

/** A detached request's answer, parked until the session closes (#285). */
export interface DetachedAnswer {
    readonly requestId: string;
    /** Who answered — the principal the follow-up posts the answer as. */
    readonly answeredBy: Principal;
}

/** Replies remembered for idempotent retries (OPS-06); the same default as `serveSession`. */
export const MAX_COMMANDS = 256;

export type SessionPatch = Partial<Pick<SessionState, 'opened' | 'spec' | 'mode' | 'ref' | 'capabilities' | 'status' | 'head' | 'transcript' | 'running' | 'gap' | 'closedAt' | 'learning' | 'corrections' | 'platformRequests' | 'detachedRequests' | 'answeredDetached'>>;

export type SessionEntry =
    | { readonly t: 'ev'; readonly ev: AgentEvent }
    | { readonly t: 'set'; readonly patch: SessionPatch }
    /** A command sent to a daemon whose reply is still out; `taskId` is the task a prompt is sent for (#390). */
    | { readonly t: 'command'; readonly command: WireCommand; readonly at: number; readonly taskId?: TaskId }
    | { readonly t: 'reply'; readonly command: WireCommand; readonly reply: WireReply; readonly at: number; readonly taskId?: TaskId }
    /** The oldest `page.count` events of the window are stored in page `page.page`: drop them from the record. */
    | { readonly t: 'roll'; readonly page: SessionPageMeta };

export function initialSessionState(): SessionState {
    return { opened: false, status: 'idle', head: { epoch: 0, seq: 0 }, events: [], openRequests: [], commands: {}, commandOrder: [] };
}

/** `ev` is strictly after `head`. */
export function cursorAfter(head: EventCursor, ev: EventCursor): boolean {
    return ev.epoch > head.epoch || (ev.epoch === head.epoch && ev.seq > head.seq);
}

/**
 * The cursor of an event the platform appends between two runtime events
 * (a platform-raised request, #122): strictly after `head`, strictly before
 * the runtime's next integer `seq` — so it is never taken for, nor skips, a
 * runtime event on either path (`applyEvent` folds by cursor; a local driver
 * subscribes from the head; a daemon replays from the Machine's own cursor).
 * Fractional on purpose; a runtime never stamps one.
 */
export function platformCursor(head: EventCursor): EventCursor {
    return { epoch: head.epoch, seq: (head.seq + Math.floor(head.seq) + 1) / 2 };
}

export function applySessionEntry(state: SessionState, entry: SessionEntry): void {
    switch (entry.t) {
        case 'ev':
            applyEvent(state, entry.ev);
            return;
        case 'set':
            for (const [k, v] of Object.entries(entry.patch)) {
                if (v === undefined) delete (state as unknown as Record<string, unknown>)[k];
                else (state as unknown as Record<string, unknown>)[k] = v;
            }
            return;
        case 'command': {
            const id = entry.command.commandId;
            if (!state.commands[id]) remember(state, id, { commandId: id, type: entry.command.type, at: entry.at, command: entry.command, ...(entry.taskId ? { taskId: entry.taskId } : {}) });
            return;
        }
        case 'reply': {
            const id = entry.command.commandId;
            const known = state.commands[id];
            const taskId = entry.taskId ?? known?.taskId;
            // Replied: the input is forgotten, the reply is what a retry gets (#391); the task stays on the record.
            remember(state, id, { commandId: id, type: entry.command.type, at: known?.at ?? entry.at, reply: entry.reply, ...(taskId ? { taskId } : {}) });
            return;
        }
        case 'roll': {
            // Idempotent: a page already rolled (a replayed entry) drops nothing twice.
            if ((state.pages ?? []).some((p) => p.page === entry.page.page)) return;
            const dropped = state.events.splice(0, entry.page.count);
            state.windowBytes = Math.max(0, (state.windowBytes ?? 0) - bytesOf(dropped));
            (state.pages ??= []).push(entry.page);
            state.archived = (state.archived ?? 0) + dropped.length;
            rollIndex(state);
            return;
        }
    }
}

/**
 * UTF-8 bytes of `text` — what a Durable Object value is measured in. `length` counts UTF-16 code
 * units and undercounts anything past ASCII up to threefold; no allocation, so it runs per event.
 */
export function utf8Bytes(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            // A surrogate pair is one 4-byte code point.
            n += 4;
            i++;
        } else n += 3;
    }
    return n;
}

/** UTF-8 bytes of `value` as JSON — the unit every budget of the record counts in. */
export const jsonBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value ?? null));

/** UTF-8 JSON bytes of `events` — the unit the window budget counts in. */
export function bytesOf(events: readonly AgentEvent[]): number {
    let n = 0;
    for (const e of events) n += jsonBytes(e);
    return n;
}

/** The index types: what a whole-history reader looks up. */
const INDEXED: ReadonlySet<AgentEvent['type']> = new Set(['request', 'request-resolved', 'turn-start', 'turn-end']);

/** Insert `entry` into the index in cursor order, once. */
function indexEvent(state: SessionState, entry: IndexEntry): void {
    const index = (state.index ??= []);
    if (index.some((e) => e.epoch === entry.epoch && e.seq === entry.seq)) return;
    let at = index.length;
    while (at > 0 && cursorAfter(entry, index[at - 1]!)) at--;
    index.splice(at, 0, entry);
}

/** `ev` as the index holds a `turn-start`: its cursor, its turn, and the bytes the whole event took — never the prompt. */
function stripTurnStart(ev: Extract<AgentEvent, { type: 'turn-start' }>, bytes: number): IndexedTurnStart {
    return { type: 'turn-start', turnId: ev.turnId ?? '', epoch: ev.epoch, seq: ev.seq, sessionId: ev.sessionId, bytes };
}

/** The `tool-call` a request asks about, from the window, into the index. */
function indexCall(state: SessionState, callId: string): void {
    const call = state.events.findLast((e) => e.type === 'tool-call' && e.callId === callId);
    if (call) indexEvent(state, call);
}

/**
 * Bound the index (#391): keep the last `INDEX_TURNS` turn-starts and everything since, drop what is
 * older — except a request still open (a detached question outlives its turn, #285) and the call it
 * asks about, which `request(id)` must still find. What leaves is still in the pages (`eventsSince`).
 */
function rollIndex(state: SessionState): void {
    const index = state.index;
    if (!index) return;
    let turns = 0;
    let keepFrom = 0;
    for (let i = index.length - 1; i >= 0; i--) {
        if (index[i]!.type !== 'turn-start') continue;
        if (++turns === INDEX_TURNS) {
            keepFrom = i;
            break;
        }
    }
    if (keepFrom === 0) return;
    const open = new Set(state.openRequests);
    const calls = new Set<string>();
    for (const e of index) if (e.type === 'request' && open.has(e.requestId) && e.callId !== undefined) calls.add(e.callId);
    const kept = index.slice(0, keepFrom).filter((e) => (e.type === 'request' && open.has(e.requestId)) || (e.type === 'tool-call' && calls.has(e.callId)));
    index.splice(0, keepFrom, ...kept);
}

/** `e` is an event as it was logged — not a `turn-start` the index stripped of its prompt (the one non-event the index holds). */
export function isWholeEvent(e: IndexEntry): e is AgentEvent {
    return e.type !== 'turn-start' || 'input' in e;
}

/** The events a whole-history reader sees without a page: the index older than the window, then the window. */
export function knownEvents(state: Pick<SessionState, 'events' | 'index'>): IndexEntry[] {
    const first = state.events[0];
    const older = (state.index ?? []).filter((e) => !first || cursorAfter(e, first));
    return [...older, ...state.events];
}

/**
 * The task the session works RIGHT NOW (#390): the running turn's, else the one it opened with. A session
 * serves many tasks over its life (§7), so everything attributed to a task — the minted principal, a
 * `delegate` parent, a `task_report`, a Ledger row, an audit row, a memory's provenance — reads this,
 * never `spec.taskId` alone.
 */
export function currentTaskId(s: Pick<SessionState, 'running' | 'spec'>): TaskId | undefined {
    return s.running?.taskId ?? s.spec?.taskId;
}

/**
 * The newest entry `pred` accepts, without materialising the log (#391): the window newest-first,
 * then the index before the window. A `turn-start` found in the index carries no `input`.
 */
export function findEvent(state: Pick<SessionState, 'events' | 'index'>, pred: (e: IndexEntry) => boolean): IndexEntry | undefined {
    const { events } = state;
    for (let i = events.length - 1; i >= 0; i--) if (pred(events[i]!)) return events[i];
    const index = state.index ?? [];
    const first = events[0];
    for (let i = index.length - 1; i >= 0; i--) {
        const e = index[i]!;
        // The index's tail overlaps the window, which was just scanned.
        if (first && !cursorAfter(e, first)) continue;
        if (pred(e)) return e;
    }
    return undefined;
}

/** One request and, once decided, its decision — the lookup a request card, a `respond` and `resolution` make. */
export function requestById(state: Pick<SessionState, 'events' | 'index'>, requestId: string): { readonly request: RequestEvent; readonly resolved?: RequestResolvedEvent } | undefined {
    const request = findEvent(state, (e) => e.type === 'request' && e.requestId === requestId) as RequestEvent | undefined;
    if (!request) return undefined;
    const resolved = findEvent(state, (e) => e.type === 'request-resolved' && e.requestId === requestId) as RequestResolvedEvent | undefined;
    return resolved ? { request, resolved } : { request };
}

function remember(state: SessionState, id: string, record: CommandRecord): void {
    if (!state.commands[id]) state.commandOrder.push(id);
    state.commands[id] = record;
    while (state.commandOrder.length > MAX_COMMANDS) {
        const oldest = state.commandOrder.shift()!;
        delete state.commands[oldest];
    }
}

function applyEvent(state: SessionState, ev: AgentEvent): void {
    // Idempotent: a frame replayed twice, or a live subscription overlapping the log, folds once.
    if (!cursorAfter(state.head, ev)) return;
    state.events.push(ev);
    const bytes = jsonBytes(ev);
    state.windowBytes = (state.windowBytes ?? 0) + bytes;
    if (ev.type === 'turn-start') indexEvent(state, stripTurnStart(ev, bytes));
    else if (INDEXED.has(ev.type)) indexEvent(state, ev);
    if (ev.type === 'request' && ev.callId !== undefined) indexCall(state, ev.callId);
    state.head = { epoch: ev.epoch, seq: ev.seq };
    const closed = state.status === 'closed';
    switch (ev.type) {
        case 'turn-start':
            if (!closed) state.status = 'running';
            return;
        case 'request':
            if (!state.openRequests.includes(ev.requestId)) state.openRequests.push(ev.requestId);
            if (!closed) state.status = 'awaiting';
            return;
        case 'request-resolved': {
            const i = state.openRequests.indexOf(ev.requestId);
            if (i >= 0) state.openRequests.splice(i, 1);
            if (state.status === 'awaiting' && state.openRequests.length === 0) state.status = state.running ? 'running' : 'idle';
            return;
        }
        case 'turn-end':
            if (state.running && state.running.turnId === ev.turnId) delete state.running;
            if (!closed) state.status = 'idle';
            return;
        case 'state':
            state.status = ev.value;
            return;
        case 'error':
            if (!ev.recoverable && !closed) state.status = 'error';
            return;
        default:
            return;
    }
}

/** `{ws}:session:{id}` → its parts, or `null` for a key that is not a session key. */
export function parseSessionKey(key: string): { readonly workspaceId: WorkspaceId; readonly sessionId: SessionId } | null {
    const parts = key.split(':');
    if (parts.length !== 3 || parts[1] !== 'session' || !parts[0] || !parts[2]) return null;
    return { workspaceId: parts[0] as WorkspaceId, sessionId: parts[2] as SessionId };
}

/** Events of `sessionId` (any session when omitted) after `from` (exclusive), oldest first. */
export function eventsAfter(events: readonly AgentEvent[], from?: EventCursor, sessionId?: string): AgentEvent[] {
    // Sorted by construction: find the first event after `from` from the end, which is where a follower stands.
    let start = events.length;
    if (from) {
        while (start > 0 && cursorAfter(from, events[start - 1]!)) start--;
    } else start = 0;
    const out = events.slice(start);
    return sessionId === undefined ? out : out.filter((e) => e.sessionId === sessionId);
}

