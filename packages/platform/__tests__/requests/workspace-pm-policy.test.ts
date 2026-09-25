/**
 * `Workspace.setProjectPmPolicy` (#758; PRJ-14): the owner sets who may send a project requests and what its manager
 * may do alone; the policy is checked (a cap above normal refused), the manager agent kept, and the change audited.
 */
import { PM_POLICY_DEFAULT, type PmPolicy, type ProjectId, type WorkspaceId } from '@agentic/core';
import { AgentActor } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');

let app: TestActorApp;
beforeEach(async () => {
    app = testActorApp([Workspace, AgentActor, AuditActor]);
    await app.start();
});
afterEach(async () => {
    await app.stop();
});

const ws = () => app.as(owner).actor(Workspace, workspaceKey('u1'));

describe('Workspace.setProjectPmPolicy (#758)', () => {
    it('stores a checked policy, keeps the manager, audits project.changed', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        const agentId = project.pm?.agentId;
        expect(agentId).toBeDefined();
        const policy: PmPolicy = { ...PM_POLICY_DEFAULT, senders: [{ project: 'prj_ag' as ProjectId, who: 'any-member', mode: 'allowed' }, ...PM_POLICY_DEFAULT.senders] };
        const saved = await ws().setProjectPmPolicy(project.id, policy);
        expect(saved.pm).toEqual({ agentId, policy });
        expect((await ws().projects()).find((p) => p.id === project.id)!.pm).toEqual({ agentId, policy });
        const events = await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['project.changed'] });
        expect(events.events[0]).toMatchObject({ summary: expect.stringMatching(/manager policy set/), data: { projectId: project.id, changed: ['pm.policy'] } });
    });

    it('refuses a cap above normal (400) and an unknown project (404)', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        expect(await statusOf(ws().setProjectPmPolicy(project.id, { ...PM_POLICY_DEFAULT, autonomy: { ...PM_POLICY_DEFAULT.autonomy, priorityUpTo: 'high' as never } }))).toBe(400);
        expect(await statusOf(ws().setProjectPmPolicy('prj_none' as ProjectId, PM_POLICY_DEFAULT))).toBe(404);
    });
});
