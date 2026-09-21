/**
 * The daemon's durable session log (architecture §5b): one NDJSON file per
 * session under `%LOCALAPPDATA%/agentic/sessions/{sessionId}.ndjson`, one
 * stamped `AgentEvent` per line. It is the `EventLogStore` `serveSession`
 * appends to, so a platform reconnect replays from disk once the in-memory
 * buffer has moved on — and after a daemon restart.
 *
 * `append` queues the write and returns at once: `serveSession` awaits it
 * per event, and a store that made its tracker wait on the disk would let a
 * replay read a log that trails events already emitted — a false gap. Writes
 * are serialised per session (order on disk is emit order), every read waits
 * for the queue, and a failed write is reported to `onError`. A torn last
 * line (a crash mid-write) is skipped, not fatal.
 *
 * The machine owns the history (#397): the platform keeps a bounded recent
 * window and asks for anything older with `history.request`, answered by
 * `slice`. The log itself is bounded by `retain` — the newest whole turns
 * that fit a byte budget — so one file per (chat, agent) does not grow for
 * the life of the chat; what it forgot is a named `gap`, never silence.
 */

import type { Cursor, HistoryError, HistoryRange } from '@agentic/core';
import { HISTORY_LIMIT } from '@agentic/core';
import type { AgentEvent, EventLogStore } from '@sigx/ai-agent';
import { cursorBefore } from '@sigx/ai-agent/wire';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** What `slice` answers: the events of the range and whether the log holds more of it, or why it could not. */
export type HistorySlice = { readonly result: { readonly events: AgentEvent[]; readonly more?: boolean } } | { readonly error: HistoryError };

export interface RetentionPolicy {
    /** The most a session's log keeps, in bytes of NDJSON: past it the oldest whole turns go. `0` keeps everything. */
    readonly maxBytes: number;
}

