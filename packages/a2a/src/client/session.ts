/**
 * One A2A context as an `AgentSession`: every `prompt()` is a task
 * (`SendStreamingMessage`, or `SendMessage` + `GetTask` polling when the card
 * declares no streaming); artifact chunks become text parts, `INPUT_REQUIRED`
 * becomes a `request` answered with a follow-up message, terminal states end
 * the turn, `cancel()` is `CancelTask`.
 */

import { AgentError, createEventLog, createSessionCore, toPromptParts as promptPartsOf } from '@sigx/ai-agent';
import type { AgentSession, PolicyRequest, PromptInput, PromptOptions, SessionOptions, SessionRef, ToolStatus, TurnDriver, TurnEndInit, UnstampedEvent } from '@sigx/ai-agent';
import type { Usage } from '@sigx/ai';
import type { A2aArtifact, A2aMessage, A2aPart, A2aTask, A2aTaskStatus, AgentCard, SendMessageResponse, StreamResponse } from '../protocol/index.js';
import { A2A_METHODS, A2aError, decisionPart, isInterruptedState, isTerminalState, readEventPart, toA2aParts } from '../protocol/index.js';
import { isAbort, newId, sleep } from '../utils.js';
import type { A2aRpcClient } from './transport.js';

export interface A2aSessionOptions extends SessionOptions {
    /** Continue an existing context; otherwise the server assigns one on the first task. */
    readonly contextId?: string;
    /** `GetTask` interval when the card declares no streaming. Default 500. */
    readonly pollMs?: number;
}

export interface OpenA2aSessionOptions {
    readonly rpc: A2aRpcClient;
    readonly card: AgentCard;
    readonly agentId: string;
    readonly tenant?: string;
    readonly sessionOptions: A2aSessionOptions;
}

/** Events a WORKING status may carry that are re-emitted as they are (the rest is A2A's own business, or ours to derive). */
const PASSED: ReadonlySet<string> = new Set(['tool-call', 'tool-update', 'ext', 'usage', 'error']);

const STATE_TO_STOP: Record<string, TurnEndInit['stopReason']> = {
    TASK_STATE_COMPLETED: 'end_turn',
    TASK_STATE_FAILED: 'error',
    TASK_STATE_CANCELED: 'cancelled',
    TASK_STATE_REJECTED: 'refusal'
};

const TERMINAL_TOOL: ReadonlySet<ToolStatus> = new Set(['completed', 'failed', 'cancelled', 'denied']);

type Outcome = { readonly kind: 'end'; readonly init: TurnEndInit } | { readonly kind: 'request'; readonly request: PolicyRequest };

/** What one turn accumulates while it maps a task. */
class TurnMapper {
    taskId: string | undefined;
    contextId: string | undefined;
    private readonly parts = new Map<string, string>();
    private readonly calls = new Map<string, ToolStatus>();
    /** Characters of each artifact's current content already emitted. */
    private readonly emitted = new Map<string, number>();
    /** Artifacts whose last chunk is out. */
    private readonly closed = new Set<string>();
    private partSeq = 0;
    private usage: Usage | undefined;
    private errored = false;
    private readonly messageId: string;

    constructor(
        private readonly driver: TurnDriver,
        private readonly aborted: () => boolean
    ) {
        this.messageId = `a:${driver.turnId}`;
    }

    private emit(e: UnstampedEvent) {
        if (!this.driver.ended) this.driver.emit(e);
    }

    private openPart(artifactId: string, kind: 'text' | 'reasoning'): string {
        let partId = this.parts.get(artifactId);
        if (partId === undefined) {
            partId = `${this.messageId}:${this.partSeq++}`;
            this.parts.set(artifactId, partId);
            this.emit({ type: 'part-start', messageId: this.messageId, partId, kind });
        }
        return partId;
    }

    private closePart(artifactId: string) {
        const partId = this.parts.get(artifactId);
        if (partId === undefined) return;
        this.parts.delete(artifactId);
        this.emit({ type: 'part-end', partId });
    }

    /** Text parts of a message that is not an artifact (a status message, a direct reply): one text part. */
    text(parts: readonly A2aPart[], id = newId('msg')) {
        const text = parts.map((p) => p.text ?? '').join('');
        if (!text) return;
        const partId = this.openPart(id, 'text');
        this.emit({ type: 'part-delta', partId, delta: text });
        this.closePart(id);
    }

