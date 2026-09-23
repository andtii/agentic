/** The Gmail trigger section's pure model (#535): intervals as UTC crons and back, the spec and patch a save sends. */
import { describe, expect, it } from 'vitest';
import { gmailConnectorPlugin } from '@agentic/connectors';
import type { ScheduleView } from '@agentic/platform';
import { draftOf, hasTrigger, intervalCron, intervalOf, triggerOf, triggerPatch, triggerSpec, triggerState, validateTrigger } from '../src/pages/plugins/connector-trigger';

const view = (over: Partial<ScheduleView>): ScheduleView => ({ id: 'schedule_1', workspaceId: 'ws', kind: 'agent-task', title: 't', recurrence: { kind: 'cron', cron: '*/15 * * * *', tz: 'UTC' }, enabled: true, next: 1, lastRun: null, runs: 0, attempts: 0, offlinePolicy: 'queue', log: [], createdAt: 0, updatedAt: 0, ...over }) as ScheduleView;

describe('connector trigger model (#535)', () => {
    it('polls on a UTC cron per interval and reads it back', () => {
        expect(intervalCron(5)).toBe('*/5 * * * *');
        expect(intervalCron(60)).toBe('0 * * * *');
        for (const m of [5, 10, 15, 30, 60]) expect(intervalOf({ recurrence: { kind: 'cron', cron: intervalCron(m), tz: 'UTC' } })).toBe(m);
        expect(intervalOf({ recurrence: { kind: 'at', at: 1 } })).toBeUndefined();
    });

    it('Gmail has a trigger this deployment runs; the entry watching it is found among the schedules', () => {
        expect(hasTrigger(gmailConnectorPlugin)).toBe(true);
        const mine = view({ id: 'schedule_2' as never, source: { kind: 'connector', connector: 'gmail' } });
        expect(triggerOf([null, view({}), mine], 'gmail')?.id).toBe('schedule_2');
        expect(triggerOf([view({})], 'gmail')).toBeUndefined();
    });

    it('a save sends a spec with the source, then a patch of the same fields', () => {
        const draft = { agentId: 'agent_1', query: ' is:unread ', interval: '10', prompt: '' };
        expect(validateTrigger({ ...draft, agentId: '' })).toHaveProperty('agentId');
        expect(validateTrigger({ ...draft, interval: '1' })).toHaveProperty('interval');
        expect(triggerSpec(draft, 'gmail', 'Gmail', 'Mail')).toEqual({
            kind: 'agent-task',
            title: 'New Gmail email → Mail',
            recurrence: { kind: 'cron', cron: '*/10 * * * *', tz: 'UTC' },
            agentId: 'agent_1',
            source: { kind: 'connector', connector: 'gmail', query: 'is:unread' },
            offlinePolicy: 'queue',
            enabled: true
        });
        expect(triggerPatch({ ...draft, query: '' }, 'gmail', 'Gmail', 'Mail')).toMatchObject({ source: { kind: 'connector', connector: 'gmail' }, prompt: '' });
        expect(draftOf(undefined)).toEqual({ agentId: '', query: 'in:inbox', interval: '5', prompt: '' });
    });

    it('states on, off and paused', () => {
        expect(triggerState(undefined)).toEqual({ state: 'none' });
        expect(triggerState(view({}))).toEqual({ state: 'on', interval: 15 });
        expect(triggerState(view({ enabled: false }))).toEqual({ state: 'off' });
        expect(triggerState(view({ enabled: false, paused: { at: 1, reason: 'reconnect' } }))).toEqual({ state: 'paused', reason: 'reconnect' });
    });
});
