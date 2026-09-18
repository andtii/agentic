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

/** Durable events: append inside a turn, read from a detached snapshot. */
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
            ctx.state.transcript = transcript;
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
