/**
 * The project form's model (#333): draft ↔ patch, the folder rows' origin
 * rules, feature detection and the effective folder of a chat member.
 */
import { describe, it, expect } from 'vitest';
import { projectFolderKey, type EnvironmentId, type MachineId, type ProjectFeatureManifest, type ProjectRecord } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import { connectorOptionsOf, detectedFeatures, effectiveWorkdir, featureManifestsOf, hasUnplacedFolders, originMismatch, originOf, projectDraftOf, projectFolderOn, projectPatchOf, projectPlaces, resolveFolders, rootsOn, validateProjectDraft, withOrigin, type ProjectMachine } from '../../src/pages/projects/model';
import { PROJECTS } from '../../src/mock/workspace';
import { opsPlugins } from '../../src/mock/ops';

const WIN_M = 'machine_win' as MachineId;
const MAC_M = 'machine_mac' as MachineId;
/** The folder keys (#702): each machine's folder. */
const WORK = projectFolderKey(WIN_M);
const MAC = projectFolderKey(MAC_M);
const GIT = { kind: 'repo', branch: 'main', origin: 'https://github.com/andtii/agentic.git' } as const;

const stored: ProjectRecord = {
    id: 'p1' as never,
    name: 'agentic',
    description: 'The platform',
    members: { agentIds: ['forge', 'lint'] as never[], coordinator: 'forge' as never },
    folders: { [WORK]: 'C:\\Dev\\agentic\\main', [MAC]: '/Users/me/dev/agentic' },
    connectors: [{ id: 'github-mcp' }],
    features: { git: { origin: GIT.origin } },
    createdAt: 1,
    updatedAt: 2
};

describe('project draft ↔ patch', () => {
    it('a blank draft creates: the name trimmed, no description, the roster with its coordinator, folders and features whole', () => {
        const draft = projectDraftOf();
        expect(validateProjectDraft(draft)).toEqual({ name: 'A name is required.' });
        draft.name = ' docs ';
        draft.picked = ['scout', 'scout'];
        draft.coordinator = 'atlas';
        draft.folders = { [WORK]: { path: ' C:\\Dev\\docs ', git: GIT } };
        draft.features = { git: { origin: GIT.origin } };
        expect(validateProjectDraft(draft)).toEqual({});
        // The coordinator must be a member; a duplicate pick counts once; the badge never leaves the draft.
        expect(projectPatchOf(draft)).toEqual({ name: 'docs', members: { agentIds: ['scout'], coordinator: null }, folders: { [WORK]: 'C:\\Dev\\docs' }, connectors: [], features: { git: { origin: GIT.origin } } });
    });

    it('an edit opens on the record and sends what was dropped as null', () => {
        const draft = projectDraftOf(stored);
        expect(draft).toMatchObject({ name: 'agentic', description: 'The platform', picked: ['forge', 'lint'], coordinator: 'forge', connectors: ['github-mcp'], folders: { [WORK]: { path: 'C:\\Dev\\agentic\\main' } } });
        draft.description = '';
        delete draft.folders[MAC];
        draft.features = {};
        expect(projectPatchOf(draft, stored)).toEqual({
            id: 'p1',
            name: 'agentic',
            description: null,
            members: { agentIds: ['forge', 'lint'], coordinator: 'forge' },
            folders: { [WORK]: 'C:\\Dev\\agentic\\main', [MAC]: null },
            connectors: [{ id: 'github-mcp' }],
            features: { git: null }
        });
    });
});

describe('folders and origins', () => {
    it('the project\u2019s origin is the first badge that has one; a row of another repo mismatches, a row without a badge never does', () => {
        const folders = { [WORK]: { path: 'a', git: GIT }, [MAC]: { path: 'b', git: { kind: 'worktree', branch: 'x', origin: 'git@github.com:andtii/agentic' } as const }, env_c: { path: 'c' } };
        expect(originOf(folders)).toBe(GIT.origin);
        expect(originOf(folders, WORK)).toBe('git@github.com:andtii/agentic');
        expect(originOf({ env_c: { path: 'c' } })).toBeUndefined();
        expect(originMismatch(folders, WORK)).toBe(false);
        expect(originMismatch(folders, 'env_c')).toBe(false);
        const other = { ...folders, [MAC]: { path: 'b', git: { kind: 'repo', branch: 'main', origin: 'https://github.com/signalxjs/sigx.git' } as const } };
        expect(originMismatch(other, MAC)).toBe(true);
        expect(originMismatch(other, WORK)).toBe(true);
    });

    it('lists where a project has folders: the machine by name, an override by its environment label', () => {
        const machines: ProjectMachine[] = [{ id: 'alien01', name: 'alien01', environments: [environment('env_alien01_personal', 'alien01 / personal', 'windows', ['C:\\Users\\andy'])] }];
        expect(projectPlaces(PROJECTS[0]!, machines)).toEqual([
            { key: 'alien01/*', label: 'alien01', path: 'C:\\Dev\\agentic\\main' },
            { key: 'alien01/env_alien01_personal', label: 'alien01 / personal', path: 'C:\\Users\\andy\\src\\agentic' }
        ]);
        // A machine no longer listed keeps its id; a pre-#702 key is labelled by an environment of that id.
        expect(projectPlaces({ folders: { 'gone/*': '/x', env_alien01_personal: 'C:\\Users\\andy\\x' } }, machines).map((p) => p.label)).toEqual(['gone', 'alien01 / personal']);
        // The same environment id on two machines: the one whose roots hold the folder names it.
        const both: ProjectMachine[] = [{ id: 'mac', name: 'mac', environments: [environment('env_claude', 'mac / claude', 'darwin', ['/Users/me'])] }, { id: 'win', name: 'win', environments: [environment('env_claude', 'win / claude', 'windows', ['C:\\Dev'])] }];
        expect(projectPlaces({ folders: { env_claude: 'C:\\Dev\\agentic' } }, both).map((p) => p.label)).toEqual(['win / claude']);
    });
});