    artifact(artifact: A2aArtifact, append: boolean | undefined, lastChunk: boolean | undefined) {
        const id = artifact.artifactId;
        const kind = artifact.metadata?.kind === 'reasoning' ? 'reasoning' : 'text';
        if (!append) {
            // A fresh (or replacing) artifact starts a new part.
            if (this.parts.has(id)) this.closePart(id);
            this.emitted.set(id, 0);
            this.closed.delete(id);
        }
        const partId = this.openPart(id, kind);
        const text = artifact.parts.map((p) => p.text ?? '').join('');
        if (text) {
            this.emit({ type: 'part-delta', partId, delta: text });
            this.emitted.set(id, (this.emitted.get(id) ?? 0) + text.length);
        }
        if (lastChunk) {
            this.closePart(id);
            this.closed.add(id);
        }
    }

    /**
     * An artifact as a snapshot holds it — its whole content so far: emit what
     * was not emitted yet, keep the part open until the artifact is complete.
     */
    private snapshotArtifact(artifact: A2aArtifact, complete: boolean) {
        const id = artifact.artifactId;
        if (this.closed.has(id)) return;
        const text = artifact.parts.map((p) => p.text ?? '').join('');
        const already = this.emitted.get(id) ?? 0;
        if (text.length > already) {
            const partId = this.openPart(id, artifact.metadata?.kind === 'reasoning' ? 'reasoning' : 'text');
            this.emit({ type: 'part-delta', partId, delta: text.slice(already) });
            this.emitted.set(id, text.length);
        }
        if (complete) {
            this.closePart(id);
            this.closed.add(id);
        }
    }

    /**
     * A whole task snapshot (a stream's first frame, a blocking reply, a poll):
     * what its artifacts gained, then its status. An artifact is complete once
     * the task stopped or the server marks it (`metadata.complete`). `skipInterrupted`
     * reads a continuation stream's opening snapshot, which still shows the
     * request that was just answered — not a new one.
     */
    snapshot(task: A2aTask, skipInterrupted = false): Outcome | undefined {
        this.taskId = task.id;
        if (task.contextId) this.contextId = task.contextId;
        const stopped = isTerminalState(task.status.state) || isInterruptedState(task.status.state);
        for (const a of task.artifacts ?? []) this.snapshotArtifact(a, stopped || a.metadata?.complete === true);
        if (skipInterrupted && isInterruptedState(task.status.state)) return undefined;
        return this.status(task.status);
    }

    /** Events carried by a status message, re-emitted; the rest of the message as text. */
    private carried(message: A2aMessage | undefined) {
        if (!message) return;
        const plain: A2aPart[] = [];
        for (const p of message.parts) {
            const e = readEventPart(p);
            if (!e) {
                if (p.mediaType === undefined || p.text !== undefined) plain.push(p);
                continue;
            }
            if (!PASSED.has(e.type)) continue;
            const { type, ...rest } = e;
            if (type === 'tool-call' && typeof rest.callId === 'string') this.calls.set(rest.callId, 'pending');
            if (type === 'tool-update' && typeof rest.callId === 'string') {
                if (!this.calls.has(rest.callId)) continue;
                this.calls.set(rest.callId, rest.status as ToolStatus);
            }
            if (type === 'usage' && typeof rest.usage === 'object' && rest.usage !== null) this.usage = rest.usage as Usage;
            if (type === 'error') this.errored = true;
            this.emit({ type, ...rest } as UnstampedEvent);
        }
        this.text(plain, message.messageId);
    }

