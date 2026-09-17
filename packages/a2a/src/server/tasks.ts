/**
 * A live task: one `AgentSession` turn seen as an A2A task. The turn's events
 * are mapped onto A2A stream responses (text parts → artifact chunks, a
 * `request` → INPUT_REQUIRED, everything else → a WORKING status carrying the
 * event as a data part), folded into the task snapshot, and fanned out to the
 * streams that watch it. The task id IS the turn id.
 */

import { AgentError, SessionBusyError, type AgentEvent, type AgentSession, type Decision, type RequestKind } from '@sigx/ai-agent';
import type { A2aArtifact, A2aMessage, A2aTask, A2aTaskStatus, StreamResponse, TaskState } from '../protocol/index.js';
import { A2A_ERROR, A2aError, eventPart, isInterruptedState, isTerminalState, partsText, readDecisionPart, toPromptParts } from '../protocol/index.js';
import { deferred, isoTime, newId, type Deferred } from '../utils.js';
import type { TaskStore } from './ports.js';

export interface LiveTaskOptions {
    readonly session: AgentSession;
    readonly agentId: string;
    readonly contextId: string;
    readonly taskId: string;
    readonly message: A2aMessage;
    readonly store: TaskStore;
    readonly now: () => number;
}

export interface LiveTask {
    readonly id: string;
    readonly contextId: string;
    readonly agentId: string;
    readonly session: AgentSession;
    /** The current snapshot, history and artifacts included. */
    readonly task: A2aTask;
    readonly updatedAt: number;
    /** The open request while the task is INPUT_REQUIRED. */
    readonly pending: { readonly requestId: string; readonly kind: RequestKind } | undefined;
    /** Every stream response from now on; returns unsubscribe. */
    subscribe(listener: (response: StreamResponse) => void): () => void;
    /** Resolves when the task is next interrupted or terminal. */
    settled(): Promise<void>;
    /** Resolves once the task is terminal. */
    readonly done: Promise<void>;
    /** Answer the open request with the client's follow-up message. */
    continue(message: A2aMessage): Promise<void>;
}

const STOP_TO_STATE: Record<string, TaskState> = {
    end_turn: 'TASK_STATE_COMPLETED',
    max_tokens: 'TASK_STATE_COMPLETED',
    max_turns: 'TASK_STATE_COMPLETED',
    refusal: 'TASK_STATE_REJECTED',
    cancelled: 'TASK_STATE_CANCELED',
    error: 'TASK_STATE_FAILED'
};

/** Events that travel as data parts on a WORKING status; the rest are mapped natively or are session bookkeeping. */
const CARRIED: ReadonlySet<AgentEvent['type']> = new Set<AgentEvent['type']>(['tool-call', 'tool-input-delta', 'tool-update', 'agent-start', 'agent-update', 'ext', 'usage', 'error', 'request-resolved']);

/** Strip the stamp and the turn context: what the other end folds into its own log. */
function payloadOf(e: AgentEvent): { readonly type: string } & Record<string, unknown> {
    const { sessionId: _s, epoch: _e, seq: _q, turnId: _t, parentCallId: _p, ...payload } = e;
    return payload;
}

/** The turn could not start: a busy or closed session, an unsupported prompt. Never a 500. */
function startError(e: unknown): A2aError {
    if (e instanceof SessionBusyError) return new A2aError(A2A_ERROR.unsupportedOperation, `Context is busy with task "${e.turnId}"; wait for it to finish or cancel it`);
    if (e instanceof AgentError) return new A2aError(A2A_ERROR.unsupportedOperation, e.message);
    return new A2aError(A2A_ERROR.internal, e instanceof Error ? e.message : String(e));
}

