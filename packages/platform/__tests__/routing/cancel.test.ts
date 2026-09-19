/**
 * Cancelling a routed task whose turn is still running (#168). The `cancel`
 * turn waits for the session driver's word (`Task.sessionStopped`), and the
 * driver — the router following the session — must hear of the cancel while
 * that turn is open: a change feed only yields after a turn ends. A task
 * parked on an approval is the case that surfaced it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, TaskId, WorkspaceId } from '@agentic/core';
import { mockAgent } from '@sigx/ai-agent/testing';
import { AgentActor, agentKey } from '../../src/agent/index';
import { sessionPolicy } from '../../src/policy/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { defineMachineActor, type MachineSocketPort } from '../../src/machine/index';
import { createToolCallPort } from '../../src/routing/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const noSockets: MachineSocketPort = { send: () => false, close: () => undefined };

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** `push …` calls a destructive tool (the agent's policy asks first); anything else echoes. */
const agentRuntime = mockAgent({
    respond: (input) => {
        const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text.startsWith('push')) return [{ tool: { name: 'push', category: 'destructive', input: {}, output: 'ok', permissionKey: 'push:origin' } }, { text: 'pushed' }];
        return [{ text: `echo: ${text}` }];
    }
});

const factory: SessionFactory = async (runtime, c) => {
    if (runtime !== 'anthropic-api') return null;
    const session = await agentRuntime.session({ policy: sessionPolicy(c.spec), signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
    return { session, agentId: agentRuntime.id, capabilities: agentRuntime.capabilities };
};

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
beforeEach(async () => {
    Session = defineSessionActor({ factory });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    const Machine = defineMachineActor({ socket: noSockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Workspace]);
    await app.start();
});

afterEach(async () => {
    await app.stop();
});

const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, `${WS}:session:${id}`);

async function runTask(id: string, objective: string): Promise<void> {
    const agentId = 'agent_forge' as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: 'Forge', instructions: 'Be brief.', tools: [{ name: 'push' }], approvalPolicy: [{ id: 'ask-destructive', match: { categories: ['destructive'] }, outcome: 'ask' }], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
    await task(id).create({ objective, origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
    await app.as(owner).actor(Routing, routingKey(WS)).run(id as TaskId);
}

describe('Task.cancel on a routed task (#168)', () => {
    it('a task parked on an approval is confirmed stopped well inside the deadline, and its open request is settled', async () => {
        await runTask('t_push', 'push it');
        await until(async () => (await task('t_push').get()).status === 'waiting', 'the task to park on the approval');
        const sessionId = (await task('t_push').get()).sessionId!;
        expect((await session(sessionId).get()).openRequests).toHaveLength(1);

        const started = Date.now();
        const report = await task('t_push').cancel('user:u1', { timeoutMs: 5_000 });
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(report).toEqual({ id: 't_push', stopped: true, notStopped: [] });
        const t = await task('t_push').get();
        expect(t.status).toBe('cancelled');
        expect(t.cancel).toMatchObject({ stopped: true });
        await until(async () => (await session(sessionId).get()).openRequests.length === 0, 'the open request to settle');
        await until(async () => (await session(sessionId).get()).status === 'closed', 'the session to close');
    });
});
