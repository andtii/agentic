/**
 * A session feed (#34): `connectSession` over the Session actor, folded
 * into one reactive transcript — in place, so a `part-delta` is one property
 * write observed by the one text node that reads it. The fold carries the
 * `coding` extension (#1106): `coding.*` events (terminal deltas, diffs,
 * plans) land under `transcript.ext.coding`, which the Follow panel's live
 * output reads first; the default reducer would drop every `ext` event.
 *
 * #398: a chat member's session lives for the life of the chat (#393), so
 * its log holds every turn it ever ran; the feed does not replay that. It is
 * anchored at `feedAnchor(info)` — the record's `transcriptAt`, the cursor of
 * the last turn's end — and carries the turn that runs now and whatever
 * comes after, nothing before: every earlier turn's final message is a `msg`
 * entry of the chat already (architecture §6). A reload mid-turn still
 * resumes from what the actor recorded, and a second tab folds the same
 * events to the same transcript (AC-06).
 */
import { signal } from 'sigx';
import { createReducer, createTranscript, type EventCursor } from '@sigx/ai-agent';
import { codingExtension } from '@sigx/ai-agent/coding';
import { connectSession, type AgentSessionClient } from '@sigx/ai-agent/wire';
import type { SessionInfo } from '@agentic/platform';
import { actorSessionTransport, type SessionActorClient, type SessionFeed } from './live';

export interface FeedHandle extends SessionFeed {
    /** The task the session runs (`SessionInfo.spec.taskId`), once the record was read — "Resume" goes to the router by it (#46). */
    readonly taskId?: string;
    /** When the session's current turn started (#1058, the live line's clock): the `turn-start` event's `at`, else when the feed saw it. */
    readonly turnStartedAt?: number;
    /** Stop following; the remote session lives on. */
    disconnect(): void;
    /** The client, once connected — `respond` and `cancel` go through it. */
    client(): AgentSessionClient | undefined;
}

/** The feed's fold: the core reducer plus the coding extension (#1106). */
const reduceFeedEvent = createReducer({ extensions: [codingExtension()] });

const START: EventCursor = { epoch: 0, seq: 0 };

/**
 * Where a feed starts following a session's log (#398): at `transcriptAt`,
 * the cursor the last finished turn left — the events after it are the
 * running turn, if one runs, and what follows. A session that has finished
 * no turn yet has no such cursor: while its first turn runs the log IS that
 * turn, so it is followed from the start; idle, there is nothing to replay
 * and the feed follows from the head.
 */
export function feedAnchor(info: Pick<SessionInfo, 'transcriptAt' | 'running' | 'head'>): EventCursor {
    if (info.transcriptAt) return { epoch: info.transcriptAt.epoch, seq: info.transcriptAt.seq };
    return info.running ? START : { epoch: info.head.epoch, seq: info.head.seq };
}

export function openFeed(session: SessionActorClient, sessionId: string, agentId: string, onError: (error: Error) => void): FeedHandle {
    const transcript = signal(createTranscript(sessionId));
    const record = signal<{ taskId?: string; turnStartedAt?: number }>({});
    let stopped = false;
    let client: AgentSessionClient | undefined;
    void (async () => {
        try {
            const info = await session.get();
            if (info.spec?.taskId) record.taskId = info.spec.taskId;
            if (stopped) return;
            const from = feedAnchor(info);
            client = await connectSession(actorSessionTransport(session, sessionId), { from });
            if (stopped) {
                client.disconnect();
                return;
            }
            for await (const event of client.subscribe(from)) {
                if (stopped) break;
                if (event.type === 'turn-start') {
                    const at = (event as unknown as { at?: unknown }).at;
                    record.turnStartedAt = typeof at === 'number' ? at : Date.now();
                }
                reduceFeedEvent(transcript, event);
            }
        } catch (e) {
            if (!stopped) onError(e instanceof Error ? e : new Error(String(e)));
        }
    })();
    return {
        sessionId,
        agentId,
        transcript,
        get taskId() {
            return record.taskId;
        },
        get turnStartedAt() {
            return record.turnStartedAt;
        },
        client: () => client,
        disconnect() {
            stopped = true;
            client?.disconnect();
        }
    };
}
