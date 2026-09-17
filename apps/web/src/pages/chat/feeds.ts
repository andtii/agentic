/**
 * A session feed (#34): `connectSession` over the Session actor, folded
 * into one reactive transcript with `reduceAgentEvent` — in place, so a
 * `part-delta` is one property write observed by the one text node that
 * reads it. Opened from the durable log's start (`{ epoch: 0, seq: 0 }`),
 * so a reload mid-turn resumes from what the actor recorded and a second
 * tab folds the same events to the same transcript (AC-06).
 */
import { signal } from 'sigx';
import { createTranscript, reduceAgentEvent } from '@sigx/ai-agent';
import { connectSession, type AgentSessionClient } from '@sigx/ai-agent/wire';
import { actorSessionTransport, type SessionActorClient, type SessionFeed } from './live';

export interface FeedHandle extends SessionFeed {
    /** Stop following; the remote session lives on. */
    disconnect(): void;
    /** The client, once connected — `respond` and `cancel` go through it. */
    client(): AgentSessionClient | undefined;
}

const START = { epoch: 0, seq: 0 } as const;

export function openFeed(session: SessionActorClient, sessionId: string, agentId: string, onError: (error: Error) => void): FeedHandle {
    const transcript = signal(createTranscript(sessionId));
    let stopped = false;
    let client: AgentSessionClient | undefined;
    void (async () => {
        try {
            client = await connectSession(actorSessionTransport(session, sessionId), { from: START });
            if (stopped) {
                client.disconnect();
                return;
            }
            for await (const event of client.subscribe(START)) {
                if (stopped) break;
                reduceAgentEvent(transcript, event);
            }
        } catch (e) {
            if (!stopped) onError(e instanceof Error ? e : new Error(String(e)));
        }
    })();
    return {
        sessionId,
        agentId,
        transcript,
        client: () => client,
        disconnect() {
            stopped = true;
            client?.disconnect();
        }
    };
}
