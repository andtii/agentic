/**
 * The Requests actor (#758) on a real in-process host with the Plan actor: a request from another project goes to
 * triage or to a person by the target's sender rules, the manager's triage turn is started, its policy decides what
 * needs a person, accept adds the item to the Plan and links it, and every transition is audited with its actor.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type PmPolicy, type Principal, type ProjectId, type ProjectRecord, type SessionId, type Triage, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey } from '../../src/plan/index';
import { defineRequestsActor, parseRequestsKey, requestsKey, requestTurnTaskId, type RequestTurn } from '../../src/requests/index';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const SX = 'prj_sx' as ProjectId;
const AG = 'prj_ag' as ProjectId;
const NOVA = 'agent_nova' as AgentId;
const CORE = 'agent_core' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const KEEL = 'agent_keel' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });
const machine: Principal = { kind: 'machine', workspaceId: ws, machineId: 'm1' as never };

type Rec = Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'>;
let policy: PmPolicy;
let projects: () => Rec[];
let turns: RequestTurn[];
let audit: ReturnType<typeof capturingAuditPort>;
let app: TestActorApp;
let Requests: ReturnType<typeof defineRequestsActor>;
let Plan: ReturnType<typeof definePlanActor>;

const allowAg = (): PmPolicy => ({ ...PM_POLICY_DEFAULT, senders: [{ project: AG, who: 'any-member', mode: 'allowed' }] });

beforeEach(() => {
    policy = allowAg();
    projects = () => [
        { id: SX, name: 'signalx', members: { agentIds: [NOVA, CORE], coordinator: NOVA }, pm: { agentId: NOVA, policy } },
        { id: AG, name: 'agentic', members: { agentIds: [KEEL, FORGE], coordinator: KEEL }, pm: { agentId: KEEL, policy: PM_POLICY_DEFAULT } }
    ];
    turns = [];
    audit = capturingAuditPort();
    const planProjects = { project: async (_ctx: unknown, _ws: WorkspaceId, id: ProjectId) => projects().find((p) => p.id === id) };
    Plan = definePlanActor({ audit, projects: planProjects });
    Requests = defineRequestsActor({
        audit,
        projects: { projects: async () => projects() },
        turns: {
            async triage(_hop, turn) {
                turns.push(turn);
            }
        }
    });
    app = testActorApp([Plan, Requests]);
    return app.start();
});
afterEach(() => app.stop());

const requests = (p: Principal = user, project: ProjectId = SX) => app.as(p).actor(Requests, requestsKey(ws, project));
const plan = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, SX));

const bug: Triage = {
    kind: 'bug',
    priority: 'normal',
    reproduced: { ok: true, note: "Forge's test fails on signalx main" },
    similar: [],
    proposedItem: { title: 'batch() drops nested effects', doneWhen: ['nested batch test passes'], assignee: { kind: 'agent', agentId: CORE }, first: true },
    openIssue: false,
    reply: 'Reproduced; filed and first in line.',
    why: ''
};

const send = (from: Principal = agentP(FORGE)) => requests(from).send({ fromProject: AG, title: 'batch() drops nested effects', body: 'Found while testing agentic#16.', refs: ['agentic#16'] });

describe('Requests actor', () => {
    it('keys: {ws}:requests:{project}', () => {
        expect(requestsKey(ws, SX)).toBe('ws_1:requests:prj_sx');
        expect(parseRequestsKey('ws_1:requests:prj_sx')).toEqual({ workspaceId: ws, projectId: SX });
        expect(parseRequestsKey('ws_1:plan:prj_sx')).toBeNull();
    });

    it('PRJ-15: send → triage turn → manager triage within policy → accept creates the plan item and links it', async () => {
        const sent = await send();
        expect(sent).toMatchObject({ id: 'req_1', state: 'triaging', fromProject: AG, toProject: SX, sender: { kind: 'agent', agentId: FORGE } });
        expect(turns).toMatchObject([{ projectId: SX, managerId: NOVA, turn: 1, request: { id: 'req_1' } }]);

        const nova = requests(agentP(NOVA));
        expect((await nova.triage('req_1', bug)).state).toBe('triaging');
        const accepted = await nova.resolve('req_1', { action: 'accept' });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1 });

        // No plan yet: a Requests plan was made, the item assigned first in the assignee's queue, the request's refs on it.
        const { plans } = await plan().list();
        expect(plans.map((p) => p.title)).toEqual(['Requests']);
        const item = plans[0]!.phases[0]!.items[0]!;
        expect(item).toMatchObject({ id: 1, title: 'batch() drops nested effects', assignee: { kind: 'agent', agentId: CORE }, queueIndex: 0 });
        expect(item.refs).toEqual([{ kind: 'project-item', project: 'agentic', n: 16 }]);

        // Sent, incoming and linked views.
        expect((await requests(user, AG).sent()).map((r) => [r.id, r.state])).toEqual([['req_1', 'accepted']]);
        expect((await requests().incoming()).map((r) => r.id)).toEqual(['req_1']);
        expect(await requests(user, AG).linked()).toMatchObject([{ direction: 'sent', request: { id: 'req_1', resultItem: 1 } }]);
        expect(await requests().linked()).toMatchObject([{ direction: 'incoming', request: { id: 'req_1' } }]);

        // Every transition is audited with its actor.
        const recs = audit.events.filter((e) => e.kind === 'request.changed');
        expect(recs.map((e) => [e.by, (e.data as { op: string }).op, (e.data as { state: string }).state])).toEqual([
            [`agent:${FORGE}`, 'received', 'triaging'],
            [`agent:${NOVA}`, 'triaged', 'triaging'],
            [`agent:${NOVA}`, 'accepted', 'accepted']
        ]);
        expect(recs.at(-1)).toMatchObject({ agentId: NOVA, data: { projectId: SX, requestId: 'req_1', fromProject: AG, resultItem: 1 } });
        expect(new Set(recs.map((e) => e.key)).size).toBe(recs.length);
    });

    it('PRJ-14: high priority always comes to a person; the manager cannot accept it, a person accepts an edited item', async () => {
        await plan().create({ title: 'Ship', phases: [{ title: 'Done', items: [] }, { title: 'Now', items: [{ title: 'other' }] }] });
        await send();
        const nova = requests(agentP(NOVA));
        const held = await nova.triage('req_1', { ...bug, priority: 'high' });
        expect(held).toMatchObject({ state: 'needs-you', needs: 'decision', reasons: ['priority'] });
        expect(held.triage!.why).toMatch(/priority/);
        expect(await statusOf(nova.resolve('req_1', { action: 'accept' }))).toBe(409);
        expect(await statusOf(requests(agentP(FORGE)).resolve('req_1', { action: 'accept' }))).toBe(403);

        const accepted = await requests().resolve('req_1', { action: 'accept', item: { title: 'batch() nested (edited)', doneWhen: ['fixed'] } });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 2 });
        // Into the first phase with open work of the existing plan, unassigned.
        const phases = (await plan().get('plan-1')).phases;
        expect(phases[1]!.items.map((i) => i.title)).toEqual(['other', 'batch() nested (edited)']);
        expect(phases[1]!.items[1]!.assignee).toBeUndefined();
    });

    it('decision 3: the default sender rule asks first — a person lets it in, then the manager gets its turn', async () => {
        policy = PM_POLICY_DEFAULT;
        const r = await send();
        expect(r).toMatchObject({ state: 'needs-you', needs: 'admit', reasons: ['sender'] });
        expect(turns).toEqual([]);
        expect(await statusOf(requests(agentP(NOVA)).admit('req_1'))).toBe(403);
        expect(await requests().admit('req_1')).toMatchObject({ state: 'triaging' });
        expect(turns.map((t) => t.turn)).toEqual([1]);
        expect(requestTurnTaskId(SX, 'req_1', 1)).toBe('task_req_1_prj_sx_1');
    });

    it('ask for more → the sender answers → a second triage turn; decline with a reason is final', async () => {
        await send();
        const nova = requests(agentP(NOVA));
        await nova.triage('req_1', bug);
        expect(await nova.resolve('req_1', { action: 'ask', question: 'Which version?' })).toMatchObject({ state: 'asked-for-more', question: 'Which version?' });
        expect(await statusOf(requests(agentP(CORE)).answer('req_1', '0.4'))).toBe(403);
        expect(await requests(agentP(FORGE)).answer('req_1', 'signalx 0.4.2')).toMatchObject({ state: 'triaging' });
        expect(turns.map((t) => t.turn)).toEqual([1, 2]);
        expect(await statusOf(nova.resolve('req_1', { action: 'decline', reason: 'not a bug' }))).toBe(409);
        expect(await requests().resolve('req_1', { action: 'decline', reason: 'works as designed' })).toMatchObject({ state: 'declined', declineReason: 'works as designed' });
        expect(await statusOf(requests().resolve('req_1', { action: 'accept', item: { title: 'x', doneWhen: [] } }))).toBe(409);
        expect((await plan().list()).plans).toEqual([]);
    });

    it('refuses what is not a request change: machines, unknown projects, self-sends, bad keys', async () => {
        expect(await statusOf(requests(machine).send({ fromProject: AG, title: 't', body: 'b' }))).toBe(403);
        expect(await statusOf(requests().send({ fromProject: 'prj_none' as ProjectId, title: 't', body: 'b' }))).toBe(404);
        expect(await statusOf(requests().send({ fromProject: SX, title: 't', body: 'b' }))).toBe(400);
        expect(await statusOf(requests().get('req_9'))).toBe(404);
        expect(await statusOf(app.as(user).actor(Requests, 'ws_1:requests:').incoming())).toBe(400);
        expect(await statusOf(requests(user, 'prj_gone' as ProjectId).send({ fromProject: AG, title: 't', body: 'b' }))).toBe(404);
    });

    it('a change racing an accept is refused: one item, one resolution', async () => {
        await send();
        await requests(agentP(NOVA)).triage('req_1', bug);
        const [accept, decline] = await Promise.allSettled([requests().resolve('req_1', { action: 'accept' }), requests().resolve('req_1', { action: 'decline', reason: 'raced' })]);
        expect(accept).toMatchObject({ status: 'fulfilled', value: { state: 'accepted', resultItem: 1 } });
        expect(decline.status).toBe('rejected');
        expect(await statusOf(Promise.reject((decline as PromiseRejectedResult).reason))).toBe(409);
        expect((await plan().list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items))).toHaveLength(1);
    });

    it('a Plan refusal leaves the request as it was', async () => {
        await send();
        await requests(agentP(NOVA)).triage('req_1', bug);
        expect(await statusOf(requests().resolve('req_1', { action: 'accept', planId: 'plan-9' }))).toBe(404);
        expect((await requests().get('req_1')).state).toBe('triaging');
    });
});
