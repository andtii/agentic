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

import type { ActorClientWith, AnyActorDefinition } from '@sigx/actors';
import type { AgentEvent, AgentMessage, AgentTranscript, EventCursor, EventLogStore, TranscriptStore } from '@sigx/ai-agent';
import type { AgentPart } from '@sigx/ai-agent/app';

import { applySessionEntry, eventsAfter, jsonBytes, utf8Bytes, type SessionEntry, type SessionState, type TranscriptPageMeta } from './state.js';
import { SessionTranscriptPage, transcriptPageKey } from './transcript.js';

/** The slice of `ActorContext<SessionState>` the stores use — the real context satisfies it inside a turn. */
export interface SessionStoreContext {
    readonly state: SessionState;
    save(): Promise<void>;
    snapshot(): SessionState;
    /** `ctx.append`: fold through the definition's `applyEntry` and write the entry alone. */
    append?(entry: unknown): Promise<void>;
    /** The actor key, `{ws}:session:{id}` — with `actor`, where the transcript pages are keyed from (#397). */
    readonly key?: string;
    /** `ctx.actor`: the hop to a `SessionTranscriptPage`. A context without it (a test double) keeps only the bounded snapshot. */
    actor?<D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D>;
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
 * The RECORD's transcript snapshot's budget (#198): with the event window (`WINDOW_BYTES`) it keeps
 * the Session record under a Durable Object value's 2 MB whatever the session's length. It bounds a
 * view — what `transcript()` and a request card read — never the model's history: the transcript the
 * runtime saves through the store lives whole in `SessionTranscriptPage`s (#397), so a long API
 * session's older outputs are not replaced by trim markers on resume. Whether that history should
 * be cut to a model's context window is a product decision, not a storage limit: compaction or
 * summarisation of a long transcript is #401.
 */
export const TRANSCRIPT_BYTES = 1024 * 1024;

/** About how many UTF-8 JSON bytes of messages one `SessionTranscriptPage` holds (#397) — a quarter of a Durable Object value. */
export const TRANSCRIPT_PAGE_BYTES = 512 * 1024;

const trimmed = (bytes: number): string => `[trimmed from the stored snapshot: ${Math.max(1, Math.round(bytes / 1024))} KB — the session's events keep it]`;
const sizeOf = jsonBytes;

/**
 * Drop a part's bulk (tool output, content blocks, streaming argument text; reasoning text and provider data;
 * an inlined image's or file's bytes, #391 — the part becomes a text note, since a marker is no base64); the bytes saved.
 */
function trimBulk(part: AgentPart): number {
    const before = sizeOf(part);
    if (part.type === 'tool') {
        const p = part as { output?: unknown; content?: unknown; inputText?: string };
        if (p.output !== undefined && sizeOf(p.output) > 256) p.output = trimmed(sizeOf(p.output));
        delete p.content;
        delete p.inputText;
    } else if (part.type === 'reasoning') {
        if (part.text.length > 256) part.text = trimmed(utf8Bytes(part.text));
        delete part.providerData;
    } else if ((part.type === 'image' || part.type === 'file') && part.data !== undefined && part.data.length > 256) {
        // The part becomes exactly `{ type: 'text', text }`: nothing of the attachment (its bytes, url, media type, name, size, …) lingers.
        // Rebuilt in place, since the passes run over views of the cloned transcript's own part objects.
        const note = `[${part.type}${'filename' in part && part.filename ? ` ${part.filename}` : ''} ${part.mediaType}] ${trimmed(utf8Bytes(part.data))}`;
        const p = part as unknown as Record<string, unknown>;
        for (const key of Object.keys(p)) delete p[key];
        Object.assign(p, { type: 'text', text: note });
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
                part.text = trimmed(utf8Bytes(part.text));
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

/**
 * `messages` cut into pages of about `TRANSCRIPT_PAGE_BYTES` (#397), each with the meta that fingerprints it: a message
 * alone past the budget is a page of its own. Pages before the last are append-only in practice (a finished turn's
 * messages do not change), so a save that compares metas rewrites only the tail.
 */
export function pageMessages(messages: readonly AgentMessage[], budget: number = TRANSCRIPT_PAGE_BYTES): { readonly messages: AgentMessage[]; readonly meta: TranscriptPageMeta }[] {
    const out: { messages: AgentMessage[]; meta: TranscriptPageMeta }[] = [];
    let page: AgentMessage[] = [];
    let bytes = 0;
    const flush = () => {
        if (page.length === 0) return;
        out.push({ messages: page, meta: { page: out.length, count: page.length, bytes, first: page[0]!.id, last: page[page.length - 1]!.id } });
        page = [];
        bytes = 0;
    };
    for (const m of messages) {
        const size = jsonBytes(m);
        if (page.length > 0 && bytes + size > budget) flush();
        page.push(m);
        bytes += size;
    }
    flush();
    return out;
}

const sameMeta = (a: TranscriptPageMeta, b: TranscriptPageMeta): boolean => a.page === b.page && a.count === b.count && a.bytes === b.bytes && a.first === b.first && a.last === b.last;

/**
 * Whole-transcript persistence keyed by the runtime session id; `save` is a full save, which compacts the log.
 * While the transcript fits `TRANSCRIPT_BYTES` the record holds it whole, as it always did. Past that the record keeps
 * the bounded snapshot (`boundTranscript`) and the messages go whole to `SessionTranscriptPage`s (#397) — only the pages
 * whose fingerprint changed — and `load` returns them, so the model's history on the API path is bounded by no record
 * budget. A context without `actor` (a test double) keeps only the bounded snapshot.
 */
export function createTranscriptStore(ctx: SessionStoreContext): TranscriptStore {
    const pageOf = (page: number) => ctx.actor!(SessionTranscriptPage, transcriptPageKey(ctx.key!, page));
    const paged = () => typeof ctx.actor === 'function' && ctx.key !== undefined;
    return {
        async load(sessionId: string) {
            const s = ctx.snapshot();
            const t = s.transcript;
            if (!t || t.sessionId !== sessionId) return undefined;
            const pages = s.transcriptPages;
            if (!pages?.length || !paged()) return t;
            const messages: AgentMessage[] = [];
            for (const p of pages) messages.push(...(await pageOf(p.page).read()));
            return { ...t, messages };
        },
        async save(sessionId: string, transcript: AgentTranscript) {
            // `load` finds a snapshot by its own id: refuse one that could never be read back.
            if (transcript.sessionId !== sessionId) throw new Error(`transcript of "${transcript.sessionId}" saved under "${sessionId}"`);
            const before = ctx.state.transcriptPages ?? [];
            if (paged() && jsonBytes(transcript) > TRANSCRIPT_BYTES) {
                const next = pageMessages(transcript.messages);
                // The pages first, the record last: a record never lists a page that is not there.
                for (const p of next) {
                    const was = before[p.meta.page];
                    if (was && sameMeta(was, p.meta)) continue;
                    await pageOf(p.meta.page).store(p.messages);
                }
                for (let n = next.length; n < before.length; n++) await pageOf(n).forget();
                ctx.state.transcriptPages = next.map((p) => p.meta);
            } else {
                // It fits the record whole (or shrank back into it): the pages, if any, are not needed.
                if (paged()) for (const p of before) await pageOf(p.page).forget();
                delete ctx.state.transcriptPages;
            }
            ctx.state.transcript = boundTranscript(transcript);
            await ctx.save();
        },
        async delete(sessionId: string) {
            if (ctx.state.transcript?.sessionId !== sessionId) return;
            if (paged()) for (const p of ctx.state.transcriptPages ?? []) await pageOf(p.page).forget();
            delete ctx.state.transcriptPages;
            delete ctx.state.transcript;
            await ctx.save();
        }
    };
}
