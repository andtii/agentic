/**
 * A machine's folders for `pnpm dev:mock` (#193): what the folder picker
 * browses when no daemon answers. The trees hang under the mock
 * environments' `cwdRoots` (`mock/ops.ts`) and include a repo, its
 * `branches/*` worktrees and a folder with more subfolders than a listing
 * carries, so every state of the picker can be seen. `mockFsList` /
 * `mockFsWorktree` answer like a daemon's `fs.response`; a created worktree
 * stays until the page reloads.
 */
import { FS_LIST_MAX_ENTRIES, normalizePath, pathWithin, type FsError, type FsGitInfo, type FsListResult, type FsWorktreeResult, type WorkdirRef } from '@agentic/core';
import { opsEnvironment, opsMachine } from './ops';

interface Dir {
    readonly git?: FsGitInfo;
    readonly children: Map<string, Dir>;
}

/** `{ name: spec }`, where `$git` marks the folder a repo or worktree. */
type Spec = { readonly $git?: FsGitInfo } & { readonly [name: string]: Spec | FsGitInfo | undefined };

const dir = (spec: Spec): Dir => {
    const children = new Map<string, Dir>();
    for (const [name, child] of Object.entries(spec)) if (name !== '$git' && child) children.set(name, dir(child as Spec));
    return { ...(spec.$git ? { git: spec.$git } : {}), children };
};

const repo = (branch: string, rest: Spec = {}): Spec => ({ $git: { kind: 'repo', branch }, ...rest });
const worktree = (branch: string, rest: Spec = {}): Spec => ({ $git: { kind: 'worktree', branch }, ...rest });
const project: Spec = { apps: {}, packages: {}, docs: {}, scripts: {} };

/** 600 run folders — more than one listing carries. */
const runs: Spec = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`run-${String(i).padStart(3, '0')}`, {}]));

/** Root → tree, per environment. */
const TREES: Record<string, Record<string, Dir>> = {
    env_alien01_work: {
        'C:\\Dev': dir({
            agentic: {
                main: repo('main', project),
                branches: {
                    '47-mobile-drawer': worktree('47-mobile-drawer', project),
                    '186-workdir-contract': worktree('186-workdir-contract', project)
                }
            },
            sigx: repo('main', { packages: {}, docs: {} }),
            'agentic-ui-handoff': { artboards: {}, screenshots: {} }
        }),
        'D:\\scratch': dir({ runs, 'detached-demo': { $git: { kind: 'repo', head: '3f9c2e1' } } })
    },
    env_alien01_personal: {
        'C:\\Users\\andy\\src': dir({ blog: repo('main', { posts: {} }), dotfiles: repo('master') })
    },
    env_alien01_client_acme: { 'C:\\clients\\acme': dir({ portal: repo('develop') }) },
    env_nuclab_work: { 'C:\\work': dir({ nightly: {} }) }
};

const fail = (code: FsError['code'], message: string): FsError => ({ code, message });
const key = (p: string): string => p.toLowerCase();

/** The folder at `path` (Windows rules: case-insensitive), with its root, or why not. */
function find(environmentId: string, path: string): { root: string; at: Dir; path: string } | FsError {
    const env = opsEnvironment(environmentId);
    const trees = TREES[environmentId];
    if (!env || !trees) return fail('unknown-environment', `no environment ${environmentId}`);
    const target = normalizePath(path, 'windows');
    if (!target || !pathWithin(target, env.cwdRoots, 'windows')) return fail('outside-roots', `${path} is outside the working roots`);
    for (const [root, tree] of Object.entries(trees)) {
        if (!pathWithin(target, [root], 'windows')) continue;
        let at: Dir | undefined = tree;
        let resolved = root;
        for (const segment of target.slice(root.length).split('\\').filter(Boolean)) {
            const hit: [string, Dir] | undefined = at ? [...at.children].find(([name]) => key(name) === key(segment)) : undefined;
            at = hit?.[1];
            resolved = `${resolved}\\${hit?.[0] ?? segment}`;
        }
        return at ? { root, at, path: resolved } : fail('not-found', `${path} does not exist`);
    }
    return fail('not-found', `${path} does not exist`);
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('\\')) || path;

/** A listing the way a daemon answers `fs.request list`. */
export function mockFsList(environmentId: string, path: string): FsListResult | FsError {
    const env = opsEnvironment(environmentId);
    const machine = env ? opsMachine(env.machineId) : undefined;
    if (machine && !machine.online) return fail('timeout', `${machine.name} is offline`);
    const found = find(environmentId, path);
    if ('code' in found) return found;
    const all = [...found.at.children].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const entries = all.slice(0, FS_LIST_MAX_ENTRIES).map(([name, d]) => ({ name, path: `${found.path}\\${name}`, ...(d.git ? { git: d.git } : {}) }));
    const isRoot = key(found.path) === key(found.root);
    return { kind: 'list', path: found.path, ...(isRoot ? {} : { parent: parentOf(found.path) }), ...(found.at.git ? { git: found.at.git } : {}), entries, truncated: all.length > FS_LIST_MAX_ENTRIES };
}

/** `git worktree add` against the mock tree: the new folder appears under its parent. */
export function mockFsWorktree(environmentId: string, repoPath: string, branch: string, path: string): FsWorktreeResult | FsError {
    const repoDir = find(environmentId, repoPath);
    if ('code' in repoDir) return repoDir;
    if (!repoDir.at.git) return fail('not-a-repo', `${repoPath} is not a git repository`);
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) return fail('invalid-branch', `${branch} is not a valid branch name`);
    const target = normalizePath(path, 'windows');
    if (!target) return fail('outside-roots', `${path} is not absolute`);
    if (!('code' in find(environmentId, target))) return fail('exists', `${target} already exists`);
    const parent = find(environmentId, parentOf(target));
    if ('code' in parent) return parent;
    parent.at.children.set(target.slice(target.lastIndexOf('\\') + 1), { git: { kind: 'worktree', branch }, children: new Map() });
    return { kind: 'worktree', path: `${parent.path}\\${target.slice(target.lastIndexOf('\\') + 1)}`, branch };
}

/** Folders the mock user picked lately. */
export const mockRecentWorkdirs: readonly (WorkdirRef & { readonly at: number })[] = [
    { environmentId: 'env_alien01_work' as WorkdirRef['environmentId'], path: 'C:\\Dev\\agentic\\branches\\47-mobile-drawer', at: Date.parse('2026-09-17T14:02:00Z') },
    { environmentId: 'env_alien01_work' as WorkdirRef['environmentId'], path: 'C:\\Dev\\agentic\\main', at: Date.parse('2026-09-17T09:40:00Z') }
];
