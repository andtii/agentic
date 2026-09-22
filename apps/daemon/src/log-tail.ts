/**
 * `log.request` (#355, #481): the last lines of the daemon's own log for the
 * Machine page. The file is the service's — the supervisor's (and so this
 * process's) stderr is pointed at `<stateDir>/logs/daemon.log` by every
 * installer — so it is read, never followed: `stat`, the last `TAIL_BYTES` at
 * most, split, the first (possibly partial) line dropped, the last `lines`
 * kept, every one run through `redact` again on the way out. Every line was
 * redacted when it was written; the second pass costs nothing and guards a
 * line something else wrote into the same file. libuv opens files with
 * shared read / write, so the file the supervisor holds open is readable on
 * Windows too. Without a file (a foreground `run`) the answer is `no-log`.
 */
import { DAEMON_LOG_MAX_LINES, type DaemonLogError, type DaemonLogResult } from '@agentic/core';
import { open } from 'node:fs/promises';
import { redact } from './logger.js';

/** At most this much of the file's end is read: 500 lines of JSON weigh far less. */
export const TAIL_BYTES = 512 * 1024;

export type LogTailOutcome = { readonly result: DaemonLogResult } | { readonly error: DaemonLogError };

export async function tailLog(file: string, lines: number, secrets: readonly string[] = []): Promise<LogTailOutcome> {
    const wanted = Math.max(1, Math.min(Math.floor(lines), DAEMON_LOG_MAX_LINES));
    let handle;
    try {
        handle = await open(file, 'r');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { error: { code: 'no-log', message: 'the daemon runs without a log file (a foreground run); the service writes one' } };
        return { error: { code: 'io', message: 'the daemon could not open its log; see the daemon log' } };
    }
    try {
        const { size } = await handle.stat();
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        if (length > 0) await handle.read(buffer, 0, length, size - length);
        let text = buffer.toString('utf8');
        const partial = length < size;
        // A cut in the middle of a line: the first piece is not a line.
        if (partial) {
            const nl = text.indexOf('\n');
            text = nl < 0 ? '' : text.slice(nl + 1);
        }
        const all = text.split(/\r?\n/).filter((l) => l !== '');
        const kept = all.slice(Math.max(0, all.length - wanted));
        return { result: { lines: kept.map((l) => redact(l, secrets)), truncated: partial || kept.length < all.length } };
    } catch {
        return { error: { code: 'io', message: 'the daemon could not read its log; see the daemon log' } };
    } finally {
        await handle.close().catch(() => {});
    }
}
