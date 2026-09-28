/**
 * A worktree per plan item (#1047): with `worktreePerChat` on, a task that carries a plan item opens in the item's own
 * worktree — branch `plan/<project>-<n>` — never the chat's, so items worked in parallel from one chat never share a
 * folder. Made the project's way, reused as the daemon answers, and deterministic per item.
 */
import { describe, expect, it } from 'vitest';
import { configDefaults, type ChatId, type EnvironmentId, type FsOp, type FsResult, type ProjectFeatureFs, type ProjectFeatureSessionInput, type ProjectId, type ProjectRecord, type TaskId } from '@agentic/core';
import { DEFAULT_WORKTREE_NOTICE, GIT_FEATURE_ID, gitFeatureManifest, gitFeaturePlugin, planItemWorktreeFor } from '../src/index';

const CHAT = 'chat_AbCdEfGhIjKlMnOpQrStUv' as ChatId;
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

function fakeFs(list?: (path: string) => FsResult): { fs: ProjectFeatureFs; ops: FsOp[] } {
    const ops: FsOp[] = [];
    const fs: ProjectFeatureFs = async (op) => {
        ops.push(op);
        if (op.kind === 'worktree') return { result: { kind: 'worktree', path: op.path, branch: op.branch } };
        if (op.kind === 'list' && list) return { result: list(op.path) };
        return { error: { code: 'unsupported', message: `not answered: ${op.kind}` } };
    };
    return { fs, ops };
}

function input(fs: ProjectFeatureFs, cwd: string, planItem: number | undefined, settings: Record<string, unknown> = { worktreePerChat: true }, taskId = 'task_1'): ProjectFeatureSessionInput {
    return {
        project: { ...project, folders: { ['env_1' as EnvironmentId]: '/work/agentic' } },
        settings: { ...configDefaults(gitFeatureManifest.projectSettings), ...settings },
        taskId: taskId as TaskId,
        chatId: CHAT,
        environmentId: 'env_1' as EnvironmentId,
        cwd,
        ...(planItem !== undefined ? { planItem } : {}),
        fs
    };
}

describe('a worktree per plan item (#1047)', () => {
    it('a task carrying a plan item gets a worktree of the item; two items from one chat, two folders', async () => {
        const { fs, ops } = fakeFs();
        const a = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', 7, undefined, 'task_a'));
        const b = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', 8, undefined, 'task_b'));
        expect(ops).toEqual([
            { kind: 'worktree', repo: '/work/agentic', branch: 'plan/agentic-7', path: '/work/agentic-worktrees/plan-agentic-7' },
            { kind: 'worktree', repo: '/work/agentic', branch: 'plan/agentic-8', path: '/work/agentic-worktrees/plan-agentic-8' }
        ]);
        expect(a).toEqual({ cwd: '/work/agentic-worktrees/plan-agentic-7', instructions: DEFAULT_WORKTREE_NOTICE.replace('{path}', '/work/agentic-worktrees/plan-agentic-7').replace('{branch}', 'plan/agentic-7') });
        expect(b?.cwd).toBe('/work/agentic-worktrees/plan-agentic-8');
    });

    it('the same item again lands in the same folder; the chat’s tasks without an item keep the chat’s worktree', async () => {
        const { fs, ops } = fakeFs();
        await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', 7));
        await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', 7));
        await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', undefined));
        expect(ops.map((op) => (op.kind === 'worktree' ? op.branch : op.kind))).toEqual(['plan/agentic-7', 'plan/agentic-7', 'chat/opqrstuv']);
    });

    it('follows the project’s folder template, and does not reuse a worktree chosen for the chat', async () => {
        // The chat was pointed at a worktree of its own: a chat task would reuse it, an item's task does not.
        const { fs, ops } = fakeFs(() => ({ kind: 'list', path: '/work/agentic-chosen', entries: [], git: { kind: 'worktree', branch: 'mine' } }) as unknown as FsResult);
        const effect = await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic-chosen', 12, { worktreePerChat: true, worktreePath: '{repo}/.worktrees/{branchSlug}' }));
        expect(ops).toEqual([{ kind: 'worktree', repo: '/work/agentic-chosen', branch: 'plan/agentic-12', path: '/work/agentic-chosen/.worktrees/plan-agentic-12' }]);
        expect(effect?.cwd).toBe('/work/agentic-chosen/.worktrees/plan-agentic-12');
    });

    it('nothing when worktreePerChat is off', async () => {
        const { fs, ops } = fakeFs();
        expect(await gitFeaturePlugin.beforeSession!(input(fs, '/work/agentic', 7, {}))).toBeUndefined();
        expect(ops).toEqual([]);
    });

    it('planItemWorktreeFor refuses what is not an item number', () => {
        expect(() => planItemWorktreeFor({}, { planItem: 0, cwd: '/work/agentic', projectName: 'Agentic' })).toThrow(/not an item number/);
        expect(planItemWorktreeFor({}, { planItem: 3, cwd: '/work/agentic', projectName: 'My Project' }).branch).toBe('plan/my-project-3');
    });
});
