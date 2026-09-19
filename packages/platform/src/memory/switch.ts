/**
 * Switching the workspace's active memory plugin with its memories (#243, MEM-09, AC-11): every scope the workspace
 * implies is walked through `@agentic/memory`'s `migrate` — the export/import path AC-11 proves — from the plugin
 * that is active into the one that is about to be.
 *
 * - A dry run asks the target's fidelity seam and reports what each scope would keep, skip and drop; nothing is
 *   written.
 * - For real, each scope is imported and then VERIFIED: the target must hold exactly `imported` more entries than it
 *   did before. Any failure throws, and the caller — the Registry — leaves the old plugin active.
 * - The source is never touched: its store stays where it is (retention removes it with the workspace), so a switch
 *   back finds it again.
 */

import type { AgentId, MemoryScope, MemoryStore, Principal } from '@agentic/core';
import { migrate, type MigrationReport } from '@agentic/memory';
import type { PlatformMemory } from '../task/driver.js';

/** One scope's part of a switch. */
export interface MemoryScopeMigration {
    readonly scope: MemoryScope;
    readonly report: MigrationReport;
}

/** What a switch did — or, as a dry run, would do. */
export interface MemorySwitchReport {
    readonly from: string;
    readonly to: string;
    readonly dryRun: boolean;
    /** The target's `export:` capability: `partial` keeps fewer fields than the default (`droppedFields` names them). */
    readonly targetExport: 'full' | 'partial';
    /** Totals over every scope. */
    readonly entries: number;
    readonly imported: number;
    readonly skipped: number;
    readonly droppedFields: readonly string[];
    /** Only the scopes that hold anything. */
    readonly scopes: readonly MemoryScopeMigration[];
}

export interface MemorySwitchInput {
    readonly from: { readonly id: string; readonly memory: PlatformMemory };
    readonly to: { readonly id: string; readonly memory: PlatformMemory; readonly export: 'full' | 'partial' };
    readonly scopes: readonly MemoryScope[];
    /** Who reads and writes every scope — the workspace owner, whom `memoryAuthorize` lets into all of them. */
    readonly principal: Principal;
    readonly dryRun: boolean;
}

/** A migration that could not be completed or did not verify; nothing was switched. */
export class MemorySwitchError extends Error {
    override readonly name = 'MemorySwitchError';
    constructor(
        readonly scope: MemoryScope,
        message: string
    ) {
        super(message);
    }
}

/** The memory scopes a workspace's agents imply: each one's own, then every shared scope any of them reads — in that order, once each. */
export function workspaceMemoryScopes(agents: readonly { readonly id: AgentId; readonly shared: readonly string[] }[]): MemoryScope[] {
    const out = new Set<MemoryScope>();
    for (const a of agents) out.add(`agent:${a.id}`);
    for (const a of agents) for (const s of a.shared) out.add((s.startsWith('shared:') ? s : `shared:${s}`) as MemoryScope);
    return [...out];
}

async function count(store: MemoryStore): Promise<number> {
    let n = 0;
    for await (const _ of store.export()) n++;
    return n;
}

export async function switchMemory(input: MemorySwitchInput): Promise<MemorySwitchReport> {
    const scopes: MemoryScopeMigration[] = [];
    const dropped = new Set<string>();
    let entries = 0;
    let imported = 0;
    let skipped = 0;
    for (const scope of input.scopes) {
        const from = input.from.memory.open(scope, input.principal);
        const to = input.to.memory.open(scope, input.principal);
        let report: MigrationReport;
        try {
            const before = input.dryRun ? 0 : await count(to);
            report = await migrate(from, to, { dryRun: input.dryRun });
            if (!input.dryRun) {
                const after = await count(to);
                if (after - before !== report.imported) throw new Error(`expected ${report.imported} new entries in ${input.to.id}, found ${after - before}`);
            }
        } catch (e) {
            throw new MemorySwitchError(scope, `scope ${scope}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (report.entries === 0) continue;
        scopes.push({ scope, report });
        entries += report.entries;
        imported += report.imported;
        skipped += report.skipped;
        for (const f of report.droppedFields) dropped.add(f);
    }
    return { from: input.from.id, to: input.to.id, dryRun: input.dryRun, targetExport: input.to.export, entries, imported, skipped, droppedFields: [...dropped].sort(), scopes };
}
