/**
 * The git project feature (#335): the manifest's shape, `detect` on the git
 * badge, `instructions` from the settings, and `beforeSession` against a
 * recording fake `fs` — one `worktree` op per chat and environment at the
 * path `suggestWorktreePath` (or the project's template, #619) names, the
 * daemon's reuse answered as a result, every daemon error thrown with the
 * daemon's message; a chosen worktree kept as it is.
 */
import { describe, expect, it } from 'vitest';
import { PROJECT_FEATURE_KIND, applyProjectFeaturePreset, configDefaults, isProjectFeatureManifest, suggestWorktreePath, validateConfig, type ChatId, type EnvironmentId, type FsError, type FsGitInfo, type FsOp, type FsResult, type ProjectFeatureFs, type ProjectFeatureSessionInput, type ProjectId, type ProjectRecord, type TaskId } from '@agentic/core';

import { chatWorktreeFor, splitCommand, DEFAULT_BRANCH_PREFIX, DEFAULT_WORKTREE_NOTICE, GIT_FEATURE_ID, gitBranchFor, gitSettingsErrors, gitFeatureManifest, gitFeaturePlugin, hostOsOfPath, identityOf, isValidBranchName } from '../src/index';

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

/** The default notice for a session in `path` on `branch`. */
const notice = (path: string, branch: string) => DEFAULT_WORKTREE_NOTICE.replace('{path}', path).replace('{branch}', branch);

