/**
 * The live operations pages' view model (#145), pure: wall time → instant
 * on the workspace zone across DST (AST-07), the schedule row labels, the
 * dialog's spec, the plugin dependents' names, the settings draft round
 * trip and the OPS-10 record lines.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, ScheduleId, WorkspaceId } from '@agentic/core';
import type { Dependents, ScheduleView, WorkspaceSettings } from '@agentic/platform';
import {
    dependentNames,
    newScheduleSpec,
    nextRunLabel,
    opStatus,
    scheduleRow,
    settingsPatch,
    timeZoneOptions,
    toDraft,
    validateDraft,
    validateNewSchedule,
    wallToInstant,
    whenLabel,
    type NewScheduleInput
} from '../../src/pages/ops/live';

const iso = (n: number | null): string | null => (n === null ? null : new Date(n).toISOString());

describe('wallToInstant', () => {
    it('reads a wall time on the workspace zone, summer and winter', () => {
        expect(iso(wallToInstant('2026-09-18 15:00', 'Europe/Stockholm'))).toBe('2026-09-18T13:00:00.000Z');
        expect(iso(wallToInstant('2026-01-18T15:00', 'Europe/Stockholm'))).toBe('2026-01-18T14:00:00.000Z');
        expect(iso(wallToInstant('2026-09-18 15:00', 'UTC'))).toBe('2026-09-18T15:00:00.000Z');
        expect(iso(wallToInstant('2026-09-18 15:00', 'America/New_York'))).toBe('2026-09-18T19:00:00.000Z');
        expect(iso(wallToInstant('2026-09-18 15:00', 'Asia/Kolkata'))).toBe('2026-09-18T09:30:00.000Z');
    });

    it('AST-07: a wall time in the spring gap lands after it; a repeated fall hour takes its first occurrence', () => {
        // Stockholm springs 02:00 → 03:00 on 2026-03-29 (01:00Z): 02:30 does not exist, the next instant is 03:30 CEST.
        expect(iso(wallToInstant('2026-03-29 02:30', 'Europe/Stockholm'))).toBe('2026-03-29T01:30:00.000Z');
        // Falls back 03:00 → 02:00 on 2026-10-25 (01:00Z): 02:30 happens twice, the first is CEST.
        expect(iso(wallToInstant('2026-10-25 02:30', 'Europe/Stockholm'))).toBe('2026-10-25T00:30:00.000Z');
    });

    it('rejects anything that is not a wall time or a zone', () => {
        expect(wallToInstant('tomorrow', 'UTC')).toBeNull();
        expect(wallToInstant('2026-13-40 99:99', 'UTC')).not.toBeNaN();
        expect(wallToInstant('2026-09-18 15:00', 'Mars/Olympus')).toBeNull();
    });
});

const AT = Date.parse('2026-09-18T10:00:00Z');

describe('schedule rows', () => {
    const view = (extra: Partial<ScheduleView> = {}): ScheduleView => ({
        workspaceId: 'u1' as WorkspaceId,
        id: 'sch_1' as ScheduleId,
        kind: 'reminder',
        title: 'Tea',
        recurrence: { kind: 'at', at: AT + 3_600_000 },
        enabled: true,
        next: AT + 3_600_000,
        lastRun: null,
        runs: 0,
        attempts: 0,
        offlinePolicy: 'queue',
        log: [],
        createdAt: AT,
        updatedAt: AT,
        ...extra
    });

    it('labels the next run on the workspace clock: today, tomorrow, else the day', () => {
        expect(nextRunLabel(AT + 3_600_000, 'Europe/Stockholm', AT)).toBe('today 13:00');
        expect(nextRunLabel(AT + 20 * 3_600_000, 'Europe/Stockholm', AT)).toBe('tomorrow 08:00');
        expect(nextRunLabel(AT + 6 * 86_400_000, 'Europe/Stockholm', AT)).toBe('Thu 24 Sep 12:00');
        expect(nextRunLabel(AT + 3_600_000, 'Asia/Tokyo', AT)).toBe('today 20:00');
    });

    it('names the recurrence the way the artboard does', () => {
        expect(whenLabel(view())).toBe('once');
        expect(whenLabel(view({ recurrence: { kind: 'cron', cron: '0 2 * * *', tz: 'UTC' } }))).toBe('daily 02:00');
        expect(whenLabel(view({ recurrence: { kind: 'cron', cron: '30 10 * * 1-5', tz: 'UTC' } }))).toBe('weekdays 10:30');
        expect(whenLabel(view({ recurrence: { kind: 'cron', cron: '30 17 * * 4', tz: 'UTC' } }))).toBe('Thu 17:30');
        expect(whenLabel(view({ recurrence: { kind: 'cron', cron: '*/5 * * * *', tz: 'UTC' } }))).toBe('*/5 * * * *');
    });

    it('a row: paused while disabled, done once a one-shot delivered, runs on the platform without an agent', () => {
        expect(scheduleRow(view(), 'Europe/Stockholm', AT)).toEqual({ id: 'sch_1', kind: 'reminder', what: 'Tea', when: 'once', nextRun: 'today 13:00', runsOn: {}, enabled: true });
        expect(scheduleRow(view({ enabled: false, next: null }), 'UTC', AT).nextRun).toBe('paused');
        expect(scheduleRow(view({ next: null, runs: 1 }), 'UTC', AT).nextRun).toBe('done');
        expect(scheduleRow(view({ kind: 'agent-task', agentId: 'agent_a' as AgentId }), 'UTC', AT).runsOn).toEqual({ agentId: 'agent_a' });
    });
});

