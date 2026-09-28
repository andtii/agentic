/**
 * Cleaning up a plan item's worktree (#1075): once item #n is done or dropped, `onPlanItemReleased` removes the worktree
 * of `plan/<project>-<n>` the way a chat's is removed — never forced, a dirty one kept, the branch deleted only when asked
 * and merged — under either cleanup policy, and not at all under `never`.
 */
import { describe, expect, it } from 'vitest';
import { configDefaults, type EnvironmentId, type FsGitInfo, type FsOp, type ProjectFeatureFs, type ProjectFeatureItemReleaseReason, type ProjectId, type ProjectRecord } from '@agentic/core';
import { GIT_FEATURE_ID, gitFeatureManifest, gitFeaturePlugin } from '../src/index';

const project: ProjectRecord = {
    id: 'project_1' as ProjectId,
    name: 'Agentic',
    members: { agentIds: [], coordinator: null },
    folders: { ['env_1' as EnvironmentId]: '/work/agentic' },
    connectors: [],
    features: { [GIT_FEATURE_ID]: {} },
    createdAt: 0,
    updatedAt: 0
};
const WT = '/work/agentic-worktrees/plan-agentic-7';
const BRANCH = 'plan/agentic-7';

const release = (fs: ProjectFeatureFs, settings: Record<string, unknown>, reason: ProjectFeatureItemReleaseReason = 'done', planItem = 7) =>
    gitFeaturePlugin.onPlanItemReleased!({
        project,
        settings: { ...configDefaults(gitFeatureManifest.projectSettings), ...settings },
        planItem,
        reason,
        environmentId: 'env_1' as EnvironmentId,
        cwd: '/work/agentic',
        fs
    });

/** A daemon that removes a clean worktree and answers `dirty` for the paths in `dirty`. */
function removingFs(dirty: ReadonlySet<string> = new Set()): { fs: ProjectFeatureFs; ops: FsOp[] } {
    const ops: FsOp[] = [];
    const fs: ProjectFeatureFs = async (op) => {
        ops.push(op);
        if (op.kind !== 'worktree-remove') return { error: { code: 'unsupported', message: op.kind } };
        if (dirty.has(op.path)) return { error: { code: 'dirty', message: `${op.path} has uncommitted changes; it was left as it is` } };
        return { result: { kind: 'worktree-remove', path: op.path, removed: true, branchDeleted: op.deleteBranch === true } };
    };
    return { fs, ops };
}

describe("cleanup of a plan item's worktree (#1075)", () => {
    it('the release of item #n removes the worktree of plan/<project>-<n>, and keeps a dirty one', async () => {
        const { fs, ops } = removingFs();
        expect(await release(fs, { worktreePerChat: true, worktreeCleanup: 'on-merge' })).toBe(`removed ${WT}`);
        expect(ops).toEqual([{ kind: 'worktree-remove', repo: '/work/agentic', path: WT, branch: BRANCH, deleteBranch: false }]);

        const kept = removingFs(new Set([WT]));
        await expect(release(kept.fs, { worktreePerChat: true, worktreeCleanup: 'on-merge' })).rejects.toThrow(/git worktree dirty/);
        expect(kept.ops).toHaveLength(1);
    });

    it('done and dropped both release, under on-chat-leave and on-merge; the branch goes only when asked', async () => {
        const { fs, ops } = removingFs();
        expect(await release(fs, { worktreePerChat: true, worktreeCleanup: 'on-chat-leave' }, 'dropped')).toBe(`removed ${WT}`);
        expect(await release(fs, { worktreePerChat: true, worktreeCleanup: 'on-merge', worktreeDeleteBranch: true }, 'done', 12)).toBe(
            'removed /work/agentic-worktrees/plan-agentic-12; branch plan/agentic-12 deleted'
        );
        expect(ops.map((o) => (o.kind === 'worktree-remove' ? [o.branch, o.deleteBranch] : o.kind))).toEqual([
            [BRANCH, false],
            ['plan/agentic-12', true]
        ]);
    });

    it('nothing under never, or with worktreePerChat off', async () => {
        const { fs, ops } = removingFs();
        expect(await release(fs, { worktreePerChat: true })).toBeUndefined();
        expect(await release(fs, { worktreePerChat: true, worktreeCleanup: 'never' }, 'dropped')).toBeUndefined();
        expect(await release(fs, { worktreeCleanup: 'on-merge' })).toBeUndefined();
        expect(ops).toEqual([]);
    });

    it("the project's own remove command runs only on a clean worktree of the item's branch", async () => {
        const settings = { worktreePerChat: true, worktreeCleanup: 'on-merge', worktreeRemove: 'pnpm wt rm {branchSlug}' };
        let status = '';
        const badges = new Map<string, FsGitInfo>([[WT, { kind: 'worktree', branch: BRANCH }]]);
        const ops: FsOp[] = [];
        const fs: ProjectFeatureFs = async (op) => {
            ops.push(op);
            if (op.kind === 'list') {
                const git = badges.get(op.path);
                return git ? { result: { kind: 'list', path: op.path, git, entries: [], truncated: false } } : { error: { code: 'not-found', message: op.path } };
            }
            if (op.kind === 'run') return { result: { kind: 'run', exitCode: 0, stdoutTail: op.argv[0] === 'git' ? status : '', stderrTail: '' } };
            return { error: { code: 'unsupported', message: op.kind } };
        };
        expect(await release(fs, settings)).toBe(`removed ${WT} with \`pnpm wt rm plan-agentic-7\``);
        expect(ops.filter((o) => o.kind === 'run')).toEqual([
            { kind: 'run', cwd: WT, argv: ['git', 'status', '--porcelain', '--untracked-files=all'] },
            { kind: 'run', cwd: '/work/agentic', argv: ['pnpm', 'wt', 'rm', 'plan-agentic-7'] }
        ]);
        status = ' M src/x.ts';
        ops.length = 0;
        await expect(release(fs, settings)).rejects.toThrow(/dirty/);
        expect(ops.filter((o) => o.kind === 'run')).toHaveLength(1);
        badges.delete(WT);
        expect(await release(fs, settings)).toBe(`no worktree of ${BRANCH} at ${WT}`);
    });
});
