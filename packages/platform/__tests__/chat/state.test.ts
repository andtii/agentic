/** The reducer is pure over (state, entry): replaying entries rebuilds the same state, which is what `ctx.append` relies on. */
import type { AgentId, ChatEntry, MessageId, Principal, ProjectId, SessionId, WorkspaceId } from '@agentic/core';
import { applyChatEntry, initialChatState, visibleFrom } from '../../src/chat/index.js';

const WS = 'ws_1' as WorkspaceId;
const A = 'agent_a' as AgentId;
const B = 'agent_b' as AgentId;

const msg = (id: string, at: number): ChatEntry => ({ t: 'msg', id: id as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text: id }], at, mentions: [] });
const agentMsg = (id: string, agentId: AgentId, sessionId: string, at: number): ChatEntry => ({
    t: 'msg',
    id: id as MessageId,
    author: { kind: 'agent', agentId, sessionId: sessionId as SessionId },
    parts: [{ type: 'text', text: id }],
    at,
    mentions: [],
    sessionId: sessionId as SessionId
});

const script: readonly ChatEntry[] = [
    msg('m0', 1),
    { t: 'member', op: 'add', agentId: A, historyAccess: 'all', at: 2 },
    { t: 'member', op: 'add', agentId: B, historyAccess: 'from-now', at: 3 },
    { t: 'coordinator', agentId: B, at: 4 },
    { t: 'status', agentId: A, kind: 'session-started', ref: 'session_1', at: 5 },
    msg('m1', 6),
    { t: 'status', agentId: A, kind: 'session-ended', ref: 'session_1', at: 7 },
    { t: 'member', op: 'remove', agentId: B, historyAccess: 'from-now', at: 8 }
];

function replay(entries: readonly ChatEntry[]) {
    const state = initialChatState();
    for (const entry of entries) applyChatEntry(state, entry);
    return state;
}

describe('applyChatEntry', () => {
    it('derives seq, index, members, coordinator and active sessions from the entries', () => {
        const state = replay(script);
        expect(state.seq).toBe(8);
        expect(state.window).toHaveLength(8);
        expect(state.index).toEqual(script.map((e, seq) => ({ seq, at: e.at })));
        expect(state.members).toEqual({ [A]: { since: 2, historyFrom: 0 } });
        expect(state.coordinator).toBeNull();
        expect(state.sessions).toEqual({});
    });

    it('is deterministic: the same entries fold to the same state', () => {
        expect(replay(script)).toEqual(replay(script));
    });

    it('a rename entry sets the title; the last one wins and none leaves it absent (#124)', () => {
        const state = replay(script);
        expect(state.title).toBeUndefined();
        applyChatEntry(state, { t: 'rename', title: 'Release plan', at: 9 });
        expect(state.title).toBe('Release plan');
        applyChatEntry(state, { t: 'rename', title: 'Release plan v2', at: 10 });
        expect(state.title).toBe('Release plan v2');
        expect(state.seq).toBe(10);
        expect(state.index.slice(-2)).toEqual([{ seq: 8, at: 9 }, { seq: 9, at: 10 }]);
    });

    it('a project note sets projectId, the last one wins, and null clears it (#332)', () => {
        const note = (id: ProjectId | null, at: number): ChatEntry => ({ ...(msg(`p${at}`, at) as Extract<ChatEntry, { t: 'msg' }>), project: { id } });
        expect(replay([...script]).projectId).toBeUndefined();
        expect(replay([...script, note('project_1' as ProjectId, 10)]).projectId).toBe('project_1');
        expect(replay([...script, note('project_1' as ProjectId, 10), note('project_2' as ProjectId, 11)]).projectId).toBe('project_2');
        const cleared = replay([...script, note('project_1' as ProjectId, 10), note(null, 11)]);
        expect(cleared.projectId).toBeUndefined();
        expect('projectId' in cleared).toBe(false);
        // A plain message leaves it alone.
        expect(replay([...script, note('project_1' as ProjectId, 10), msg('m', 12)]).projectId).toBe('project_1');
    });

    it('from-now starts at the join entry itself', () => {
        const state = replay(script.slice(0, 3));
        expect(state.members[B]).toEqual({ since: 3, historyFrom: 2 });
        expect(state.coordinator).toBeNull();
        applyChatEntry(state, { t: 'coordinator', agentId: B, at: 4 });
        expect(state.coordinator).toBe(B);
        applyChatEntry(state, { t: 'status', agentId: B, kind: 'session-started', ref: 'session_9', at: 5 });
        expect(state.sessions).toEqual({ [B]: { sessionId: 'session_9' as SessionId, since: 5, seenSeq: 0 } });
    });
});