/** A session in `cwd`: by default the project's own folder on the environment, so no chosen worktree is looked for. */
function input(fs: ProjectFeatureFs, cwd: string, extra: { settings?: Record<string, unknown>; chatId?: ChatId | undefined; environmentId?: EnvironmentId; projectFolder?: string } = {}): ProjectFeatureSessionInput {
    const environmentId = extra.environmentId ?? ('env_1' as EnvironmentId);
    return {
        project: { ...project, folders: { [environmentId]: extra.projectFolder ?? cwd } },
        settings: settingsOf(extra.settings),
        taskId: 'task_1' as TaskId,
        ...('chatId' in extra ? (extra.chatId ? { chatId: extra.chatId } : {}) : { chatId: CHAT }),
        environmentId,
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
        expect(Object.keys(gitFeatureManifest.projectSettings.properties!)).toEqual(['origin', 'worktreePerChat', 'branchPrefix', 'branchTemplate', 'worktreePath', 'worktreeStrategy', 'worktreeCreate', 'worktreeSetup', 'worktreeCleanup', 'worktreeDeleteBranch', 'worktreeRemove', 'reuseExisting', 'worktreeNotice', 'base', 'instructions']);
        expect(configDefaults(gitFeatureManifest.projectSettings)).toEqual({ worktreePerChat: false, branchPrefix: DEFAULT_BRANCH_PREFIX, worktreeStrategy: 'builtin', worktreeCleanup: 'never', worktreeDeleteBranch: false, reuseExisting: true, instructions: '' });
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

    it('on a Windows checkout named main: one worktree op beside it under branches/, the session moved there with the notice naming it', async () => {
        const { fs, ops } = fakeFs();
        const effect = await gitFeaturePlugin.beforeSession!(input(fs, 'C:\\Dev\\agentic\\main', { settings: { worktreePerChat: true, instructions: 'Branch first.' } }));
        expect(ops).toEqual([{ kind: 'worktree', repo: 'C:\\Dev\\agentic\\main', branch: `chat/${SHORT}`, path: `C:\\Dev\\agentic\\branches\\chat-${SHORT}` }]);
        expect(ops[0]).toMatchObject({ path: suggestWorktreePath('C:\\Dev\\agentic\\main', `chat/${SHORT}`, 'windows') });
        expect(effect).toEqual({ cwd: `C:\\Dev\\agentic\\branches\\chat-${SHORT}`, instructions: notice(`C:\\Dev\\agentic\\branches\\chat-${SHORT}`, `chat/${SHORT}`) });
    });

    it('on a Linux checkout: the worktree goes to <repo>-worktrees/<slug>; the daemon\u2019s answer names the folder', async () => {
        // The daemon may resolve the path it was given: what it answers is where the session opens.
        const { fs, ops } = fakeFs((op) => ({ result: { kind: 'worktree', path: `${op.path}/`, branch: op.branch } }));
        const effect = await gitFeaturePlugin.beforeSession!(input(fs, '/home/me/agentic', { settings: { worktreePerChat: true } }));
        expect(ops).toEqual([{ kind: 'worktree', repo: '/home/me/agentic', branch: `chat/${SHORT}`, path: `/home/me/agentic-worktrees/chat-${SHORT}` }]);
        expect(effect?.cwd).toBe(`/home/me/agentic-worktrees/chat-${SHORT}/`);
        expect(effect?.instructions).toBe(notice(`/home/me/agentic-worktrees/chat-${SHORT}/`, `chat/${SHORT}`));
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

    it('a worktree the daemon reused or re-created is where the session opens, like a new one (#618)', async () => {
        for (const flag of [{ reused: true }, { recreated: true }] as const) {
            const { fs, ops } = fakeFs((op) => ({ result: { kind: 'worktree', path: op.path, branch: op.branch, ...flag } }));
            const effect = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true } }));
            expect(ops).toHaveLength(1);
            expect(effect).toEqual({ cwd: `/work/agentic-worktrees/chat-${SHORT}`, instructions: notice(`/work/agentic-worktrees/chat-${SHORT}`, `chat/${SHORT}`) });
        }
    });

    it("any other daemon error throws with the daemon's code and message, so the router parks the task", async () => {
        for (const [code, message] of [
            ['timeout', 'the daemon did not answer worktree within 35000 ms'],
            ['not-a-repo', '/work/agentic is not a git repository'],
            ['unsupported', 'the in-memory daemon does not answer worktree'],
            ['outside-roots', '/work/agentic-worktrees/x is outside the working roots'],
            ['worktree-mismatch', '/work/agentic-worktrees/x is the worktree of branch other'],
            ['branch-exists', 'branch chat/x is checked out at /elsewhere'],
            ['exists', '/work/agentic-worktrees/x already exists']
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

    it('names the branch and folder from the project templates, the same for every task of the chat (#619)', async () => {
        const { fs, ops } = fakeFs();
        const settings = { worktreePerChat: true, branchTemplate: 'agent/{project}-{chatId8}', worktreePath: '{repo}/.worktrees/{branchSlug}' };
        const effect = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings }));
        expect(ops).toEqual([{ kind: 'worktree', repo: '/work/agentic', branch: `agent/agentic-${SHORT}`, path: `/work/agentic/.worktrees/agent-agentic-${SHORT}` }]);
        expect(effect?.cwd).toBe(`/work/agentic/.worktrees/agent-agentic-${SHORT}`);
        await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings }));
        expect(ops[1]).toEqual(ops[0]);
        // Windows: `/` in a template is fine, `..` resolves; a sibling folder beside the checkout.
        const win = fakeFs();
        await gitFeaturePlugin.beforeSession!(input(win.fs, 'C:\\Dev\\agentic\\main', { settings: { worktreePerChat: true, worktreePath: '{repoParent}/{repoName}-{branchSlug}' } }));
        expect(win.ops[0]).toMatchObject({ path: `C:\\Dev\\agentic\\main-chat-${SHORT}` });
        // `auto` keeps the built-in placement.
        const auto = fakeFs();
        await gitFeaturePlugin.beforeSession!(input(auto.fs, '/work/agentic', { settings: { worktreePerChat: true, worktreePath: ' auto ' } }));
        expect(auto.ops[0]).toMatchObject({ path: `/work/agentic-worktrees/chat-${SHORT}` });
    });

    it('an unknown token, an invalid expanded branch or a relative folder throws before any daemon round trip (#619)', async () => {
        const { fs, ops } = fakeFs();
        const run = (settings: Record<string, unknown>) => gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true, ...settings } }));
        await expect(run({ branchTemplate: 'chat/{date}' })).rejects.toThrow(/unknown token \{date\}/);
        await expect(run({ branchTemplate: 'chat/{chatId8' })).rejects.toThrow(/unbalanced/);
        await expect(run({ branchTemplate: '-{chatId8}' })).rejects.toThrow(/not a valid branch name/);
        await expect(run({ worktreePath: '{repoName}/{branchSlug}' })).rejects.toThrow(/is not an absolute path/);
        await expect(run({ worktreePath: '{repo}/{nope}' })).rejects.toThrow(/unknown token \{nope\}/);
        expect(ops).toEqual([]);
    });

    it('the notice is the project\u2019s own words with {path} and {branch}, or nothing when blank (#619)', async () => {
        const { fs } = fakeFs();
        const own = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true, worktreeNotice: 'Stay in {path} ({branch}).' } }));
        expect(own?.instructions).toBe(`Stay in /work/agentic-worktrees/chat-${SHORT} (chat/${SHORT}).`);
        const none = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: { worktreePerChat: true, worktreeNotice: '  ' } }));
        expect(none).toEqual({ cwd: `/work/agentic-worktrees/chat-${SHORT}` });
    });

    it('keeps a worktree the chat or task already works in, other than the project folder; creates one from the project folder or a plain checkout (#619)', async () => {
        /** A daemon whose listing gives the session folder `git`, and that makes every worktree it is asked for. */
        const listing =
            (git: FsGitInfo): ProjectFeatureFs =>
            async (op) =>
                op.kind === 'list' ? { result: { kind: 'list', path: op.path, git, entries: [], truncated: false } } : op.kind === 'worktree' ? { result: { kind: 'worktree', path: op.path, branch: op.branch } } : { error: { code: 'unsupported', message: op.kind } };
        const chosen = '/work/agentic-worktrees/42-fix';
        const kept = await gitFeaturePlugin.beforeSession!(input(listing({ kind: 'worktree', branch: '42-fix' }), chosen, { settings: { worktreePerChat: true }, projectFolder: '/work/agentic' }));
        expect(kept).toEqual({ cwd: chosen, instructions: notice(chosen, '42-fix') });

        const ops: FsOp[] = [];
        const record = (inner: ProjectFeatureFs): ProjectFeatureFs => (op) => (ops.push(op), inner(op));
        // A detached worktree is kept, without a notice naming a branch it does not have.
        expect(await gitFeaturePlugin.beforeSession!(input(record(listing({ kind: 'worktree', head: 'abc1234' })), chosen, { settings: { worktreePerChat: true }, projectFolder: '/work/agentic' }))).toEqual({ cwd: chosen });
        // A chosen plain checkout (not a worktree) gets a chat worktree beside it.
        const plain = await gitFeaturePlugin.beforeSession!(input(record(listing({ kind: 'repo', branch: 'main' })), '/work/other', { settings: { worktreePerChat: true }, projectFolder: '/work/agentic' }));
        expect(plain?.cwd).toBe(`/work/other-worktrees/chat-${SHORT}`);
        // `reuseExisting: false` never looks: it creates from wherever the session was placed.
        ops.length = 0;
        await gitFeaturePlugin.beforeSession!(input(record(listing({ kind: 'worktree', branch: '42-fix' })), chosen, { settings: { worktreePerChat: true, reuseExisting: false }, projectFolder: '/work/agentic' }));
        expect(ops.map((o) => o.kind)).toEqual(['worktree']);
        // The project folder itself is never "chosen", even when it is a worktree: every chat still gets its own.
        ops.length = 0;
        await gitFeaturePlugin.beforeSession!(input(record(listing({ kind: 'worktree', branch: 'dev' })), '/work/agentic', { settings: { worktreePerChat: true } }));
        expect(ops.map((o) => o.kind)).toEqual(['worktree']);
    });
});

