/**
 * The project manager's weekly summary on Home and merge notices to requesters (#763; PRJ-14): the pure text, the
 * summary schedule driven by the manual scheduler through `pmSummaryTrigger`, and the merge notices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineActorApp, manualScheduler, memoryStorage, type Host, type ManualScheduler } from '@sigx/actors/host';
import { PM_POLICY_DEFAULT, type ChatId, type PmPolicy, type Principal, type ProjectId, type ProjectRecord, type ScheduleId, type WorkspaceId } from '@agentic/core';
import { defineScheduleActor, type ScheduleFired, type TriggerHop, type TriggerPort } from '../../src/schedule/index';
import { defineRequestsActor, requestsKey, type RequestView } from '../../src/requests/index';
import {
    actorSummaryRequests,
    inboxSummaryHome,
    isPmSummary,
    mergeNotice,
    notifyRequestersOnMerge,
    PM_SUMMARY_PROMPT,
    pmSummaryCron,
    pmSummarySchedule,
    pmSummaryScheduleId,
    pmSummaryScheduleKey,
    pmSummaryTrigger,
    requestsForMerge,
    weeklySummary,
    type PmSummaryPost,
    type PmSummaryRequestsPort
} from '../../src/requests/summary';
import { testActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const SX = 'prj_sx' as ProjectId;
const AG = 'prj_ag' as ProjectId;
const TZ = 'Europe/Stockholm';
const T = (iso: string) => Date.parse(iso);
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;

const req = (over: Partial<RequestView> & Pick<RequestView, 'id' | 'state'>): RequestView => ({
    fromProject: AG,
    sender: { kind: 'agent', agentId: 'agent_forge' as never },
    toProject: SX,
    title: `title of ${over.id}`,
    body: 'body',
    refs: [],
    createdAt: T('2026-09-22T10:00:00Z'),
    updatedAt: T('2026-09-22T10:00:00Z'),
    ...over
});

type Rec = Pick<ProjectRecord, 'id' | 'name' | 'pm'>;
const withSummary: PmPolicy = { ...PM_POLICY_DEFAULT, weeklySummary: { day: 1, time: '08:45' } };
const project = (policy: PmPolicy = withSummary): Rec => ({ id: SX, name: 'signalx', pm: { agentId: 'agent_nova' as never, policy } });

describe('weekly summary schedule', () => {
    it('is Monday 08:45 by default, on the workspace time zone', () => {
        expect(pmSummaryCron()).toBe('45 8 * * 1');
        expect(pmSummaryCron({ day: 5, time: '17:05' })).toBe('5 17 * * 5');
        expect(pmSummarySchedule({ id: SX, name: 'signalx' }, TZ)).toEqual({
            kind: 'recurring',
            title: 'Weekly summary · signalx',
            recurrence: { kind: 'cron', cron: '45 8 * * 1', tz: TZ },
            projectId: SX,
            prompt: PM_SUMMARY_PROMPT
        });
        expect(pmSummaryScheduleKey(ws, SX)).toBe('ws_1:schedule:sch_pm_prj_sx');
    });

    it.each([
        [{ day: 7, time: '08:45' }],
        [{ day: -1, time: '08:45' }],
        [{ day: 1.5, time: '08:45' }],
        [{ day: 1, time: '8:45' }],
        [{ day: 1, time: '24:00' }],
        [{ day: 1, time: '08:60' }]
    ])('refuses %j', (s) => {
        expect(() => pmSummaryCron(s)).toThrow(/weekly summary/);
    });

    it('recognises only its own entry', () => {
        const id = pmSummaryScheduleId(SX);
        expect(isPmSummary({ prompt: PM_SUMMARY_PROMPT, projectId: SX, scheduleId: id })).toBe(true);
        expect(isPmSummary({ prompt: 'Standup', projectId: SX, scheduleId: id })).toBe(false);
        expect(isPmSummary({ prompt: PM_SUMMARY_PROMPT, projectId: SX, scheduleId: 'sch_other' as ScheduleId })).toBe(false);
        expect(isPmSummary({ prompt: PM_SUMMARY_PROMPT, scheduleId: id })).toBe(false);
    });
});

describe('weeklySummary', () => {
    const now = T('2026-09-28T06:45:00Z');
    const since = now - 7 * DAY;

    it('counts the week and lists what waits on you', () => {
        const s = weeklySummary({
            projectName: 'signalx',
            since,
            now,
            incoming: [
                req({ id: 'req_1', state: 'accepted', resultItem: 3 }),
                req({ id: 'req_2', state: 'declined', declineReason: 'duplicate of #2' }),
                req({ id: 'req_3', state: 'needs-you', createdAt: since - DAY, updatedAt: since - DAY }),
                req({ id: 'req_4', state: 'asked-for-more' }),
                // Decided before the week: counted nowhere.
                req({ id: 'req_5', state: 'accepted', resultItem: 1, createdAt: since - 2 * DAY, updatedAt: since - DAY })
            ],
            sent: [req({ id: 'req_9', state: 'accepted', fromProject: SX, toProject: AG })]
        });
        expect(s.quiet).toBe(false);
        expect(s.title).toBe('Weekly summary · signalx');
        expect(s.counts).toEqual({ received: 3, accepted: 1, declined: 1, needsYou: 1, askedForMore: 1, sent: 1, sentAccepted: 1 });
        expect(s.body).toContain('3 requests came in: 1 accepted, 1 declined.');
        expect(s.body).toContain('1 request waits on you.');
        expect(s.body).toContain('1 request waits on the sender.');
        expect(s.body).toContain('signalx sent 1 request; 1 accepted elsewhere.');
        expect(s.body).toContain('Needs you:\n- req_3 from prj_ag: title of req_3');
        expect(s.body).toContain('- req_1: title of req_1 → #3');
        expect(s.body).toContain('- req_2: title of req_2 (duplicate of #2)');
        expect(s.body).not.toContain('req_5');
    });

    it('is one line for a quiet week', () => {
        const s = weeklySummary({ projectName: 'signalx', since, now, incoming: [req({ id: 'req_5', state: 'accepted', createdAt: since - 2 * DAY, updatedAt: since - DAY })] });
        expect(s.quiet).toBe(true);
        expect(s.body).toBe('A quiet week: no requests came in or went out, and nothing waits on you.');
    });

    it('caps each list at five', () => {
        const incoming = Array.from({ length: 7 }, (_, i) => req({ id: `req_${i + 1}`, state: 'needs-you' }));
        const s = weeklySummary({ projectName: 'signalx', since, now, incoming });
        expect(s.body).toContain('- req_5 from prj_ag: title of req_5');
        expect(s.body).not.toContain('req_6 ');
        expect(s.body).toContain('- and 2 more');
    });
});

// ---------------------------------------------------------------------------
// The summary on the manual scheduler

class Recorder implements TriggerPort {
    events: ScheduleFired[] = [];
    async fired(event: ScheduleFired): Promise<void> {
        this.events.push(event);
    }
}

describe('pmSummaryTrigger on the manual scheduler', () => {
    const running: Host[] = [];
    let scheduler: ManualScheduler;
    let posts: PmSummaryPost[];
    let next: Recorder;
    let rec: Rec | undefined;
    let incoming: RequestView[];
    let Schedule: ReturnType<typeof defineScheduleActor>;
    let host: Host;

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T('2026-09-26T10:00:00Z')); // a Saturday
        scheduler = manualScheduler();
        posts = [];
        next = new Recorder();
        rec = project();
        incoming = [req({ id: 'req_1', state: 'needs-you', createdAt: T('2026-09-25T09:00:00Z'), updatedAt: T('2026-09-25T09:00:00Z') })];
        const requests: PmSummaryRequestsPort = { requests: async () => ({ incoming, sent: [] }) };
        Schedule = defineScheduleActor({
            allowAnonymous: true,
            trigger: pmSummaryTrigger({
                projects: { project: async (_hop, w, id) => (w === ws && id === SX ? rec : undefined) },
                requests,
                home: { post: async (_hop, s) => void posts.push(s) },
                next
            })
        });
        host = await defineActorApp({ actors: [Schedule], storage: memoryStorage(), scheduler, defaults: { reminderTickMs: MIN, sweepIntervalMs: 0, callTimeoutMs: 0 } }).start();
        running.push(host);
    });

    afterEach(async () => {
        for (const h of running.splice(0)) await h.stop({ timeoutMs: 1000 });
        vi.useRealTimers();
    });

    const yieldTurns = async (n: number) => {
        for (let i = 0; i < n; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
    };
    /** Move Date to `t` in `stepMs` jumps, one reminder tick per jump. */
    const runTo = async (t: number, stepMs = MIN) => {
        while (Date.now() < t) {
            vi.setSystemTime(Math.min(t, Date.now() + stepMs));
            scheduler.advance(MIN);
            await yieldTurns(1);
        }
        await yieldTurns(20);
    };

    it('posts the week to Home on Monday 08:45 local, and not before', async () => {
        const created = await host.actor(Schedule, pmSummaryScheduleKey(ws, SX)).create(pmSummarySchedule(rec!, TZ));
        expect(created.next).toBe(T('2026-09-28T06:45:00Z')); // 08:45 CEST

        await runTo(T('2026-09-28T06:44:00Z'), 60 * MIN);
        expect(posts).toEqual([]);

        await runTo(T('2026-09-28T06:45:00Z'));
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
            workspaceId: ws,
            projectId: SX,
            scheduleId: pmSummaryScheduleId(SX),
            scheduledFor: T('2026-09-28T06:45:00Z'),
            title: 'Weekly summary · signalx',
            counts: { received: 1, needsYou: 1 }
        });
        expect(posts[0]!.body).toContain('req_1 from prj_ag');
        expect(next.events).toEqual([]);

        // A week later, the next one.
        await runTo(T('2026-10-05T06:45:00Z'), 60 * MIN);
        await runTo(T('2026-10-05T06:47:00Z'));
        expect(posts.map((p) => p.scheduledFor)).toEqual([T('2026-09-28T06:45:00Z'), T('2026-10-05T06:45:00Z')]);
    });

    it('pauses its entry when the summary was turned off', async () => {
        rec = project(PM_POLICY_DEFAULT);
        const client = host.actor(Schedule, pmSummaryScheduleKey(ws, SX));
        await client.create(pmSummarySchedule({ id: SX, name: 'signalx' }, TZ));
        await runTo(T('2026-09-28T06:44:00Z'), 60 * MIN);
        await runTo(T('2026-09-28T06:46:00Z'));
        expect(posts).toEqual([]);
        const view = await client.get();
        expect(view.enabled).toBe(false);
        expect(view.paused?.reason).toMatch(/weekly summary is off/);
    });

    it('hands every other firing to the next trigger', async () => {
        await host.actor(Schedule, 'ws_1:schedule:sch_standup').create({ kind: 'reminder', title: 'standup', recurrence: { kind: 'cron', cron: '0 9 * * *', tz: TZ }, prompt: 'Standup' });
        await runTo(T('2026-09-27T06:59:00Z'), 60 * MIN);
        await runTo(T('2026-09-27T07:01:00Z'));
        expect(next.events.map((e) => e.title)).toEqual(['standup']);
        expect(posts).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The default ports

describe('inboxSummaryHome', () => {
    it('posts one reminder row linked to the schedule, and nothing again for a retried firing', async () => {
        const rows: { kind: string; title: string; body?: string; ref?: { kind: string; scheduleId?: string } }[] = [];
        const hop = { actor: () => ({ list: async () => [...rows], push: async (row: (typeof rows)[number]) => void rows.push(row) }) } as unknown as TriggerHop;
        const post: PmSummaryPost = {
            ...weeklySummary({ projectName: 'signalx', since: 0, now: 1, incoming: [] }),
            workspaceId: ws,
            projectId: SX,
            scheduledFor: T('2026-09-28T06:45:00Z'),
            scheduleId: pmSummaryScheduleId(SX)
        };
        await inboxSummaryHome.post(hop, post);
        await inboxSummaryHome.post(hop, post);
        expect(rows).toEqual([{ kind: 'reminder', title: 'Weekly summary · signalx · 2026-09-28', body: post.body, ref: { kind: 'schedule', scheduleId: 'sch_pm_prj_sx' } }]);
    });
});

describe('actorSummaryRequests', () => {
    it('reads incoming and sent from the project Requests actor', async () => {
        const Requests = defineRequestsActor({
            projects: {
                projects: async () => [
                    { id: SX, name: 'signalx', members: { agentIds: [], coordinator: null }, pm: { policy: { ...PM_POLICY_DEFAULT, senders: [{ project: '*', who: 'any-member', mode: 'allowed' }] } } },
                    { id: AG, name: 'agentic', members: { agentIds: [], coordinator: null } }
                ]
            },
            turns: { triage: async () => {} }
        });
        const app = testActorApp([Requests]);
        await app.start();
        try {
            const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
            await app.as(user).actor(Requests, requestsKey(ws, SX)).send({ fromProject: AG, title: 'batch() drops nested effects', body: 'seen in agentic' });
            const hop = app.as(user) as unknown as TriggerHop;
            const sx = await actorSummaryRequests.requests(hop, ws, SX);
            expect(sx.incoming.map((r) => r.title)).toEqual(['batch() drops nested effects']);
            const ag = await actorSummaryRequests.requests(hop, ws, AG);
            expect(ag.sent.map((r) => r.id)).toEqual([sx.incoming[0]!.id]);
        } finally {
            await app.stop();
        }
    });
});

// ---------------------------------------------------------------------------
// Merge notices

describe('telling requesters on merge', () => {
    const CHAT = 'chat_forge' as ChatId;
    const incoming = [
        req({ id: 'req_1', state: 'accepted', resultItem: 3, fromChat: CHAT, title: 'batch() drops nested effects' }),
        req({ id: 'req_2', state: 'accepted', resultItem: 3 }), // no chat
        req({ id: 'req_3', state: 'accepted', resultItem: 4, fromChat: CHAT }),
        req({ id: 'req_4', state: 'declined', fromChat: CHAT })
    ];
    const requests: PmSummaryRequestsPort = { requests: async () => ({ incoming, sent: [] }) };
    const hop = {} as TriggerHop;
    const merged = { workspaceId: ws, projectId: SX, item: 3, pull: 'signalx#812' };

    it('picks the accepted requests that became the item and came from a chat', () => {
        expect(requestsForMerge(incoming, 3).map((r) => r.id)).toEqual(['req_1']);
        expect(requestsForMerge(incoming, 9)).toEqual([]);
    });

    it('words the notice', () => {
        expect(mergeNotice('signalx', { id: 'req_1', title: 'batch() drops nested effects' }, merged)).toBe('signalx#3 merged (signalx#812): your request "batch() drops nested effects" (req_1) is done.');
        expect(mergeNotice('signalx', { id: 'req_1', title: 't' }, { item: 3 })).toBe('signalx#3 merged: your request "t" (req_1) is done.');
    });

    it('posts in the requester chat when notifyOnMerge', async () => {
        const posted: [ChatId, string][] = [];
        const sent = await notifyRequestersOnMerge(hop, merged, { project: project(), requests, chat: { post: async (_h, w, chatId, text) => void (w === ws && posted.push([chatId, text])) } });
        expect(posted).toEqual([[CHAT, 'signalx#3 merged (signalx#812): your request "batch() drops nested effects" (req_1) is done.']]);
        expect(sent).toEqual([{ chatId: CHAT, requestId: 'req_1', text: posted[0]![1] }]);
    });

    it('stays quiet when the policy turns it off', async () => {
        const chat = { post: vi.fn(async () => {}) };
        const sent = await notifyRequestersOnMerge(hop, merged, { project: project({ ...withSummary, notifyOnMerge: false }), requests, chat });
        expect(sent).toEqual([]);
        expect(chat.post).not.toHaveBeenCalled();
    });

    it('a failing chat does not stop the others', async () => {
        const two: PmSummaryRequestsPort = { requests: async () => ({ incoming: [incoming[0]!, req({ id: 'req_5', state: 'accepted', resultItem: 3, fromChat: 'chat_b' as ChatId })], sent: [] }) };
        const chat = {
            post: async (_h: TriggerHop, _w: WorkspaceId, chatId: ChatId) => {
                if (chatId === CHAT) throw new Error('gone');
            }
        };
        const sent = await notifyRequestersOnMerge(hop, merged, { project: project(), requests: two, chat });
        expect(sent.map((s) => s.requestId)).toEqual(['req_5']);
    });
});
