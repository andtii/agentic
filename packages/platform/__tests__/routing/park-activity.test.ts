/**
 * The router's status line on the index row (#937): a task the router parks carries the line that says why as its
 * activity (`Task.note`), and the next status change clears it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, EnvironmentId, TaskId, WorkspaceId } from '@agentic/core';

import { AgentActor, agentKey } from '../../src/agent/index';
import { Chat } from '../../src/chat/index';
import { defineMachineActor, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor } from '../../src/session/index';
import { TaskActor, TaskIndex, taskIndexKey, taskKey } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const nowhere: MachineSocketPort = { send: () => false, close: () => undefined };

let app: TestActorApp;
let Routing: ReturnType<typeof defineRoutingActor>;
beforeEach(async () => {
    const Session = defineSessionActor({ factory: () => null, commands: { send: async () => undefined } as never });
    const Machine = defineMachineActor({ socket: nowhere, sessions: () => Session, routing: () => Routing, tools: { call: async () => null } });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine });
    app = testActorApp([Routing, Session, Machine, TaskActor, TaskIndex, AgentActor, Workspace, PairingDirectory, Chat]);
    await app.start();
});
afterEach(() => app.stop());

const task = () => app.as(owner).actor(TaskActor, taskKey(WS, 't1' as TaskId));
const row = async () => (await app.as(owner).actor(TaskIndex, taskIndexKey(WS)).list()).find((r) => r.id === 't1');

describe('the router parks a task with its status line (#937)', () => {
    it('an environment no machine reports: the task waits, and its row says why', async () => {
        const agentId = 'agent_q' as AgentId;
        await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: 'q', instructions: 'Be brief.', execution: { runtime: 'in-memory', defaultEnvironmentId: 'env_nowhere' as EnvironmentId, offlinePolicy: 'queue' } }, 'create');
        await task().create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        await app.as(owner).actor(Routing, routingKey(WS)).run('t1' as TaskId);
        const t = await task().get();
        expect(t.status).toBe('waiting');
        expect(t.activity).toBe('environment env_nowhere (no machine of the workspace reports it) is offline');
        expect(await row()).toMatchObject({ status: 'waiting', activity: t.activity });

        await task().resolveWaiting('router');
        expect((await row())!.activity).toBeUndefined();
    });
});
