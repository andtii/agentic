import type { EnvironmentId, PluginManifest, ProjectFeatureManifest, ProjectId, ProjectRecord } from '../src/index';
import { applyProjectFeaturePreset, enabledProjectFeatures, isProjectFeatureManifest, PROJECT_FEATURE_KIND, PROJECTS_MAX, projectFolderFor } from '../src/index';

const env = (id: string) => id as EnvironmentId;

const project: ProjectRecord = {
    id: 'project_1' as ProjectId,
    name: 'agentic',
    members: { agentIds: [], coordinator: null },
    folders: { [env('env_win')]: 'C:\\Dev\\agentic\\main', [env('env_mac')]: '/Users/me/dev/agentic' },
    connectors: [],
    features: { git: { worktreePerChat: true } },
    createdAt: 1,
    updatedAt: 1
};

describe('projectFolderFor', () => {
    it('returns the folder for the environment, machine-native', () => {
        expect(projectFolderFor(project, env('env_win'))).toBe('C:\\Dev\\agentic\\main');
        expect(projectFolderFor(project, env('env_mac'))).toBe('/Users/me/dev/agentic');
    });
    it('is undefined on an environment without a folder', () => {
        expect(projectFolderFor(project, env('env_other'))).toBeUndefined();
        expect(projectFolderFor({ folders: {} }, env('env_win'))).toBeUndefined();
    });
    it('never reads a prototype key', () => {
        expect(projectFolderFor({ folders: {} }, env('constructor'))).toBeUndefined();
        expect(projectFolderFor({ folders: {} }, env('__proto__'))).toBeUndefined();
    });
});

describe('enabledProjectFeatures', () => {
    it('lists the feature ids that have settings', () => {
        expect(enabledProjectFeatures(project)).toEqual(['git']);
        expect(enabledProjectFeatures({ features: {} })).toEqual([]);
    });
});

describe('applyProjectFeaturePreset (#621)', () => {
    it('lays the preset over the settings, clears a null field, keeps the rest', () => {
        const preset = { id: 'in-repo', label: 'In the repo', settings: { worktreePath: '{repo}/.worktrees/{branchSlug}', branchTemplate: null } };
        expect(applyProjectFeaturePreset({ worktreePerChat: true, branchTemplate: 'x-{chatId8}', worktreePath: 'auto' }, preset)).toEqual({ worktreePerChat: true, worktreePath: '{repo}/.worktrees/{branchSlug}' });
        // An `undefined` field (a preset built from an optional value) never clobbers what the project has.
        expect(applyProjectFeaturePreset({ base: 'main' }, { id: 'x', label: 'X', settings: { base: undefined } })).toEqual({ base: 'main' });
    });
});

describe('project feature manifests', () => {
    const base: PluginManifest = {
        id: 'git',
        version: '1.0.0',
        kind: PROJECT_FEATURE_KIND,
        name: 'Git',
        description: 'Repos, worktrees',
        capabilities: [],
        config: {},
        permissions: [],
        compat: { platform: '*', core: '*' }
    };
    it('recognises a manifest of the kind that declares project settings', () => {
        const manifest: ProjectFeatureManifest = { ...base, kind: 'project-feature', projectSettings: { type: 'object', properties: { worktreePerChat: { type: 'boolean', default: false } } } };
        expect(isProjectFeatureManifest(manifest)).toBe(true);
        expect(isProjectFeatureManifest(base)).toBe(false);
        expect(isProjectFeatureManifest({ ...base, kind: 'memory' })).toBe(false);
    });
    it('rejects a project settings schema that is not an object', () => {
        expect(isProjectFeatureManifest({ ...base, projectSettings: undefined } as PluginManifest)).toBe(false);
        expect(isProjectFeatureManifest({ ...base, projectSettings: null } as unknown as PluginManifest)).toBe(false);
        expect(isProjectFeatureManifest({ ...base, projectSettings: [] } as unknown as PluginManifest)).toBe(false);
        expect(isProjectFeatureManifest(Object.create({ ...base, projectSettings: {} }) as PluginManifest)).toBe(false);
    });
    it('caps a workspace at fifty projects', () => {
        expect(PROJECTS_MAX).toBe(50);
    });
});
