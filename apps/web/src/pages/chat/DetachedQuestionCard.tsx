/**
 * An open question of the chat whose asker stopped waiting (#285): it was
 * asked in a turn that has ended, and a feed carries only the turn that runs
 * now (#398), so no feed holds it. The card reads the request live from the
 * Session that asked (`detachedQuestions` names it), says who asked and that
 * answering starts that agent again, and answers through `Session.respond` —
 * which takes a question's answer on an idle session and on a closed one.
 */
import { component } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { Decision } from '@sigx/ai-agent';
import { QuestionPrompt } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { sessionKeyOf } from '../../actors/keys';
import { openRequestOf } from '../inbox/NeedsYou';
import type { AgentLookup, DetachedQuestion } from './live';

export const DetachedQuestionCard = component<{ question: DetachedQuestion; lookup: AgentLookup; onError: (e: unknown) => void }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const key = (): string | null => (viewer.workspaceId ? sessionKeyOf(viewer.workspaceId, props.question.sessionId) : null);
    const view = useActorState(defs.Session, () => { const k = key(); return k && ([k, 'request', props.question.requestId] as const); }, { live: true });

    const respond = async (requestId: string, decision: Decision): Promise<void> => {
        const k = key();
        if (!k) return;
        const reply = await actor(defs.Session, k).respond(requestId, decision);
        if (reply.kind === 'error') {
            props.onError(new Error(reply.message));
            throw new Error(reply.message);
        }
    };

    return () => {
        const v = view.value;
        if (!v || v.resolved) return null;
        const who = props.lookup(props.question.agentId);
        return <QuestionPrompt request={openRequestOf(v)} requestedBy={{ name: v.agentName || who.name, hue: who.hue }} stale={v.detached} onRespond={respond} />;
    };
});
