/** The reducer is pure over (state, entry): replaying entries rebuilds the same state, which is what `ctx.append` relies on. */
import type { AgentId, ChatEntry, MessageId, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { applyChatEntry, initialChatState, visibleFrom } from '../../src/chat/index.js';

const WS = 'ws_1' as WorkspaceId;
const A = 'agent_a' as AgentId;
const B = 'agent_b' as AgentId;

const msg = (id: string, at: number): ChatEntry => ({ t: 'msg', id: id as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text: id }], at, mentions: [] });

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
        expect(state.activeSessions).toEqual({});
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

    it('from-now starts at the join entry itself', () => {
        const state = replay(script.slice(0, 3));
        expect(state.members[B]).toEqual({ since: 3, historyFrom: 2 });
        expect(state.coordinator).toBeNull();
        applyChatEntry(state, { t: 'coordinator', agentId: B, at: 4 });
        expect(state.coordinator).toBe(B);
        applyChatEntry(state, { t: 'status', agentId: B, kind: 'session-started', ref: 'session_9', at: 5 });
        expect(state.activeSessions).toEqual({ [B]: 'session_9' as SessionId });
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
