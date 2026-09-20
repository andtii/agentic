/**
 * The git project feature (#335): the manifest's shape, `detect` on the git
 * badge, `instructions` from the settings, and `beforeSession` against a
 * recording fake `fs` — one `worktree` op per chat and environment at the
 * path `suggestWorktreePath` names, reused through `branch-exists` / `exists`,
 * any other daemon error thrown with the daemon's message.
 */
import { describe, expect, it } from 'vitest';
import { PROJECT_FEATURE_KIND, configDefaults, isProjectFeatureManifest, suggestWorktreePath, validateConfig, type ChatId, type EnvironmentId, type FsError, type FsOp, type FsResult, type ProjectFeatureFs, type ProjectFeatureSessionInput, type ProjectId, type ProjectRecord, type TaskId } from '@agentic/core';

import { DEFAULT_BRANCH_PREFIX, GIT_FEATURE_ID, gitBranchFor, gitFeatureManifest, gitFeaturePlugin, hostOsOfPath, identityOf, isValidBranchName } from '../src/index';

const CHAT = 'chat_AbCdEfGhIjKlMnOpQrStUv' as ChatId;
const SHORT = 'opqrstuv';

const project: ProjectRecord = {
    id: 'project_1' as ProjectId,
    name: 'Agentic',
    members: { agentIds: [], coordinator: null },
    folders: { ['env_1' as EnvironmentId]: 'C:\\Dev\\agentic\\main' },
    connectors: [],
    features: { [GIT_FEATURE_ID]: {} },
    createdAt: 0,
    updatedAt: 0
};

/** The settings as the router hands them over: the manifest's defaults under the project's own. */
const settingsOf = (own: Record<string, unknown> = {}): Readonly<Record<string, unknown>> => ({ ...configDefaults(gitFeatureManifest.projectSettings), ...own });

/** A fake daemon: records every op and answers with the scripted result or error (a created worktree by default). */
function fakeFs(answer?: (op: Extract<FsOp, { kind: 'worktree' }>) => { result: FsResult } | { error: FsError }): { fs: ProjectFeatureFs; ops: FsOp[] } {
    const ops: FsOp[] = [];
    const fs: ProjectFeatureFs = async (op) => {
        ops.push(op);
        if (op.kind !== 'worktree') return { error: { code: 'unsupported', message: `not a worktree op: ${op.kind}` } };
        return answer ? answer(op) : { result: { kind: 'worktree', path: op.path, branch: op.branch } };
    };
    return { fs, ops };
}

function input(fs: ProjectFeatureFs, cwd: string, extra: { settings?: Record<string, unknown>; chatId?: ChatId | undefined; environmentId?: EnvironmentId } = {}): ProjectFeatureSessionInput {
    return {
        project,
        settings: settingsOf(extra.settings),
        taskId: 'task_1' as TaskId,
        ...('chatId' in extra ? (extra.chatId ? { chatId: extra.chatId } : {}) : { chatId: CHAT }),
        environmentId: extra.environmentId ?? ('env_1' as EnvironmentId),
        cwd,
        fs
    };
}

describe('manifest', () => {
    it('is a project-feature manifest under the id the web already uses, with the documented settings and their defaults', () => {
        expect(gitFeatureManifest.id).toBe('agentic.feature.git');
        expect(gitFeatureManifest.kind).toBe(PROJECT_FEATURE_KIND);
        expect(isProjectFeatureManifest(gitFeatureManifest)).toBe(true);
        expect(gitFeaturePlugin.manifest).toBe(gitFeatureManifest);
        // The registry's `assertPluginManifest` rules, replicated: strings, lists and a compat block.
        expect(gitFeatureManifest.version).not.toBe('');
        expect(gitFeatureManifest.name.trim()).not.toBe('');
        expect(typeof gitFeatureManifest.description).toBe('string');
        expect(Array.isArray(gitFeatureManifest.capabilities)).toBe(true);
        expect(gitFeatureManifest.permissions).toEqual([]);
        expect(gitFeatureManifest.compat).toEqual({ platform: '*', core: '*' });
        expect(Object.keys(gitFeatureManifest.projectSettings.properties!)).toEqual(['origin', 'worktreePerChat', 'branchPrefix', 'base', 'instructions']);
        expect(configDefaults(gitFeatureManifest.projectSettings)).toEqual({ worktreePerChat: false, branchPrefix: DEFAULT_BRANCH_PREFIX, instructions: '' });
        // Nothing workspace-wide to set.
        expect(validateConfig(gitFeatureManifest.config, {})).toEqual({ ok: true, value: {} });
    });

    it('accepts an origin as git writes it — https or scp-like — and refuses a setting it does not have', () => {
        const schema = gitFeatureManifest.projectSettings;
        expect(validateConfig(schema, { origin: 'https://github.com/andtii/agentic.git' }).ok).toBe(true);
        expect(validateConfig(schema, { origin: 'git@github.com:andtii/agentic.git', worktreePerChat: true, base: 'main' }).ok).toBe(true);
        expect(validateConfig(schema, { worktrees: true })).toMatchObject({ ok: false, errors: [{ path: 'worktrees' }] });
        expect(validateConfig(schema, { worktreePerChat: 'yes' })).toMatchObject({ ok: false, errors: [{ path: 'worktreePerChat' }] });
    });
});

