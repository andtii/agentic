/**
 * Project feature plugins in the Registry (#332, PLG-01): a `project-feature`
 * manifest is listed like every other kind (multi-enable, never a slot), and
 * `checkProjectSettings` holds a project's settings to its `projectSettings`
 * schema — what `Workspace.upsertProject` asks over a hop.
 */
import type { ProjectFeatureManifest, WorkspaceId } from '@agentic/core';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');

const git: ProjectFeatureManifest = {
    id: 'agentic.project.git',
    version: '1.0.0',
    kind: 'project-feature',
    name: 'Git',
    description: 'Worktrees and branches per task',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: {
        type: 'object',
        properties: {
            baseBranch: { type: 'string', title: 'Base branch', default: 'main' },
            worktrees: { type: 'boolean', title: 'One worktree per task', default: true }
        }
    },
    permissions: [],
    compat: { platform: '*', core: '*' }
};

const Registry = defineRegistry({ catalogue: [git] });

let app: TestActorApp;
beforeEach(() => {
    // `disable` walks the Workspace index for dependents.
    app = testActorApp([Registry, Workspace]);
    return app.start();
});
afterEach(() => app.stop());

const reg = () => app.as(owner).actor(Registry, registryKey(WS));

describe('project feature manifests (#332)', () => {
    it('are listed with their kind, enabled by default, never a slot', async () => {
        const listed = await reg().list();
        expect(listed.map((p) => [p.manifest.id, p.manifest.kind, p.enabled, p.builtin])).toEqual([['agentic.project.git', 'project-feature', true, true]]);
        expect('active' in listed[0]!).toBe(false);
        expect((await reg().overview()).active).toEqual({});
    });

    it('checkProjectSettings accepts settings that pass the projectSettings schema, defaults filled in', async () => {
        await expect(reg().checkProjectSettings('agentic.project.git', {})).resolves.toBeUndefined();
        await expect(reg().checkProjectSettings('agentic.project.git', { baseBranch: 'develop' })).resolves.toBeUndefined();
        await expect(reg().checkProjectSettings('agentic.project.git', { worktrees: false, baseBranch: undefined })).resolves.toBeUndefined();
    });

    it('refuses bad settings, another kind, a disabled or unknown plugin (400)', async () => {
        expect(await statusOf(reg().checkProjectSettings('agentic.project.git', { baseBranch: 7 }))).toBe(400);
        await expect(reg().checkProjectSettings('agentic.project.git', { worktrees: 'yes' })).rejects.toThrow(/worktrees/);
        expect(await statusOf(reg().checkProjectSettings('agentic.project.git', [] as never))).toBe(400);
        expect(await statusOf(reg().checkProjectSettings('nope', {}))).toBe(400);
        await reg().register({ ...git, id: 'other', kind: 'connector', projectSettings: undefined } as never, { enabled: true });
        expect(await statusOf(reg().checkProjectSettings('other', {}))).toBe(400);
        await reg().disable('agentic.project.git');
        expect(await statusOf(reg().checkProjectSettings('agentic.project.git', {}))).toBe(400);
        await expect(reg().checkProjectSettings('agentic.project.git', {})).rejects.toThrow(/turned off/);
    });
});
