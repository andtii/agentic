/**
 * Projects inside workerd (#333): the browser's own stubs upsert and list a
 * project on the Workspace object, a chat created in it carries the project
 * (name included) on `Chat.get()`, the Workspace remembers it as the last
 * used, and a schedule in the project refuses an environment beside it.
 */
import type { AgentId, ChatId, EnvironmentId, ProjectId, WorkspaceId } from '@agentic/core';
import { Chat, Workspace, workspaceKey } from '@agentic/platform';
import { actor } from '@sigx/actors';
import { configureActors, fetchTransport } from '@sigx/actors/client';
import { SELF } from 'cloudflare:test';
import { clientDefs } from '../../src/actors/client';
import { chatKeyOf, scheduleKeyOf, workspaceKeyOf } from '../../src/actors/keys';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { newScheduleSpec } from '../../src/pages/ops/live';
import { overHttp, signIn } from './http';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_projects';
const workspaceId = userId as WorkspaceId;

afterEach(() => {
    configureActors(null);
});

describe('worker: projects over the browser stubs', () => {
    it('upserts, lists, creates a chat in the project and notes it as the last used; a project schedule is exclusive with an environment', async () => {
        const cookie = await signIn(userId);
        configureActors(
            fetchTransport({
                endpoint: `${ORIGIN}/_sigx/actor`,
                headers: { cookie, origin: ORIGIN },
                fetch: (input, init) => SELF.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)
            })
        );
        const defs = clientDefs();
        const workspace = actor(defs.Workspace, workspaceKeyOf(workspaceId));
        const { agentId } = await workspace.createAgent({ name: 'Ada' });

        const created = await workspace.upsertProject({ name: '  agentic  ', description: 'The platform', members: { agentIds: [agentId as AgentId], coordinator: agentId as AgentId }, connectors: [{ id: 'github' }] });
        expect(created).toMatchObject({ name: 'agentic', description: 'The platform', members: { agentIds: [agentId], coordinator: agentId }, folders: {}, connectors: [{ id: 'github' }], features: {} });
        expect((await workspace.projects()).map((p) => p.id)).toEqual([created.id]);
        // A folder on an environment no machine reports is refused (a 400 the form shows inline).
        await expect(workspace.upsertProject({ id: created.id, folders: { ['env_nowhere' as EnvironmentId]: 'C:\\x' } })).rejects.toThrow(/no machine/);

        const chatId = await createChatWith(defs, workspaceId, [agentId], agentId, created.id);
        const summary = await overHttp(Chat, chatKeyOf(workspaceId, chatId as ChatId), cookie).get();
        expect(summary.projectId).toBe(created.id);
        expect(summary.project).toEqual({ id: created.id, name: 'agentic' });
        expect(summary.coordinator).toBe(agentId);
        expect((await overHttp(Workspace, workspaceKey(workspaceId), cookie).get()).lastProjectId).toBe(created.id);

        const { scheduleId } = await workspace.createSchedule();
        const schedule = actor(defs.Schedule, scheduleKeyOf(workspaceId, scheduleId));
        const spec = newScheduleSpec({ kind: 'agent-task', title: 'Audit', at: '', cron: '0 2 * * *', agentId, environmentId: 'env_x', workdir: 'C:\\x', projectId: created.id, prompt: 'Audit deps' }, 'UTC')!;
        expect(spec).toMatchObject({ projectId: created.id });
        expect(spec).not.toHaveProperty('environmentId');
        expect((await schedule.create(spec)).projectId).toBe(created.id);
        await expect(schedule.update({ environmentId: 'env_x' as never })).rejects.toThrow(/exclusive/);

        await workspace.removeProject(created.id as ProjectId);
        expect(await workspace.projects()).toEqual([]);
        expect((await workspace.get()).lastProjectId).toBeUndefined();
        // The chat keeps the id; the name is gone with the project.
        const after = await overHttp(Chat, chatKeyOf(workspaceId, chatId as ChatId), cookie).get();
        expect(after.projectId).toBe(created.id);
        expect(after.project).toBeUndefined();
    });
});
