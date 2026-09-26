/**
 * #943: the #931 seams bound. `createPlanPort` implements `PlanPort.after` over the actor's `after`, so an agent's
 * `plan_update` with `after` works; and the manager agent of the project a request was sent to, accepting it, may set
 * the one wait on the requester's item it names — nothing more, and nobody else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type Principal, type ProjectId, type ProjectRecord, type SessionId, type Triage, type WorkspaceId } from '@agentic/core';
import type { ToolCall } from '@agentic/runtimes';
import { capturingAuditPort } from '../../src/audit/port';
import { createPlanPort, definePlanActor, planKey, type PlanActorClient } from '../../src/plan/index';
import { defineRequestsActor, requestsKey } from '../../src/requests/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const SX = 'prj_sx' as ProjectId;
const AG = 'prj_ag' as ProjectId;
const NOVA = 'agent_nova' as AgentId;
const KEEL = 'agent_keel' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });

type Rec = Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'>;
const policy = { ...PM_POLICY_DEFAULT, senders: [{ project: AG, who: 'any-member' as const, mode: 'allowed' as const }] };
const projects: Rec[] = [
    { id: SX, name: 'signalx', members: { agentIds: [NOVA, FORGE], coordinator: NOVA }, pm: { agentId: NOVA, policy } },
    { id: AG, name: 'agentic', members: { agentIds: [KEEL, FORGE], coordinator: KEEL }, pm: { agentId: KEEL, policy: PM_POLICY_DEFAULT } }
];

let app: TestActorApp;
let Requests: ReturnType<typeof defineRequestsActor>;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    const audit = capturingAuditPort();
    Plan = definePlanActor({
        audit,
        projects: { project: async (_ctx, _ws, id) => projects.find((p) => p.id === id) },
        links: { projects: async () => projects.map((p) => ({ id: p.id, name: p.name })) }
    });
    Requests = defineRequestsActor({ audit, projects: { projects: async () => projects }, turns: { async triage() {} } });
    app = testActorApp([Plan, Requests]);
    return app.start();
});
afterEach(() => app.stop());

const requests = (p: Principal = user) => app.as(p).actor(Requests, requestsKey(ws, SX));
const plan = (project: ProjectId, p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));
const item = async (project: ProjectId, n: number) =>
    (await plan(project).list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items)).find((i) => i.id === n)! as Awaited<ReturnType<ReturnType<typeof plan>['list']>>['plans'][number]['phases'][number]['items'][number] & { afterRefs?: unknown };
const call: ToolCall = { callId: 'call_1', signal: new AbortController().signal };

const triage: Triage = { kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'Fix nested batch()', doneWhen: ['nested batch test passes'] }, openIssue: false, reply: 'On it.', why: '' };

/** agentic: #1, #2 (waits on #1); signalx: #1 "Other", which names nothing. */
async function plans(): Promise<void> {
    await plan(AG).create({ title: 'Ship', phases: [{ title: 'Now', items: [{ title: 'Prep' }, { title: 'Use batch()', after: [1] }] }] });
    await plan(SX).create({ title: 'Core', phases: [{ title: 'Now', items: [{ title: 'Other' }] }] });
}

describe('#943: PlanPort.after', () => {
    it("the port's after is the actor's: the project manager sets a cross-project wait through plan_update", async () => {
        await plans();
        const port = createPlanPort({ me: KEEL, scope: async () => ({ plan: plan(AG, agentP(KEEL)) as unknown as PlanActorClient, project: projects[1]!, names: new Map() }) });
        expect(port.after).toBeTypeOf('function');
        const out = await port.after!(2, [1, 'signalx#1'], call);
        expect(out.after).toEqual([1]);
        expect((out as typeof out & { afterRefs?: unknown }).afterRefs).toEqual([{ projectId: SX, n: 1 }]);
        expect(out.state).toBe('blocked');
    });

    it("a member agent's after is refused in the actor's words", async () => {
        await plans();
        const port = createPlanPort({ me: FORGE, scope: async () => ({ plan: plan(AG, agentP(FORGE)) as unknown as PlanActorClient, project: projects[1]!, names: new Map() }) });
        await expect(port.after!(2, [1, 'signalx#1'], call)).rejects.toThrow(/only the project manager and people/);
    });
});

describe("#943: the other project's manager agent accepting sets the one wait", () => {
    it('Nova accepts within its policy: agentic#2 waits on signalx#2 as well as its own #1', async () => {
        await plans();
        await requests(agentP(FORGE)).send({ fromProject: AG, title: 'x', body: 'b', refs: ['agentic#2'] });
        const nova = requests(agentP(NOVA));
        await nova.triage('req_1', triage);
        const accepted = await nova.resolve('req_1', { action: 'accept' });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 2 });
        const waiting = await item(AG, 2);
        expect(waiting.after).toEqual([1]);
        expect(waiting.afterRefs).toEqual([{ projectId: SX, n: 2 }]);
        expect(waiting.state).toBe('blocked');
    });

    it('only that one wait: dropping a wait, adding two, or naming an item that does not name it is refused', async () => {
        await plans();
        await requests(agentP(FORGE)).send({ fromProject: AG, title: 'x', body: 'b', refs: ['agentic#2'] });
        await requests(agentP(NOVA)).triage('req_1', triage);
        await requests(agentP(NOVA)).resolve('req_1', { action: 'accept' });
        const asNova = plan(AG, agentP(NOVA));
        // signalx#1 names no agentic item.
        await expect(asNova.after(1, ['signalx#1'])).rejects.toThrow(/only the project manager and people/);
        // Adding another wait beside the ones it has, or dropping them.
        await expect(asNova.after(2, [1, 'signalx#2', 'signalx#1'])).rejects.toThrow(/only the project manager and people/);
        await expect(asNova.after(2, ['signalx#2'])).rejects.toThrow(/only the project manager and people/);
        expect((await item(AG, 2)).afterRefs).toEqual([{ projectId: SX, n: 2 }]);
    });

    it("an agent that is not signalx's manager may not, even for the item that names it", async () => {
        await plans();
        await requests(agentP(FORGE)).send({ fromProject: AG, title: 'x', body: 'b', refs: ['agentic#2'] });
        await requests(agentP(NOVA)).triage('req_1', triage);
        await requests().resolve('req_1', { action: 'accept' });
        await plan(AG).after(2, [1]);
        await expect(plan(AG, agentP(FORGE)).after(2, [1, 'signalx#2'])).rejects.toThrow(/only the project manager and people/);
        expect((await item(AG, 2)).afterRefs).toEqual([]);
    });
});