const environment = (id: string, label: string, os: WorkdirEnvironment['os'], roots: string[]): WorkdirEnvironment => ({ id: id as EnvironmentId, label, os, roots });

describe('folders stored before #702 (keyed by a bare environment id)', () => {
    // The reported case: both machines have an environment the daemon named `env_claude`, each with its own roots.
    const mac: ProjectMachine = { id: MAC_M, name: 'Andii Mac', environments: [environment('env_andii', 'Andii Mac / andii', 'darwin', ['/Users/andii/dev']), environment('env_claude', 'Andii Mac / claude', 'darwin', ['/Users/andii/dev']), environment('env_claude2', 'Andii Mac / claude2', 'darwin', ['/Users/andii/dev'])] };
    const win: ProjectMachine = { id: WIN_M, name: 'machine-6', environments: [environment('env_claude', 'machine-6 / Claude', 'windows', ['C:\\Dev']), environment('env_claude_2', 'machine-6 / Claude 2', 'windows', ['C:\\Dev']), environment('env_codex', 'machine-6 / Codex', 'windows', ['D:\\work'])] };

    it('go to the machine whose environment of that id holds them; one folder for all of them becomes the machine folder', () => {
        const folders = { env_andii: { path: '/Users/andii/dev/agentic/main' }, env_claude2: { path: '/Users/andii/dev/agentic/main' }, env_claude: { path: 'C:\\Dev\\agentic\\main' }, env_claude_2: { path: 'C:\\Dev\\agentic\\main' } };
        expect(hasUnplacedFolders(folders)).toBe(true);
        const placed = resolveFolders(folders, [mac, win]);
        expect(placed).toEqual({ [MAC]: { path: '/Users/andii/dev/agentic/main' }, [WORK]: { path: 'C:\\Dev\\agentic\\main' } });
        expect(hasUnplacedFolders(placed)).toBe(false);
    });

    it('different folders on one machine stay overrides; one no machine can take is left out; nothing moves before the machines are known', () => {
        const folders = { env_andii: { path: '/Users/andii/dev/a' }, env_claude2: { path: '/Users/andii/dev/b', git: GIT }, env_claude: { path: 'E:\\elsewhere' }, env_gone: { path: '/x' } };
        expect(resolveFolders(folders, [mac, win])).toEqual({ [projectFolderKey(MAC_M, 'env_andii' as EnvironmentId)]: { path: '/Users/andii/dev/a' }, [projectFolderKey(MAC_M, 'env_claude2' as EnvironmentId)]: { path: '/Users/andii/dev/b', git: GIT } });
        // Outside every root but reported by one machine only: kept there, so the save explains it instead of losing it.
        expect(resolveFolders({ env_codex: { path: 'C:\\elsewhere' } }, [mac, win])).toEqual({ [WORK]: { path: 'C:\\elsewhere' } });
        expect(resolveFolders(folders, [])).toEqual(folders);
    });

    it('the save removes the old keys and sends the placed ones; a folder not yet placed is never sent', () => {
        const record = { ...stored, folders: { env_andii: '/Users/andii/dev/agentic/main' } };
        const draft = projectDraftOf(record);
        expect(projectPatchOf(draft, record).folders).toEqual({});
        draft.folders = resolveFolders(draft.folders, [mac, win]);
        expect(projectPatchOf(draft, record).folders).toEqual({ [MAC]: '/Users/andii/dev/agentic/main', env_andii: null });
    });
});

