/**
 * The project form's model (#333): draft ↔ patch, the folder rows' origin
 * rules, feature detection and the effective folder of a chat member.
 */
import { describe, it, expect } from 'vitest';
import type { EnvironmentId, ProjectFeatureManifest, ProjectRecord } from '@agentic/core';
import { connectorOptionsOf, detectedFeatures, effectiveWorkdir, featureManifestsOf, originMismatch, originOf, projectDraftOf, projectEnvironments, projectPatchOf, validateProjectDraft, withOrigin } from '../../src/pages/projects/model';
import { PROJECTS } from '../../src/mock/workspace';
import { opsPlugins } from '../../src/mock/ops';

const WORK = 'env_work' as EnvironmentId;
const MAC = 'env_mac' as EnvironmentId;
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

    it('lists the environments a project has a folder on with the picker labels', () => {
        expect(projectEnvironments(PROJECTS[0]!, [{ id: 'env_alien01_work', label: 'alien01 / work' }])).toEqual([
            { id: 'env_alien01_work', label: 'alien01 / work', path: 'C:\\Dev\\agentic\\main' },
            { id: 'env_alien01_personal', label: 'env_alien01_personal', path: 'C:\\Users\\andy\\src\\agentic' }
        ]);
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

    it('the mock Registry lists one project feature and one connector', () => {
        expect(featureManifestsOf(opsPlugins).map((m) => m.id)).toEqual(['agentic.feature.git']);
        expect(featureManifestsOf(opsPlugins)[0]!.projectSettings.properties).toHaveProperty('origin');
        expect(connectorOptionsOf(opsPlugins)).toEqual([{ value: 'github-mcp', label: 'GitHub (MCP)' }]);
    });
});

describe('effectiveWorkdir', () => {
    it('the override wins, else the project\u2019s folder for the member\u2019s environment, else none', () => {
        const project = { folders: { [WORK]: 'C:\\Dev\\agentic\\main' } };
        expect(effectiveWorkdir({ workdir: { environmentId: MAC, path: '/tmp/x' } }, WORK, project)).toEqual({ ref: { environmentId: MAC, path: '/tmp/x' }, inherited: false });
        expect(effectiveWorkdir({}, WORK, project)).toEqual({ ref: { environmentId: WORK, path: 'C:\\Dev\\agentic\\main' }, inherited: true });
        expect(effectiveWorkdir({}, MAC, project)).toEqual({ ref: null, inherited: false });
        expect(effectiveWorkdir({}, undefined, project)).toEqual({ ref: null, inherited: false });
        expect(effectiveWorkdir({}, WORK, undefined)).toEqual({ ref: null, inherited: false });
    });
});
