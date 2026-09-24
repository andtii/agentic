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

import { normalizePath, PROJECT_FEATURE_KIND, projectFolderFor, suggestWorktreePath, type ConfigSchema, type HostOs, type ProjectFeatureContext, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFeatureSessionEffect, type ProjectFeatureSessionInput, type ProjectFolderInfo } from '@agentic/core';
import { BRANCH_TOKENS, expandPath, expandTemplate, NOTICE_TOKENS, PATH_TOKENS, repoValues, slugOf, templateError } from './templates.js';

export { BRANCH_TOKENS, expandTemplate, NOTICE_TOKENS, PATH_TOKENS, slugOf, templateError, templateTokens } from './templates.js';

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
export function chatWorktreeFor(settings: Readonly<Record<string, unknown>>, input: { readonly chatId: string; readonly cwd: string; readonly projectName: string }): { readonly branch: string; readonly path: string } {
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
    const pathTemplate = templateSetting(settings, 'worktreePath');
    if (!pathTemplate || pathTemplate === AUTO_WORKTREE_PATH) {
        const path = suggestWorktreePath(input.cwd, branch, os);
        if (path === null) throw new Error(`git worktree: the project's folder "${input.cwd}" is not an absolute path`);
        return { branch, path };
    }
    return { branch, path: expandPath(pathTemplate, { ...common, ...repoValues(input.cwd, os), branch, branchSlug: branch.replace(/\//g, '-') }, os) };
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
 * - Otherwise one `worktree` op for the branch and folder `chatWorktreeFor` names, from `base` when set. The daemon
 *   makes it idempotent (#618): a worktree already there is `reused`, one removed by hand `recreated`. So nothing is
 *   remembered: every task of the chat asks again and lands in the same folder.
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
    const { branch, path } = chatWorktreeFor(settings, { chatId, cwd, projectName: project.name });
    const base = stringSetting(settings, 'base')?.trim();
    const answer = await fs({ kind: 'worktree', repo: cwd, branch, path, ...(base ? { base } : {}) });
    if (answer.error) throw new Error(`git worktree ${answer.error.code}: ${answer.error.message}`);
    if (answer.result.kind !== 'worktree') throw new Error(`git worktree: the daemon answered with a ${answer.result.kind} result`);
    const instructions = noticeFor(settings, answer.result.path, answer.result.branch);
    return { cwd: answer.result.path, ...(instructions ? { instructions } : {}) };
}

/** The git feature: `detect` on the git badge, `instructions` from the settings, `beforeSession` the worktree per chat. */
export const gitFeaturePlugin: ProjectFeaturePlugin = {
    manifest: gitFeatureManifest,
    detect: (folder) => folder.git !== undefined,
    instructions: instructionsOf,
    beforeSession
};
