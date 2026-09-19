/** The live chat's pure rules added by #152: tasks in a chat, what a stop reaches, open requests, unread, the settings change, the list filter, the read marks. */
import { describe, it, expect, afterEach } from 'vitest';
import type { AgentId, MessageId, TaskId } from '@agentic/core';
import type { ChatSummary, InboxNotification, IndexedEntry, TaskIndexRow } from '@agentic/platform';
import { createTranscript } from '@sigx/ai-agent';
import { matchingChats } from '../../src/pages/chat/ChatList';
import { settingsChange } from '../../src/pages/chat/ChatSettingsDialog';
import { chatRow, chatTasks, detachedQuestions, entryTranscript, lastOf, lookupOver, membersOf, notStoppedLine, openRequests, stopTargets, stoppable, unreadOf, waitingAgents, workingAgents, type AgentIdentity } from '../../src/pages/chat/live';
import { baselineReadMarks, loadReadMarks, markSeen, readMarks, resetReadMarks } from '../../src/pages/chat/read-marks';
import { zoneFormat } from '../../src/time';

const atlas: AgentIdentity = { id: 'a1', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 3 };
const forge: AgentIdentity = { id: 'a2', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 1 };
const lookup = lookupOver({ a1: atlas, a2: forge });

const row = (id: string, extra: Partial<TaskIndexRow> = {}): TaskIndexRow => ({
    id: id as TaskId, objective: `do ${id}`, assignee: 'a1' as AgentId, owner: 'a1' as AgentId, status: 'active', origin: 'user', depth: 0, createdAt: 1000, updatedAt: 1000, n: 1, ...extra
});

const msg = (seq: number, who: 'user' | 'a1' | 'a2', text: string, at = seq * 1000): IndexedEntry => ({
    seq,
    entry: { t: 'msg', id: `m${seq}` as MessageId, author: who === 'user' ? { kind: 'user' } : { kind: 'agent', agentId: who as AgentId, sessionId: 's1' as never }, parts: [{ type: 'text', text }], at, mentions: [] }
});
const request = (seq: number, agentId: string, kind: 'request' | 'request-resolved', ref: `approval:${string}` | `input:${string}`): IndexedEntry => ({ seq, entry: { t: 'status', agentId: agentId as AgentId, kind, ref, at: seq * 1000 } });