describe('templates (#619)', () => {
    it('chatWorktreeFor is deterministic and defaults to today\u2019s names', () => {
        const at = { chatId: CHAT, cwd: '/work/agentic', projectName: 'My App' };
        expect(chatWorktreeFor(settingsOf(), at)).toMatchObject({ branch: `chat/${SHORT}`, path: `/work/agentic-worktrees/chat-${SHORT}`, values: { repoName: 'agentic', branchSlug: `chat-${SHORT}` } });
        expect(chatWorktreeFor(settingsOf({ branchTemplate: '{project}/{chatId}' }), at).branch).toBe('my-app/abcdefghijklmnopqrstuv');
        expect(chatWorktreeFor(settingsOf({ branchPrefix: 'wip-', branchTemplate: '{branchPrefix}{chatId8}', worktreePath: '{repoParent}/wt/{branch}' }), at)).toMatchObject({ branch: `wip-${SHORT}`, path: `/work/wt/wip-${SHORT}` });
    });

    it('gitSettingsErrors names each template that cannot expand, for the settings form', () => {
        expect(gitSettingsErrors(settingsOf({ worktreePath: 'auto', branchTemplate: '{chatId8}', worktreeNotice: '{path}' }))).toEqual({});
        expect(gitSettingsErrors(settingsOf({ branchTemplate: '{repo}', worktreePath: '{repo}/{x}', worktreeNotice: '{chatId}' }))).toEqual({
            branchTemplate: expect.stringContaining('{repo}'),
            worktreePath: expect.stringContaining('{x}'),
            worktreeNotice: expect.stringContaining('{chatId}')
        });
    });
});

