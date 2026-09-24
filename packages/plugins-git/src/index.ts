/**
 * The git project feature (#335; EXE-02, EXE-12, PLG-01, PLG-02): the first
 * `ProjectFeaturePlugin`. It detects a repo from the daemon's git badge, keeps
 * the origin remote URL as the project's identity across machines, carries a
 * "how to work here" fragment into every session's system prompt and, when a
 * project switches it on, gives each chat its own branch and worktree beside
 * the project's folder on whichever machine the member runs — through the
 * daemon's generic `worktree` operation, so no daemon code ships here.
 *
 * Edge-safe: `@agentic/core` only, no `node:` imports; it runs on the router.
 */

import { normalizePath, PROJECT_FEATURE_KIND, projectFolderFor, suggestWorktreePath, type ConfigSchema, type FsGitInfo, type HostOs, type ProjectFeatureContext, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFeaturePreset, type ProjectFeaturePreviewInput, type ProjectFeaturePreviewLine, type ProjectFeatureSessionEffect, type ProjectFeatureSessionInput, type ProjectFolderInfo } from '@agentic/core';
import { BRANCH_TOKENS, commandError, expandCommand, expandPath, expandTemplate, NOTICE_TOKENS, PATH_TOKENS, repoValues, slugOf, templateError, type TemplateValues } from './templates.js';

export { BRANCH_TOKENS, COMMAND_TOKENS, commandError, expandCommand, expandTemplate, NOTICE_TOKENS, PATH_TOKENS, slugOf, splitCommand, templateError, templateTokens } from './templates.js';

/** The plugin's id: what a project stores its settings under (`features['agentic.feature.git']`). */
export const GIT_FEATURE_ID = 'agentic.feature.git';
export const GIT_FEATURE_VERSION = '0.1.0';
/** Where a chat's branch name starts unless the project says otherwise. */
export const DEFAULT_BRANCH_PREFIX = 'chat/';
/** How many characters of the chat id (after its `chat_` prefix) name the branch. */
export const SHORT_CHAT_ID_LENGTH = 8;
/** The `worktreePath` value that keeps the built-in placement (`suggestWorktreePath`). */
export const AUTO_WORKTREE_PATH = 'auto';
/** What the agent is told when its session opens in a chat worktree, unless the project words it itself (#619). */
export const DEFAULT_WORKTREE_NOTICE =
    'You are working in an isolated git worktree `{path}` on branch `{branch}`, prepared for this chat. Do not create another worktree or switch directories; your changes are shown to the user from here.';

