/**
 * `RoutingPorts.placed` (#793): once a task in a project has run its feature hooks, the app hears of the placement —
 * the workspace, the project record, the task and its chat — and a hook that throws never fails the task. A task
 * outside any project is not reported.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ProjectFeatureManifest, ProjectId, RuntimeId, TaskId, WorkspaceId } from '@agentic/core';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { ChatPage, defineChatActor } from '../../src/chat/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry } from '../../src/registry/index';
import { defineRoutingActor, routingKey, type ProjectPlacement, type RuntimeCatalogue } from '../../src/routing/index';
import { defineSessionActor, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const FEATURE = 'agentic.project.watched';
const manifest: ProjectFeatureManifest = {
    id: FEATURE,
    version: '1.0.0',
    kind: 'project-feature',
    name: 'Watched',
    description: 'A fake feature',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object' },
    permissions: [],
    compat: { platform: '*', core: '*' }
};
const runtimes: RuntimeCatalogue = { 'anthropic-api': { host: 'local', open: () => Promise.reject(new Error('not opened here')) } };
const Registry = defineRegistry({ kek: () => importWorkspaceKek(generateWorkspaceKek()), catalogue: [anthropicApiPlugin, manifest] });

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let placements: ProjectPlacement[];
let failPlaced: boolean;

beforeEach(async () => {
    placements = [];
    failPlaced = false;
    const agent = mockAgent({ respond: () => [{ text: 'done' }] });
    const factory: SessionFactory = async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
    const Session = defineSessionActor({ factory });
    const Routing = defineRoutingActor({
        sessions: () => Session,
        machines: () => Session,
        registry: () => Registry,
        runtimes,
        projectFeatures: { [FEATURE]: { manifest } },
        placed: (p) => {
            placements.push(p);
            if (failPlaced) throw new Error('the hook broke');
        }
    });
    const RoutedChat = defineChatActor({ routing: () => Routing });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, PairingDirectory, RoutedChat, ChatPage, Registry, AuditActor]);
    await app.start();
    routing = () => app.as(owner).actor(Routing, routingKey(WS));
});
afterEach(() => app.stop());

let routing: () => { run(id: TaskId): Promise<unknown> };
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const workspace = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

async function apiAgent(): Promise<AgentId> {
    const agentId = 'agent_api' as AgentId;
    await workspace().createAgent({ name: 'agent_api' });
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: 'agent_api', instructions: 'Be brief.', tools: [], connectors: [], execution: { runtime: 'anthropic-api' as RuntimeId, offlinePolicy: 'fail' } }, 'create');
    return agentId;
}

async function runTask(id: string, assignee: AgentId, projectId?: ProjectId): Promise<void> {
    await task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...(projectId ? { projectId } : {}) }, { owner: assignee });
    await routing().run(id as TaskId);
    await settled(id);
}

describe('RoutingPorts.placed (#793)', () => {
    it('tells the app of a placement in a project, with the workspace and the project record', async () => {
        const a = await apiAgent();
        const project = await workspace().upsertProject({ name: 'Agentic', folders: {}, connectors: [], features: { [FEATURE]: { x: 1 } } });
        await runTask('t1', a, project.id);
        await until(() => placements.length > 0, 'the placement');
        expect(placements[0]).toMatchObject({ workspaceId: WS, taskId: 't1', project: { id: project.id, features: { [FEATURE]: { x: 1 } } } });
    });

    it('a hook that throws never fails the task, and a task outside any project is not reported', async () => {
        const a = await apiAgent();
        await runTask('t2', a);
        expect(placements).toEqual([]);
        failPlaced = true;
        const project = await workspace().upsertProject({ name: 'Agentic', folders: {}, connectors: [], features: { [FEATURE]: {} } });
        await runTask('t3', a, project.id);
        expect((await task('t3').get()).status).toBe('completed');
        expect(placements.map((p) => p.taskId)).toEqual(['t3']);
    });
});
