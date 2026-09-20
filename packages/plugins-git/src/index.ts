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

import { PROJECT_FEATURE_KIND, suggestWorktreePath, type ConfigSchema, type HostOs, type ProjectFeatureContext, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFeatureSessionEffect, type ProjectFeatureSessionInput, type ProjectFolderInfo } from '@agentic/core';

/** The plugin's id: what a project stores its settings under (`features['agentic.feature.git']`). */
export const GIT_FEATURE_ID = 'agentic.feature.git';
export const GIT_FEATURE_VERSION = '0.1.0';
/** Where a chat's branch name starts unless the project says otherwise. */
export const DEFAULT_BRANCH_PREFIX = 'chat/';
/** How many characters of the chat id (after its `chat_` prefix) name the branch. */
export const SHORT_CHAT_ID_LENGTH = 8;

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

/** The OS a path's shape says it belongs to: a drive or UNC prefix is Windows, anything else POSIX. */
export function hostOsOfPath(path: string): HostOs {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') ? 'windows' : 'linux';
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

/**
 * When the project has `worktreePerChat` on and the task came from a chat: one `worktree` op to the environment's
 * daemon for `branchPrefix + short chat id` at `suggestWorktreePath(cwd, branch)` (the sigx layout: beside
 * `main` under `branches/`, else `<repo>-worktrees/<slug>`), from `base` when set. The session then opens in
 * the worktree. Nothing is remembered: a later task of the same chat — or the same chat after a restart —
 * asks again and resolves through the daemon's `branch-exists` / `exists` to the same path. Any other error
 * throws, so the router parks the task `waiting { project-feature }` with the daemon's message (EXE-12).
 */
async function beforeSession({ settings, chatId, cwd, fs }: ProjectFeatureSessionInput): Promise<ProjectFeatureSessionEffect | undefined> {
    if (settings['worktreePerChat'] !== true || !chatId) return undefined;
    const branch = gitBranchFor(chatId, stringSetting(settings, 'branchPrefix') ?? DEFAULT_BRANCH_PREFIX);
    const path = suggestWorktreePath(cwd, branch, hostOsOfPath(cwd));
    if (path === null) throw new Error(`git worktree: the project's folder "${cwd}" is not an absolute path`);
    const base = stringSetting(settings, 'base')?.trim();
    const answer = await fs({ kind: 'worktree', repo: cwd, branch, path, ...(base ? { base } : {}) });
    const effect = (at: string): ProjectFeatureSessionEffect => ({ cwd: at, instructions: `This chat works on branch \`${branch}\` in \`${at}\`.` });
    if (answer.result) {
        if (answer.result.kind !== 'worktree') throw new Error(`git worktree: the daemon answered with a ${answer.result.kind} result`);
        return effect(answer.result.path);
    }
    // The worktree from an earlier task of this chat: the same branch at the same path.
    if (answer.error.code === 'branch-exists' || answer.error.code === 'exists') return effect(path);
    throw new Error(`git worktree ${answer.error.code}: ${answer.error.message}`);
}

/** The git feature: `detect` on the git badge, `instructions` from the settings, `beforeSession` the worktree per chat. */
export const gitFeaturePlugin: ProjectFeaturePlugin = {
    manifest: gitFeatureManifest,
    detect: (folder) => folder.git !== undefined,
    instructions: instructionsOf,
    beforeSession
};