/**
 * A fake daemon for the command strategy (#620): a folder map of badges `list` reads, and a `run` that answers from
 * `onRun` (which may add the worktree the command made). Every op recorded.
 */
function commandFs(badges: Map<string, FsGitInfo>, onRun: (op: Extract<FsOp, { kind: 'run' }>) => { result: FsResult } | { error: FsError } = () => ({ result: { kind: 'run', exitCode: 0, stdoutTail: '', stderrTail: '' } })) {
    const ops: FsOp[] = [];
    const fs: ProjectFeatureFs = async (op) => {
        ops.push(op);
        if (op.kind === 'list') {
            const git = badges.get(op.path);
            return git ? { result: { kind: 'list', path: op.path, git, entries: [], truncated: false } } : { error: { code: 'not-found', message: `${op.path} does not exist` } };
        }
        if (op.kind === 'run') return onRun(op);
        if (op.kind === 'worktree') return { result: { kind: 'worktree', path: op.path, branch: op.branch, ...(badges.has(op.path) ? { reused: true as const } : {}) } };
        return { error: { code: 'unsupported', message: op.kind } };
    };
    return { fs, ops };
}

describe('command strategy and setup (#620)', () => {
    const wt = `/work/branches/chat-${SHORT}`;
    const settings = { worktreePerChat: true, worktreeStrategy: 'command', worktreeCreate: 'pnpm wt new {branchSlug}', branchTemplate: 'chat-{chatId8}', worktreePath: '{repoParent}/branches/{branchSlug}' };

    it("runs the project's create command in the project folder, checks what it made, then the setup commands in the worktree", async () => {
        const badges = new Map<string, FsGitInfo>();
        const { fs, ops } = commandFs(badges, (op) => {
            if (op.argv[0] === 'pnpm' && op.argv[1] === 'wt') badges.set(wt, { kind: 'worktree', branch: `chat-${SHORT}` });
            return { result: { kind: 'run', exitCode: 0, stdoutTail: '', stderrTail: '' } };
        });
        const effect = await gitFeaturePlugin.beforeSession!(input(fs, '/work/main', { settings: { ...settings, worktreeSetup: ['pnpm install --frozen-lockfile', '  ', 'echo "{path} ready"'] } }));
        expect(ops).toEqual([
            { kind: 'list', path: wt },
            { kind: 'run', cwd: '/work/main', argv: ['pnpm', 'wt', 'new', `chat-${SHORT}`] },
            { kind: 'list', path: wt },
            { kind: 'run', cwd: wt, argv: ['pnpm', 'install', '--frozen-lockfile'] },
            { kind: 'run', cwd: wt, argv: ['echo', `${wt} ready`] }
        ]);
        expect(effect).toEqual({ cwd: wt, instructions: notice(wt, `chat-${SHORT}`) });

        // The next task: the worktree is there, so neither the create command nor setup runs again.
        ops.length = 0;
        expect((await gitFeaturePlugin.beforeSession!(input(fs, '/work/main', { settings: { ...settings, worktreeSetup: ['pnpm install'] } })))?.cwd).toBe(wt);
        expect(ops).toEqual([{ kind: 'list', path: wt }]);
    });

    it('parks the task when the command fails, makes nothing, or makes the wrong branch; or something else is at the folder', async () => {
        const run = (fs: ProjectFeatureFs, extra: Record<string, unknown> = {}) => gitFeaturePlugin.beforeSession!(input(fs, '/work/main', { settings: { ...settings, ...extra } }));
        const failing = commandFs(new Map(), () => ({ result: { kind: 'run', exitCode: 2, stdoutTail: 'ok so far', stderrTail: 'line 1\nfatal: no space' } }));
        await expect(run(failing.fs)).rejects.toThrow(/create failed: `pnpm wt new chat-opqrstuv` exited 2: line 1\nfatal: no space/);
        await expect(run(commandFs(new Map()).fs)).rejects.toThrow(/finished but .* is not a worktree/);
        const wrong = new Map<string, FsGitInfo>();
        await expect(run(commandFs(wrong, () => (wrong.set(wt, { kind: 'worktree', branch: 'other' }), { result: { kind: 'run', exitCode: 0, stdoutTail: '', stderrTail: '' } })).fs)).rejects.toThrow(/worktree-mismatch: the create command made .* on other/);
        await expect(run(commandFs(new Map([[wt, { kind: 'worktree', branch: 'other' }]])).fs)).rejects.toThrow(/worktree-mismatch: .* holds the worktree of other/);
        const old = commandFs(new Map(), () => ({ error: { code: 'unsupported', message: 'the daemon does not run project commands (no run feature); update it' } }));
        await expect(run(old.fs)).rejects.toThrow('git worktree create unsupported: `pnpm wt new chat-opqrstuv`: the daemon does not run project commands (no run feature); update it');
        await expect(run(commandFs(new Map()).fs, { worktreeCreate: '' })).rejects.toThrow(/has no create command/);
    });

    it('with the builtin strategy, setup runs after the daemon adds or re-creates the worktree, not when it reuses one', async () => {
        const badges = new Map<string, FsGitInfo>();
        const { fs, ops } = commandFs(badges);
        const own = { worktreePerChat: true, worktreeSetup: ['npm ci'] };
        await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: own }));
        expect(ops.map((o) => o.kind)).toEqual(['worktree', 'run']);
        expect(ops[1]).toEqual({ kind: 'run', cwd: `/work/agentic-worktrees/chat-${SHORT}`, argv: ['npm', 'ci'] });
        badges.set(`/work/agentic-worktrees/chat-${SHORT}`, { kind: 'worktree', branch: `chat/${SHORT}` });
        ops.length = 0;
        await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', { settings: own }));
        expect(ops.map((o) => o.kind)).toEqual(['worktree']);
        // A failing setup parks the task with its output.
        const failing = commandFs(new Map(), () => ({ result: { kind: 'run', exitCode: 1, stdoutTail: 'npm ERR! missing lockfile', stderrTail: '' } }));
        await expect(gitFeaturePlugin.beforeSession!(input(failing.fs, '/work/agentic', { settings: own }))).rejects.toThrow('git worktree setup failed: `npm ci` exited 1: npm ERR! missing lockfile');
    });

    it('splitCommand reads quotes and nothing else of shell syntax; gitSettingsErrors names bad commands', () => {
        expect(splitCommand(`make  worktree NAME="a b" 'c d'e`)).toEqual(['make', 'worktree', 'NAME=a b', 'c de']);
        expect(splitCommand('echo $HOME; rm -rf / | x && y')).toEqual(['echo', '$HOME;', 'rm', '-rf', '/', '|', 'x', '&&', 'y']);
        expect(splitCommand('say ""')).toEqual(['say', '']);
        expect(() => splitCommand('say "hi')).toThrow(/unclosed "/);
        expect(gitSettingsErrors(settingsOf({ worktreeStrategy: 'command' }))).toEqual({ worktreeCreate: expect.stringContaining('needs a create command') });
        expect(gitSettingsErrors(settingsOf({ worktreeStrategy: 'command', worktreeCreate: 'wt "{branch}', worktreeSetup: ['ok', 'x {nope}'] }))).toEqual({
            worktreeCreate: expect.stringContaining('unclosed'),
            'worktreeSetup.1': expect.stringContaining('{nope}')
        });
        expect(gitSettingsErrors(settingsOf(settings))).toEqual({});
    });
});

