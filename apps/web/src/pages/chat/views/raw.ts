/**
 * Raw detail on a finished turn (#1058): the chat keeps only a turn's step summary (`msg.steps`), never its
 * tool input or output, so Raw reads the turn back from its Session — lazily, once per session, only while
 * the viewer has Raw on — and shows the calls the turn made above its final text, as today's thread did.
 */
import { createTranscript, reduceAgentEvent, type AgentEvent } from '@sigx/ai-agent';
import type { AgentMessage, AgentPart, AgentTranscript } from '@sigx/ai-agent/app';
import type { StepsMessage } from '@agentic/ui';

/** A session's log folded once: what `rawParts` reads a turn out of. */
export function foldSession(sessionId: string, events: readonly AgentEvent[]): AgentTranscript {
    const t = createTranscript(sessionId);
    for (const e of events) reduceAgentEvent(t, e);
    return t;
}

/** The tool calls turn `turnId` made, in order (the top-level messages of that turn; a sub-agent's stay on its card). */
export function turnToolParts(t: AgentTranscript, turnId: string): AgentPart[] {
    return t.messages
        .filter((m) => m.role === 'assistant' && m.turnId === turnId && m.parentCallId === undefined)
        .flatMap((m) => m.parts.filter((p) => p.type === 'tool'));
}

/**
 * The thread's messages at Raw: each finished turn whose session log was read gets its calls in front of its
 * text. `sessionOf` names the session a message's turn ran in; `folded` the logs read so far. A message whose
 * log is not read yet (or that made no call) is kept as it is.
 */
export function withRawTurns(messages: readonly AgentMessage[], sessionOf: (message: AgentMessage) => string | undefined, folded: Readonly<Record<string, AgentTranscript>>): AgentMessage[] {
    return messages.map((m) => {
        const turnId = (m as StepsMessage).steps?.turnId;
        const sessionId = turnId ? sessionOf(m) : undefined;
        const t = sessionId ? folded[sessionId] : undefined;
        if (!t || !turnId || m.parts.some((p) => p.type === 'tool')) return m;
        const calls = turnToolParts(t, turnId);
        return calls.length ? { ...m, parts: [...calls, ...m.parts] } : m;
    });
}
