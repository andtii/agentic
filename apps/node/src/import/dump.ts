/**
 * `importDump` — write a Cloudflare export (`apps/web/src/export`, #994) into
 * a node's actor storage.
 *
 * Each `ExportLine` becomes the record it was on the Durable Object: the
 * state through `saveText` (a full save, so the record's log starts empty),
 * then every appended entry through `appendText` in order — the node's
 * `sqliteStorage` keeps the same snapshot-plus-log shape, and the host folds
 * the log at load exactly as the object's host did. An existing record is
 * overwritten (its etag is read first), so running an import twice converges.
 *
 * Reminders go into the node's `shardedReminders()` table through its own
 * API, bound to the same storage, at their exported due time: one already
 * due fires on the node's first reminder tick. Periods keep their value.
 *
 * Run it with the node stopped: a live activation holds its own etag and
 * would conflict on its next save.
 */
import type { ActorStorage } from '@sigx/actors';
import { manualScheduler, shardedReminders } from '@sigx/actors/host';
import type { ExportedReminder, ExportLine } from '../../../web/src/export';

export interface ImportCounts {
    readonly records: number;
    readonly logEntries: number;
    readonly reminders: number;
}

function parseLine(text: string, n: number): ExportLine {
    let line: unknown;
    try {
        line = JSON.parse(text);
    } catch {
        throw new Error(`[import] line ${n}: not JSON`);
    }
    const l = line as Partial<ExportLine> | null;
    if (!l || typeof l.type !== 'string' || typeof l.key !== 'string' || (l.record !== null && typeof l.record !== 'object') || typeof l.reminders !== 'object' || l.reminders === null) {
        throw new Error(`[import] line ${n}: not an export line ({ type, key, record, reminders })`);
    }
    if (l.record && !Array.isArray(l.record.log)) throw new Error(`[import] line ${n}: record.log is not an array`);
    return l as ExportLine;
}

/** Import every line of a dump (NDJSON text lines; blank lines skipped) into `storage`. */
export async function importDump(lines: AsyncIterable<string> | Iterable<string>, storage: ActorStorage): Promise<ImportCounts> {
    const reminders = shardedReminders();
    reminders.bind({ storage, scheduler: manualScheduler(), tickMs: 1000, ownsShard: () => true, deliver: async () => undefined });
    let records = 0;
    let logEntries = 0;
    let reminderCount = 0;
    let n = 0;
    for await (const text of lines) {
        n++;
        if (!text.trim()) continue;
        const line = parseLine(text, n);
        if (line.record) {
            const existing = await storage.load(line.type, line.key);
            const json = JSON.stringify(line.record.state);
            let etag = storage.saveText
                ? await storage.saveText(line.type, line.key, json, existing?.etag ?? null)
                : await storage.save(line.type, line.key, JSON.parse(json), existing?.etag ?? null);
            for (const entry of line.record.log) {
                if (!storage.appendText) throw new Error(`[import] line ${n}: ${line.type}/${line.key} has a log, and this storage cannot append`);
                etag = await storage.appendText(line.type, line.key, JSON.stringify(entry), etag);
                logEntries++;
            }
            records++;
        }
        const api = reminders.apiFor({ type: line.type, key: line.key });
        for (const [name, reminder] of Object.entries(line.reminders)) {
            const { nextDue, period } = (reminder ?? {}) as Partial<ExportedReminder>;
            if (typeof nextDue !== 'number' || !Number.isFinite(nextDue) || (period !== undefined && (typeof period !== 'number' || !Number.isFinite(period)))) {
                throw new Error(`[import] line ${n}: reminder "${name}" of ${line.type}/${line.key} has no finite nextDue / period`);
            }
            // One already due fires on the node's first tick.
            await api.set(name, { due: Math.max(0, nextDue - Date.now()), ...(period === undefined ? {} : { period }) });
            reminderCount++;
        }
    }
    return { records, logEntries, reminders: reminderCount };
}