export interface NdjsonEventLog extends EventLogStore {
    readonly dir: string;
    /** Append under `key` whatever the event's own `sessionId` says (a runtime names its sessions its own way). */
    appendTo(key: string, event: AgentEvent): Promise<void>;
    /** The store for one platform session: every event goes to `{key}.ndjson` and reads come from it. */
    forSession(key: string): EventLogStore;
    /** The last cursor on disk for `sessionId`, or `undefined` without a log. */
    head(sessionId: string): Promise<Cursor | undefined>;
    /** Session ids with a log on disk. */
    sessions(): Promise<string[]>;
    /**
     * A history slice (#397): the events after `range.from` (exclusive) up to `range.to` (inclusive), at most `range.limit`
     * (default `HISTORY_LIMIT`) and about `maxBytes` of JSON, `more` when cut short. A log that no longer reaches back to
     * `from` answers `gap` naming its oldest cursor; a session without a log `unknown-session`.
     */
    slice(sessionId: string, range: HistoryRange, options?: { readonly maxBytes?: number }): Promise<HistorySlice>;
    /** Forget events before `keepFrom` (retention; makes an older cursor a gap). */
    truncate(sessionId: string, keepFrom: Cursor): Promise<void>;
    /**
     * Apply the retention policy (#397): while the file is over `maxBytes`, forget the oldest whole turns until what is
     * left fits — a turn is never cut in the middle. Resolves to the cursor the log now starts at when it was trimmed,
     * `undefined` when it was under budget. Cheap when under budget (one `stat`).
     */
    retain(sessionId: string, policy: RetentionPolicy): Promise<Cursor | undefined>;
    /** Resolves once every pending append has reached the file. */
    flush(sessionId?: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;

/** The log reaches back to `from` (exclusive): its oldest event is at or before it, or is the very next stamp — `from` may be platform-stamped, a fractional seq. */
export function reachesBack(oldest: Cursor, from: Cursor): boolean {
    if (!cursorBefore(from, oldest)) return true;
    return oldest.epoch === from.epoch ? oldest.seq === Math.floor(from.seq) + 1 : oldest.epoch > from.epoch && oldest.seq === 1;
}

export interface NdjsonEventLogOptions {
    /** A write that failed; the event is lost from disk (the live stream still has it). */
    readonly onError?: (error: unknown, sessionId: string) => void;
}

export function ndjsonEventLog(dir: string, options: NdjsonEventLogOptions = {}): NdjsonEventLog {
    const chains = new Map<string, Promise<void>>();
    let ready: Promise<string | undefined> | undefined;

    const fileOf = (sessionId: string): string => {
        // Ids become file names: refuse anything that could leave the directory.
        if (!SESSION_ID.test(sessionId)) throw new Error(`[daemon] refusing a session id that is not a safe file name: ${JSON.stringify(sessionId)}`);
        return join(dir, `${sessionId}.ndjson`);
    };

    const enqueue = (sessionId: string, work: () => Promise<void>): Promise<void> => {
        const run = (chains.get(sessionId) ?? Promise.resolve()).then(async () => {
            ready ??= mkdir(dir, { recursive: true });
            await ready;
            await work();
        });
        // Keep the chain alive after a failure; the caller still sees the error.
        chains.set(
            sessionId,
            run.catch(() => {})
        );
        return run;
    };

    /** The file's lines as written, with the event each one holds — without waiting for the write queue (the queue's own work reads this way). */
    async function* rawLines(file: string): AsyncGenerator<{ readonly line: string; readonly event: AgentEvent }> {
        const stream = createReadStream(file, { encoding: 'utf8' });
        const opened = new Promise<boolean>((resolve) => {
            stream.once('open', () => resolve(true));
            stream.once('error', () => resolve(false));
        });
        if (!(await opened)) {
            stream.destroy();
            return;
        }
        const reader = createInterface({ input: stream, crlfDelay: Infinity });
        try {
            for await (const line of reader) {
                if (!line.trim()) continue;
                let event: AgentEvent;
                try {
                    event = JSON.parse(line) as AgentEvent;
                } catch {
                    continue;
                }
                if (typeof event?.seq === 'number' && typeof event.epoch === 'number') yield { line, event };
            }
        } finally {
            reader.close();
            // Wait for the handle to close: a reader left early (a `slice` cut by its limit) must not hold the file open
            // when a `truncate` renames over it — Windows refuses the rename while a handle is open.
            await new Promise<void>((resolve) => {
                if (stream.destroyed) return resolve();
                stream.once('close', () => resolve());
                stream.destroy();
            });
        }
    }

    /** `rename` with a few retries: on Windows a handle another process holds for a moment (an indexer, a scanner) refuses it once. */
    async function replaceFile(tmp: string, file: string): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            try {
                await rename(tmp, file);
                return;
            } catch (e) {
                if (attempt >= 5 || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
                await new Promise((r) => setTimeout(r, 20 * attempt));
            }
        }
    }

    /** The file's lines once every pending write has landed — what every read outside the queue goes through. */
    async function* settledLines(sessionId: string): AsyncGenerator<{ readonly line: string; readonly event: AgentEvent }> {
        await (chains.get(sessionId) ?? Promise.resolve());
        yield* rawLines(fileOf(sessionId));
    }

    async function* lines(sessionId: string): AsyncGenerator<AgentEvent> {
        for await (const { event } of settledLines(sessionId)) yield event;
    }

    const cursorOf = (event: AgentEvent): Cursor => ({ epoch: event.epoch, seq: event.seq });

    const store: NdjsonEventLog = {
        dir,
        append(event) {
            return store.appendTo(event.sessionId, event);
        },
        appendTo(key, event) {
            let file: string;
            try {
                file = fileOf(key);
            } catch (e) {
                return Promise.reject(e);
            }
            const line = `${JSON.stringify(event)}\n`;
            enqueue(key, () => appendFile(file, line, 'utf8')).catch((e: unknown) => options.onError?.(e, key));
            return Promise.resolve();
        },
        forSession(key) {
            fileOf(key);
            return {
                append: (event) => store.appendTo(key, event),
                read: (_sessionId, from) => store.read(key, from)
            };
        },
        async *read(sessionId, from) {
            for await (const event of lines(sessionId)) {
                if (!from || cursorBefore(from, { epoch: event.epoch, seq: event.seq })) yield event;
            }
        },
        async head(sessionId) {
            let last: Cursor | undefined;
            for await (const event of lines(sessionId)) last = { epoch: event.epoch, seq: event.seq };
            return last;
        },
        async sessions() {
            try {
                const names = await readdir(dir);
                return names.filter((n) => n.endsWith('.ndjson')).map((n) => n.slice(0, -'.ndjson'.length));
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw e;
            }
        },
        async slice(sessionId, range, options = {}) {
            const limit = Math.max(1, range.limit ?? HISTORY_LIMIT);
            const maxBytes = options.maxBytes ?? Infinity;
            const events: AgentEvent[] = [];
            let bytes = 0;
            let oldest: Cursor | undefined;
            let more = false;
            for await (const { line, event } of settledLines(sessionId)) {
                const at = cursorOf(event);
                oldest ??= at;
                if (!cursorBefore(range.from, at) || (range.to && cursorBefore(range.to, at))) continue;
                if (events.length >= limit || (events.length > 0 && bytes + line.length > maxBytes)) {
                    more = true;
                    break;
                }
                events.push(event);
                bytes += line.length;
            }
            if (!oldest) return { error: { code: 'unknown-session', message: `no session log for ${sessionId} on this machine` } };
            if (!reachesBack(oldest, range.from)) return { error: { code: 'gap', message: `the log of ${sessionId} starts at (${oldest.epoch}, ${oldest.seq}); what came before was forgotten by retention`, earliest: oldest } };
            return { result: { events, ...(more ? { more: true } : {}) } };
        },
        truncate(sessionId, keepFrom) {
            const file = fileOf(sessionId);
            // Read inside the queue: a line appended while the kept lines were being collected would otherwise be lost to the rewrite.
            return enqueue(sessionId, async () => {
                const kept: string[] = [];
                for await (const { line, event } of rawLines(file)) if (!cursorBefore(cursorOf(event), keepFrom)) kept.push(line);
                const tmp = `${file}.tmp`;
                await writeFile(tmp, kept.map((l) => `${l}\n`).join(''), 'utf8');
                await replaceFile(tmp, file);
            });
        },
        async retain(sessionId, policy) {
            const file = fileOf(sessionId);
            if (policy.maxBytes <= 0) return undefined;
            await store.flush(sessionId);
            try {
                if ((await stat(file)).size <= policy.maxBytes) return undefined;
            } catch {
                return undefined; // no log yet
            }
            // One pass: what each line weighs and where turns start, so the cut lands on a turn boundary.
            const entries: { readonly at: Cursor; readonly bytes: number; readonly turnStart: boolean }[] = [];
            let total = 0;
            for await (const { line, event } of rawLines(file)) {
                const bytes = Buffer.byteLength(line, 'utf8') + 1;
                total += bytes;
                entries.push({ at: cursorOf(event), bytes, turnStart: event.type === 'turn-start' });
            }
            let i = 0;
            while (i < entries.length && total > policy.maxBytes) total -= entries[i++]!.bytes;
            // Whole turns only: move up to the next turn start (the tail of a turn without its start is no history) — unless
            // the runtime stamps none, when the cut lands where the budget says.
            let cut = i;
            while (cut < entries.length && !entries[cut]!.turnStart) cut++;
            if (cut >= entries.length) cut = i;
            if (cut === 0 || cut >= entries.length) return undefined;
            const keepFrom = entries[cut]!.at;
            await store.truncate(sessionId, keepFrom);
            return keepFrom;
        },
        async flush(sessionId) {
            if (sessionId !== undefined) await (chains.get(sessionId) ?? Promise.resolve());
            else await Promise.all(chains.values());
        },
        async remove(sessionId) {
            const file = fileOf(sessionId);
            await enqueue(sessionId, () => rm(file, { force: true }));
            chains.delete(sessionId);
        }
    };
    return store;
}