describe('detect and identity', () => {
    it('detect is true for a repo or a worktree badge, false without one; identityOf is the badge origin', () => {
        const detect = gitFeaturePlugin.detect!;
        expect(detect({ path: '/work/agentic', git: { kind: 'repo', branch: 'main', origin: 'git@github.com:andtii/agentic.git' } })).toBe(true);
        expect(detect({ path: '/work/agentic/branches/x', git: { kind: 'worktree', branch: 'x' } })).toBe(true);
        expect(detect({ path: '/work/agentic', git: { kind: 'repo', head: 'abc1234' } })).toBe(true);
        expect(detect({ path: '/work/notes' })).toBe(false);
        expect(identityOf({ path: '/work/agentic', git: { kind: 'repo', origin: 'https://github.com/andtii/agentic.git' } })).toBe('https://github.com/andtii/agentic.git');
        expect(identityOf({ path: '/work/agentic', git: { kind: 'repo' } })).toBeUndefined();
        expect(identityOf({ path: '/work/notes' })).toBeUndefined();
    });
});

describe('instructions', () => {
    it('is the trimmed settings text, or nothing when the text is empty', () => {
        const instructions = gitFeaturePlugin.instructions!;
        expect(instructions({ project, settings: settingsOf({ instructions: '  Branch first; never work on main.\n' }) })).toBe('Branch first; never work on main.');
        expect(instructions({ project, settings: settingsOf() })).toBeUndefined();
        expect(instructions({ project, settings: settingsOf({ instructions: '   ' }) })).toBeUndefined();
        expect(instructions({ project, settings: { instructions: 42 } })).toBeUndefined();
    });
});

