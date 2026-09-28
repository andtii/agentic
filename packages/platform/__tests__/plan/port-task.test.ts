/**
 * The plan port inside a task (#1047): the board names the caller's task, a claim records it, and the actor refuses a
 * second item for the same task even when the tools' own check is bypassed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler } from '@sigx/actors/host';
import type { AgentId, Principal, ProjectId, ProjectMembers, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { planTools, type ToolCall } from '@agentic/runtimes';
import { capturingAuditPort } from '../../src/audit/port';
import { createPlanPort, definePlanActor, planKey, type PlanActorClient } from '../../src/plan/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const TASK = 'task_a' as TaskId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });

let members: ProjectMembers;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    members = { agentIds: [PM, FORGE], coordinator: PM, limits: { [FORGE]: 3 } };
    Plan = definePlanActor({ audit: capturingAuditPort(), projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members } : undefined) } });
    app = testActorApp([Plan], { scheduler: manualScheduler() });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const store = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));
const call = (): ToolCall => ({ callId: 'call_1', signal: new AbortController().signal });
const ctx = { toolCallId: 'call_1', signal: new AbortController().signal } as never;
const portIn = (taskId: TaskId | undefined) =>
    createPlanPort({ me: FORGE, scope: async () => ({ plan: store(agentP(FORGE)) as unknown as PlanActorClient, project: { members }, names: new Map() }), taskId: () => taskId });

describe('the plan port inside a task (#1047)', () => {
    it('the board names the task; a claim records it; a second item for the same task is refused by the tool and by the actor', async () => {
        await store().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a', touches: ['src/a/'] }, { title: 'b', touches: ['src/b/'] }] }] });
        const port = portIn(TASK);
        expect((await port.board(call())).task).toBe(TASK);
        const claim = planTools(port).find((t) => t.name === 'plan_claim')!;
        await claim.run({ item: 1 }, ctx);
        expect((await store().get('plan-1')).phases[0]!.items[0]!.claim).toMatchObject({ agentId: FORGE, taskId: TASK });
        await expect(claim.run({ item: 2 }, ctx)).rejects.toThrow(/this task already carries #1/);
        await expect(port.claim(2, undefined, call())).rejects.toThrow(/already carries #1; one item per task/);
        // Another task of the same agent takes #2 beside it: independent, under the limit.
        await portIn('task_b' as TaskId).claim(2, undefined, call());
        expect((await store().get('plan-1')).phases[0]!.items[1]!.claim).toMatchObject({ taskId: 'task_b' });
    });
});