export async function startLiveTask(o: LiveTaskOptions): Promise<LiveTask> {
    const { session, agentId, contextId, taskId, store, now } = o;
    const turn = session.prompt(toPromptParts(o.message.parts), { turnId: taskId });
    const iterator = turn[Symbol.asyncIterator]();
    // The first event (`turn-start`) is in the buffer at once for a turn that
    // started; a turn that could not start throws here, before any record exists.
    let first: IteratorResult<AgentEvent>;
    try {
        first = await iterator.next();
    } catch (e) {
        throw startError(e);
    }

    const listeners = new Set<(response: StreamResponse) => void>();
    const artifacts = new Map<string, { text: string; kind: string; complete?: true }>();
    const history: A2aMessage[] = [{ ...o.message, contextId, taskId }];
    let status: A2aTaskStatus = { state: 'TASK_STATE_SUBMITTED', timestamp: isoTime(now()) };
    let updatedAt = now();
    let pending: LiveTask['pending'];
    let settle: Deferred<void> = deferred();
    const done = deferred<void>();

    const snapshot = (): A2aTask => ({
        id: taskId,
        contextId,
        status,
        // `complete` lets a client that joins mid-turn close a part whose last chunk it never saw.
        artifacts: [...artifacts.entries()].map(([artifactId, a]): A2aArtifact => ({ artifactId, parts: [{ text: a.text }], metadata: { kind: a.kind, ...(a.complete ? { complete: true } : {}) } })),
        history: [...history]
    });
    const persist = () => {
        updatedAt = now();
        void Promise.resolve(store.put({ agentId, task: snapshot(), updatedAt })).catch(() => {});
    };
    const publish = (response: StreamResponse) => {
        for (const l of listeners) l(response);
    };
    const setStatus = (next: A2aTaskStatus) => {
        status = { ...next, timestamp: isoTime(now()) };
        persist();
        publish({ statusUpdate: { taskId, contextId, status } });
        if (isInterruptedState(status.state) || isTerminalState(status.state)) {
            settle.resolve();
            if (isTerminalState(status.state)) done.resolve();
        }
    };
    const working = (parts: A2aMessage['parts']) => setStatus({ state: 'TASK_STATE_WORKING', message: { messageId: newId('msg'), role: 'ROLE_AGENT', contextId, taskId, parts } });

    const apply = (e: AgentEvent) => {
        // A sub-agent's nested events stay on this side: the card promises no sub-agent visibility.
        if (e.parentCallId !== undefined) return;
        switch (e.type) {
            case 'turn-start':
                setStatus({ state: 'TASK_STATE_WORKING' });
                return;
            case 'part-start': {
                artifacts.set(e.partId, { text: '', kind: e.kind });
                persist();
                publish({ artifactUpdate: { taskId, contextId, artifact: { artifactId: e.partId, parts: [{ text: '' }], metadata: { kind: e.kind, messageId: e.messageId } }, append: false } });
                return;
            }
            case 'part-delta': {
                const a = artifacts.get(e.partId);
                if (a) a.text += e.delta;
                else artifacts.set(e.partId, { text: e.delta, kind: 'text' });
                publish({ artifactUpdate: { taskId, contextId, artifact: { artifactId: e.partId, parts: [{ text: e.delta }] }, append: true } });
                return;
            }
            case 'part-end': {
                const a = artifacts.get(e.partId);
                if (a) a.complete = true;
                persist();
                publish({ artifactUpdate: { taskId, contextId, artifact: { artifactId: e.partId, parts: [{ text: '' }] }, append: true, lastChunk: true } });
                return;
            }
            case 'request': {
                pending = { requestId: e.requestId, kind: e.kind };
                const message: A2aMessage = {
                    messageId: newId('msg'),
                    role: 'ROLE_AGENT',
                    contextId,
                    taskId,
                    parts: [...(e.message ? [{ text: e.message }] : []), eventPart(payloadOf(e))]
                };
                history.push(message);
                setStatus({ state: 'TASK_STATE_INPUT_REQUIRED', message });
                return;
            }
            case 'turn-end': {
                const text = [...artifacts.values()]
                    .filter((a) => a.kind === 'text')
                    .map((a) => a.text)
                    .join('');
                if (text) history.push({ messageId: newId('msg'), role: 'ROLE_AGENT', contextId, taskId, parts: [{ text }] });
                setStatus({ state: STOP_TO_STATE[e.stopReason] ?? 'TASK_STATE_COMPLETED', message: { messageId: newId('msg'), role: 'ROLE_AGENT', contextId, taskId, parts: [eventPart(payloadOf(e))] } });
                return;
            }
            default:
                if (CARRIED.has(e.type)) working([eventPart(payloadOf(e))]);
        }
    };

    persist();
    void (async () => {
        try {
            if (!first.done) apply(first.value);
            for (;;) {
                const next = await iterator.next();
                if (next.done) break;
                apply(next.value);
            }
        } catch (e) {
            if (!isTerminalState(status.state)) {
                const message = e instanceof Error ? e.message : String(e);
                setStatus({ state: 'TASK_STATE_FAILED', message: { messageId: newId('msg'), role: 'ROLE_AGENT', contextId, taskId, parts: [eventPart({ type: 'turn-end', stopReason: 'error', error: { code: 'protocol_error', message } })] } });
            }
        }
        // A turn that ended without a terminal state (the log closed under it) is failed, never left hanging.
        if (!isTerminalState(status.state)) setStatus({ state: 'TASK_STATE_FAILED' });
    })();

    const live: LiveTask = {
        id: taskId,
        contextId,
        agentId,
        session,
        get task() {
            return snapshot();
        },
        get updatedAt() {
            return updatedAt;
        },
        get pending() {
            return pending;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        settled: () => settle.promise,
        done: done.promise,
        async continue(message) {
            if (isTerminalState(status.state)) throw new A2aError(A2A_ERROR.unsupportedOperation, `Task "${taskId}" is ${status.state}; it accepts no further messages`);
            if (!pending) throw new A2aError(A2A_ERROR.unsupportedOperation, `Task "${taskId}" is ${status.state} and awaits no input`);
            const { requestId, kind } = pending;
            pending = undefined;
            settle = deferred();
            history.push({ ...message, contextId, taskId });
            // The answer is in: the task works again, before the harness has read it.
            setStatus({ state: 'TASK_STATE_WORKING' });
            await session.respond(requestId, decisionOf(message, kind));
        }
    };
    return live;
}

/** The decision a follow-up message carries: an explicit decision part, else its plain content read for the request's kind. */
function decisionOf(message: A2aMessage, kind: RequestKind): Decision {
    for (const p of message.parts) {
        const d = readDecisionPart(p);
        if (d) return d;
    }
    const data = message.parts.find((p) => p.data !== undefined && p.mediaType === undefined);
    const text = partsText(message.parts);
    if (kind === 'input') return { type: 'input', answers: data ? data.data : text };
    return /^\s*(y|yes|allow|ok|approve)\b/i.test(text) ? { type: 'permission', outcome: 'allow', scope: 'once' } : { type: 'permission', outcome: 'deny', scope: 'once', ...(text ? { message: text } : {}) };
}