describe('chatTasks', () => {
    const rows = [
        row('other', { chatId: 'c2' as never, createdAt: 9000 }),
        row('done', { chatId: 'c1' as never, status: 'completed', createdAt: 5000 }),
        row('root', { chatId: 'c1' as never, status: 'waiting', createdAt: 2000 }),
        row('kid-b', { parentId: 'root' as TaskId, origin: 'agent', depth: 1, assignee: 'a2' as AgentId, createdAt: 2200 }),
        row('kid-a', { parentId: 'root' as TaskId, origin: 'agent', depth: 1, assignee: 'a2' as AgentId, status: 'completed', createdAt: 2100 }),
        row('grandkid', { parentId: 'kid-b' as TaskId, origin: 'agent', depth: 2, createdAt: 2300 }),
        row('stray', { parentId: 'elsewhere' as TaskId, origin: 'agent', depth: 1 })
    ];

    it('keeps the chains of this chat: roots by chatId, children by parentId, a running chain first, depth-first', () => {
        const tasks = chatTasks(rows, 'c1');
        expect(tasks.map((t) => [t.id, t.depth])).toEqual([['root', 0], ['kid-a', 1], ['kid-b', 1], ['grandkid', 2], ['done', 0]]);
        expect(tasks[2]).toEqual({ id: 'kid-b', parentId: 'root', depth: 1, status: 'active', objective: 'do kid-b', agentId: 'a2' });
        expect(chatTasks(rows, 'nope')).toEqual([]);
    });

    it('a settled root with a child still running counts as running, and the list is capped', () => {
        const mixed = [row('old', { chatId: 'c1' as never, status: 'completed', createdAt: 1 }), row('old-kid', { parentId: 'old' as TaskId, createdAt: 2 }), row('newer', { chatId: 'c1' as never, status: 'completed', createdAt: 50 })];
        expect(chatTasks(mixed, 'c1').map((t) => t.id)).toEqual(['old', 'old-kid', 'newer']);
        expect(chatTasks(rows, 'c1', 2).map((t) => t.id)).toEqual(['root', 'kid-a']);
    });

    it('a stop reaches what has not settled, through the highest task that still runs', () => {
        const tasks = chatTasks(rows, 'c1');
        expect(stoppable(tasks).map((t) => t.id)).toEqual(['root', 'kid-b', 'grandkid']);
        expect(stopTargets(tasks).map((t) => t.id)).toEqual(['root']);
        const mixed = chatTasks([row('old', { chatId: 'c1' as never, status: 'completed' }), row('old-kid', { parentId: 'old' as TaskId })], 'c1');
        expect(stopTargets(mixed).map((t) => t.id)).toEqual(['old-kid']);
        expect(stopTargets(chatTasks([row('done', { chatId: 'c1' as never, status: 'cancelled' })], 'c1'))).toEqual([]);
    });

    it("a member working a delegated task of this chat reads active; settled, queued or other chats' work does not (#258)", () => {
        const summary = { seq: 1, members: { a1: { since: 0, historyFrom: 0 }, a2: { since: 0, historyFrom: 0 }, a3: { since: 0, historyFrom: 0 } }, coordinator: 'a1', activeSessions: { a1: 's1' } } as unknown as ChatSummary;
        const tree = [
            row('root', { chatId: 'c1' as never, status: 'waiting', createdAt: 1 }),
            row('kid', { parentId: 'root' as TaskId, origin: 'agent', depth: 1, assignee: 'a2' as AgentId, createdAt: 2 }),
            row('queued', { parentId: 'root' as TaskId, origin: 'agent', depth: 1, assignee: 'a3' as AgentId, status: 'queued', createdAt: 3 }),
            row('elsewhere', { chatId: 'c2' as never, assignee: 'a3' as AgentId })
        ];
        expect(workingAgents(tree, 'c1')).toEqual(new Set(['a2']));
        expect(membersOf(summary, new Set(), workingAgents(tree, 'c1')).map((m) => [m.agentId, m.status])).toEqual([['a1', 'active'], ['a2', 'active'], ['a3', 'idle']]);
        // An open request still reads WAITING first.
        expect(membersOf(summary, new Set(['a2']), workingAgents(tree, 'c1'))[1]!.status).toBe('waiting');
        // Beyond the panel's cap: status still counts every row.
        const many = [row('r', { chatId: 'c1' as never, createdAt: 1 }), ...Array.from({ length: 12 }, (_, i) => row(`k${i}`, { parentId: 'r' as TaskId, origin: 'agent', depth: 1, assignee: (i === 11 ? 'a3' : 'a2') as AgentId, status: i === 11 ? 'active' : 'completed', createdAt: 2 + i }))];
        expect(workingAgents(many, 'c1').has('a3')).toBe(true);
    });

    it('what could not be stopped is named by objective, once (COL-12)', () => {
        expect(notStoppedLine([{ notStopped: [] }], rows)).toBeNull();
        expect(notStoppedLine([{ notStopped: ['kid-b', 'gone'] }, { notStopped: ['kid-b'] }], rows)).toBe('Could not be stopped: do kid-b; gone');
    });
});

