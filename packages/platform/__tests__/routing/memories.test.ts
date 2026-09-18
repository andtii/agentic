/**
 * Retrieved memories on the routed local path (architecture §8; MEM-04,
 * MEM-07, LRN-05, AC-09, #135): `Routing.run` → `Session.open` →
 * `createSessionFactory` → `createPlatformModelAgent`. The Session retrieves
 * the agent's memories keyed on the TASK's objective, and the factory hands
 * them to the model agent — so the model's request carries the lesson. The
 * real factory runs here over a `mockModel` whose `requests` are what the
 * runtime saw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { learningPlugin } from '@agentic/learning';
import { mockModel, type MockModel } from '@sigx/ai/testing';

import { AgentActor, agentKey, agentMemoryScope } from '../../src/agent/index';
import { Memory, memoryActorKey } from '../../src/memory/index';
import { createSessionFactory, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor } from '../../src/session/index';
import { platformLearningPorts } from '../../src/task/index';
import { TaskActor, taskKey } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_ada' as AgentId;
const OBJECTIVE = 'Draft the release notes for v2.1';
const LESSON = 'Never mention internal ticket numbers in release notes';

let app: TestActorApp;
let model: MockModel;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;

beforeEach(async () => {
    model = mockModel({ modelId: 'claude-test', respond: () => ({ text: 'done' }) });
    Session = defineSessionActor({
        factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, model }),
        learning: platformLearningPorts({ plugin: (c) => learningPlugin({ contextFor: () => (c.objective ? { objective: c.objective } : {}) }) })
    });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Memory]);
    await app.start();
    await app.as(owner).actor(AgentActor, agentKey(WS, AGENT)).update({ name: 'Ada', instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
    await app.as(owner).actor(Memory, memoryActorKey(WS, agentMemoryScope(AGENT))).put({ kind: 'lesson', text: LESSON, tags: ['correction'], confidence: 'stated', provenance: { source: 'user' } });
});
afterEach(() => app.stop());

const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const settled = async (id: string): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (!['completed', 'failed', 'cancelled'].includes((await task(id).get()).status)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for task ${id} to settle: ${JSON.stringify(await task(id).get())}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

async function run(id: string, extra: Partial<TaskContract> = {}) {
    await task(id).create({ objective: OBJECTIVE, origin: { kind: 'external', clientId: 'c1' }, assignee: AGENT, context: [], constraints: {}, ...extra }, { owner: AGENT });
    await app.as(owner).actor(Routing, routingKey(WS)).run(id as TaskId);
    await settled(id);
    const t = await task(id).get();
    expect(t.status).toBe('completed');
    return session(t.sessionId!).get();
}

describe('Routing.placeLocal: memories reach the model', () => {
    it('opens the session on the task objective and context, so retrieval ranks on the task', async () => {
        const info = await run('t1', { context: [{ type: 'text', text: 'Audience: customers.' }] });
        expect(info.spec).toMatchObject({ objective: OBJECTIVE, context: [{ type: 'text', text: 'Audience: customers.' }] });
        expect(info.spec?.retrieval).toMatchObject({ text: `${OBJECTIVE}\nAudience: customers.`, scopes: [`agent:${AGENT}`], skipped: [] });
    });

    it('the retrieved lesson is on the record and in the system prompt of every request the model saw', async () => {
        const info = await run('t2');
        expect(info.spec?.retrieval?.text).toBe(OBJECTIVE);
        expect(info.spec?.memories?.map((m) => m.text)).toEqual([LESSON]);
        // One place renders the block on the local path: the factory, from `spec.memories` — the record carries no second, caller-less system prompt.
        expect(info.spec?.system).toBeUndefined();
        expect(model.requests.length).toBeGreaterThan(0);
        for (const r of model.requests) {
            expect(r.system).toContain('# Ada');
            expect(r.system).toContain(`- lesson/stated: ${LESSON} [correction]`);
        }
    });
});