/** The per-project settings (`projectSettings`): what a project stores under `features[GIT_FEATURE_ID]`. */
export const gitProjectSettings: ConfigSchema = {
    type: 'object',
    properties: {
        origin: {
            type: 'string',
            title: 'Origin',
            description: "The origin remote URL as git writes it (https://host/owner/repo.git or git@host:owner/repo.git): the repo's identity across machines, filled from the folder's badge."
        },
        worktreePerChat: {
            type: 'boolean',
            title: 'Worktree per chat',
            description: 'Give each chat its own branch and worktree beside the project folder, created on the machine the session runs on.',
            default: false
        },
        branchPrefix: {
            type: 'string',
            title: 'Branch prefix',
            description: `What a chat's branch name starts with; the rest is the chat's short id (${DEFAULT_BRANCH_PREFIX}a1b2c3d4).`,
            default: DEFAULT_BRANCH_PREFIX
        },
        branchTemplate: {
            type: 'string',
            title: 'Branch name',
            description: "A chat's branch, as a template: {branchPrefix}, {chatId8} (the chat's short id), {chatId}, {project}. Empty: {branchPrefix}{chatId8}."
        },
        worktreePath: {
            type: 'string',
            title: 'Worktree folder',
            description:
                "Where a chat's worktree goes, as a template: {repo} (the project folder), {repoName}, {repoParent}, {branch}, {branchSlug}, {chatId8}, {project} — e.g. {repo}/.worktrees/{branchSlug} or {repoParent}/{repoName}-{branchSlug}. `auto` (or empty): beside a checkout named main under branches/, else <repo>-worktrees/<branch>, the branch's / written as - (chat/x → chat-x)."
        },
        worktreeStrategy: {
            type: 'string',
            title: 'How worktrees are made',
            description: "`builtin`: agentic runs git worktree add. `command`: the project's own command (worktreeCreate) makes it — a repo script, a make target, a task runner.",
            enum: ['builtin', 'command'],
            default: 'builtin'
        },
        worktreeCreate: {
            type: 'string',
            title: 'Create command',
            description:
                'With the command strategy: run in the project folder to make the worktree, as a template with every folder token plus {path} — e.g. `pnpm wt new {branchSlug}` or `make worktree NAME={branchSlug}`. Quotes group an argument; nothing else is shell syntax.'
        },
        worktreeSetup: {
            type: 'array',
            title: 'Setup commands',
            description: 'Run in order in a worktree agentic just made (never in one it reused), e.g. `npm ci` or `uv sync`; the first failure parks the task.',
            items: { type: 'string' }
        },
        reuseExisting: {
            type: 'boolean',
            title: 'Keep a chosen worktree',
            description: 'When a chat or task already works in a worktree other than the project folder, use it as it is instead of creating one.',
            default: true
        },
        worktreeNotice: {
            type: 'string',
            title: 'Worktree notice',
            description: `What the agent is told about its worktree, as a template with {path} and {branch}; empty for nothing. Unset: "${DEFAULT_WORKTREE_NOTICE}"`
        },
        base: {
            type: 'string',
            title: 'Base',
            description: 'The start point of a new chat branch (a branch, tag or commit); the checkout’s HEAD when empty.'
        },
        instructions: {
            type: 'string',
            title: 'Instructions',
            description: 'How to work in this repo: joined into the system prompt of every session in the project.',
            default: ''
        }
    },
    additionalProperties: false
};

export const gitFeatureManifest: ProjectFeatureManifest = {
    id: GIT_FEATURE_ID,
    version: GIT_FEATURE_VERSION,
    kind: PROJECT_FEATURE_KIND,
    name: 'Git',
    description: 'Knows the repo behind a project: its origin, how to work in it, and a branch and worktree per chat when you want one.',
    capabilities: ['detect', 'instructions', 'worktree-per-chat'],
    config: { type: 'object', properties: {}, additionalProperties: false },
    permissions: [],
    compat: { platform: '*', core: '*' },
    projectSettings: gitProjectSettings
};

/** The folder's origin remote URL: the repo's identity across machines (what the project form fills `origin` from). */
export function identityOf(folder: ProjectFolderInfo): string | undefined {
    return folder.git?.origin;
}

/**
 * The OS a path's shape says it belongs to: a drive prefix or a UNC share (`\\server\share`, or `//server/share`
 * as core's `parse` also reads it) is Windows, anything else POSIX (a POSIX path never starts with `//`).
 */
export function hostOsOfPath(path: string): HostOs {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || /^\/\/[^/]+\//.test(path) ? 'windows' : 'linux';
}

/**
 * A conservative subset of git's ref-name rules (`git check-ref-format --branch`): only `[A-Za-z0-9._/-]`,
 * no empty component, none starting with `.` or ending in `.lock`, no `..`, and the name never starts with `-`
 * (git would read it as an option) or ends with `/`.
 */
export function isValidBranchName(name: string): boolean {
    if (name === '' || name.startsWith('-') || name.endsWith('/') || !/^[A-Za-z0-9._/-]+$/.test(name) || name.includes('..')) return false;
    return name.split('/').every((c) => c !== '' && !c.startsWith('.') && !c.endsWith('.lock'));
}

/**
 * The branch a chat works on: `prefix` + the chat's short id (the last `SHORT_CHAT_ID_LENGTH` characters after
 * the `chat_` prefix, lowercased). Deterministic, so every environment of the chat and every later task get
 * the same name. Throws when the result is not a valid branch name (a prefix like `..` or `-x`).
 */