describe('settings form seam (#621)', () => {
    it('presets only fill fields, and each clears the templates the others set', () => {
        expect(gitFeaturePlugin.presets!.map((p) => p.id)).toEqual(['git-default', 'in-repo', 'sibling', 'command']);
        const sibling = applyProjectFeaturePreset(settingsOf({ worktreePerChat: true, branchTemplate: 'x-{chatId8}' }), gitFeaturePlugin.presets![2]!);
        expect(sibling).toMatchObject({ worktreePerChat: true, worktreeStrategy: 'builtin', worktreePath: '{repoParent}/{repoName}-{branchSlug}' });
        expect(sibling).not.toHaveProperty('branchTemplate');
        const back = applyProjectFeaturePreset(sibling, gitFeaturePlugin.presets![0]!);
        expect(back).not.toHaveProperty('worktreePath');
        // Every preset clears the templates another may have set.
        for (const p of gitFeaturePlugin.presets!) {
            const after = applyProjectFeaturePreset({ ...sibling, branchTemplate: 'x-{chatId8}' }, p);
            if (!('worktreePath' in p.settings) || p.settings['worktreePath'] === null) expect(after, p.id).not.toHaveProperty('worktreePath');
            expect(after, p.id).not.toHaveProperty('branchTemplate');
        }
        for (const p of gitFeaturePlugin.presets!) expect(validateConfig(gitFeatureManifest.projectSettings, Object.fromEntries(Object.entries(p.settings).filter(([, v]) => v !== null))).ok, p.id).toBe(true);
        expect(gitFeaturePlugin.settingsErrors).toBe(gitSettingsErrors);
    });

    it('previews the branch, folder, maker and setup for a folder of the project, and a problem as a line', () => {
        const preview = gitFeaturePlugin.previewSettings!;
        expect(preview({ project, settings: settingsOf() })).toEqual([{ label: 'Worktrees', value: 'off: sessions open in the project folder' }]);
        expect(preview({ project, settings: settingsOf({ worktreePerChat: true, worktreeSetup: ['npm ci'] }), folder: { path: '/work/app' } })).toEqual([
            { label: 'Branch', value: 'chat/a1b2c3d4' },
            { label: 'Folder', value: '/work/app-worktrees/chat-a1b2c3d4' },
            { label: 'Made by', value: 'git worktree add' },
            { label: 'Then runs', value: 'npm ci' },
            { label: 'Chosen worktree', value: 'kept as it is' }
        ]);
        const command = preview({ project, settings: settingsOf({ worktreePerChat: true, worktreeStrategy: 'command', worktreeCreate: 'pnpm wt new {branchSlug}', worktreePath: '{repoParent}/branches/{branchSlug}', reuseExisting: false }), folder: { path: 'C:\\Dev\\app\\main' } });
        expect(command).toContainEqual({ label: 'Folder', value: 'C:\\Dev\\app\\branches\\chat-a1b2c3d4' });
        expect(command).toContainEqual({ label: 'Made by', value: 'pnpm wt new chat-a1b2c3d4' });
        expect(command.some((l) => l.label === 'Chosen worktree')).toBe(false);
        expect(preview({ project, settings: settingsOf({ worktreePerChat: true, worktreePath: '{repo}/{x}' }) })).toEqual([{ label: 'Problem', value: expect.stringContaining('{x}') }]);
    });
});

