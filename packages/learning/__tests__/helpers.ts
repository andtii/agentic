import type { AgentId, Correction, MessageId, SessionId, TaskId, TaskOutcome } from '@agentic/core';
import { createMemoryStore } from '@agentic/memory';

export const NOW = Date.UTC(2026, 8, 17, 10, 0, 0); // Thursday, 2026-W38
export const AGENT = 'agent_a' as AgentId;

export function store(now = () => NOW) {
    return createMemoryStore({ now });
}

let seq = 0;

export function correction(text: string, extra: Partial<Correction> = {}): Correction {
    seq++;
    return {
        agentId: AGENT,
        sessionId: 'session_1' as SessionId,
        messageId: `msg_${seq}` as MessageId,
        text,
        what: 'prefer',
        by: 'user',
        at: NOW,
        ...extra
    };
}

export function outcome(objective: string, extra: Partial<TaskOutcome> = {}): TaskOutcome {
    return {
        taskId: 'task_1' as TaskId,
        agentId: AGENT,
        status: 'completed',
        verification: 'claimed',
        objective,
        tags: [],
        ...extra
    };
}
