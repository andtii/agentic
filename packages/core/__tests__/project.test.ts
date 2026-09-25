import type { EnvironmentId, MachineId, PluginManifest, ProjectFeatureManifest, ProjectId, ProjectRecord } from '../src/index';
import { applyProjectFeaturePreset, enabledProjectFeatures, isProjectFeatureManifest, PROJECT_FEATURE_KIND, PROJECTS_MAX, parseProjectFolderKey, projectFolderFor, projectFolderIsShared, projectFolderKey } from '../src/index';

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
        expect(projectFolderFor({ folders: {} }, env('__proto__'), machine('constructor'))).toBeUndefined();
    });
});

const machine = (id: string) => id as MachineId;

describe('project folders by machine (#702)', () => {
    // Environment ids are only unique per machine: `env_claude` on the Mac and on the Windows box are two environments.
    const folders = {
        [projectFolderKey(machine('machine_mac'))]: '/Users/me/dev/agentic',
        [projectFolderKey(machine('machine_win'))]: 'C:\\Dev\\agentic\\main',
        [projectFolderKey(machine('machine_win'), env('env_codex'))]: 'D:\\agentic'
    };
    it('keys a machine folder as <machineId>/* and an override as <machineId>/<environmentId>', () => {
        expect(projectFolderKey(machine('machine_mac'))).toBe('machine_mac/*');
        expect(projectFolderKey(machine('machine_mac'), env('env_claude'))).toBe('machine_mac/env_claude');
    });
    it('gives the same environment id its own folder on each machine', () => {
        expect(projectFolderFor({ folders }, env('env_claude'), machine('machine_mac'))).toBe('/Users/me/dev/agentic');
        expect(projectFolderFor({ folders }, env('env_claude'), machine('machine_win'))).toBe('C:\\Dev\\agentic\\main');
    });
    it('lets an environment override win over its machine folder', () => {
        expect(projectFolderFor({ folders }, env('env_codex'), machine('machine_win'))).toBe('D:\\agentic');
        expect(projectFolderIsShared({ folders }, env('env_codex'), machine('machine_win'))).toBe(false);
        expect(projectFolderIsShared({ folders }, env('env_claude'), machine('machine_win'))).toBe(true);
    });
    it('falls back to a pre-#702 folder keyed by the bare environment id', () => {
        expect(projectFolderFor({ folders: { env_claude: '/old' } }, env('env_claude'), machine('machine_mac'))).toBe('/old');
        expect(projectFolderFor({ folders: { ...folders, env_claude: '/old' } }, env('env_claude'), machine('machine_mac'))).toBe('/Users/me/dev/agentic');
        expect(projectFolderFor({ folders }, env('env_claude'))).toBeUndefined();
    });
    it('parses every key shape and refuses a malformed one', () => {
        expect(parseProjectFolderKey('machine_mac/*')).toEqual({ machineId: 'machine_mac' });
        expect(parseProjectFolderKey('machine_mac/env_claude')).toEqual({ machineId: 'machine_mac', environmentId: 'env_claude' });
        expect(parseProjectFolderKey('env_claude')).toEqual({ environmentId: 'env_claude', legacy: true });
        for (const bad of ['', ' ', '/*', 'machine_mac/', 'machine_mac/a/b']) expect(parseProjectFolderKey(bad)).toBeNull();
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
