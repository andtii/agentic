/**
 * The app-level ports `Workspace.exportAll` / `deleteAll` run through
 * (OPS-10). Both bindings are the deployment's: on Cloudflare the sink is
 * the `ARTIFACTS` R2 bucket and the store is the actor storage; in tests
 * they are an in-memory map and `memoryStorage()`.
 */

import type { WorkspaceId } from '@agentic/core';

/** Where an export lands: one object per `put`. `path` is `{ws}/{stamp}/{kind}.ndjson`. */
export interface ArtifactSink {
    put(path: string, body: string, options?: { readonly contentType?: string }): Promise<void>;
}

/** One stored actor record — the `(type, key)` the storage seam is addressed by. */
export interface ActorRecordRef {
    readonly type: string;
    readonly key: string;
}

/**
 * How `deleteAll` reaches records the actors will not delete themselves.
 * `purge` must be idempotent (a ref that has no record is fine) and should
 * deactivate any live activation first, so nothing re-saves afterwards.
 * `list` is optional: a storage that can enumerate by workspace lets the
 * cascade also reach what the Workspace index cannot see (tasks, sessions,
 * ledger months) — without it those are documented as left behind.
 */
export interface WorkspaceStore {
    purge(ref: ActorRecordRef): Promise<void>;
    list?(workspaceId: WorkspaceId): Promise<readonly ActorRecordRef[]>;
}
