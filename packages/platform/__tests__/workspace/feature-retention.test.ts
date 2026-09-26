/**
 * Removed-feature retention (#941): taking a feature off a project keeps its settings and `removedAt`; adding it back
 * within 30 days restores them; after 30 days the Workspace's reminder purges the feature's data (Plan: the project's
 * Plan record) through the store and forgets the settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler, type ManualScheduler } from '@sigx/actors/host';
import type { ProjectFeatureManifest, ProjectId, ProjectRecord, WorkspaceId } from '@agentic/core';
import { AgentActor } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { planKey } from '../../src/plan/key';
import { defineRegistry } from '../../src/registry/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { defineWorkspace, REMOVED_FEATURE_RETENTION_MS, type ActorRecordRef, type WorkspaceState } from '../../src/workspace/index';
import { nextPurgeIn, nextRemoved, PURGE_MIN_DELAY_MS, purgeExpired, retainedSettings } from '../../src/workspace/feature-retention';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = workspaceKey('u1');
const PLAN = 'agentic.feature.plan';
const DAY = 24 * 60 * 60_000;

const plan: ProjectFeatureManifest = {
    id: PLAN,
    version: '1.0.0',
    kind: 'project-feature',
    name: 'Plan',
    description: 'A shared plan',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object', properties: { template: { type: 'string' }, agentsMayTick: { type: 'boolean' } } },
    permissions: [],
    compat: { platform: '*', core: '*' }
};

let purged: ActorRecordRef[];
let scheduler: ManualScheduler;
let app: TestActorApp;
const Workspace = defineWorkspace({ store: { async purge(ref) { purged.push(ref); } } });
const Registry = defineRegistry({ catalogue: [plan] });

const yieldTurns = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
};

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    purged = [];
    scheduler = manualScheduler();
    app = testActorApp([Workspace, Registry, AuditActor, AgentActor], { scheduler, defaults: { reminderTickMs: 60 * 60_000 } });
    await app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const ws = () => app.as(owner).actor(Workspace, KEY);
const stored = async () => (await app.storage.load('Workspace', KEY))!.state as WorkspaceState;
const later = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    scheduler.advance(ms);
    await yieldTurns(30);
};

describe('removed-feature retention (#941)', () => {
    it('adding a feature back within 30 days restores its settings, the patch’s own on top', async () => {
        const p = await ws().upsertProject({ name: 'Party', pm: null, features: { [PLAN]: { template: 'sprint', agentsMayTick: true } } });
        const off = await ws().upsertProject({ id: p.id, features: { [PLAN]: null } });
        expect(off.features).toEqual({});
        expect((await stored()).removedFeatures).toEqual([{ projectId: p.id, featureId: PLAN, settings: { template: 'sprint', agentsMayTick: true }, removedAt: Date.now() }]);

        await later(29 * DAY);
        expect(purged).toEqual([]);
        const back = await ws().upsertProject({ id: p.id, features: { [PLAN]: { agentsMayTick: false } } });
        expect(back.features).toEqual({ [PLAN]: { template: 'sprint', agentsMayTick: false } });
        expect((await stored()).removedFeatures).toBeUndefined();

        // Nothing is left to purge once it is back.
        await later(2 * DAY);
        expect(purged).toEqual([]);
    });

    it('after 30 days the reminder purges the feature’s data and forgets its settings', async () => {
        const p = await ws().upsertProject({ name: 'Party', pm: null, features: { [PLAN]: { template: 'sprint' } } });
        await ws().upsertProject({ id: p.id, features: { [PLAN]: null } });

        await later(REMOVED_FEATURE_RETENTION_MS + 60_000);
        expect(purged).toEqual([{ type: 'plan', key: planKey(WS, p.id) }]);
        expect((await stored()).removedFeatures).toBeUndefined();

        const fresh = await ws().upsertProject({ id: p.id, features: { [PLAN]: {} } });
        expect(fresh.features).toEqual({ [PLAN]: {} });
    });

    it('a newer removal replaces the older one; another project’s record is kept apart', async () => {
        const a = await ws().upsertProject({ name: 'A', pm: null, features: { [PLAN]: { template: 'a1' } } });
        const b = await ws().upsertProject({ name: 'B', pm: null, features: { [PLAN]: { template: 'b' } } });
        await ws().upsertProject({ id: a.id, features: { [PLAN]: null } });
        await ws().upsertProject({ id: b.id, features: { [PLAN]: null } });
        await later(DAY);
        await ws().upsertProject({ id: a.id, features: { [PLAN]: { template: 'a2' } } });
        await ws().upsertProject({ id: a.id, features: { [PLAN]: null } });
        const kept = (await stored()).removedFeatures!;
        expect(kept.map((r) => [r.projectId, r.settings])).toEqual([[b.id, { template: 'b' }], [a.id, { template: 'a2' }]]);

        // B runs out first: only its data goes.
        await later(REMOVED_FEATURE_RETENTION_MS - DAY + 2 * 60 * 60_000);
        expect(purged).toEqual([{ type: 'plan', key: planKey(WS, b.id) }]);
        expect((await stored()).removedFeatures!.map((r) => r.projectId)).toEqual([a.id]);
    });
});

describe('retention rules (#941)', () => {
    const pid = 'p1' as ProjectId;
    const project = (features: ProjectRecord['features']): ProjectRecord => ({ id: pid, name: 'P', members: { agentIds: [], coordinator: null }, folders: {}, connectors: [], features, createdAt: 0, updatedAt: 0 });

    it('keeps what a patch takes off, and nothing for a new project', () => {
        expect(nextRemoved(undefined, undefined, project({ [PLAN]: {} }), 5)).toEqual([]);
        expect(nextRemoved(undefined, project({ [PLAN]: { a: 1 }, x: {} }), project({ x: {} }), 5)).toEqual([{ projectId: pid, featureId: PLAN, settings: { a: 1 }, removedAt: 5 }]);
    });

    it('restores nothing once the window has passed', () => {
        const removed = [{ projectId: pid, featureId: PLAN, settings: { a: 1 }, removedAt: 0 }];
        expect(retainedSettings(removed, pid, PLAN, REMOVED_FEATURE_RETENTION_MS - 1)).toEqual({ a: 1 });
        expect(retainedSettings(removed, pid, PLAN, REMOVED_FEATURE_RETENTION_MS)).toBeUndefined();
        expect(retainedSettings(removed, undefined, PLAN, 1)).toBeUndefined();
    });

    it('never purges a feature that is on again, and keeps a record whose purge failed', async () => {
        const removed = [{ projectId: pid, featureId: PLAN, settings: {}, removedAt: 0 }];
        const refs: ActorRecordRef[] = [];
        const on = await purgeExpired(removed, WS, [project({ [PLAN]: {} })], { async purge(ref) { refs.push(ref); } }, REMOVED_FEATURE_RETENTION_MS);
        expect(on).toEqual({ kept: [], purged: [] });
        expect(refs).toEqual([]);
        const failed = await purgeExpired(removed, WS, [project({})], { async purge() { throw new Error('down'); } }, REMOVED_FEATURE_RETENTION_MS);
        expect(failed.kept).toEqual(removed);
    });
});

describe('purge timing (#941)', () => {
    it('arms for the exact expiry, and waits the retry delay only for one already due', () => {
        const removed = [{ projectId: 'p1' as ProjectId, featureId: PLAN, settings: {}, removedAt: 0 }];
        expect(nextPurgeIn(undefined, 0)).toBeUndefined();
        expect(nextPurgeIn(removed, REMOVED_FEATURE_RETENTION_MS - 60_000)).toBe(60_000);
        expect(nextPurgeIn(removed, REMOVED_FEATURE_RETENTION_MS)).toBe(PURGE_MIN_DELAY_MS);
    });
});
