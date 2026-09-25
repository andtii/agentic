/**
 * `project.changed` (#775): `ProjectChangedData.changed` names the project keys an upsert changed, typed on the
 * audit event itself — read here without a cast, so the declaration and the recorded data stay in step.
 */
import type { WorkspaceId } from '@agentic/core';
import { AgentActor } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import type { ProjectChangedData } from '../../src/audit/events';
import { workspaceKey } from '../../src/auth/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
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

const projectChanges = async (): Promise<ProjectChangedData[]> => {
    const { events } = await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['project.changed'] });
    return events.flatMap((e) => (e.kind === 'project.changed' ? [e.data] : []));
};

describe('project.changed data.changed (#775)', () => {
    it('lists the keys an update changed, and none on remove', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        await ws().upsertProject({ id: project.id, name: 'signalx-2', description: 'renamed' });
        const updated = (await projectChanges()).find((d) => d.op === 'updated' && d.name === 'signalx-2');
        expect(updated?.changed).toEqual(expect.arrayContaining(['name', 'description']));
        expect(updated?.changed).not.toContain('folders');

        await ws().removeProject(project.id);
        const removed = (await projectChanges()).find((d) => d.op === 'removed');
        expect(removed).toBeDefined();
        expect(removed!.changed).toBeUndefined();
    });
});
