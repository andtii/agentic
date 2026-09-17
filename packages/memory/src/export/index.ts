/**
 * The export format (MEM-05/08/09): NDJSON, one versioned header line then
 * one `MemoryEntry` per line. The header is what makes a file self-describing
 * across plugins and versions — an importer refuses a format it does not
 * know instead of guessing, and a future version bumps `version` and adds a
 * reader here.
 */

import type { MemoryEntry } from '@agentic/core';

export const MEMORY_EXPORT_FORMAT = 'agentic-memory';
export const MEMORY_EXPORT_VERSION = 1;

export interface MemoryExportHeader {
    readonly format: typeof MEMORY_EXPORT_FORMAT;
    readonly version: typeof MEMORY_EXPORT_VERSION;
    readonly scope?: string;
    readonly exportedAt: number;
}

export class MemoryExportError extends Error {
    override readonly name = 'MemoryExportError';
}

export function memoryExportHeader(init: { readonly scope?: string; readonly exportedAt?: number } = {}): MemoryExportHeader {
    const header: MemoryExportHeader = { format: MEMORY_EXPORT_FORMAT, version: MEMORY_EXPORT_VERSION, exportedAt: init.exportedAt ?? Date.now() };
    return init.scope === undefined ? header : { ...header, scope: init.scope };
}

/** Lines (without newlines): the header, then one entry per line. */
export async function* toNdjson(entries: AsyncIterable<MemoryEntry> | Iterable<MemoryEntry>, init?: { readonly scope?: string; readonly exportedAt?: number }): AsyncIterable<string> {
    yield JSON.stringify(memoryExportHeader(init));
    for await (const e of entries) yield JSON.stringify(e);
}

/** The whole export as one string, newline-terminated. */
export async function exportToString(entries: AsyncIterable<MemoryEntry> | Iterable<MemoryEntry>, init?: { readonly scope?: string; readonly exportedAt?: number }): Promise<string> {
    let out = '';
    for await (const line of toNdjson(entries, init)) out += line + '\n';
    return out;
}

/** Split NDJSON text into lines, dropping blank ones. */
export function ndjsonLines(text: string): string[] {
    return text.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export function parseExportHeader(line: string): MemoryExportHeader {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        throw new MemoryExportError('memory export: the first line is not JSON');
    }
    const h = value as Partial<MemoryExportHeader> | null;
    if (!h || typeof h !== 'object' || h.format !== MEMORY_EXPORT_FORMAT) throw new MemoryExportError(`memory export: unknown format ${JSON.stringify(h && typeof h === 'object' ? h.format : value)}`);
    if (h.version !== MEMORY_EXPORT_VERSION) throw new MemoryExportError(`memory export: unsupported version ${String(h.version)} (this reader knows ${MEMORY_EXPORT_VERSION})`);
    return { format: MEMORY_EXPORT_FORMAT, version: MEMORY_EXPORT_VERSION, exportedAt: typeof h.exportedAt === 'number' ? h.exportedAt : 0, ...(typeof h.scope === 'string' ? { scope: h.scope } : {}) };
}

/**
 * Rows from NDJSON lines: validates the header, then yields each parsed line
 * as-is. Validation of the rows themselves is the importer's job — it is what
 * produces the fidelity report. Pass `onHeader` to read the header.
 */
export async function* fromNdjson(lines: AsyncIterable<string> | Iterable<string>, onHeader?: (header: MemoryExportHeader) => void): AsyncIterable<MemoryEntry> {
    let first = true;
    for await (const line of lines) {
        if (!line.trim()) continue;
        if (first) {
            first = false;
            const header = parseExportHeader(line);
            onHeader?.(header);
            continue;
        }
        yield JSON.parse(line) as MemoryEntry;
    }
    if (first) throw new MemoryExportError('memory export: empty input (no header line)');
}
