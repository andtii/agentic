/**
 * One A2A context as an `AgentSession` over the platform (#245). The A2A
 * server (`createA2aHandler`) runs a task as a turn of a live session; here a
 * turn is a platform TASK: `prompt` creates it through the external client's
 * port (`Task.create` as the client, `Routing.run` as the workspace — so the
 * runtime gate, the approval policy and the audit apply as for any task), then
 * follows the Session the router opened and hands its turn's events back.
 *
 * - The task's objective is the message's text; earlier exchanges of the same
 *   context in this isolate travel as the task's context, so a follow-up reads
 *   in the conversation it belongs to.
 * - A task that fails before a session opens (the runtime turned off, no key,
 *   no environment) still yields a turn: `turn-start`, then a `turn-end` with
 *   `stopReason: 'error'` naming the platform's code — a FAILED A2A task, not a
 *   JSON-RPC error.
 * - `respond` answers the session's open request; `cancel` cancels the task.
 */
import { isTerminal, type AgentId, type PromptPart as CorePromptPart, type SessionId, type TaskId } from '@agentic/core';
import type { PlatformPort, RespondDecision, TaskSummary } from '@agentic/mcp';
import { AgentError, SessionBusyError, toPromptParts, type AgentEvent, type AgentSession, type AgentTurn, type Decision, type EventCursor, type PromptInput, type PromptOptions, type TurnResult } from '@sigx/ai-agent';

export interface PlatformA2aSessionOptions {
    /** The external client's port (`createActorPlatformPort`) — tasks and sessions only. */
    readonly platform: Pick<PlatformPort, 'tasks' | 'sessions'>;
    readonly agentId: AgentId;
    readonly contextId: string;
    /** How often the session log is read while a turn runs. Default 250 ms. */
    readonly pollMs?: number;
    /** How many earlier exchanges of this context go into the next task's context. Default 6. */
    readonly historyTurns?: number;
    readonly sleep?: (ms: number) => Promise<void>;
}

const PAGE = 200;
/** How many empty polls pass between task reads — the task says when a turn will never end in the log. */
const TASK_EVERY = 4;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The prompt's text — the task's objective. Non-text parts are not carried (the card offers text only). */
function textOf(input: PromptInput): string {
    return toPromptParts(input)
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .trim();
}

/** The `turn-end` a task that left the log without one ends with. */
function endOf(t: TaskSummary): Pick<Extract<AgentEvent, { type: 'turn-end' }>, 'stopReason' | 'error'> {
    if (t.status === 'cancelled') return { stopReason: 'cancelled' };
    if (t.status === 'failed') return { stopReason: 'error', error: { code: 'protocol_error', message: t.error ? `${t.error.code}: ${t.error.message}` : 'the task failed' } };
    return { stopReason: 'end_turn' };
}

