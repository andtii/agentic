/**
 * The Team rows' working card (#1109): keyed on the agent, so the card keeps its key — and updates in place —
 * when its feed's task id arrives mid-turn.
 */
import { describe, expect, it } from 'vitest';
import type { AgentTranscript } from '@sigx/ai-agent';
import { teamRows } from '../../src/pages/chat/views/team/model';
import type { ChatViewModel } from '../../src/pages/chat/views/types';

const empty = (): AgentTranscript => ({ messages: [], requests: {}, state: 'idle' }) as unknown as AgentTranscript;

const view = (taskId?: string): ChatViewModel => ({
    chatId: 'c1',
    thread: { transcript: empty() },
    live: [{ agentId: 'forge', name: 'Forge', startedAt: 1_000 }],
    members: [{ agentId: 'forge', status: 'active' }],
    lookup: (id: string) => ({ name: id }),
    feeds: [{ sessionId: 's1', agentId: 'forge', transcript: empty(), ...(taskId ? { taskId } : {}) }],
    followed: null,
    onFollow: () => {}
}) as unknown as ChatViewModel;

describe('teamRows working card', () => {
    it('keeps its key when the feed learns its task id', () => {
        const before = teamRows(view()).work;
        const after = teamRows(view('t_1')).work;
        expect(before).toHaveLength(1);
        expect(after).toHaveLength(1);
        expect(before[0]!.state).toBe('working');
        expect(after[0]!.key).toBe(before[0]!.key);
    });
});
