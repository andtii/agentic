/**
 * Agent summaries on the Workspace index (#1125): the Agent actor writes its summary onto the index with every
 * config version, in the same turn, so the agent directory reads names and default environments from
 * `Workspace.get` alone; a record from before the summaries is backfilled on read.
 */
import { agentSummaryOf, type AgentId, type EnvironmentId, type WorkspaceId } from '@agentic/core';
import { AgentActor, agentKey } from '../../src/agent/index';
import { workspaceKey } from '../../src/auth/index';
import { recordingStorage, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = workspaceKey('u1');

let app: TestActorApp;
afterEach(async () => {
    await app?.stop();
    vi.restoreAllMocks();
});

const ws = () => app.as(owner).actor(Workspace, KEY);
const agent = (id: AgentId) => app.as(owner).actor(AgentActor, agentKey(WS, id));

describe('agent summaries on the Workspace index (#1125)', () => {
    beforeEach(async () => {
        app = testActorApp([Workspace, AgentActor]);
        await app.start();
    });

    it('every config version lands on the index: a rename, a new default environment, a rollback', async () => {
        const { agentId } = await ws().createAgent({ name: 'Ada' });
        await agent(agentId).update({ name: 'Ada', role: 'reviewer', execution: { runtime: 'claude-code', defaultEnvironmentId: 'env_1' as EnvironmentId } }, 'create');
        expect((await ws().get()).agentSummaries?.[agentId]).toEqual({
            id: agentId,
            configVersion: 1,
            config: { name: 'Ada', role: 'reviewer', description: '', execution: { runtime: 'claude-code', defaultEnvironmentId: 'env_1' } }
        });

        await agent(agentId).update({ name: 'Grace' }, 'rename');
        await agent(agentId).update({ execution: { defaultEnvironmentId: 'env_2' as EnvironmentId } }, 'move');
        const held = (await ws().get()).agentSummaries?.[agentId];
        expect(held?.configVersion).toBe(3);
        expect(held?.config.name).toBe('Grace');
        expect(held?.config.execution.defaultEnvironmentId).toBe('env_2');

        await agent(agentId).rollback(1);
        expect((await ws().get()).agentSummaries?.[agentId]).toMatchObject({ configVersion: 4, config: { name: 'Ada', execution: { defaultEnvironmentId: 'env_1' } } });
    });

    it('a manager the Workspace creates itself gets its summary without deadlocking the hop back', async () => {
        const project = await ws().upsertProject({ name: 'SignalX', pm: { name: 'Nova', personality: { custom: 'Calm.' }, skills: [] } });
        const pm = project.pm!.agentId!;
        expect((await ws().get()).agentSummaries?.[pm]).toMatchObject({ id: pm, configVersion: 1, config: { name: 'Nova' } });
        await ws().createProjectManager(project.id, { name: 'Vega', personality: { custom: 'Calm.' }, skills: [] });
        expect((await ws().get()).agentSummaries?.[pm]).toMatchObject({ configVersion: 2, config: { name: 'Vega' } });
    });

    it('keeps the newer summary, and ignores an agent the index does not list', async () => {
        const { agentId } = await ws().createAgent({ name: 'Ada' });
        await agent(agentId).update({ name: 'Ada' }, 'create');
        await agent(agentId).update({ name: 'Grace' }, 'rename');
        const config = (await agent(agentId).get()).config;
        await ws().setAgentSummary(agentSummaryOf(agentId, 1, { ...config, name: 'stale' }));
        expect((await ws().get()).agentSummaries?.[agentId]?.config.name).toBe('Grace');

        await ws().setAgentSummary(agentSummaryOf('agent_ghost' as AgentId, 9, config));
        expect((await ws().get()).agentSummaries?.['agent_ghost' as AgentId]).toBeUndefined();
    });
});

describe('backfill (#1125)', () => {
    it('an agent configured before the summaries existed gets one on the first read, saved once', async () => {
        const storage = recordingStorage();
        // The index lists the agent...
        app = testActorApp([Workspace], { storage });
        await app.start();
        const { agentId } = await ws().createAgent({ name: 'Ada' });
        await app.stop();
        // ...and its config was versioned with no Workspace to write to: the version stands, the summary is missing.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        app = testActorApp([AgentActor], { storage });
        await app.start();
        await agent(agentId).update({ name: 'Ada', execution: { runtime: 'claude-code', defaultEnvironmentId: 'env_1' as EnvironmentId } }, 'create');
        expect(warn).toHaveBeenCalled();
        expect((await agent(agentId).get()).configVersion).toBe(1);
        await app.stop();

        app = testActorApp([Workspace, AgentActor], { storage });
        await app.start();
        expect((await ws().get()).agentSummaries?.[agentId]).toEqual({
            id: agentId,
            configVersion: 1,
            config: { name: 'Ada', role: '', description: '', execution: { runtime: 'claude-code', defaultEnvironmentId: 'env_1' } }
        });
        const saves = storage.saves.filter((x) => x.type === 'Workspace').length;
        // Nothing missing now: a second read writes nothing.
        expect((await ws().get()).agentSummaries?.[agentId]?.configVersion).toBe(1);
        expect(storage.saves.filter((x) => x.type === 'Workspace')).toHaveLength(saves);
    });
});
