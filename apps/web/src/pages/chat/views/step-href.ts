/**
 * `Full output` on a step (#1058 over #1056): the step's own `output.ref` (`<sessionId>#<callId>`) as the
 * Session page's address; a step without one (a turn still in flight, read off its tool parts) goes to its
 * call in the session its agent runs for this chat.
 */
import type { StepHrefFn } from '@agentic/ui';
import { callHref, refHref } from '../../session/call';

export function stepHrefOf(sessionOf: (agentId: string) => string | undefined): StepHrefFn {
    return (step) => {
        const own = step.output?.ref ? refHref(step.output.ref) : undefined;
        if (own) return own;
        const sessionId = sessionOf(step.agentId);
        return sessionId ? callHref(sessionId, step.id) : undefined;
    };
}
