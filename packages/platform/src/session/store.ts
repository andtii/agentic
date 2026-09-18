/**
 * `@sigx/ai-agent`'s store seams over the actor's own record: `EventLogStore`
 * is one `ev` entry per event plus a read over the folded log,
 * `TranscriptStore` the snapshot the driver takes at every turn end.
 *
 * `appendEntry` is the one write path: `ctx.append(entry)` (@sigx/actors
 * 0.10, #312), which folds the entry through the definition's
 * `applyEntry` — `applySessionEntry` — and writes the entry alone, O(entry)
 * on a storage with `appendText` (Durable Objects since
 * signalxjs/actors#375); a full save compacts the log. A context without
 * `append` (a test double) folds the entry itself and saves — the same state
 * either way. Promotion candidate (docs/promotion.md).
 */

import type { AgentEvent, AgentTranscript, EventCursor, EventLogStore, TranscriptStore } from '@sigx/ai-agent';
import type { AgentPart } from '@sigx/ai-agent/app';

import { applySessionEntry, eventsAfter, type SessionEntry, type SessionState } from './state.js';

/** The slice of `ActorContext<SessionState>` the stores use — the real context satisfies it inside a turn. */
export interface SessionStoreContext {
    readonly state: SessionState;
    save(): Promise<void>;
    snapshot(): SessionState;
    /** `ctx.append`: fold through the definition's `applyEntry` and write the entry alone. */
    append?(entry: unknown): Promise<void>;
}

/** Fold `entry` into the state and make it durable — call only inside a turn. */
export async function appendEntry(ctx: SessionStoreContext, entry: SessionEntry): Promise<void> {
    if (typeof ctx.append === 'function') {
        await ctx.append(entry);
        return;
    }
    applySessionEntry(ctx.state, entry);
    await ctx.save();
}

/**
 * The stored transcript snapshot's budget (#198). With the event window (`WINDOW_BYTES`) it keeps
 * the Session record under a Durable Object value's 2 MB whatever the session's length.
 */
export const TRANSCRIPT_BYTES = 1024 * 1024;

const trimmed = (bytes: number): string => `[trimmed from the stored snapshot: ${Math.max(1, Math.round(bytes / 1024))} KB — the session's events keep it]`;
const sizeOf = (v: unknown): number => JSON.stringify(v ?? null).length;

/** Drop a part's bulk (tool output, content blocks, streaming argument text; reasoning text and provider data); the bytes saved. */
function trimBulk(part: AgentPart): number {
    const before = sizeOf(part);
    if (part.type === 'tool') {
        const p = part as { output?: unknown; content?: unknown; inputText?: string };
        if (p.output !== undefined && sizeOf(p.output) > 256) p.output = trimmed(sizeOf(p.output));
        delete p.content;
        delete p.inputText;
    } else if (part.type === 'reasoning') {
        if (part.text.length > 256) part.text = trimmed(part.text.length);
        delete part.providerData;
    }
    return before - sizeOf(part);
}

/** Drop a tool call's large arguments (a written file's contents); the bytes saved. */
function trimInput(part: AgentPart): number {
    if (part.type !== 'tool') return 0;
    const p = part as { input?: unknown };
    if (p.input === undefined || sizeOf(p.input) <= 1024) return 0;
    const before = sizeOf(part);
    p.input = { trimmed: trimmed(sizeOf(p.input)) };
    return before - sizeOf(part);
}

/**
 * `transcript` as the record may keep it (#198): unchanged under `budget`; past it, a copy whose
 * OLDEST messages lose their bulk first — tool outputs and content, reasoning text — then their large
 * tool arguments, each replaced by a marker saying so, until it fits. The newest message is never
 * touched, and nothing is lost for good: the event log (window and pages) keeps every byte. On the API
 * path this is also the model's history on resume, which then sees the old outputs as trimmed.
 */
export function boundTranscript(transcript: AgentTranscript, budget: number = TRANSCRIPT_BYTES): AgentTranscript {
    let size = sizeOf(transcript);
    if (size <= budget) return transcript;
    const out = structuredClone(transcript);
    for (const pass of [trimBulk, trimInput]) {
        for (let i = 0; i < out.messages.length - 1 && size > budget; i++) {
            for (const part of out.messages[i]!.parts) size -= pass(part);
        }
    }
    // Last resort — one message alone past the budget (an enormous answer or output): the largest parts
    // anywhere, text too, until it fits. The bound is a guarantee, not a best effort.
    if (size > budget) {
        const parts = out.messages.flatMap((m) => m.parts).sort((a, b) => sizeOf(b) - sizeOf(a));
        for (const part of parts) {
            if (size <= budget) break;
            size -= trimBulk(part) + trimInput(part);
            if (part.type === 'text' && part.text.length > 256) {
                const before = sizeOf(part);
                part.text = trimmed(part.text.length);
                size -= before - sizeOf(part);
            }
        }
    }
    return out;
}

/** Durable events: append inside a turn, read from a detached snapshot — of the record's WINDOW; older events are in the actor's pages (#198). */
export function createEventLogStore(ctx: SessionStoreContext): EventLogStore {
    return {
        append: (event: AgentEvent) => appendEntry(ctx, { t: 'ev', ev: event }),
        async *read(sessionId: string, from?: EventCursor) {
            for (const ev of eventsAfter(ctx.snapshot().events, from, sessionId)) yield ev;
        }
    };
}

/** Whole-transcript persistence keyed by the runtime session id; `save` is a full save, which compacts the log. */
export function createTranscriptStore(ctx: SessionStoreContext): TranscriptStore {
    return {
        async load(sessionId: string) {
            const t = ctx.snapshot().transcript;
            return t && t.sessionId === sessionId ? t : undefined;
        },
        async save(sessionId: string, transcript: AgentTranscript) {
            // `load` finds a snapshot by its own id: refuse one that could never be read back.
            if (transcript.sessionId !== sessionId) throw new Error(`transcript of "${transcript.sessionId}" saved under "${sessionId}"`);
            ctx.state.transcript = boundTranscript(transcript);
            await ctx.save();
        },
        async delete(sessionId: string) {
            if (ctx.state.transcript?.sessionId === sessionId) {
                delete ctx.state.transcript;
                await ctx.save();
            }
        }
    };
}
