/**
 * The Pulls actor read live (#865): Home's "Needs you" lists a ready PR from a Git project's Pulls actor as a MERGE
 * item that opens the PR page, and the task tree shows the PR on the node of the task it resolved to. A project
 * without Git is not read. `taskPullOf` / `createWorkspacePulls` are the pure parts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectFolderKey, type EnvironmentDescriptor, type EnvironmentId, type ChatId, type MessageId, type PullRequest, type TaskId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { TaskActor, Workspace, definePullsActor, defineRegistry, machineKey, pullsKey, registryKey, taskKey, workspaceKey, type PullSource } from '@agentic/platform';
import { gitFeatureManifest } from '@agentic/plugins-git';
import { clientDefs } from '../../src/actors/client';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { GIT_FEATURE_ID } from '../../src/pages/projects/features/git/model';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { createWorkspacePulls, taskPullOf } from '../../src/pages/projects/work/pull/LivePulls';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const TASK = 't_pr_task' as TaskId;
const ready: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 602, title: 'shell: drawer collapses below 768 px', url: 'https://github.com/andtii/agentic/pull/602',
    head: 'drawer', base: 'main', state: 'open', additions: 40, deletions: 8, files: 3, openedBy: 'forge', openedAt: 1_000,
    checks: [{ name: 'test', state: 'passed' }], review: { state: 'approved', reviewers: ['Lint'], threads: [] }, mergeable: true, taskId: TASK
};

describe('workspace pulls (#865)', () => {
    it('gathers each project\'s PRs, drops a project, and finds a task\'s PR', () => {
        const feed = createWorkspacePulls();
        feed.put('p1', [ready]);
        feed.put('p2', [{ ...ready, number: 7, taskId: undefined }]);
        expect(feed.all().map((p) => `${p.projectId}:${p.pr.number}`)).toEqual(['p1:602', 'p2:7']);
        expect(taskPullOf(feed.all(), 'nope', TASK)?.number).toBe(602);
        expect(taskPullOf(feed.all(), undefined)).toBeUndefined();
        feed.put('p1', null);
        expect(feed.all().map((p) => p.pr.number)).toEqual([7]);
        expect(taskPullOf(feed.all(), TASK)).toBeUndefined();
    });
});

describe('the Pulls actor on the live pages (#865)', () => {
    let h: LiveHarness;
    const source: PullSource = { get: async (_repo, n) => (n === 602 ? ready : undefined), listOpen: async () => [ready] };
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

    it('Home lists a ready PR as a MERGE item; the task tree shows the PR line', { timeout: 20_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const defs = clientDefs();
        const members = { agentIds: [forge], coordinator: forge };
        // Git needs a folder, and a folder a paired machine.
        const { machineId, pairingCode } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'laptop' });
        const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(h.Machine, machineKey(WS, machineId));
        await daemon.pair(pairingCode, { name: 'laptop', os: 'windows', daemonVersion: '0.1.0-test' });
        const env: EnvironmentDescriptor = { ...inMemoryEnvironment(machineId, 'env_win' as EnvironmentId), name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus: 'ok' }, cwdRoots: ['C:/Dev'], isolation: 'config-dir' };
        await daemon.socketMessage(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.1.0-test', os: 'windows', environments: [env], capabilities: [{ ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code' }], resume: {} }));
        const { id } = await saveProjectWith(defs, USER, { name: 'agentic', members, folders: { [projectFolderKey(machineId)]: 'C:/Dev/agentic' }, connectors: [], features: { [GIT_FEATURE_ID]: {} } });
        const { id: plain } = await saveProjectWith(defs, USER, { name: 'notes', members, folders: {}, connectors: [], features: {} });
        await h.app.as(owner).actor(Pulls, pullsKey(WS, id)).watch({ provider: 'github', repo: 'andtii/agentic' });
        // The same repo on a project without Git: never read, so the PR is listed once.
        await h.app.as(owner).actor(Pulls, pullsKey(WS, plain)).watch({ provider: 'github', repo: 'andtii/agentic' });

        const home = await mountLive('/', h);
        await until(() => home.querySelector('[data-needs-pull="602"]') !== null, 'the PR on Home');
        expect(home.querySelectorAll('[data-needs-pull]').length).toBe(1);
        const row = home.querySelector('[data-needs-pull="602"]')!;
        expect([...row.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Squash and merge')).toBe(true);
        expect(row.querySelector<HTMLAnchorElement>(`a[href="/projects/${id}/work/pr:602"]`)).not.toBeNull();

        const chatId = await createChatWith(defs, USER, [forge], forge, id);
        await h.app.as(owner).actor(TaskActor, taskKey(WS, TASK)).create(
            { objective: 'collapse the drawer', origin: { kind: 'user', chatId: chatId as ChatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} },
            { owner: forge }
        );
        const task = await mountLive(`/tasks/${TASK}`, h);
        await until(() => task.querySelector('[data-pull-line]') !== null, 'the PR line on the task node');
        expect(task.querySelector('[data-pull-line]')?.textContent).toContain('602');
    });
});