    status(status: A2aTaskStatus): Outcome | undefined {
        const { state, message } = status;
        if (isTerminalState(state)) {
            const result = message?.parts.map(readEventPart).find((e) => e?.type === 'turn-end');
            // A final text in the status message (no artifacts) is the reply.
            if (!result) this.carried(message);
            const stopReason = STATE_TO_STOP[state] ?? 'end_turn';
            const init: TurnEndInit = {
                stopReason,
                ...(this.usage ? { usage: this.usage } : {}),
                ...(result && typeof result.usage === 'object' && result.usage !== null ? { usage: result.usage as Usage } : {}),
                ...(result && typeof result.costUsd === 'number' ? { costUsd: result.costUsd } : {}),
                ...(result && result.output !== undefined ? { output: result.output } : {}),
                ...(result && typeof result.error === 'object' && result.error !== null ? { error: result.error as TurnEndInit['error'] } : {})
            };
            if (stopReason === 'error' && !init.error) {
                const text = message?.parts.map((p) => p.text ?? '').join('') || `the task ended ${state}`;
                return { kind: 'end', init: { ...init, error: { code: 'provider_error', message: text } } };
            }
            return { kind: 'end', init };
        }
        if (state === 'TASK_STATE_INPUT_REQUIRED') {
            const carried = message?.parts.map(readEventPart).find((e) => e?.type === 'request');
            const text = message?.parts.map((p) => p.text ?? '').join('') ?? '';
            if (carried) {
                const { type: _t, requestId: _r, ...rest } = carried;
                return { kind: 'request', request: { source: 'native', ...(rest as Omit<PolicyRequest, 'source'>), kind: rest.kind === 'permission' ? 'permission' : 'input' } };
            }
            return { kind: 'request', request: { kind: 'input', source: 'native', ...(text ? { message: text } : {}) } };
        }
        if (state === 'TASK_STATE_AUTH_REQUIRED') {
            const text = message?.parts.map((p) => p.text ?? '').join('') || 'the agent requires authentication to proceed';
            this.emit({ type: 'error', code: 'auth_required', message: text, recoverable: true });
            this.errored = true;
            return { kind: 'end', init: { stopReason: 'error', error: { code: 'auth_required', message: text } } };
        }
        this.carried(message);
        return undefined;
    }

    apply(r: StreamResponse, opening = false): Outcome | undefined {
        if ('task' in r) return this.snapshot(r.task, opening && this.taskId === r.task.id);
        if ('message' in r) {
            if (r.message.contextId) this.contextId = r.message.contextId;
            this.text(r.message.parts, r.message.messageId);
            return { kind: 'end', init: { stopReason: 'end_turn', ...(this.usage ? { usage: this.usage } : {}) } };
        }
        if ('artifactUpdate' in r) {
            this.artifact(r.artifactUpdate.artifact, r.artifactUpdate.append, r.artifactUpdate.lastChunk);
            return undefined;
        }
        return this.status(r.statusUpdate.status);
    }

    fail(e: unknown): TurnEndInit {
        const code = e instanceof AgentError ? e.code : e instanceof A2aError && /UNAUTHENTICATED/.test(JSON.stringify(e.data ?? '')) ? 'auth_required' : 'provider_error';
        const message = e instanceof Error ? e.message : String(e);
        if (!this.errored) this.emit({ type: 'error', code, message, recoverable: code === 'auth_required' });
        return { stopReason: 'error', error: { code, message } };
    }

    /** Close what is still open, then end the turn. */
    finish(init: TurnEndInit) {
        for (const id of Array.from(this.parts.keys())) this.closePart(id);
        for (const [callId, status] of this.calls) {
            if (!TERMINAL_TOOL.has(status)) this.emit({ type: 'tool-update', callId, status: this.aborted() || init.stopReason === 'cancelled' ? 'cancelled' : 'failed' });
        }
        this.calls.clear();
        this.driver.end(init);
    }
}