describe('newScheduleSpec', () => {
    const input = (extra: Partial<NewScheduleInput> = {}): NewScheduleInput => ({ kind: 'reminder', title: 'Tea', at: '2026-09-18 15:00', cron: '0 9 * * 1-5', agentId: '', environmentId: '', prompt: '', ...extra });

    it('a reminder: a one-shot at the wall time on the workspace zone, its note as the prompt', () => {
        expect(newScheduleSpec(input({ prompt: ' Kettle on ' }), 'Europe/Stockholm')).toEqual({ kind: 'reminder', title: 'Tea', recurrence: { kind: 'at', at: Date.parse('2026-09-18T13:00:00Z') }, prompt: 'Kettle on' });
    });

    it('a recurrence: the cron on the workspace zone; an agent task carries the agent, the environment and the queue policy', () => {
        expect(newScheduleSpec(input({ kind: 'recurring' }), 'Europe/Stockholm')).toEqual({ kind: 'recurring', title: 'Tea', recurrence: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Stockholm' } });
        expect(newScheduleSpec(input({ kind: 'agent-task', agentId: 'agent_a', environmentId: 'env_1', prompt: 'Audit' }), 'UTC')).toEqual({
            kind: 'agent-task',
            title: 'Tea',
            recurrence: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'UTC' },
            prompt: 'Audit',
            agentId: 'agent_a',
            environmentId: 'env_1',
            offlinePolicy: 'queue'
        });
    });

    it('validates what the dialog asks for', () => {
        expect(validateNewSchedule(input({ title: ' ' }), 'UTC')).toEqual({ title: 'A title is required.' });
        expect(validateNewSchedule(input({ at: 'soon' }), 'UTC')).toEqual({ at: 'Pick a date and time.' });
        expect(validateNewSchedule(input({ kind: 'recurring', cron: '0 9' }), 'UTC')).toEqual({ cron: 'Five cron fields: minute hour day month weekday.' });
        expect(validateNewSchedule(input({ kind: 'agent-task' }), 'UTC')).toEqual({ agentId: 'Pick the agent that runs it.' });
        expect(newScheduleSpec(input({ title: '' }), 'UTC')).toBeNull();
    });
});

describe('dependentNames', () => {
    it('agents by name and how, schedules by title through their agent', () => {
        const deps: Dependents = {
            pluginId: 'github',
            agents: [{ id: 'agent_a' as AgentId, name: 'Ada', via: ['connector', 'tool'] }],
            schedules: [{ id: 'sch_1' as ScheduleId, title: 'nightly triage', agentId: 'agent_b' as AgentId }]
        };
        expect(dependentNames(deps, (id) => (id === 'agent_b' ? 'Bob' : id))).toEqual(['Ada — connector, tool', 'nightly triage — schedule via Bob']);
    });
});

describe('settings draft', () => {
    const settings: WorkspaceSettings = { timeZone: 'Europe/Stockholm', notifications: { inbox: true, push: false }, defaults: { runtime: 'anthropic-api' }, retention: { sessionLogDays: 90, artifactDays: 30 } };

    it('round-trips the actor settings through the draft to the patch', () => {
        const draft = toDraft(settings);
        expect(draft).toEqual({ timeZone: 'Europe/Stockholm', environmentId: '', inbox: true, push: false, sessionLogDays: '90', artifactDays: '30' });
        expect(settingsPatch(draft, ['Europe/Stockholm'])).toEqual({
            timeZone: 'Europe/Stockholm',
            notifications: { inbox: true, push: false },
            defaults: { runtime: 'anthropic-api', environmentId: undefined },
            retention: { sessionLogDays: 90, artifactDays: 30 }
        });
        expect(settingsPatch({ ...draft, environmentId: 'env_1', sessionLogDays: '7' }, [])).toMatchObject({ defaults: { runtime: 'claude-code', environmentId: 'env_1' }, retention: { sessionLogDays: 7, artifactDays: 30 } });
    });

    it('refuses an unknown zone or a retention that is not whole days', () => {
        expect(validateDraft({ ...toDraft(settings), timeZone: 'Mars/Olympus' }, ['Europe/Stockholm'])).toEqual({ timeZone: 'Unknown time zone "Mars/Olympus".' });
        expect(validateDraft({ ...toDraft(settings), artifactDays: '30 days' }, [])).toEqual({ artifactDays: 'Whole days.' });
        expect(settingsPatch({ ...toDraft(settings), sessionLogDays: '' }, [])).toBeNull();
        expect(timeZoneOptions('Europe/Stockholm')[0]).toBe('Europe/Stockholm');
        expect(timeZoneOptions('Europe/Stockholm')).toContain('UTC');
    });

    it('reads an OPS-10 record as running, done or failed', () => {
        expect(opStatus(undefined, 'export')).toEqual({ state: 'idle', text: '' });
        expect(opStatus({ startedAt: AT }, 'export')).toEqual({ state: 'running', text: 'Exporting…' });
        expect(opStatus({ startedAt: AT, finishedAt: AT + 1, prefix: 'u1/2026-09-18', count: 10 }, 'export')).toEqual({ state: 'done', text: 'Exported 10 files under u1/2026-09-18 (manifest.json lists them).' });
        expect(opStatus({ startedAt: AT, finishedAt: AT + 1, error: 'no ArtifactSink' }, 'export')).toEqual({ state: 'failed', text: 'Export failed: no ArtifactSink' });
        expect(opStatus({ startedAt: AT, finishedAt: AT + 1, error: 'boom' }, 'delete').text).toBe('Delete failed: boom');
    });
});
