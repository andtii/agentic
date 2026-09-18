/**
 * Session actor state and the entry reducer behind `ctx.append`.
 *
 * The record is the event log itself: every `AgentEvent` is one `ev`
 * entry, folded in append order by `applySessionEntry`, which must be a
 * pure function of (state, entry) — it runs once live and again on every
 * activation replaying the record's log. No clock, no ids in here.
 */

import type { Correction, SessionId, TaskOutcome, WorkspaceId } from '@agentic/core';
import type { AgentCapabilities, AgentEvent, AgentTranscript, EventCursor, PromptPart, SessionRef } from '@sigx/ai-agent';
import type { WireCommand, WireReply } from '@sigx/ai-agent/wire';

import type { SessionOpenSpec } from './ports.js';

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

export type SessionStatus = 'idle' | 'running' | 'awaiting' | 'closed' | 'error' | 'disconnected';

/** `local`: the actor drives an in-process `AgentSession`; `remote`: a daemon does and forwards frames. */
export type SessionMode = 'local' | 'remote';

/** The turn in flight — what a restarted driver reads to know a turn was cut short. */
export interface RunningTurn {
    readonly turnId: string;
    readonly commandId: string;
    readonly input: readonly PromptPart[];
    readonly startedAt: number;
}

/** One command by its idempotency key: what was sent and, once known, the reply. */
export interface CommandRecord {
    readonly command: WireCommand;
    readonly at: number;
    readonly reply?: WireReply;
}

export interface SessionState {
    opened: boolean;
    spec?: SessionOpenSpec;
    mode?: SessionMode;
    ref?: SessionRef;
    capabilities?: AgentCapabilities;
    status: SessionStatus;
    /** The last `(epoch, seq)` in `events`. */
    head: EventCursor;
    /** The durable event log, in `(epoch, seq)` order (= `EventLogStore`). */
    events: AgentEvent[];
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
}

/** Replies remembered for idempotent retries (OPS-06); the same default as `serveSession`. */
export const MAX_COMMANDS = 256;

export type SessionPatch = Partial<Pick<SessionState, 'opened' | 'spec' | 'mode' | 'ref' | 'capabilities' | 'status' | 'head' | 'transcript' | 'running' | 'gap' | 'closedAt' | 'learning' | 'corrections' | 'platformRequests'>>;

export type SessionEntry =
    | { readonly t: 'ev'; readonly ev: AgentEvent }
    | { readonly t: 'set'; readonly patch: SessionPatch }
    /** A command sent to a daemon whose reply is still out. */
    | { readonly t: 'command'; readonly command: WireCommand; readonly at: number }
    | { readonly t: 'reply'; readonly command: WireCommand; readonly reply: WireReply; readonly at: number };

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
        case 'command':
            if (!state.commands[entry.command.commandId]) remember(state, entry.command.commandId, { command: entry.command, at: entry.at });
            return;
        case 'reply': {
            const id = entry.command.commandId;
            const known = state.commands[id];
            remember(state, id, { command: entry.command, at: known?.at ?? entry.at, reply: entry.reply });
            return;
        }
    }
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