export function openA2aSession(o: OpenA2aSessionOptions): AgentSession {
    const { rpc, card, agentId, sessionOptions } = o;
    if (sessionOptions.resume) throw new AgentError('protocol_error', `[agentic a2a] agent "${agentId}" cannot resume sessions (resume: false)`);
    const sessionId = sessionOptions.contextId ?? newId('a2a');
    let contextId: string | undefined = sessionOptions.contextId;
    const streaming = card.capabilities?.streaming === true;
    const pollMs = sessionOptions.pollMs ?? 500;
    const tenant = o.tenant !== undefined ? { tenant: o.tenant } : {};
    const log = createEventLog({ sessionId });
    const core = createSessionCore({
        id: sessionId,
        log,
        ...(sessionOptions.policy ? { policy: sessionOptions.policy } : {}),
        interactive: sessionOptions.interactive ?? true,
        ...(sessionOptions.requestTimeoutMs !== undefined ? { requestTimeoutMs: sessionOptions.requestTimeoutMs } : {}),
        ...(sessionOptions.signal ? { signal: sessionOptions.signal } : {}),
        steer: false,
        subagents: 'none'
    });

    const ref = (): SessionRef => ({ agent: agentId, v: 1, id: sessionId, ...(contextId ? { data: { contextId } } : {}) });

    const session: AgentSession = {
        id: sessionId,
        get ref() {
            return ref();
        },
        prompt(input: PromptInput, promptOptions?: PromptOptions) {
            return core.startTurn(input, promptOptions, async (driver, ctx) => {
                if (ctx.options.output) throw new AgentError('protocol_error', `[agentic a2a] agent "${agentId}" cannot produce structured output (structuredOutput: false)`);
                const parts = promptPartsOf(input);
                driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                const mapper = new TurnMapper(driver, () => driver.signal.aborted);
                const abort = new AbortController();
                let cancelSent = false;
                const cancel = () => {
                    abort.abort();
                    if (cancelSent || !mapper.taskId) return;
                    cancelSent = true;
                    void rpc.call(A2A_METHODS.cancelTask, { ...tenant, id: mapper.taskId }).catch(() => {});
                };
                if (driver.signal.aborted) cancel();
                else driver.signal.addEventListener('abort', cancel, { once: true });

                const run = async (message: A2aMessage): Promise<Outcome> => {
                    if (streaming) {
                        let opening = true;
                        for await (const r of rpc.stream(A2A_METHODS.sendStreamingMessage, { ...tenant, message }, abort.signal)) {
                            const outcome = mapper.apply(r, opening);
                            opening = false;
                            if (outcome) return outcome;
                        }
                    } else {
                        const res = await rpc.call<SendMessageResponse>(A2A_METHODS.sendMessage, { ...tenant, message, configuration: { returnImmediately: false } }, abort.signal);
                        const outcome = mapper.apply(res);
                        if (outcome) return outcome;
                    }
                    // The stream ended (or the reply came back) with the task still open: poll it to its next stop.
                    if (!mapper.taskId) throw new AgentError('protocol_error', `[agentic a2a] the agent ended the stream without a task or a message`);
                    for (;;) {
                        await sleep(pollMs, abort.signal);
                        const task = await rpc.call<A2aTask>(A2A_METHODS.getTask, { ...tenant, id: mapper.taskId }, abort.signal);
                        const outcome = mapper.snapshot(task);
                        if (outcome) return outcome;
                        if (isInterruptedState(task.status.state) || isTerminalState(task.status.state)) return { kind: 'end', init: { stopReason: 'end_turn' } };
                    }
                };

                try {
                    let message: A2aMessage = { messageId: newId('msg'), role: 'ROLE_USER', parts: toA2aParts(parts), ...(contextId ? { contextId } : {}) };
                    for (;;) {
                        const outcome = await run(message);
                        if (mapper.contextId) contextId = mapper.contextId;
                        if (outcome.kind === 'end') {
                            mapper.finish(outcome.init);
                            return;
                        }
                        const resolved = await ctx.resolve(outcome.request);
                        const d = resolved.decision;
                        if (d.type === 'cancel') {
                            cancel();
                            mapper.finish({ stopReason: 'cancelled' });
                            return;
                        }
                        // The decision for an agentic server; a plain rendering for any other.
                        const plain: A2aPart[] = d.type === 'input' ? (typeof d.answers === 'string' ? [{ text: d.answers }] : [{ data: d.answers ?? null }]) : [{ text: d.outcome === 'allow' ? 'allow' : `deny${d.message ? `: ${d.message}` : ''}` }];
                        message = { messageId: newId('msg'), role: 'ROLE_USER', taskId: mapper.taskId!, ...(contextId ? { contextId } : {}), parts: [decisionPart(d), ...plain] };
                    }
                } catch (e) {
                    if (driver.signal.aborted || isAbort(e)) {
                        mapper.finish({ stopReason: 'cancelled' });
                        return;
                    }
                    mapper.finish(mapper.fail(e));
                } finally {
                    driver.signal.removeEventListener('abort', cancel);
                }
            });
        },
        respond: (requestId, decision) => core.respond(requestId, decision),
        cancel: (target) => core.cancel(target),
        subscribe: (from) => core.subscribe(from),
        close: () => core.close()
    };
    return session;
}
