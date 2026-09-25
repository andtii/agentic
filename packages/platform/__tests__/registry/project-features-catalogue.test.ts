/**
 * `Registry.projectFeatures()` and `checkProjectSettings` needs (#735, PRJ-06/07): the Features page lists every
 * project feature with its ui slots, category, needs, presets and used-by count in one read, and enabling a
 * feature whose `needs` the project lacks is refused with a one-line reason (Git needs a folder).
 */
import type { ProjectFeatureManifest, WorkspaceId } from '@agentic/core';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';
import { workspaceKey } from '../../src/auth/index';
import { AgentActor } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');

const base = {
    version: '1.0.0',
    kind: 'project-feature',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object', properties: { baseBranch: { type: 'string', default: 'main' } } },
    permissions: [],
    compat: { platform: '*', core: '*' }
} as const;

const git: ProjectFeatureManifest = {
    ...base,
    id: 'agentic.project.git',
    name: 'Git',
    description: 'Worktrees and branches per task',
    category: 'code',
    ui: {
        section: { label: 'Code', icon: 'git-branch', badge: 'open-items' },
        workStages: ['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge'],
        chatRefPrefixes: ['#', 'pr:'],
        needs: ['folder']
    }
};

const plan: ProjectFeatureManifest = {
    ...base,
    id: 'agentic.project.plan',
    name: 'Plan',
    description: 'Milestones and a work list',
    category: 'planning',
    ui: { overviewCard: { title: 'Plan' } },
    projectSettings: { type: 'object' }
};

const gitPresets = [{ id: 'trunk', label: 'Trunk based', settings: { baseBranch: 'main' } }];

const Registry = defineRegistry({ catalogue: [git, plan], projectFeatures: { [git.id]: { presets: gitPresets } } });

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([Registry, Workspace, AuditActor, AgentActor]);
    return app.start();
});
afterEach(() => app.stop());

const reg = () => app.as(owner).actor(Registry, registryKey(WS));
const ws = () => app.as(owner).actor(Workspace, workspaceKey(WS));

describe('Registry.projectFeatures (#735)', () => {
    it('lists every project feature with ui slots, category, needs, presets and used-by count', async () => {
        await reg().register({ ...base, id: 'other', kind: 'connector', name: 'Other', description: 'x', projectSettings: undefined } as never, { enabled: true });
        const features = await reg().projectFeatures();
        expect(features.map((f) => f.id)).toEqual(['agentic.project.git', 'agentic.project.plan']);
        const [g, p] = features;
        expect(g).toMatchObject({ name: 'Git', description: 'Worktrees and branches per task', version: '1.0.0', enabled: true, builtin: true, category: 'code', needs: ['folder'], presets: gitPresets, usedBy: 0 });
        expect(g!.ui.workStages).toEqual(['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge']);
        expect(p).toMatchObject({ category: 'planning', needs: [], presets: [], usedBy: 0, ui: { overviewCard: { title: 'Plan' } } });
    });

    it('counts the projects that have each feature enabled', async () => {
        const a = await ws().upsertProject({ name: 'A', features: { [plan.id]: {} } });
        await ws().upsertProject({ name: 'B', features: { [plan.id]: {} } });
        await ws().upsertProject({ name: 'C' });
        // Git needs a folder, which a test machine would have to report (#772): turn it on for A in storage.
        await app.stop();
        const stored = (await app.storage.load('Workspace', workspaceKey(WS)))!;
        const state = stored.state as { projects: { id: string; features: Record<string, unknown> }[] };
        state.projects.find((p) => p.id === a.id)!.features[git.id] = {};
        await app.storage.save('Workspace', workspaceKey(WS), state, stored.etag);
        app = testActorApp([Registry, Workspace, AuditActor, AgentActor], { storage: app.storage });
        await app.start();
        const byId = Object.fromEntries((await reg().projectFeatures()).map((f) => [f.id, f.usedBy]));
        expect(byId).toEqual({ [git.id]: 1, [plan.id]: 2 });
    });

    it('reports a feature turned off in the workspace', async () => {
        await reg().disable(plan.id);
        expect((await reg().projectFeatures()).find((f) => f.id === plan.id)?.enabled).toBe(false);
    });
});

describe('checkProjectSettings needs (#735)', () => {
    it('refuses Git on a project without a folder, in one line', async () => {
        const refused = reg().checkProjectSettings(git.id, {}, { folders: {} });
        expect(await statusOf(refused)).toBe(400);
        await expect(reg().checkProjectSettings(git.id, {}, { folders: { 'm1/*': '' } })).rejects.toThrow(/Git needs a folder: add one to the project first/);
    });

    it('accepts Git on a project with a folder', async () => {
        await expect(reg().checkProjectSettings(git.id, {}, { folders: { 'm1/*': 'C:/code/a' } })).resolves.toBeUndefined();
    });

    it('accepts a feature without needs on a project without a folder, and skips the check without a target', async () => {
        await expect(reg().checkProjectSettings(plan.id, {}, { folders: {} })).resolves.toBeUndefined();
        await expect(reg().checkProjectSettings(git.id, {})).resolves.toBeUndefined();
    });
});
