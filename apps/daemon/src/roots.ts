/**
 * The working-roots check every folder request shares (#185, #559): lexically first, so a path outside is refused
 * before the disk is touched, then again after `realpath` of the path and of every root, so neither `..` nor a symlink
 * or junction can reach outside a root.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/** `cwd` lies inside one of `roots` (case-insensitive on Windows) — lexically; `checkWithinRoots` also resolves symlinks. */
export function withinRoots(cwd: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
    const norm = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const target = norm(cwd);
    return roots.some((root) => {
        const rel = relative(norm(root), target);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
}

export type RootCheck =
    /** `path`: the request resolved lexically (what the user sees); `real`: after symlinks (what is read). */
    | { readonly ok: true; readonly path: string; readonly real: string; readonly realRoots: readonly string[] }
    | { readonly ok: false; readonly code: 'outside-roots' | 'not-found'; readonly message: string };

export const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

/** The roots that exist, symlinks resolved. */
export async function realRootsOf(roots: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const root of roots) {
        try {
            out.push(await realpath(resolve(root)));
        } catch {
            // A missing root contains nothing.
        }
    }
    return out;
}

/**
 * Whether `path` is inside one of `roots`: lexically first (answered without
 * touching the disk), then with symlinks resolved on both sides. A path that
 * does not exist is `not-found`; a relative path is outside.
 */
export async function checkWithinRoots(path: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): Promise<RootCheck> {
    const outside: RootCheck = { ok: false, code: 'outside-roots', message: `${path} is outside the working roots` };
    if (!isAbsolute(path) || !withinRoots(path, roots, platform)) return outside;
    // Resolved lexically before `realpath`, so `link/..` means what it looks like.
    const lexical = resolve(path);
    let real: string;
    try {
        real = await realpath(lexical);
    } catch (e) {
        if (isMissing(e)) return { ok: false, code: 'not-found', message: `${path} does not exist` };
        throw e;
    }
    const realRoots = await realRootsOf(roots);
    if (!withinRoots(real, realRoots, platform)) return { ok: false, code: 'outside-roots', message: `${path} resolves outside the working roots` };
    return { ok: true, path: lexical, real, realRoots };
}