export function platformA2aSession(options: PlatformA2aSessionOptions): AgentSession {
    const { platform, agentId, contextId } = options;
    const pollMs = options.pollMs ?? 250;
    const keep = options.historyTurns ?? 6;
    const sleep = options.sleep ?? defaultSleep;
    const id = `a2a:${contextId}`;
    const history: { user: string; agent: string }[] = [];
    /** The context's turn in flight, or the last one (`done`). */
    let current: { readonly turnId: string; readonly taskId?: TaskId; readonly sessionId?: SessionId; readonly done?: boolean } | undefined;
    let closed = false;

    const context = (): CorePromptPart[] =>
        history.length === 0
            ? []
            : [
                  {
                      type: 'text',
                      text: `Earlier in this A2A conversation (context ${contextId}):\n${history
                          .slice(-keep)
                          .map((h) => `Client: ${h.user}\nYou: ${h.agent}`)
                          .join('\n\n')}`
                  }
              ];

    async function* run(turnId: string, text: string): AsyncGenerator<AgentEvent> {
        let seq = 0;
        const stamp = <E extends object>(payload: E) => ({ ...payload, turnId, sessionId: id, epoch: 0, seq: seq++ }) as unknown as AgentEvent;
        const created = await platform.tasks.create({ agentId, objective: text, context: context() });
        current = { turnId, taskId: created.taskId };
        let t = created;
        while (!t.sessionId && !isTerminal(t.status)) {
            await sleep(pollMs);
            t = await platform.tasks.get(t.taskId);
        }
        if (!t.sessionId) {
            yield stamp({ type: 'turn-start', input: [{ type: 'text', text }] });
            yield stamp({ type: 'turn-end', ...endOf(t) });
            return;
        }
        const sessionId = t.sessionId;
        current = { turnId, taskId: t.taskId, sessionId };
        let answer = '';
        let cursor: EventCursor | undefined;
        let runTurn: string | undefined;
        let quiet = 0;
        let drained = false;
        for (;;) {
            const page = await platform.sessions.tail(sessionId, cursor, PAGE);
            for (const raw of page.events) {
                const e = raw as AgentEvent;
                // The task's own turn: the first to start in its session (the router prompts once).
                if (runTurn === undefined) {
                    if (e.type !== 'turn-start') continue;
                    runTurn = e.turnId;
                }
                if (e.turnId !== runTurn) continue;
                if (e.type === 'part-delta' && e.parentCallId === undefined) answer += e.delta;
                yield e;
                if (e.type === 'turn-end') {
                    history.push({ user: text, agent: answer.trim() });
                    return;
                }
            }
            cursor = page.next;
            if (page.truncated) continue;
            if (page.events.length === 0 && ++quiet % TASK_EVERY === 0) {
                // A task that ended with no turn-end in the log (cancelled before its prompt, failed on the way) ends the turn here.
                const now = await platform.tasks.get(t.taskId);
                if (isTerminal(now.status)) {
                    if (!drained) {
                        drained = true; // one more read: the log may have caught up with the task
                        continue;
                    }
                    if (runTurn === undefined) yield stamp({ type: 'turn-start', input: [{ type: 'text', text }] });
                    yield stamp({ type: 'turn-end', ...endOf(now) });
                    history.push({ user: text, agent: answer.trim() });
                    return;
                }
            }
            await sleep(pollMs);
        }
    }

    const session: AgentSession = {
        id,
        ref: { agent: 'agentic-a2a', v: 1, id },
        prompt(input: PromptInput, promptOptions?: PromptOptions): AgentTurn {
            const turnId = promptOptions?.turnId ?? `turn_${crypto.randomUUID()}`;
            let resolve!: (r: TurnResult) => void;
            let reject!: (e: unknown) => void;
            const result = new Promise<TurnResult>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            // Nobody has to await `result`; a turn that could not start still rejects it.
            result.catch(() => {});
            const start = (): AsyncGenerator<AgentEvent> => {
                if (closed) throw new AgentError('protocol_error', `context "${contextId}" is closed`);
                if (current && !current.done) throw new SessionBusyError(id, current.turnId);
                const text = textOf(input);
                if (!text) throw new AgentError('protocol_error', 'the message carries no text');
                current = { turnId };
                return run(turnId, text);
            };
            return {
                id: turnId,
                result,
                async *[Symbol.asyncIterator]() {
                    let events: AsyncGenerator<AgentEvent>;
                    try {
                        events = start();
                    } catch (e) {
                        reject(e);
                        throw e;
                    }
                    let ended = false;
                    try {
                        for await (const e of events) {
                            if (e.type === 'turn-end') {
                                ended = true;
                                resolve({ turnId, stopReason: e.stopReason, ...(e.usage ? { usage: e.usage } : {}), ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}), ...(e.error ? { error: e.error } : {}) });
                            }
                            yield e;
                        }
                    } catch (e) {
                        // The task could not be created (unknown agent, a scope the grant lacks): the turn never started.
                        const error = e instanceof AgentError ? e : new AgentError('protocol_error', e instanceof Error ? e.message : String(e));
                        reject(error);
                        throw error;
                    } finally {
                        if (current?.turnId === turnId) current = { ...current, done: true };
                        if (!ended) reject(new AgentError('protocol_error', 'the turn ended without a turn-end'));
                    }
                }
            };
        },
        async respond(requestId: string, decision: Decision): Promise<void> {
            const sessionId = current?.sessionId;
            if (!sessionId) return;
            // Withdrawing the question ends the task's turn: the A2A client cancelled rather than answered.
            if (decision.type === 'cancel') return session.cancel();
            const answer: RespondDecision = decision.type === 'permission' ? { type: 'permission', outcome: decision.outcome, scope: decision.scope, ...(decision.message !== undefined ? { message: decision.message } : {}) } : { type: 'input', answers: decision.answers };
            const r = await platform.sessions.respond(sessionId, requestId, answer);
            if (r.kind === 'error') throw new AgentError('protocol_error', `${r.code ?? 'error'}: ${r.message ?? 'the answer was refused'}`);
        },
        async cancel(): Promise<void> {
            const taskId = current && !current.done ? current.taskId : undefined;
            if (taskId) await platform.tasks.cancel(taskId);
        },
        subscribe(): AsyncIterable<AgentEvent> {
            throw new AgentError('protocol_error', 'an A2A context is followed per task, not subscribed to');
        },
        async close(): Promise<void> {
            closed = true;
        }
    };
    return session;
}
