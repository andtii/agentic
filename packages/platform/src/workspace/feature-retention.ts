/**
 * Removed-feature retention (#941; HANDOFF "Features": "Removing a feature keeps its data for 30 days"). Taking a
 * feature off a project (`upsertProject({ features: { id: null } })`) records it with its settings and `removedAt`
 * in `WorkspaceState.removedFeatures`; adding it back within `REMOVED_FEATURE_RETENTION_MS` restores those settings
 * (the patch's own settings on top) and drops the record. After the window the Workspace's reminder purges the
 * feature's data in that project through the `WorkspaceStore` port (Plan: the project's Plan record, every plan in
 * it) and drops the record. Pure, but for the purge.
 */

import type { ProjectId, ProjectRecord, WorkspaceId } from '@agentic/core';
import { PLAN_TYPE, planKey } from '../plan/key.js';
import type { ActorRecordRef, WorkspaceStore } from './ports.js';

/** How long a removed feature's settings and data are kept: 30 days. */
export const REMOVED_FEATURE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** The Workspace reminder the purge runs under. */
export const REMOVED_FEATURES_REMINDER = 'removed-features';

/** The reminder is never armed sooner than this: an expired record whose purge failed waits this long to retry. */
export const PURGE_MIN_DELAY_MS = 60 * 60_000;

/** One feature taken off one project, kept until `removedAt + REMOVED_FEATURE_RETENTION_MS`. */
export interface RemovedFeature {
    readonly projectId: ProjectId;
    readonly featureId: string;
    /** Its settings when it was removed: what adding it back restores. */
    readonly settings: Readonly<Record<string, unknown>>;
    readonly removedAt: number;
}

/**
 * Feature id → the actor records holding its data in one project, which the purge deletes. A feature not listed
 * keeps nothing outside its settings. The Plan feature's id is `@agentic/plugins-plan`'s `PLAN_FEATURE_ID`.
 */
export const FEATURE_DATA: Readonly<Record<string, (workspaceId: WorkspaceId, projectId: ProjectId) => readonly ActorRecordRef[]>> = {
    'agentic.feature.plan': (workspaceId, projectId) => [{ type: PLAN_TYPE, key: planKey(workspaceId, projectId) }]
};

const expired = (entry: RemovedFeature, at: number): boolean => entry.removedAt + REMOVED_FEATURE_RETENTION_MS <= at;

/** The settings a feature re-added at `at` gets back, or `undefined` when nothing is kept for it. */
export function retainedSettings(removed: readonly RemovedFeature[] | undefined, projectId: ProjectId | undefined, featureId: string, at: number): Readonly<Record<string, unknown>> | undefined {
    if (projectId === undefined) return undefined;
    const entry = (removed ?? []).find((r) => r.projectId === projectId && r.featureId === featureId);
    return entry && !expired(entry, at) ? entry.settings : undefined;
}

/**
 * `removed` after an upsert of `record` over `base` at `at`: each feature `base` had and `record` lacks is kept (a
 * newer removal replaces an older one), each feature `record` has is no longer kept — its data is in use again.
 */
export function nextRemoved(removed: readonly RemovedFeature[] | undefined, base: ProjectRecord | undefined, record: ProjectRecord, at: number): RemovedFeature[] {
    const gone = base ? Object.keys(base.features).filter((id) => !Object.hasOwn(record.features, id)) : [];
    const kept = (removed ?? []).filter((r) => r.projectId !== record.id || (!Object.hasOwn(record.features, r.featureId) && !gone.includes(r.featureId)));
    return [...kept, ...gone.map((featureId) => ({ projectId: record.id, featureId, settings: { ...base!.features[featureId] }, removedAt: at }))];
}

/** How long until the next kept feature runs out (at least `PURGE_MIN_DELAY_MS`, so a failed purge retries calmly), or `undefined` when none is kept. */
export function nextPurgeIn(removed: readonly RemovedFeature[] | undefined, at: number): number | undefined {
    if (!removed?.length) return undefined;
    return Math.max(PURGE_MIN_DELAY_MS, Math.min(...removed.map((r) => r.removedAt + REMOVED_FEATURE_RETENTION_MS)) - at);
}

/**
 * Purge what ran out by `at`: each expired feature's data (`FEATURE_DATA`) through `store`, unless the project has the
 * feature on again. Returns the records still kept — the ones not yet due, and any whose purge failed (retried on the
 * next reminder). Without a store the data cannot be reached; the record is dropped all the same.
 */
export async function purgeExpired(
    removed: readonly RemovedFeature[] | undefined,
    workspaceId: WorkspaceId,
    projects: readonly ProjectRecord[],
    store: WorkspaceStore | undefined,
    at: number
): Promise<{ readonly kept: RemovedFeature[]; readonly purged: RemovedFeature[] }> {
    const kept: RemovedFeature[] = [];
    const purged: RemovedFeature[] = [];
    for (const entry of removed ?? []) {
        if (!expired(entry, at)) {
            kept.push(entry);
            continue;
        }
        const project = projects.find((p) => p.id === entry.projectId);
        if (project && Object.hasOwn(project.features, entry.featureId)) continue;
        try {
            if (store) for (const ref of FEATURE_DATA[entry.featureId]?.(workspaceId, entry.projectId) ?? []) await store.purge(ref);
            purged.push(entry);
        } catch {
            kept.push(entry);
        }
    }
    return { kept, purged };
}
