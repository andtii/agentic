/**
 * #931: accepting a request links the items across projects. The requester's item the request names (`agentic#2`)
 * waits on the item the accept filed (`signalx#1`) through a real cross-project `after` — so the workspace's link
 * graph shows the pair and the requester's item is blocked until the new one is done — and the request keeps who
 * accepted it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type PlanActor, type Principal, type ProjectId, type ProjectRecord, type SessionId, type Triage, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey, workspaceLinks } from '../../src/plan/index';
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
    { id: SX, name: 'signalx', members: { agentIds: [NOVA], coordinator: NOVA }, pm: { agentId: NOVA, policy } },
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

const triage: Triage = { kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'Fix nested batch()', doneWhen: ['nested batch test passes'] }, openIssue: false, reply: 'On it.', why: '' };

/** agentic's plan: #1, and #2 (waits on #1) — the item the request names. */
async function requesterPlan(): Promise<void> {
    const created = await plan(AG).create({ title: 'Ship', phases: [{ title: 'Now', items: [{ title: 'Prep' }, { title: 'Use batch()', after: [1] }] }] });
    expect(created.phases[0]!.items.map((i) => i.id)).toEqual([1, 2]);
}

const item = async (project: ProjectId, n: number) => (await plan(project).list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items)).find((i) => i.id === n)!;

const graph = (show: 'open' | 'done' = 'open') =>
    workspaceLinks({
        projects: async () => projects.map((p) => ({ id: p.id, name: p.name })),
        items: (id) => plan(id).linkItems()
    }, show);

describe('#931: accepting a request links the items across projects', () => {
    it('a person accepts: agentic#2 waits on signalx#1 (keeping its own after), Links shows the pair, blocked until done', async () => {
        await requesterPlan();
        await requests(agentP(FORGE)).send({ fromProject: AG, title: 'batch() drops nested effects', body: 'Found while testing agentic#2.', refs: ['agentic#2', 'pr:12'] });
        await requests(agentP(NOVA)).triage('req_1', triage);
        const accepted = await requests().resolve('req_1', { action: 'accept' });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1 });
        expect((accepted as { acceptedBy?: PlanActor }).acceptedBy).toEqual({ kind: 'user', userId: 'u1' });

        const waiting = (await item(AG, 2)) as Awaited<ReturnType<typeof item>> & { afterRefs?: unknown };
        expect(waiting.after).toEqual([1]);
        expect(waiting.afterRefs).toEqual([{ projectId: SX, n: 1 }]);
        expect(waiting.state).toBe('blocked');

        const open = await graph();
        expect(open.edges).toContainEqual(expect.objectContaining({ from: `${SX}#1`, to: `${AG}#2` }));

        // agentic#1 done: #2 still waits on signalx#1.
        await plan(AG).update(1, { state: 'done' });
        expect((await item(AG, 2)).state).toBe('blocked');
        // signalx#1 done: #2 is ready.
        await plan(SX).update(1, { tick: [{ index: 0, checked: true }], state: 'done' });
        expect((await item(AG, 2)).state).toBe('ready');
    });

    it('accepting again elsewhere never duplicates the wait; an item already done is left alone', async () => {
        await requesterPlan();
        await plan(AG).update(1, { state: 'done' });
        await requests(agentP(FORGE)).send({ fromProject: AG, title: 'one', body: 'b', refs: ['agentic#1', 'agentic#2', 'agentic#2', 'agentic#99'] });
        await requests(agentP(NOVA)).triage('req_1', triage);
        await requests().resolve('req_1', { action: 'accept' });
        expect(((await item(AG, 2)) as { afterRefs?: unknown }).afterRefs).toEqual([{ projectId: SX, n: 1 }]);
        expect(((await item(AG, 1)) as { afterRefs?: unknown }).afterRefs).toEqual([]);
    });

    it("another project's manager accepting: the request is accepted and, the item naming the requester's (#943), it waits on it", async () => {
        await requesterPlan();
        await requests(agentP(FORGE)).send({ fromProject: AG, title: 'x', body: 'b', refs: ['agentic#2'] });
        const nova = requests(agentP(NOVA));
        await nova.triage('req_1', triage);
        const accepted = await nova.resolve('req_1', { action: 'accept' });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1, acceptedBy: { kind: 'agent', agentId: NOVA } });
        expect(((await item(AG, 2)) as { afterRefs?: unknown }).afterRefs).toEqual([{ projectId: SX, n: 1 }]);
    });
});
