/**
 * The browser's actor stubs (#34): one `__actorRef` per platform actor the
 * pages read, typed as the real definition so `useActorState(Chat, …)`
 * and `actor(Session, key).tail()` are checked against the actor's own
 * method table. Values only — nothing of `@agentic/platform` is imported
 * at runtime here, so the platform stays out of the client bundle.
 *
 * `type` is the wire and storage identity (`defineActor({ type })`);
 * `streams` and `reads` mirror each definition's declarations, exactly as
 * `@sigx/actors/vite` stamps them.
 */
import { __actorRef } from '@sigx/actors/client';
import type { ActorDefs } from './defs';

/** The actor mount `createActorWorker` serves (`@sigx/actors` default base). */
export const ACTOR_ENDPOINT = '/_sigx/actor';

const ref = <D>(type: string, streams: readonly string[] = []): D => __actorRef(type, ACTOR_ENDPOINT, streams, []) as unknown as D;

export function clientDefs(): ActorDefs {
    return {
        Workspace: ref('Workspace'),
        Chat: ref('Chat'),
        AgentActor: ref('Agent'),
        TaskActor: ref('task'),
        Session: ref('session', ['tail']),
        Routing: ref('routing'),
        Inbox: ref('Inbox'),
        Machine: ref('machine'),
        Schedule: ref('Schedule'),
        Registry: ref('Registry'),
        TaskIndex: ref('task-index'),
        Audit: ref('audit'),
        Ledger: ref('ledger'),
        Memory: ref('Memory')
    };
}
