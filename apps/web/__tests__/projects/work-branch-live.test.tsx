/**
 * Live tasks carry their branch and current activity (#937): a task whose chat worktree has a branch and no PR shows
 * "branch X · no PR yet" on Work, its activity line is the row's next step, and the Code card lists the branch under
 * "Branches without a PR" — all read off the TaskIndex row. `workTaskOf` maps the row; `pullsPlacement` records the
 * branch on the task.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectFolderKey, type AgentId, type EnvironmentDescriptor, type EnvironmentId, type ChatId, type MessageId, type ProjectId, type ProjectRecord, type PullRequest, type TaskId, type WorkspaceId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { TaskActor, TaskIndex, Workspace, definePullsActor, defineRegistry, machineKey, registryKey, taskKey, workspaceKey, type PullSource } from '@agentic/platform';
import { chatWorktreeFor, gitFeatureManifest } from '@agentic/plugins-git';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../../packages/platform/src/testing/index';
import { pullsPlacement } from '../../src/actors/pulls';
import { clientDefs } from '../../src/actors/client';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { GIT_FEATURE_ID } from '../../src/pages/projects/features/git/model';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { workTaskOf } from '../../src/pages/projects/work/live';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const BRANCH = 'agentic/604-mcp-tools';

describe('workTaskOf (#937)', () => {
    it('carries the row\u2019s branch and activity, and leaves them out when the row has none', () => {
        const row = { id: 't1' as TaskId, objective: 'mcp tools', status: 'active' as const, assignee: 'a' as AgentId, updatedAt: 5 };
        expect(workTaskOf({ ...row, branch: BRANCH, activity: 'Writing tests' })).toMatchObject({ branch: BRANCH, activity: 'Writing tests' });
        const plain = workTaskOf(row);
        expect('branch' in plain || 'activity' in plain).toBe(false);
    });
});

describe('pullsPlacement records the chat worktree branch on the task (#937)', () => {
    const WS2 = 'u1' as WorkspaceId;
    const TASK = 'task_1' as TaskId;
    const CHAT = 'chat_ab12cd34ef' as ChatId;
    let app: TestActorApp;
    const Pulls = definePullsActor({ sources: { open: () => undefined } });
    beforeEach(() => {
        app = testActorApp([TaskActor, TaskIndex, Pulls]);
        return app.start();
    });
    afterEach(() => app.stop());

    it('even when the origin names no host it can read', async () => {
        const task = app.as(userPrincipal('u1')).actor(TaskActor, taskKey(WS2, TASK));
        await task.create({ objective: 'mcp tools', origin: { kind: 'user', chatId: CHAT, messageId: 'm1' as MessageId }, assignee: 'a' as AgentId, context: [], constraints: {} }, { owner: 'a' as AgentId });
        const settings = { worktreePerChat: true };
        const project: ProjectRecord = { id: 'project_1' as ProjectId, name: 'Agentic', members: { agents: [], users: [] } as unknown as ProjectRecord['members'], folders: {}, connectors: [], features: { [GIT_FEATURE_ID]: settings }, createdAt: 0, updatedAt: 0 };
        await pullsPlacement(() => Pulls)({ workspaceId: WS2, project, taskId: TASK, chatId: CHAT, cwd: '/src/agentic' });
        const { branch } = chatWorktreeFor(settings, { chatId: CHAT, cwd: '/src/agentic', projectName: 'Agentic' });
        expect((await task.get()).branch).toBe(branch);
        // No chat worktree per chat: nothing to record, and nothing throws.
        await pullsPlacement(() => Pulls)({ workspaceId: WS2, project: { ...project, features: { [GIT_FEATURE_ID]: {} } }, taskId: 'task_2' as TaskId, chatId: CHAT, cwd: '/src/agentic' });
    });
});

describe('Work and the Code card on live task rows (#937)', () => {
    let h: LiveHarness;
    const other: PullRequest = {
        provider: 'github', repo: 'andtii/agentic', number: 7, title: 'other', url: 'https://github.com/andtii/agentic/pull/7', head: 'other-branch', base: 'main',
        state: 'open', additions: 1, deletions: 0, files: 1, openedBy: 'forge', openedAt: 1_000, checks: [], review: { state: 'none', reviewers: [], threads: [] }
    };
    const source: PullSource = { get: async (_repo, n) => (n === 7 ? other : undefined), listOpen: async () => [other] };
    const Pulls = definePullsActor({ sources: { open: () => source } });
    const Registry = defineRegistry({ catalogue: [gitFeatureManifest] });
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Pulls, Registry] });
        await h.app.as(owner).actor(Registry, registryKey(WS)).enable(GIT_FEATURE_ID);
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    it('a task with a branch and no PR: "branch X · no PR yet" with its activity on Work, and the Code card lists the branch', { timeout: 30_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const defs = clientDefs();
        // Git needs a folder, and a folder a paired machine.
        const { machineId, pairingCode } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'laptop' });
        const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(h.Machine, machineKey(WS, machineId));
        await daemon.pair(pairingCode, { name: 'laptop', os: 'windows', daemonVersion: '0.1.0-test' });
        const env: EnvironmentDescriptor = { ...inMemoryEnvironment(machineId, 'env_win' as EnvironmentId), name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus: 'ok' }, cwdRoots: ['C:/Dev'], isolation: 'config-dir' };
        await daemon.socketMessage(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.1.0-test', os: 'windows', environments: [env], capabilities: [{ ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code' }], resume: {} }));
        const { id: projectId } = await saveProjectWith(defs, USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: { [projectFolderKey(machineId)]: 'C:/Dev/agentic' }, connectors: [], features: { [GIT_FEATURE_ID]: {} } });
        const chatId = await createChatWith(defs, USER, [forge], forge, projectId);
        const taskId = 't_mcp_tools' as TaskId;
        const task = h.app.as(owner).actor(TaskActor, taskKey(WS, taskId));
        await task.create({ objective: 'MCP tools', origin: { kind: 'user', chatId: chatId as ChatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} }, { owner: forge });
        await task.start('router');
        await task.note({ branch: BRANCH, activity: 'Writing the tool schemas' });

        const work = await mountLive(`/projects/${projectId}/work`, h);
        const row = () => work.querySelector<HTMLElement>(`[data-work-row="task:${taskId}"]`);
        await until(() => !!row()?.querySelector('[data-work-branch]'), 'the task row with its branch', 10_000);
        expect(row()!.querySelector('[data-work-branch]')?.textContent).toBe(`branch ${BRANCH}`);
        expect(row()!.querySelector('[data-work-note]')?.textContent).toBe('no PR yet');
        expect(row()!.querySelector('[data-work-next]')?.textContent).toBe('Writing the tool schemas');

        const overview = await mountLive(`/projects/${projectId}`, h);
        const without = () => overview.querySelector('[data-git-without] [data-overview-v]')?.textContent;
        await until(() => without() === `1 · ${BRANCH}`, 'the Code card listing the branch', 10_000);
    });
});