describe('features', () => {
    const git: ProjectFeatureManifest = { id: 'git', version: '1', kind: 'project-feature', name: 'Git', description: '', capabilities: [], config: {}, permissions: [], compat: { platform: '*', core: '*' }, projectSettings: { properties: { origin: { type: 'string', format: 'uri' }, worktrees: { type: 'boolean' } } } };

    it('detect asks each plugin about the folder; withOrigin fills an empty origin only where the schema has one', () => {
        const catalogue = { git: { manifest: git, detect: (f: { git?: unknown }) => !!f.git }, other: { manifest: { ...git, id: 'other', projectSettings: {} } } };
        expect(detectedFeatures(catalogue, { path: 'x', git: GIT })).toEqual(['git']);
        expect(detectedFeatures(catalogue, { path: 'x' })).toEqual([]);
        expect(withOrigin(git.projectSettings, {}, GIT.origin)).toEqual({ origin: GIT.origin });
        expect(withOrigin(git.projectSettings, { origin: 'kept' }, GIT.origin)).toEqual({ origin: 'kept' });
        expect(withOrigin(git.projectSettings, { worktrees: true }, undefined)).toEqual({ worktrees: true });
        expect(withOrigin({}, {}, GIT.origin)).toEqual({});
    });

    it('the mock Registry lists one project feature and its connectors', () => {
        expect(featureManifestsOf(opsPlugins).map((m) => m.id)).toEqual(['agentic.feature.git']);
        expect(featureManifestsOf(opsPlugins)[0]!.projectSettings.properties).toHaveProperty('origin');
        expect(connectorOptionsOf(opsPlugins)).toEqual([
            { value: 'github-mcp', label: 'GitHub (MCP)' },
            // A conduit connector (#533).
            { value: 'gmail', label: 'Gmail' }
        ]);
    });
});

describe('rootsOn', () => {
    it('reads an environment\u2019s roots on the machine named, never another machine\u2019s of the same id (#702)', () => {
        const machines = [
            { id: 'mac', name: 'Mac', online: true, os: 'darwin' as const, environments: [{ id: 'env_claude', cwdRoots: ['/Users/me/dev'] }] },
            { id: 'win', name: 'Win', online: true, environments: [{ id: 'env_claude', cwdRoots: ['C:\\Dev'] }] }
        ] as never;
        expect(rootsOn(machines, 'win', 'env_claude')).toEqual({ roots: ['C:\\Dev'], os: 'windows' });
        expect(rootsOn(machines, 'mac', 'env_claude')).toEqual({ roots: ['/Users/me/dev'], os: 'darwin' });
        expect(rootsOn(machines, undefined, 'env_claude')).toBeUndefined();
        expect(rootsOn(machines, 'win', 'env_nope')).toBeUndefined();
    });
});

describe('effectiveWorkdir', () => {
    it('the override wins, else the project\u2019s folder for the member\u2019s environment, else none', () => {
        const project = { folders: { env_work: 'C:\\Dev\\agentic\\main' } };
        // A pre-#702 folder keyed by the environment id alone.
        expect(effectiveWorkdir({ workdir: { environmentId: 'env_mac' as EnvironmentId, path: '/tmp/x' } }, 'env_work', project)).toEqual({ ref: { environmentId: 'env_mac', path: '/tmp/x' }, inherited: false });
        expect(effectiveWorkdir({}, 'env_work', project)).toEqual({ ref: { environmentId: 'env_work', path: 'C:\\Dev\\agentic\\main' }, inherited: true });
        expect(effectiveWorkdir({}, 'env_mac', project)).toEqual({ ref: null, inherited: false });
        expect(effectiveWorkdir({}, undefined, project)).toEqual({ ref: null, inherited: false });
        // By machine (#702): the environment's override on the chat's machine, else that machine's folder.
        const byMachine = { folders: { [projectFolderKey(WIN_M)]: 'C:\\Dev\\agentic\\main', [projectFolderKey(WIN_M, 'env_codex' as EnvironmentId)]: 'D:\\work\\agentic' } };
        expect(effectiveWorkdir({}, 'env_claude', byMachine, WIN_M).ref).toEqual({ environmentId: 'env_claude', path: 'C:\\Dev\\agentic\\main' });
        expect(effectiveWorkdir({}, 'env_codex', byMachine, WIN_M).ref).toEqual({ environmentId: 'env_codex', path: 'D:\\work\\agentic' });
        expect(effectiveWorkdir({}, 'env_claude', byMachine, MAC_M).ref).toBeNull();
        // As the router takes it: the machine's folder only where the environment's roots hold it; an override always.
        const dev = { roots: ['C:\\Dev'], os: 'windows' as const };
        const elsewhere = { roots: ['E:\\other'], os: 'windows' as const };
        expect(effectiveWorkdir({}, 'env_claude', byMachine, WIN_M, dev).ref?.path).toBe('C:\\Dev\\agentic\\main');
        expect(effectiveWorkdir({}, 'env_claude', byMachine, WIN_M, elsewhere)).toEqual({ ref: null, inherited: false });
        expect(projectFolderOn(byMachine, 'env_codex', WIN_M, elsewhere)).toBe('D:\\work\\agentic');
        expect(effectiveWorkdir({}, 'env_work', undefined)).toEqual({ ref: null, inherited: false });
    });
});