export function gitBranchFor(chatId: string, prefix: string = DEFAULT_BRANCH_PREFIX): string {
    const underscore = chatId.indexOf('_');
    const body = (underscore >= 0 ? chatId.slice(underscore + 1) : chatId).trim();
    const short = body.slice(-SHORT_CHAT_ID_LENGTH).toLowerCase();
    if (short === '') throw new Error(`git worktree: chat id "${chatId}" has nothing to name a branch after`);
    const name = `${prefix}${short}`;
    if (!isValidBranchName(name)) throw new Error(`git worktree: "${name}" is not a valid branch name; check the project's branch prefix "${prefix}"`);
    return name;
}

const stringSetting = (settings: Readonly<Record<string, unknown>>, key: string): string | undefined => {
    const value = settings[key];
    return typeof value === 'string' ? value : undefined;
};

/** The project's instruction text, trimmed; `undefined` when it has none. */
function instructionsOf({ settings }: ProjectFeatureContext): string | undefined {
    const text = stringSetting(settings, 'instructions')?.trim();
    return text ? text : undefined;
}

/** The project's template for `key`, trimmed; `undefined` when unset or blank. */
const templateSetting = (settings: Readonly<Record<string, unknown>>, key: string): string | undefined => {
    const text = stringSetting(settings, key)?.trim();
    return text ? text : undefined;
};

/** The chat id's short form: the last `SHORT_CHAT_ID_LENGTH` characters after its `chat_` prefix, lowercased. */
function shortChatId(chatId: string): string {
    const underscore = chatId.indexOf('_');
    return (underscore >= 0 ? chatId.slice(underscore + 1) : chatId).trim().slice(-SHORT_CHAT_ID_LENGTH).toLowerCase();
}

/**
 * The branch and folder a chat's worktree gets from the project's settings (#619): `branchTemplate` (default
 * `{branchPrefix}{chatId8}`, i.e. `gitBranchFor`) and `worktreePath` (default `auto`: `suggestWorktreePath`).
 * Deterministic for a chat. Throws on an unknown token, an invalid branch name or a folder that is not absolute.
 */