describe('detachedQuestions (#285)', () => {
    const note = (requestId: string, sessionId: string, read = false): InboxNotification => ({ id: `n_${requestId}`, kind: 'input', title: 'Ada needs input', ref: { kind: 'session', sessionId: sessionId as never, requestId }, at: 1, read, deliveries: [] });

    it('lists the open questions no live feed carries, with the session the Inbox names; never an approval, an answered one, or one a feed shows', () => {
        const entries = [request(1, 'a1', 'request', 'input:ask:c1'), request(2, 'a2', 'request', 'input:ask:c2'), request(3, 'a2', 'request', 'approval:r9'), request(4, 'a1', 'request', 'input:ask:c3'), request(5, 'a1', 'request-resolved', 'input:ask:c3')];
        const inbox = [note('ask:c1', 's1'), note('ask:c2', 's2'), note('r9', 's2'), note('ask:c3', 's1', true)];
        const live = createTranscript('s2');
        live.requests['ask:c2'] = { requestId: 'ask:c2', kind: 'input', seq: 2 };
        expect(detachedQuestions(entries, inbox, [{ transcript: live }])).toEqual([{ sessionId: 's1', requestId: 'ask:c1', agentId: 'a1' }]);
        // Without the Inbox row there is no session to answer through: nothing to show.
        expect(detachedQuestions(entries, [], [])).toEqual([]);
    });
});

