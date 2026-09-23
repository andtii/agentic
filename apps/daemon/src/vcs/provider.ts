/**
 * Version control behind the session-files requests (#561, architecture "Session files and changes"): the daemon asks
 * each `VcsProvider` in turn whether it owns a folder, and the first that does answers `changes`, the change marks and
 * ignore filter of a `tree`, and the committed text of a `read`. Git is the first provider (`git.ts`); another VCS plugs
 * in by implementing this interface — the wire (`ChangeSet`, `FileChangeStatus`) is already VCS-neutral.
 *
 * Every path here is relative to the session folder the repo was opened at, `/`-separated.
 */

import type { ChangeScope, ChangeSet, FileChangeStatus, FsErrorCode } from '@agentic/core';

/** A failure a provider answers with, mapped to an `fs.response` error as it is. */
export class VcsFailure extends Error {
    constructor(
        readonly code: FsErrorCode,
        message: string
    ) {
        super(message);
    }
}

/** A committed file: its size and bytes — all of them up to `maxBytes`, else only the first `prefixBytes` (`partial`). */
export type VcsBlob = { readonly kind: 'missing' } | { readonly kind: 'blob'; readonly size: number; readonly bytes: Buffer; readonly partial: boolean };

export interface VcsRepo {
    /** The provider's id, the `ChangeSet.vcs` it answers. */
    readonly vcs: string;
    /** What changed, per `ChangeSet`: uncommitted work, or the branch since its merge-base with `base` (or the default base). */
    changes(scope: ChangeScope, base?: string): Promise<ChangeSet>;
    /** How each changed file under the folder differs from the committed version, for a `tree`'s marks. */
    status(): Promise<ReadonlyMap<string, FileChangeStatus>>;
    /** Which of `paths` the VCS ignores. */
    ignored(paths: readonly string[]): Promise<ReadonlySet<string>>;
    /** `path` as committed at `rev`; `base` is the merge-base with `base` (or the default base). */
    show(rev: 'head' | 'base', path: string, options: { readonly base?: string; readonly maxBytes: number; readonly prefixBytes: number }): Promise<VcsBlob>;
}

export interface VcsProvider {
    readonly id: string;
    /** The repo `folder` (an absolute, resolved path) lies in, or `undefined` when this VCS does not own it. */
    open(folder: string): Promise<VcsRepo | undefined>;
}

/** The first provider that owns `folder`. */
export async function openRepo(providers: readonly VcsProvider[], folder: string): Promise<VcsRepo | undefined> {
    for (const provider of providers) {
        const repo = await provider.open(folder);
        if (repo) return repo;
    }
    return undefined;
}
