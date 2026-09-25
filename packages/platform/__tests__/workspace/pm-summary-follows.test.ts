/**
 * The weekly summary entry stays correct over time (#906): a new workspace time zone re-syncs every project's entry,
 * and removing a project switches its entry off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type PmPolicy, type ProjectId, type WorkspaceId } from '@agentic/core';
import { AgentActor } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { pmSummaryScheduleId, pmSummaryScheduleKey } from '../../src/requests/index';
import { defineScheduleActor } from '../../src/schedule/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const withSummary = (day = 1, time = '08:45'): PmPolicy => ({ ...PM_POLICY_DEFAULT, weeklySummary: { day, time } });
const Schedule = defineScheduleActor({ trigger: { fired: async () => undefined } });

describe('the weekly summary entry follows the workspace', () => {
    let app: TestActorApp;
    beforeEach(async () => {
        app = testActorApp([Workspace, AgentActor, AuditActor, Schedule]);
        await app.start();
    });
    afterEach(() => app.stop());

    const ws = () => app.as(owner).actor(Workspace, workspaceKey('u1'));
    const entry = (projectId: ProjectId) => app.as(owner).actor(Schedule, pmSummaryScheduleKey(WS, projectId));

    it('updateSettings with a new time zone re-syncs every project with a summary', async () => {
        const a = await ws().upsertProject({ name: 'signalx', pmPolicy: withSummary() });
        const b = await ws().upsertProject({ name: 'agentic', pmPolicy: withSummary(5, '17:05') });
        const none = await ws().upsertProject({ name: 'quiet' });
        expect((await entry(a.id).get()).recurrence).toMatchObject({ tz: 'UTC' });

        await ws().updateSettings({ timeZone: 'Europe/Stockholm' });
        expect((await entry(a.id).get()).recurrence).toMatchObject({ cron: '45 8 * * 1', tz: 'Europe/Stockholm' });
        expect((await entry(b.id).get()).recurrence).toMatchObject({ cron: '5 17 * * 5', tz: 'Europe/Stockholm' });
        await expect(entry(none.id).get()).rejects.toThrow(/does not exist/);

        // A settings change that keeps the zone leaves the entries alone.
        await ws().updateSettings({ retention: {} });
        expect((await entry(a.id).get()).recurrence).toMatchObject({ tz: 'Europe/Stockholm' });
    });

    it('removeProject switches its entry off and keeps it indexed', async () => {
        const project = await ws().upsertProject({ name: 'signalx', pmPolicy: withSummary() });
        expect((await entry(project.id).get()).enabled).toBe(true);
        await ws().removeProject(project.id);
        expect((await entry(project.id).get()).enabled).toBe(false);
        expect((await ws().get()).schedules).toEqual([pmSummaryScheduleId(project.id)]);
    });

    it('removeProject without a summary creates no entry', async () => {
        const project = await ws().upsertProject({ name: 'signalx' });
        await ws().removeProject(project.id);
        await expect(entry(project.id).get()).rejects.toThrow(/does not exist/);
    });
});