describe('sessions (#392): one row per member, bound by the session statuses', () => {
    const joined = script.slice(0, 3);
    const started = (agentId: AgentId, ref: string, at: number): ChatEntry => ({ t: 'status', agentId, kind: 'session-started', ref, at });
    const ended = (agentId: AgentId, ref: string, at: number): ChatEntry => ({ t: 'status', agentId, kind: 'session-ended', ref, at });

    it('session-started builds a row with the entry `at` as `since` and nothing seen yet', () => {
        const state = replay([...joined, started(A, 'session_1', 10)]);
        expect(state.sessions).toEqual({ [A]: { sessionId: 'session_1', since: 10, seenSeq: 0 } });
    });

    it('a session-started without a ref binds nothing', () => {
        const state = replay([...joined, { t: 'status', agentId: A, kind: 'session-started', at: 10 }]);
        expect(state.sessions).toEqual({});
    });

    it('seenSeq advances on that member’s own message and not on another member’s or a user’s', () => {
        const state = replay([...joined, started(A, 'session_1', 10), started(B, 'session_2', 11)]);
        // seq 0..2 joined, 3 and 4 the session starts.
        applyChatEntry(state, msg('u1', 12)); // seq 5, a user
        expect(state.sessions[A]!.seenSeq).toBe(0);
        expect(state.sessions[B]!.seenSeq).toBe(0);
        applyChatEntry(state, agentMsg('a1', A, 'session_1', 13)); // seq 6, A's own answer
        expect(state.sessions[A]!.seenSeq).toBe(6);
        expect(state.sessions[B]!.seenSeq).toBe(0);
        applyChatEntry(state, agentMsg('b1', B, 'session_2', 14)); // seq 7, B's — A is untouched
        expect(state.sessions[A]!.seenSeq).toBe(6);
        expect(state.sessions[B]!.seenSeq).toBe(7);
        applyChatEntry(state, msg('u2', 15)); // seq 8
        applyChatEntry(state, agentMsg('a2', A, 'session_1', 16)); // seq 9
        expect(state.sessions).toEqual({
            [A]: { sessionId: 'session_1', since: 10, seenSeq: 9 },
            [B]: { sessionId: 'session_2', since: 11, seenSeq: 7 }
        });
    });

    it('a message from an agent without a row moves nothing', () => {
        const state = replay([...joined, started(A, 'session_1', 10), agentMsg('b1', B, 'session_x', 11)]);
        expect(state.sessions).toEqual({ [A]: { sessionId: 'session_1', since: 10, seenSeq: 0 } });
    });

    it('a second session-started for the same member replaces the row: new id, new since, nothing seen', () => {
        const state = replay([...joined, started(A, 'session_1', 10), agentMsg('a1', A, 'session_1', 11), started(A, 'session_2', 12)]);
        expect(state.sessions).toEqual({ [A]: { sessionId: 'session_2', since: 12, seenSeq: 0 } });
    });

    it('a late message from a replaced session leaves the new row’s watermark alone; the bound session’s moves it', () => {
        const state = replay([...joined, started(A, 'session_1', 10), started(A, 'session_2', 11)]);
        applyChatEntry(state, agentMsg('late', A, 'session_1', 12)); // seq 5, the old session's final answer
        expect(state.sessions).toEqual({ [A]: { sessionId: 'session_2', since: 11, seenSeq: 0 } });
        applyChatEntry(state, agentMsg('fresh', A, 'session_2', 13)); // seq 6
        expect(state.sessions).toEqual({ [A]: { sessionId: 'session_2', since: 11, seenSeq: 6 } });
    });

    it('session-ended drops the row; another member’s row stays', () => {
        const state = replay([...joined, started(A, 'session_1', 10), started(B, 'session_2', 11), ended(A, 'session_1', 12)]);
        expect(state.sessions).toEqual({ [B]: { sessionId: 'session_2', since: 11, seenSeq: 0 } });
        applyChatEntry(state, ended(A, 'session_1', 13)); // ending an unbound member is a no-op
        expect(state.sessions).toEqual({ [B]: { sessionId: 'session_2', since: 11, seenSeq: 0 } });
    });

    it('removing a member drops its row', () => {
        const state = replay([...joined, started(A, 'session_1', 10), started(B, 'session_2', 11), { t: 'member', op: 'remove', agentId: A, historyAccess: 'all', at: 12 }]);
        expect(state.sessions).toEqual({ [B]: { sessionId: 'session_2', since: 11, seenSeq: 0 } });
    });

    it('a replay of the entry log rebuilds exactly the same rows', () => {
        const log: readonly ChatEntry[] = [
            ...joined,
            started(A, 'session_1', 10),
            agentMsg('a1', A, 'session_1', 11),
            started(B, 'session_2', 12),
            msg('u1', 13),
            agentMsg('b1', B, 'session_2', 14),
            agentMsg('a2', A, 'session_1', 15),
            ended(B, 'session_2', 16),
            started(B, 'session_3', 17)
        ];
        const live = initialChatState();
        for (const entry of log) applyChatEntry(live, entry);
        expect(live.sessions).toEqual({
            [A]: { sessionId: 'session_1', since: 10, seenSeq: 8 },
            [B]: { sessionId: 'session_3', since: 17, seenSeq: 0 }
        });
        expect(replay(log).sessions).toEqual(live.sessions);
        expect(replay(log)).toEqual(live);
    });
});

describe('visibleFrom', () => {
    const state = replay(script.slice(0, 3));
    const agent = (agentId: AgentId): Principal => ({ kind: 'agent', workspaceId: WS, agentId, sessionId: 's' as SessionId });

    it('users and external clients see everything', () => {
        expect(visibleFrom(state, { kind: 'user', userId: 'u', workspaceId: WS })).toBe(0);
        expect(visibleFrom(state, { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['chats'] })).toBe(0);
    });

    it('agents see from their historyFrom; non-members and anonymous callers see nothing', () => {
        expect(visibleFrom(state, agent(A))).toBe(0);
        expect(visibleFrom(state, agent(B))).toBe(2);
        expect(visibleFrom(state, agent('agent_x' as AgentId))).toBeNull();
        expect(visibleFrom(state, null)).toBeNull();
    });
});