export function chatWorktreeFor(settings: Readonly<Record<string, unknown>>, input: { readonly chatId: string; readonly cwd: string; readonly projectName: string }): { readonly branch: string; readonly path: string; readonly values: TemplateValues } {
    const prefix = stringSetting(settings, 'branchPrefix') ?? DEFAULT_BRANCH_PREFIX;
    const os = hostOsOfPath(input.cwd);
    const chatId8 = shortChatId(input.chatId);
    const common = { chatId: input.chatId.slice(input.chatId.indexOf('_') + 1).toLowerCase(), chatId8, branchPrefix: prefix, project: slugOf(input.projectName) };
    const branchTemplate = templateSetting(settings, 'branchTemplate');
    let branch: string;
    if (branchTemplate) {
        branch = expandTemplate(branchTemplate, common, BRANCH_TOKENS);
        if (!isValidBranchName(branch)) throw new Error(`git worktree: "${branch}" (from the branch template "${branchTemplate}") is not a valid branch name`);
    } else branch = gitBranchFor(input.chatId, prefix);
    const values = { ...common, ...repoValues(input.cwd, os), branch, branchSlug: branch.replace(/\//g, '-') };
    const pathTemplate = templateSetting(settings, 'worktreePath');
    let path: string | null;
    if (!pathTemplate || pathTemplate === AUTO_WORKTREE_PATH) {
        path = suggestWorktreePath(input.cwd, branch, os);
        if (path === null) throw new Error(`git worktree: the project's folder "${input.cwd}" is not an absolute path`);
    } else path = expandPath(pathTemplate, values, os);
    return { branch, path, values: { ...values, path } };
}

/** Every template setting the project has that cannot expand, by key (#619): what the settings form shows. */
export function gitSettingsErrors(settings: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
    const errors: Record<string, string> = {};
    const check = (key: string, allowed: readonly string[]) => {
        const template = templateSetting(settings, key);
        if (template === undefined || (key === 'worktreePath' && template === AUTO_WORKTREE_PATH)) return;
        const error = templateError(template, allowed);
        if (error) errors[key] = error;
    };
    check('branchTemplate', BRANCH_TOKENS);
    check('worktreePath', PATH_TOKENS);
    check('worktreeNotice', NOTICE_TOKENS);
    const create = templateSetting(settings, 'worktreeCreate');
    if (settings['worktreeStrategy'] === 'command' && !create) errors['worktreeCreate'] = 'the command strategy needs a create command';
    const createError = create ? commandError(create) : undefined;
    if (createError) errors['worktreeCreate'] = createError;
    setupOf(settings).forEach((line, i) => {
        const error = commandError(line);
        if (error) errors[`worktreeSetup.${i}`] = error;
    });
    return errors;
}

/** The notice for a session in `path` on `branch`: the project's own words, the default when unset, none when blank. */
function noticeFor(settings: Readonly<Record<string, unknown>>, path: string, branch: string): string | undefined {
    const own = stringSetting(settings, 'worktreeNotice');
    const template = own === undefined ? DEFAULT_WORKTREE_NOTICE : own.trim();
    return template ? expandTemplate(template, { path, branch }, NOTICE_TOKENS) : undefined;
}

/**
 * When the project has `worktreePerChat` on and the task came from a chat, the session opens in the chat's worktree:
 * - With `reuseExisting` (the default), a folder other than the project's own that is already a linked worktree —
 *   one the user chose for the chat or task, made in a terminal or anywhere else — is used as it is (#619).
 * - Otherwise the branch and folder `chatWorktreeFor` names, made the project's way (#620): by default one `worktree`
 *   op, from `base` when set, which the daemon makes idempotent (#618: `reused`, `recreated`); with
 *   `worktreeStrategy: 'command'` the project's `worktreeCreate` command, unless that worktree is already there.
 *   So nothing is remembered: every task of the chat asks again and lands in the same folder.
 * - In a worktree just made (not reused), the `worktreeSetup` commands run in order.
 * Any daemon error — `worktree-mismatch` (something else at the folder), `branch-exists` (the branch checked out in
 * another folder), `not-a-repo`, … — throws, so the router parks the task `waiting { project-feature }` with the
 * daemon's message (EXE-12). The agent is told it is already isolated (`worktreeNotice`), so a repo guide that says
 * "create a worktree first" does not make it leave the folder the user watches.
 */
async function beforeSession({ settings, project, chatId, environmentId, cwd, fs }: ProjectFeatureSessionInput): Promise<ProjectFeatureSessionEffect | undefined> {
    if (settings['worktreePerChat'] !== true || !chatId) return undefined;
    if (settings['reuseExisting'] !== false) {
        const own = projectFolderFor(project, environmentId);
        const os = hostOsOfPath(cwd);
        const key = (p: string) => (os === 'windows' ? normalizePath(p, os)?.toLowerCase() : normalizePath(p, os));
        if (own === undefined || key(own) !== key(cwd)) {
            const listed = await fs({ kind: 'list', path: cwd });
            const git = listed.result?.kind === 'list' ? listed.result.git : undefined;
            if (git?.kind === 'worktree') {
                const instructions = git.branch ? noticeFor(settings, cwd, git.branch) : undefined;
                return { cwd, ...(instructions ? { instructions } : {}) };
            }
        }
    }
    const { branch, path, values } = chatWorktreeFor(settings, { chatId, cwd, projectName: project.name });
    const made = settings['worktreeStrategy'] === 'command' ? await byCommand(settings, fs, cwd, branch, path, values) : await builtin(settings, fs, cwd, branch, path);
    if (made.fresh) for (const line of setupOf(settings)) await run(fs, made.path, line, { ...values, path: made.path }, 'setup');
    const instructions = noticeFor(settings, made.path, made.branch);
    return { cwd: made.path, ...(instructions ? { instructions } : {}) };
}

/** Where the chat's worktree ended up, and whether it was just made (so setup runs) or was already there. */
interface MadeWorktree {
    readonly path: string;
    readonly branch: string;
    readonly fresh: boolean;
}

/** The project's setup commands, in order, blank lines left out. */
function setupOf(settings: Readonly<Record<string, unknown>>): string[] {
    const list = settings['worktreeSetup'];
    return Array.isArray(list) ? list.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim()) : [];
}

/** The `worktree` op (#618): the daemon reuses, re-creates or adds the worktree; any error parks the task. */
async function builtin(settings: Readonly<Record<string, unknown>>, fs: ProjectFeatureSessionInput['fs'], cwd: string, branch: string, path: string): Promise<MadeWorktree> {
    const base = stringSetting(settings, 'base')?.trim();
    const answer = await fs({ kind: 'worktree', repo: cwd, branch, path, ...(base ? { base } : {}) });
    if (answer.error) throw new Error(`git worktree ${answer.error.code}: ${answer.error.message}`);
    if (answer.result.kind !== 'worktree') throw new Error(`git worktree: the daemon answered with a ${answer.result.kind} result`);
    return { path: answer.result.path, branch: answer.result.branch, fresh: answer.result.reused !== true };
}

/** The git badge of `path`, or `undefined` when there is nothing there (or nothing git). */
async function badgeOf(fs: ProjectFeatureSessionInput['fs'], path: string): Promise<FsGitInfo | undefined> {
    const listed = await fs({ kind: 'list', path });
    if (listed.error) {
        if (listed.error.code === 'not-found') return undefined;
        throw new Error(`git worktree ${listed.error.code}: ${listed.error.message}`);
    }
    return listed.result.kind === 'list' ? listed.result.git : undefined;
}

/**
 * The project's own create command (#620): a worktree of `branch` already at `path` is kept; otherwise the command
 * runs in the project folder, and afterwards `path` must be a worktree of `branch` — a command that made something
 * else, or nothing, parks the task like a daemon error would.
 */
async function byCommand(settings: Readonly<Record<string, unknown>>, fs: ProjectFeatureSessionInput['fs'], cwd: string, branch: string, path: string, values: TemplateValues): Promise<MadeWorktree> {
    const create = templateSetting(settings, 'worktreeCreate');
    if (!create) throw new Error('git worktree: the project makes worktrees with a command but has no create command');
    const argv = expandCommand(create, values);
    const before = await badgeOf(fs, path);
    if (before?.kind === 'worktree' && before.branch === branch) return { path, branch, fresh: false };
    if (before) throw new Error(`git worktree worktree-mismatch: ${path} already holds ${before.kind === 'worktree' ? `the worktree of ${before.branch ?? 'a detached HEAD'}` : 'a repository'}, not ${branch}`);
    await runArgv(fs, cwd, argv, 'create');
    const after = await badgeOf(fs, path);
    if (after?.kind !== 'worktree') throw new Error(`git worktree: the create command \`${argv.join(' ')}\` finished but ${path} is not a worktree`);
    if (after.branch !== branch) throw new Error(`git worktree worktree-mismatch: the create command made ${path} on ${after.branch ?? 'a detached HEAD'}, not ${branch}`);
    return { path, branch, fresh: true };
}

/** A command template run in `cwd`: expanded, split, then `runArgv`. */
function run(fs: ProjectFeatureSessionInput['fs'], cwd: string, line: string, values: TemplateValues, what: 'create' | 'setup'): Promise<void> {
    return runArgv(fs, cwd, expandCommand(line, values), what);
}

/** One `run` op; a daemon error or a non-zero exit throws with the tail of its output, so the task parks. */
async function runArgv(fs: ProjectFeatureSessionInput['fs'], cwd: string, argv: readonly string[], what: 'create' | 'setup'): Promise<void> {
    const answer = await fs({ kind: 'run', cwd, argv });
    const command = argv.join(' ');
    if (answer.error) throw new Error(`git worktree ${what} ${answer.error.code}: \`${command}\`: ${answer.error.message}`);
    if (answer.result.kind !== 'run') throw new Error(`git worktree: the daemon answered with a ${answer.result.kind} result`);
    if (answer.result.exitCode !== 0) {
        const output = (answer.result.stderrTail.trim() || answer.result.stdoutTail.trim()).split(/\r?\n/).slice(-5).join('\n');
        throw new Error(`git worktree ${what} failed: \`${command}\` exited ${answer.result.exitCode}${output ? `: ${output}` : ''}`);
    }
}

/**
 * Starting points for the worktree settings (#621). Each only fills fields — every one stays editable, and none is
 * special-cased anywhere — and each clears the fields the others set, so switching presets leaves no stray template.
 */
export const GIT_PRESETS: readonly ProjectFeaturePreset[] = [
    {
        id: 'git-default',
        label: 'Git default',
        description: 'git worktree add, beside a main checkout under branches/ or in <repo>-worktrees/',
        settings: { worktreeStrategy: 'builtin', worktreePath: null, branchTemplate: null, worktreeCreate: null }
    },
    {
        id: 'in-repo',
        label: 'Inside the repo',
        description: 'git worktree add into <repo>/.worktrees/ (add it to .gitignore)',
        settings: { worktreeStrategy: 'builtin', worktreePath: '{repo}/.worktrees/{branchSlug}', branchTemplate: null, worktreeCreate: null }
    },
    {
        id: 'sibling',
        label: 'Sibling folders',
        description: 'git worktree add beside the checkout, as <repo>-<branch>',
        settings: { worktreeStrategy: 'builtin', worktreePath: '{repoParent}/{repoName}-{branchSlug}', branchTemplate: null, worktreeCreate: null }
    },
    {
        id: 'command',
        label: 'Your own command',
        description: "the repo's own script makes the worktree; fill in the create command and where it puts the folder",
        settings: { worktreeStrategy: 'command', worktreeCreate: '' }
    }
];

/** The chat a settings preview is shown for: any id works, the preview only shows the shape of the names. */
export const PREVIEW_CHAT_ID = 'chat_a1b2c3d4';

/**
 * What the worktree settings would do for a folder of the project (#621): the branch and folder a chat would get,
 * how the worktree is made and what runs in it. A settings problem is one `Problem` line, never a throw.
 */
export function previewGitSettings({ project, settings, folder }: ProjectFeaturePreviewInput): readonly ProjectFeaturePreviewLine[] {
    if (settings['worktreePerChat'] !== true) return [{ label: 'Worktrees', value: 'off: sessions open in the project folder' }];
    const cwd = folder?.path ?? '/path/to/repo';
    try {
        const { branch, path, values } = chatWorktreeFor(settings, { chatId: PREVIEW_CHAT_ID, cwd, projectName: project.name });
        const create = templateSetting(settings, 'worktreeCreate');
        const made = settings['worktreeStrategy'] === 'command' ? (create ? expandCommand(create, values).join(' ') : 'no create command yet') : 'git worktree add';
        const setup = setupOf(settings).map((line) => expandCommand(line, values).join(' '));
        return [
            { label: 'Branch', value: branch },
            { label: 'Folder', value: path },
            { label: 'Made by', value: made },
            { label: 'Then runs', value: setup.length ? setup.join(' → ') : 'nothing' },
            ...(settings['reuseExisting'] !== false ? [{ label: 'Chosen worktree', value: 'kept as it is' }] : [])
        ];
    } catch (e) {
        return [{ label: 'Problem', value: e instanceof Error ? e.message : String(e) }];
    }
}

/** The git feature: `detect` on the git badge, `instructions` from the settings, `beforeSession` the worktree per chat. */
export const gitFeaturePlugin: ProjectFeaturePlugin = {
    manifest: gitFeatureManifest,
    detect: (folder) => folder.git !== undefined,
    instructions: instructionsOf,
    beforeSession,
    presets: GIT_PRESETS,
    settingsErrors: gitSettingsErrors,
    previewSettings: previewGitSettings
};