describe('cleanup when a chat leaves the project (#623)', () => {
    const release = (fs: ProjectFeatureFs, settings: Record<string, unknown>, cwd = '/work/agentic') =>
        gitFeaturePlugin.onChatReleased!({ project, settings: settingsOf(settings), chatId: CHAT, reason: 'project-changed', environmentId: 'env_1' as EnvironmentId, cwd, fs });
    const wt = `/work/agentic-worktrees/chat-${SHORT}`;

    it('does nothing unless the project asks for cleanup of its chat worktrees', async () => {
        const { fs, ops } = commandFs(new Map());
        expect(await release(fs, { worktreePerChat: true })).toBeUndefined();
        expect(await release(fs, { worktreeCleanup: 'on-chat-leave' })).toBeUndefined();
        expect(ops).toEqual([]);
    });

    it("built in: one worktree-remove of the chat's own worktree, the branch only when asked; dirty is thrown for the audit", async () => {
        const ops: FsOp[] = [];
        const fs: ProjectFeatureFs = async (op) => (ops.push(op), op.kind === 'worktree-remove' ? { result: { kind: 'worktree-remove', path: op.path, removed: true, branchDeleted: true } } : { error: { code: 'unsupported', message: op.kind } });
        expect(await release(fs, { worktreePerChat: true, worktreeCleanup: 'on-chat-leave', worktreeDeleteBranch: true })).toBe(`removed ${wt}; branch chat/${SHORT} deleted`);
        expect(ops).toEqual([{ kind: 'worktree-remove', repo: '/work/agentic', path: wt, branch: `chat/${SHORT}`, deleteBranch: true }]);
        const dirty: ProjectFeatureFs = async () => ({ error: { code: 'dirty', message: `${wt} has uncommitted changes; it was left as it is` } });
        await expect(release(dirty, { worktreePerChat: true, worktreeCleanup: 'on-chat-leave' })).rejects.toThrow(/git worktree dirty/);
    });

    it("the project's own remove command runs only on a clean worktree of the chat's branch", async () => {
        const settings = { worktreePerChat: true, worktreeCleanup: 'on-chat-leave', worktreeRemove: 'pnpm wt rm {branchSlug}' };
        let status = '';
        const badges = new Map<string, FsGitInfo>([[wt, { kind: 'worktree', branch: `chat/${SHORT}` }]]);
        const { fs, ops } = commandFs(badges, (op) => ({ result: { kind: 'run', exitCode: 0, stdoutTail: op.argv[0] === 'git' ? status : '', stderrTail: '' } }));
        expect(await release(fs, settings)).toBe(`removed ${wt} with \`pnpm wt rm chat-${SHORT}\``);
        expect(ops.filter((o) => o.kind === 'run')).toEqual([
            { kind: 'run', cwd: wt, argv: ['git', 'status', '--porcelain', '--untracked-files=all'] },
            { kind: 'run', cwd: '/work/agentic', argv: ['pnpm', 'wt', 'rm', `chat-${SHORT}`] }
        ]);
        status = '?? scratch.txt';
        ops.length = 0;
        await expect(release(fs, settings)).rejects.toThrow(/dirty/);
        expect(ops.filter((o) => o.kind === 'run')).toHaveLength(1);
        // Not the chat's worktree (gone, or the user's own): nothing runs.
        badges.set(wt, { kind: 'worktree', branch: 'mine' });
        ops.length = 0;
        expect(await release(fs, settings)).toBe(`no worktree of chat/${SHORT} at ${wt}`);
        expect(ops.map((o) => o.kind)).toEqual(['list']);
        expect(gitSettingsErrors(settingsOf({ worktreeRemove: 'rm "{path}' }))).toEqual({ worktreeRemove: expect.stringContaining('unclosed') });
    });
});
