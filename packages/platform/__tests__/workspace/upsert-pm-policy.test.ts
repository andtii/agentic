/**
 * `Workspace.upsertProject({ pmPolicy })` (#819; PRJ-14): the project manager's policy saves through the project
 * patch — checked like `setProjectPmPolicy`, the manager agent kept, a manager-less project still gets `pm.policy`.
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

const policy: PmPolicy = {
    senders: [{ project: 'prj_ag' as ProjectId, who: 'any-member', mode: 'allowed' }, ...PM_POLICY_DEFAULT.senders],
    autonomy: { ...PM_POLICY_DEFAULT.autonomy, openIssues: true, priorityUpTo: 'low' },
    weeklySummary: { day: 1, time: '09:00' },
    notifyOnMerge: false
};

describe('Workspace.upsertProject pmPolicy (#819)', () => {
    it('persists pm.policy, keeps the manager agent and its config, audits pm.policy', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        const agentId = project.pm!.agentId!;
        const agentsBefore = (await ws().get()).agents;

        const saved = await ws().upsertProject({ id: project.id, pmPolicy: policy });
        expect(saved.pm).toEqual({ agentId, policy });
        expect(saved.members.coordinator).toBe(agentId);
        expect((await ws().projects()).find((p) => p.id === project.id)!.pm).toEqual({ agentId, policy });
        expect((await ws().get()).agents).toEqual(agentsBefore);

        const events = await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['project.changed'] });
        expect(events.events.some((e) => (e.data as { changed?: string[] }).changed?.includes('pm.policy'))).toBe(true);
    });

    it('a later patch without pmPolicy keeps the saved policy', async () => {
        const project = await ws().upsertProject({ name: 'signalx', pmPolicy: policy });
        expect(project.pm?.policy).toEqual(policy);
        const renamed = await ws().upsertProject({ id: project.id, name: 'renamed' });
        expect(renamed.pm).toEqual({ agentId: project.pm!.agentId, policy });
    });

    it('a project without a manager still gets pm: { policy }', async () => {
        const project = await ws().upsertProject({ name: 'solo', pm: null });
        expect(project.pm).toBeUndefined();
        const saved = await ws().upsertProject({ id: project.id, pmPolicy: policy });
        expect(saved.pm).toEqual({ policy });
    });

    it('refuses a malformed policy with a 400 and changes nothing', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        const high = { ...policy, autonomy: { ...policy.autonomy, priorityUpTo: 'high' } } as unknown as PmPolicy;
        expect(await statusOf(ws().upsertProject({ id: project.id, pmPolicy: high }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ id: project.id, pmPolicy: { senders: 'all' } as unknown as PmPolicy }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ id: project.id, pmPolicy: null as unknown as PmPolicy }))).toBe(400);
        expect((await ws().projects()).find((p) => p.id === project.id)!.pm).toEqual(project.pm);
    });
});
