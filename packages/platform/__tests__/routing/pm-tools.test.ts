/**
 * A project manager's session gets the manager tools it lacks (#975): a manager written before `chat_post` and
 * `delegate` joined `pmTools()` still starts members from the chat, without a new config version. Any other agent in
 * the project, and a grant the manager denies, are left alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_TOOLS, type AgentId, type ProjectId, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { ChatPage, defineChatActor } from '../../src/chat/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';
import { pmTools } from '../../src/workspace/project-manager';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');

const factory = (): SessionFactory => {
    const agent = mockAgent({ respond: () => [{ text: 'ok' }] });
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
};

let app: TestActorApp;
let Routing: ReturnType<typeof defineRoutingActor>;
let Session: ReturnType<typeof defineSessionActor>;

beforeEach(async () => {
    Session = defineSessionActor({ factory: factory() });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, defineChatActor(), ChatPage, AuditActor]);
    await app.start();
});
afterEach(async () => {
    await app.stop();
});

const ws = () => app.as(owner).actor(Workspace, workspaceKey('u1'));
const agent = (id: AgentId) => app.as(owner).actor(AgentActor, agentKey(WS, id));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));

async function sessionTools(id: string, assignee: AgentId, projectId: ProjectId): Promise<readonly string[] | undefined> {
    await task(id).create({ objective: 'plan', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, projectId }, { owner: assignee });
    await app.as(owner).actor(Routing, routingKey(WS)).run(id as TaskId);
    const deadline = Date.now() + 4_000;
    while ((await task(id).get()).status !== 'completed') {
        if (Date.now() > deadline) throw new Error(`timed out waiting for task ${id}`);
        await new Promise((r) => setTimeout(r, 5));
    }
    const t = await task(id).get();
    return (await app.as(owner).actor(Session, `${WS}:session:${t.sessionId}`).get()).spec?.tools;
}

describe('a project manager session (#975)', () => {
    it('adds chat_post and delegate to a manager written with only the plan and requests tools', async () => {
        const { agentId: forge } = await ws().createAgent({ name: 'Forge' });
        const p = await ws().upsertProject({ name: 'Agentic', members: { agentIds: [forge], coordinator: null } });
        const pm = p.pm!.agentId!;
        // A manager from before #975: its stored grant has no chat tools.
        await agent(pm).update({ tools: PLAN_TOOLS.map((name) => ({ name })) }, 'an older manager');
        const tools = await sessionTools('t1', pm, p.id);
        expect(tools).toEqual(expect.arrayContaining(pmTools().map((g) => g.name)));
        expect(tools).toContain('chat_post');
        expect((await agent(pm).get()).config.tools.map((g) => g.name)).not.toContain('chat_post');
    });

    it('keeps a chat_post the manager denies, and gives another member nothing', async () => {
        const { agentId: forge } = await ws().createAgent({ name: 'Forge' });
        await agent(forge).update({ execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'local runtime');
        const p = await ws().upsertProject({ name: 'Agentic', members: { agentIds: [forge], coordinator: null } });
        const pm = p.pm!.agentId!;
        await agent(pm).update({ tools: [{ name: 'chat_post', mode: 'deny' }] }, 'no chat posts');
        expect(await sessionTools('t2', pm, p.id)).not.toContain('chat_post');
        expect(await sessionTools('t3', forge, p.id)).not.toContain('chat_post');
    });
});