describe('branch names', () => {
    it('gitBranchFor is the prefix plus the lowercased short chat id; the same for every environment and task of the chat', () => {
        expect(gitBranchFor(CHAT)).toBe(`chat/${SHORT}`);
        expect(gitBranchFor(CHAT, 'feat/')).toBe(`feat/${SHORT}`);
        expect(gitBranchFor(CHAT, 'wip-')).toBe(`wip-${SHORT}`);
        expect(gitBranchFor(CHAT, '')).toBe(SHORT);
        expect(gitBranchFor('short')).toBe('chat/short');
        expect(gitBranchFor('chat_-_Ab-Cd_')).toBe('chat/-_ab-cd_');
    });

    it('throws a clear error when the prefix makes an invalid ref name, or the id has nothing to name after', () => {
        expect(() => gitBranchFor(CHAT, '-x/')).toThrow(/"-x\/opqrstuv" is not a valid branch name; check the project's branch prefix "-x\/"/);
        expect(() => gitBranchFor(CHAT, 'a..b/')).toThrow(/not a valid branch name/);
        expect(() => gitBranchFor(CHAT, 'a b/')).toThrow(/not a valid branch name/);
        expect(() => gitBranchFor(CHAT, '.hidden/')).toThrow(/not a valid branch name/);
        expect(() => gitBranchFor(CHAT, 'x//')).toThrow(/not a valid branch name/);
        expect(() => gitBranchFor('chat_')).toThrow(/has nothing to name a branch after/);
    });

    it('isValidBranchName follows the conservative ref-name rules', () => {
        for (const ok of ['main', 'chat/a1b2c3d4', 'feat/x.y-z_1', 'release-1.0', 'a/b/c']) expect(isValidBranchName(ok), ok).toBe(true);
        for (const bad of ['', '-main', 'chat/', '/chat', 'a//b', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '.a', 'a/.b', 'a.lock', 'a/b.lock', '@', 'a@{b']) expect(isValidBranchName(bad), bad).toBe(false);
    });

    it('hostOsOfPath reads the path shape', () => {
        expect(hostOsOfPath('C:\\Dev\\agentic\\main')).toBe('windows');
        expect(hostOsOfPath('c:/dev/agentic')).toBe('windows');
        expect(hostOsOfPath('\\\\server\\share\\repo')).toBe('windows');
        // A UNC share written with forward slashes, as core's `parse` / `suggestWorktreePath` also read it.
        expect(hostOsOfPath('//server/share/repo')).toBe('windows');
        expect(suggestWorktreePath('//server/share/repo', 'chat/x', hostOsOfPath('//server/share/repo'))).toBe('\\\\server\\share\\repo-worktrees\\chat-x');
        expect(hostOsOfPath('/home/me/agentic')).toBe('linux');
        expect(hostOsOfPath('/Users/me/agentic')).toBe('linux');
    });
});

describe('beforeSession', () => {
    it('does nothing when worktreePerChat is off, or the task came from no chat', async () => {
        const { fs, ops } = fakeFs();
        expect(await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic'))).toBeUndefined();
        expect(await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true, instructions: 'x' }, chatId: undefined }))).toBeUndefined();
        expect(ops).toEqual([]);
    });

    it('on a Windows checkout named main: one worktree op beside it under branches/, the session moved there with a line naming the branch', async () => {
        const { fs, ops } = fakeFs();
        const effect = await gitFeaturePlugin.beforeSession!(input(fs, 'C:\\Dev\\agentic\\main', { settings: { worktreePerChat: true, instructions: 'Branch first.' } }));
        expect(ops).toEqual([{ kind: 'worktree', repo: 'C:\\Dev\\agentic\\main', branch: `chat/${SHORT}`, path: `C:\\Dev\\agentic\\branches\\chat-${SHORT}` }]);
        expect(ops[0]).toMatchObject({ path: suggestWorktreePath('C:\\Dev\\agentic\\main', `chat/${SHORT}`, 'windows') });
        expect(effect).toEqual({ cwd: `C:\\Dev\\agentic\\branches\\chat-${SHORT}`, instructions: `This chat works on branch \`chat/${SHORT}\` in \`C:\\Dev\\agentic\\branches\\chat-${SHORT}\`.` });
    });

    it('on a Linux checkout: the worktree goes to <repo>-worktrees/<slug>; the daemon\u2019s answer names the folder', async () => {
        // The daemon may resolve the path it was given: what it answers is where the session opens.
        const { fs, ops } = fakeFs((op) => ({ result: { kind: 'worktree', path: `${op.path}/`, branch: op.branch } }));
        const effect = await gitFeaturePlugin.beforeSession!(input(fs, '/home/me/agentic', { settings: { worktreePerChat: true } }));
        expect(ops).toEqual([{ kind: 'worktree', repo: '/home/me/agentic', branch: `chat/${SHORT}`, path: `/home/me/agentic-worktrees/chat-${SHORT}` }]);
        expect(effect?.cwd).toBe(`/home/me/agentic-worktrees/chat-${SHORT}/`);
        expect(effect?.instructions).toContain(`branch \`chat/${SHORT}\` in \`/home/me/agentic-worktrees/chat-${SHORT}/\``);
    });

    it('two environments of one chat get the same branch name, each beside its own checkout; base and branchPrefix pass through', async () => {
        const { fs, ops } = fakeFs();
        const settings = { worktreePerChat: true, branchPrefix: 'feat/', base: ' develop ' };
        const a = await gitFeaturePlugin.beforeSession!(input(fs, 'C:\\Dev\\agentic\\main', { settings, environmentId: 'env_1' as EnvironmentId }));
        const b = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings, environmentId: 'env_2' as EnvironmentId }));
        expect(ops).toEqual([
            { kind: 'worktree', repo: 'C:\\Dev\\agentic\\main', branch: `feat/${SHORT}`, path: `C:\\Dev\\agentic\\branches\\feat-${SHORT}`, base: 'develop' },
            { kind: 'worktree', repo: '/work/agentic', branch: `feat/${SHORT}`, path: `/work/agentic-worktrees/feat-${SHORT}`, base: 'develop' }
        ]);
        expect(a?.cwd).toBe(`C:\\Dev\\agentic\\branches\\feat-${SHORT}`);
        expect(b?.cwd).toBe(`/work/agentic-worktrees/feat-${SHORT}`);
    });

    it('branch-exists and exists mean an earlier task made the worktree: the same path, no error', async () => {
        for (const code of ['branch-exists', 'exists'] as const) {
            const { fs, ops } = fakeFs(() => ({ error: { code, message: `${code} from the daemon` } }));
            const effect = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true } }));
            expect(ops).toHaveLength(1);
            expect(effect).toEqual({ cwd: `/work/agentic-worktrees/chat-${SHORT}`, instructions: `This chat works on branch \`chat/${SHORT}\` in \`/work/agentic-worktrees/chat-${SHORT}\`.` });
        }
    });

    it("any other daemon error throws with the daemon's code and message, so the router parks the task", async () => {
        for (const [code, message] of [
            ['timeout', 'the daemon did not answer worktree within 35000 ms'],
            ['not-a-repo', '/work/agentic is not a git repository'],
            ['unsupported', 'the in-memory daemon does not answer worktree'],
            ['outside-roots', '/work/agentic-worktrees/x is outside the working roots']
        ] as const) {
            const { fs } = fakeFs(() => ({ error: { code, message } }));
            await expect(gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true } }))).rejects.toThrow(`git worktree ${code}: ${message}`);
        }
    });

    it('an invalid branch prefix or a relative folder throws before any daemon round trip; a wrong-kind answer throws after it', async () => {
        const { fs, ops } = fakeFs();
        await expect(gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true, branchPrefix: '..' } }))).rejects.toThrow(/not a valid branch name/);
        await expect(gitFeaturePlugin.beforeSession!(input(fs, 'agentic', { settings: { worktreePerChat: true } }))).rejects.toThrow(/"agentic" is not an absolute path/);
        expect(ops).toEqual([]);
        const wrong = fakeFs(() => ({ result: { kind: 'list', path: '/work/agentic', entries: [], truncated: false } }));
        await expect(gitFeaturePlugin.beforeSession!(input(wrong.fs, '/work/agentic', { settings: { worktreePerChat: true } }))).rejects.toThrow(/answered with a list result/);
    });
});
