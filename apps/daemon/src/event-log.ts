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
 */

import type { Cursor } from '@agentic/core';
import type { AgentEvent, EventLogStore } from '@sigx/ai-agent';
import { cursorBefore } from '@sigx/ai-agent/wire';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

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
    /** Forget events before `keepFrom` (retention; makes an older cursor a gap). */
    truncate(sessionId: string, keepFrom: Cursor): Promise<void>;
    /** Resolves once every pending append has reached the file. */
    flush(sessionId?: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;

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

    async function* lines(sessionId: string): AsyncGenerator<AgentEvent> {
        await (chains.get(sessionId) ?? Promise.resolve());
        const stream = createReadStream(fileOf(sessionId), { encoding: 'utf8' });
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
                if (typeof event?.seq === 'number' && typeof event.epoch === 'number') yield event;
            }
        } finally {
            reader.close();
            stream.destroy();
        }
    }

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
        async truncate(sessionId, keepFrom) {
            const kept: string[] = [];
            for await (const event of lines(sessionId)) if (!cursorBefore({ epoch: event.epoch, seq: event.seq }, keepFrom)) kept.push(JSON.stringify(event));
            const file = fileOf(sessionId);
            await enqueue(sessionId, async () => {
                const tmp = `${file}.tmp`;
                await writeFile(tmp, kept.map((l) => `${l}\n`).join(''), 'utf8');
                await rename(tmp, file);
            });
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