describe('open requests, waiting and unread', () => {
    const summary: ChatSummary = { seq: 6, members: { a1: { since: 1, historyFrom: 0 }, a2: { since: 1, historyFrom: 0 } }, coordinator: 'a1' as AgentId, activeSessions: { a1: 's1' as never, a2: 's2' as never } };
    const entries = [msg(0, 'user', 'push it'), request(1, 'a2', 'request', 'approval:r1'), request(2, 'a1', 'request', 'input:r2'), request(3, 'a1', 'request-resolved', 'input:r2'), msg(4, 'a1', 'thanks'), msg(5, 'a2', 'waiting on you')];

    it('pairs a request with its resolution by ref', () => {
        expect(openRequests(entries)).toEqual([{ ref: 'approval:r1', agentId: 'a2', at: 1000 }]);
        expect(openRequests([...entries, request(6, 'a2', 'request-resolved', 'approval:r1')])).toEqual([]);
        // A resolution whose request is out of view resolves nothing in view.
        expect(openRequests([request(3, 'a1', 'request-resolved', 'input:r2')])).toEqual([]);
        expect([...waitingAgents(entries)]).toEqual(['a2']);
    });

    it('a member with an open request reads waiting, ahead of its active session', () => {
        expect(membersOf(summary, waitingAgents(entries)).map((m) => [m.agentId, m.status])).toEqual([['a1', 'active'], ['a2', 'waiting']]);
        expect(membersOf(summary).map((m) => m.status)).toEqual(['active', 'active']);
    });

    it('unread counts agent messages at or past the marker; no marker counts nothing', () => {
        expect(unreadOf(entries, undefined)).toBe(0);
        expect(unreadOf(entries, 0)).toBe(2);
        expect(unreadOf(entries, 5)).toBe(1);
        expect(unreadOf(entries, 6)).toBe(0);
        expect(unreadOf(entries, Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('the last line is the newest message; the time is the newest entry', () => {
        const ended: IndexedEntry = { seq: 6, entry: { t: 'status', agentId: 'a2' as AgentId, kind: 'session-ended', ref: 's2', at: 6000 } };
        expect(lastOf([...entries, ended], lookup)).toEqual({ line: 'Forge: waiting on you', at: 6000 });
        expect(lastOf([ended], lookup)).toEqual({ line: 'Forge ended its session', at: 6000 });
        expect(lastOf([], lookup)).toEqual({ line: '', at: 0 });
    });

    it('the list row carries both', () => {
        expect(chatRow('c1', summary, entries, lookup, 5)).toMatchObject({ unread: 1, waiting: true, lastLine: 'Forge: waiting on you', updatedAt: 5000 });
        expect(chatRow('c1', summary, entries, lookup)).toMatchObject({ unread: 0, waiting: true });
        expect(chatRow('c1', summary, [...entries, request(6, 'a2', 'request-resolved', 'approval:r1')], lookup, 6)).toMatchObject({ unread: 0, waiting: false });
    });
});

describe('entryTranscript on the live page', () => {
    it('attributes the user as given and prints times with the clock face it is handed', () => {
        const at = Date.UTC(2026, 8, 16, 23, 30);
        const t = entryTranscript([msg(0, 'user', 'hi', at)], lookup, 'You', zoneFormat('Europe/Stockholm').time);
        expect(t.authors.m0).toMatchObject({ name: 'You', person: true, time: { text: '01:30' } });
        expect(entryTranscript([msg(0, 'user', 'hi', at)], lookup, 'You', zoneFormat('UTC').time).authors.m0!.time!.text).toBe('23:30');
    });
});

describe('settingsChange', () => {
    const current = { title: 'Release plan', coordinator: 'a1' };
    it('names only what changed', () => {
        expect(settingsChange(current, { title: 'Release plan', coordinator: 'a1', remove: [] })).toEqual({ remove: [] });
        expect(settingsChange(current, { title: '  Release   plan v2 ', coordinator: 'a2', remove: [] })).toEqual({ title: 'Release plan v2', coordinator: 'a2', remove: [] });
        expect(settingsChange(current, { title: '', coordinator: '', remove: [] })).toEqual({ coordinator: null, remove: [] });
    });
    it('a removed coordinator leaves with its membership; a removed pick is no coordinator', () => {
        expect(settingsChange(current, { title: 'Release plan', coordinator: 'a1', remove: ['a1'] })).toEqual({ remove: ['a1'] });
        expect(settingsChange(current, { title: 'Release plan', coordinator: 'a2', remove: ['a1'] })).toEqual({ coordinator: 'a2', remove: ['a1'] });
        expect(settingsChange({ title: '', coordinator: null }, { title: '', coordinator: 'a2', remove: ['a2'] })).toEqual({ remove: ['a2'] });
    });
});

describe('matchingChats', () => {
    const chats = [
        { id: 'c1', title: 'Mobile pass', members: [], lastLine: 'Forge: pushed the drawer fix', unread: 0, waiting: false, updatedAt: 2 },
        { id: 'c2', title: 'A2A research', members: [], lastLine: 'Scout: three clients', unread: 0, waiting: false, updatedAt: 1 }
    ];
    it('keeps rows with every word in the title or the last line', () => {
        expect(matchingChats(chats, '  ')).toBe(chats);
        expect(matchingChats(chats, 'MOBILE').map((c) => c.id)).toEqual(['c1']);
        expect(matchingChats(chats, 'scout clients').map((c) => c.id)).toEqual(['c2']);
        expect(matchingChats(chats, 'mobile scout')).toEqual([]);
    });
});

describe('read marks', () => {
    afterEach(() => {
        resetReadMarks();
        localStorage.clear();
    });

    it('load from storage, only move forward, and are kept per workspace', () => {
        localStorage.setItem('agentic:chat-seen:u1', JSON.stringify({ c1: 4, junk: 'x' }));
        expect(readMarks('u1')).toEqual({});
        loadReadMarks('u1');
        expect(readMarks('u1')).toEqual({ c1: 4 });
        markSeen('u1', 'c1', 2);
        markSeen('u1', 'c2', 7);
        expect(readMarks('u1')).toEqual({ c1: 4, c2: 7 });
        expect(JSON.parse(localStorage.getItem('agentic:chat-seen:u1')!)).toEqual({ c1: 4, c2: 7 });
        expect(readMarks('u2')).toEqual({});
    });

    it('a first sight starts a chat at its present end and leaves known chats alone', () => {
        markSeen('u1', 'c1', 3);
        baselineReadMarks('u1', [{ id: 'c1', seq: 9 }, { id: 'c2', seq: 5 }]);
        expect(readMarks('u1')).toEqual({ c1: 3, c2: 5 });
    });

    it('survives storage that refuses or holds garbage', () => {
        localStorage.setItem('agentic:chat-seen:u1', '{not json');
        loadReadMarks('u1');
        expect(readMarks('u1')).toEqual({});
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = () => { throw new Error('quota'); };
        try {
            markSeen('u1', 'c1', 1);
            expect(readMarks('u1')).toEqual({ c1: 1 });
        } finally {
            Storage.prototype.setItem = setItem;
        }
    });
});
