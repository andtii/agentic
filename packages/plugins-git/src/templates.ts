/**
 * Worktree templates (#619): how a project names a chat's branch and places its worktree, in its own convention.
 * A template is text with `{token}` placeholders; an unknown token is an error, never left in a name or a path.
 * Every token is deterministic for a chat, so every task and every environment of the chat expands to the same
 * branch and folder. Pure and edge-safe: the router expands them, the settings form validates them.
 */

import { normalizePath, type HostOs } from '@agentic/core';

/** What a branch template may name. */
export const BRANCH_TOKENS = ['chatId', 'chatId8', 'branchPrefix', 'project'] as const;
/** What a path template may name: everything a branch may, and the repo and the expanded branch. */
export const PATH_TOKENS = [...BRANCH_TOKENS, 'repo', 'repoName', 'repoParent', 'branch', 'branchSlug'] as const;
/** What the session notice may name. */
export const NOTICE_TOKENS = ['path', 'branch'] as const;

export type TemplateValues = Readonly<Record<string, string>>;

/** The `{token}` names a template uses, in order, each once. */
export function templateTokens(template: string): string[] {
    const names = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
    return [...new Set(names)];
}

/** Why `template` cannot be expanded with `allowed`: an unknown token or an unbalanced brace. `undefined` when it can. */
export function templateError(template: string, allowed: readonly string[]): string | undefined {
    const unknown = templateTokens(template).filter((t) => !allowed.includes(t));
    if (unknown.length > 0) return `unknown ${unknown.length === 1 ? 'token' : 'tokens'} ${unknown.map((t) => `{${t}}`).join(', ')}; use ${allowed.map((t) => `{${t}}`).join(', ')}`;
    if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ''))) return 'an unbalanced { or }';
    return undefined;
}

/** `template` with every `{token}` replaced by its value. Throws on an unknown token or an unbalanced brace. */
export function expandTemplate(template: string, values: TemplateValues, allowed: readonly string[]): string {
    const error = templateError(template, allowed);
    if (error) throw new Error(`template "${template}": ${error}`);
    return template.replace(/\{([^{}]*)\}/g, (_, name: string) => values[name] ?? '');
}

/** A value made safe for one path segment or branch component: anything but `[A-Za-z0-9._-]` becomes `-`, lowercased. */
export function slugOf(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
}

/** The repo tokens of a folder: the folder itself, its last segment and its parent, in the folder's own syntax. */
export function repoValues(repo: string, os: HostOs): { repo: string; repoName: string; repoParent: string } {
    const sep = os === 'windows' ? '\\' : '/';
    const normal = normalizePath(repo, os) ?? repo;
    const cut = Math.max(normal.lastIndexOf('/'), normal.lastIndexOf('\\'));
    const parent = cut <= 0 ? normal.slice(0, cut + 1) || sep : normal.slice(0, cut);
    return { repo: normal, repoName: normal.slice(cut + 1), repoParent: /^[A-Za-z]:$/.test(parent) ? `${parent}${sep}` : parent };
}

/**
 * A path template expanded to an absolute, normalised folder in the repo's OS syntax (`/` in the template is fine on
 * Windows; `..` is resolved). Throws when the result is not absolute.
 */
export function expandPath(template: string, values: TemplateValues, os: HostOs): string {
    const raw = expandTemplate(template, values, PATH_TOKENS);
    const path = normalizePath(raw, os);
    if (path === null) throw new Error(`worktree path "${raw}" (from "${template}") is not an absolute path`);
    return path;
}
