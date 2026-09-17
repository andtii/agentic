/**
 * `migrate(from, to)` — the defined path between two MemoryStores (MEM-09):
 * export everything from `from`, import it into `to`, and report what the
 * target could not hold, per entry kind and in total. A dry run reports the
 * same numbers without writing — it asks the target's `fidelity` seam, which
 * every store of this package has; a store without one migrates for real.
 */

import type { MemoryEntry, MemoryKind, MemoryStore } from '@agentic/core';
import { MEMORY_KINDS } from '../state/index.js';
import type { MemoryFidelity } from '../store/index.js';

export interface MigrationKindReport {
    /** Entries of this kind read from the source. */
    readonly entries: number;
    readonly imported: number;
    readonly skipped: number;
    /** Fields the target dropped from entries of this kind, sorted, dotted for `provenance.*`. */
    readonly droppedFields: readonly string[];
}

export interface MigrationReport {
    readonly dryRun: boolean;
    /** Entries read from the source, retired included. */
    readonly entries: number;
    readonly imported: number;
    readonly skipped: number;
    /** The union of every kind's `droppedFields`, sorted. */
    readonly droppedFields: readonly string[];
    /** One report per kind present in the source. */
    readonly kinds: Readonly<Partial<Record<MemoryKind, MigrationKindReport>>>;
}

export interface MigrateOptions {
    /** Report without writing. Needs a target with a `fidelity` seam. */
    readonly dryRun?: boolean;
    /** What to do with an id the target already holds. Default `'skip'`. */
    readonly onConflict?: 'skip' | 'replace';
}

/** A store that may know, without writing, what its `import` would drop. */
export type MigrationTarget = MemoryStore & Partial<MemoryFidelity>;

export class MemoryMigrationError extends Error {
    override readonly name = 'MemoryMigrationError';
}

export async function migrate(from: MemoryStore, to: MigrationTarget, options: MigrateOptions = {}): Promise<MigrationReport> {
    const dryRun = options.dryRun ?? false;
    const onConflict = options.onConflict ?? 'skip';
    if (dryRun && typeof to.fidelity !== 'function') throw new MemoryMigrationError('memory migrate: a dry run needs a target with a `fidelity` seam; run without dryRun to migrate for real');

    const byKind = new Map<MemoryKind, MemoryEntry[]>();
    for await (const entry of from.export()) {
        let group = byKind.get(entry.kind);
        if (!group) byKind.set(entry.kind, (group = []));
        group.push(entry);
    }

    const kinds: Partial<Record<MemoryKind, MigrationKindReport>> = {};
    const all = new Set<string>();
    let entries = 0;
    let imported = 0;
    let skipped = 0;
    for (const kind of MEMORY_KINDS) {
        const group = byKind.get(kind);
        if (!group) continue;
        const report = dryRun ? await probe(to as MemoryStore & MemoryFidelity, group, onConflict) : summarize(await to.import(iterate(group), { onConflict }));
        kinds[kind] = { entries: group.length, ...report };
        entries += group.length;
        imported += report.imported;
        skipped += report.skipped;
        for (const f of report.droppedFields) all.add(f);
    }
    return { dryRun, entries, imported, skipped, droppedFields: [...all].sort(), kinds };
}

type Counts = Omit<MigrationKindReport, 'entries'>;

function summarize(r: { readonly imported: number; readonly skipped: number; readonly droppedFields: readonly string[] }): Counts {
    return { imported: r.imported, skipped: r.skipped, droppedFields: [...r.droppedFields].sort() };
}

/** What `import` would do, entry by entry: the fidelity seam for the fields, `get` for the conflicts. */
async function probe(to: MemoryStore & MemoryFidelity, group: readonly MemoryEntry[], onConflict: 'skip' | 'replace'): Promise<Counts> {
    let imported = 0;
    let skipped = 0;
    const dropped = new Set<string>();
    for (const entry of group) {
        const fields = to.fidelity(entry);
        if (fields === null) {
            skipped++;
            continue;
        }
        for (const f of fields) dropped.add(f);
        if (onConflict === 'skip' && (await to.get(entry.id))) {
            skipped++;
            continue;
        }
        imported++;
    }
    return { imported, skipped, droppedFields: [...dropped].sort() };
}

async function* iterate<T>(items: Iterable<T>): AsyncIterable<T> {
    yield* items;
}
