/**
 * `copilotCli` — GitHub Copilot CLI as an `@sigx/ai-agent` `Agent` (#319), over `@github/copilot-sdk`.
 *
 * One Copilot session per agent session, on the environment's client (one runtime process per
 * profile, owned by the driver). What the adapter maps:
 * - `assistant.message_delta` / `assistant.message` → text parts; `assistant.reasoning_delta` /
 *   `assistant.reasoning` → reasoning parts;
 * - `tool.execution_start` / `tool.execution_complete` → `tool-call` / `tool-update`;
 * - Copilot's permission requests (shell, write, read, url, mcp, …) → the platform policy through
 *   `ctx.resolve` (`source: 'native'`, or `'mcp'`); a client tool (platform tools, connectors) runs in
 *   this process and is ruled on inside its handler (`source: 'client'`), so Copilot is not asked;
 * - `ask_user` → an `input` request; `assistant.usage` → `usage`; `session.error` → `error`;
 *   `session.idle` ends the turn; cancel is `session.abort()`.
 *
 * Copilot decides which native calls to ask about (reads inside the folder run unasked), so
 * permissions are `harness-filtered`. Sub-agent events (`parentToolCallId`) are not surfaced.
 */

import type { AnyTool, Usage } from '@sigx/ai';
import {
    capabilities,
    createEventLog,
    createSessionCore,
    partsText,
    toPromptParts,
    type Agent,
    type AgentCapabilities,
    type AgentErrorCode,
    type AgentSession,
    type PolicyRequest,
    type SessionOptions,
    type SessionRef,
    type TurnContext,
    type TurnDriver
} from '@sigx/ai-agent';
import { categoryOf } from '@sigx/ai-agent/coding';
import type {
    CopilotClientLike,
    CopilotError,
    CopilotEvent,
    CopilotMessage,
    CopilotMessageDelta,
    CopilotPermissionRequest,
    CopilotPermissionResult,
    CopilotReasoningDelta,
    CopilotSessionConfig,
    CopilotSessionLike,
    CopilotTitleChanged,
    CopilotTool,
    CopilotToolComplete,
    CopilotToolStart,
    CopilotUsage,
    CopilotUserInputRequest,
    CopilotUserInputResponse
} from './sdk.js';

export const COPILOT_CLI_AGENT_ID = 'copilot-cli';

export const COPILOT_CLI_CAPABILITIES: AgentCapabilities = capabilities({
    resume: 'local',
    cancel: true,
    promptParts: 'text',
    tools: 'native',
    permissions: 'harness-filtered'
});

export interface CopilotCliOptions {
    /** For logs; default `copilot-cli`. */
    readonly id?: string;
    /** The environment's client, started — the driver owns its lifetime. */
    readonly client: () => Promise<CopilotClientLike>;
    /** How long an aborted turn waits for Copilot's `session.idle` before it is ended anyway. Default 5 s. */
    readonly abortGraceMs?: number;
}

export interface CopilotSessionOptions extends SessionOptions {
    /** The folder the session works in. */
    readonly cwd: string;
}

interface RunningTurn {
    readonly driver: TurnDriver;
    readonly ctx: TurnContext;
    /** Text / reasoning parts still open, by part id. */
    readonly open: Set<string>;
    /** Calls the platform policy denied — their completion is `denied`, not `failed`. */
    readonly denied: Set<string>;
    /** Calls announced but not completed — settled when the turn ends without Copilot doing it. */
    readonly calls: Set<string>;
    usage: Usage | undefined;
    error: { readonly code: AgentErrorCode; readonly message: string } | undefined;
    finish(): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The policy's view of one Copilot permission request. */
export function permissionRequestOf(request: CopilotPermissionRequest): PolicyRequest {
    const callId = request.toolCallId !== undefined ? { callId: request.toolCallId } : {};
    const message = typeof request.intention === 'string' ? { message: request.intention } : {};
    switch (request.kind) {
        case 'shell': {
            const command = String(request.fullCommandText ?? '');
            return { kind: 'permission', ...callId, toolName: 'shell', input: { command }, category: 'execute', source: 'native', permissionKey: `shell:${command}`, ...message };
        }
        case 'write': {
            const path = String(request.fileName ?? '');
            return { kind: 'permission', ...callId, toolName: 'write', input: { path }, category: 'edit', source: 'native', permissionKey: `write:${path}`, ...message };
        }
        case 'read': {
            const path = String(request.path ?? request.fileName ?? '');
            return { kind: 'permission', ...callId, toolName: 'read', input: { path }, category: 'read', source: 'native', annotations: { readOnly: true }, permissionKey: `read:${path}`, ...message };
        }
        case 'url': {
            const url = String(request.url ?? '');
            return { kind: 'permission', ...callId, toolName: 'fetch', input: { url }, category: 'fetch', source: 'native', permissionKey: `fetch:${url}`, ...message };
        }
        case 'mcp': {
            const toolName = `${String(request.serverName ?? 'mcp')}__${String(request.toolName ?? 'tool')}`;
            return {
                kind: 'permission',
                ...callId,
                toolName,
                input: request.args,
                source: 'mcp',
                ...(request.readOnly === true ? { annotations: { readOnly: true }, category: 'read' } : {}),
                permissionKey: toolName,
                ...message
            };
        }
        case 'custom-tool': {
            const toolName = String(request.toolName ?? 'tool');
            return { kind: 'permission', ...callId, toolName, input: request.args, source: 'client', permissionKey: toolName, ...message };
        }
        default:
            return { kind: 'permission', ...callId, toolName: request.kind, input: request, category: 'other', source: 'native', permissionKey: request.kind, ...message };
    }
}

const errorCodeOf = (error: CopilotError): AgentErrorCode => {
    const type = error.errorType.toLowerCase();
    if (error.statusCode === 401 || error.statusCode === 403 || type.includes('auth')) return 'auth_required';
    if (error.statusCode === 429 || type.includes('rate') || type.includes('quota')) return 'rate_limited';
    if (type.includes('context') || type.includes('token_limit')) return 'context_exceeded';
    return 'provider_error';
};

const toolText = (output: unknown): string => (typeof output === 'string' ? output : JSON.stringify(output ?? null));

/** The title the CLI last gave each session's conversation (#460); `copilotSessionTitle` reads it. */
const titles = new WeakMap<AgentSession, string>();

/** The conversation's title as Copilot last reported it (`session.title_changed`), or `undefined` before it has. */
export function copilotSessionTitle(session: AgentSession): string | undefined {
    return titles.get(session);
}

export function copilotCli(options: CopilotCliOptions): Agent<CopilotSessionOptions> {
    const id = options.id ?? COPILOT_CLI_AGENT_ID;
    const abortGraceMs = options.abortGraceMs ?? 5_000;
    const sessions = new Set<AgentSession>();

    async function session(opts: CopilotSessionOptions): Promise<AgentSession> {
        const client = await options.client();
        let turn: RunningTurn | undefined;
        let agentSession: AgentSession;

        const tools: CopilotTool[] = (opts.tools ?? []).map((tool: AnyTool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.spec.inputSchema as Record<string, unknown>,
            skipPermission: true,
            handler: async (args, invocation) => {
                const running = turn;
                if (!running) throw new Error(`${tool.name} was called outside a turn`);
                const resolved = await running.ctx.resolve({
                    kind: 'permission',
                    callId: invocation.toolCallId,
                    toolName: tool.name,
                    input: args,
                    ...(tool.annotations ? { annotations: tool.annotations } : {}),
                    source: 'client',
                    permissionKey: tool.name
                });
                if (resolved.decision.type !== 'permission' || resolved.decision.outcome !== 'allow') {
                    running.denied.add(invocation.toolCallId);
                    const why = resolved.decision.type === 'permission' ? resolved.decision.message : undefined;
                    return { textResultForLlm: why ?? `The user did not allow ${tool.name}.`, resultType: 'denied' };
                }
                const output = await tool.run(args, { signal: invocation.signal ?? running.driver.signal, toolCallId: invocation.toolCallId });
                return toolText(output);
            }
        }));

        const onPermissionRequest = async (request: CopilotPermissionRequest): Promise<CopilotPermissionResult> => {
            const running = turn;
            if (!running) return { kind: 'user-not-available' };
            const resolved = await running.ctx.resolve(permissionRequestOf(request));
            const decision = resolved.decision;
            if (decision.type === 'permission' && decision.outcome === 'allow') return { kind: 'approve-once' };
            if (request.toolCallId !== undefined) running.denied.add(request.toolCallId);
            return { kind: 'reject', ...(decision.type === 'permission' && decision.message ? { feedback: decision.message } : {}) };
        };

        const onUserInputRequest = async (request: CopilotUserInputRequest): Promise<CopilotUserInputResponse> => {
            const running = turn;
            if (!running) return { answer: '', wasFreeform: true };
            const choices = request.choices ?? [];
            const resolved = await running.ctx.resolve({
                kind: 'input',
                source: 'native',
                message: request.question,
                ...(choices.length ? { options: choices.map((c) => ({ id: c, label: c })) } : {}),
                schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
            });
            if (resolved.decision.type !== 'input') return { answer: '', wasFreeform: true };
            const answers = resolved.decision.answers;
            const answer = typeof answers === 'string' ? answers : isRecord(answers) && typeof answers.answer === 'string' ? answers.answer : JSON.stringify(answers ?? '');
            return { answer, wasFreeform: !choices.includes(answer) };
        };

        const config: CopilotSessionConfig = {
            workingDirectory: opts.cwd,
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.system ? { systemMessage: { mode: 'append', content: opts.system } } : {}),
            tools,
            streaming: true,
            skipCustomInstructions: true,
            enableConfigDiscovery: false,
            onPermissionRequest,
            onUserInputRequest
        };
        const resumeId = opts.resume?.id;
        const copilot: CopilotSessionLike = resumeId !== undefined ? await client.resumeSession(resumeId, config) : await client.createSession(config);
        const previousEpoch = isRecord(opts.resume?.data) && typeof opts.resume.data.epoch === 'number' ? opts.resume.data.epoch : undefined;

        const log = createEventLog({ sessionId: copilot.sessionId, epoch: previousEpoch === undefined ? 1 : previousEpoch + 1 });
        const core = createSessionCore({
            id: copilot.sessionId,
            log,
            promptParts: COPILOT_CLI_CAPABILITIES.promptParts,
            ...(opts.policy ? { policy: opts.policy } : {}),
            interactive: opts.interactive ?? true,
            ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
            ...(opts.signal ? { signal: opts.signal } : {})
        });

        const openPart = (running: RunningTurn, partId: string, messageId: string, kind: 'text' | 'reasoning') => {
            if (running.open.has(partId)) return;
            running.open.add(partId);
            running.driver.emit({ type: 'part-start', messageId, partId, kind });
        };
        const endPart = (running: RunningTurn, partId: string) => {
            if (!running.open.delete(partId)) return;
            running.driver.emit({ type: 'part-end', partId });
        };

        const onEvent = (event: CopilotEvent) => {
            // The title is the session's, not a turn's (#460): it lands whenever the CLI computes it, a turn running or not.
            if (event.type === 'session.title_changed') {
                const title = (event.data as Partial<CopilotTitleChanged> | undefined)?.title;
                if (typeof title === 'string' && title.trim()) titles.set(agentSession, title.replace(/\s+/g, ' ').trim());
                return;
            }
            const running = turn;
            if (!running || running.driver.ended) return;
            const data = event.data;
            if (isRecord(data) && typeof data.parentToolCallId === 'string') return;
            const { driver } = running;
            switch (event.type) {
                case 'assistant.message_delta': {
                    const d = data as CopilotMessageDelta;
                    openPart(running, d.messageId, d.messageId, 'text');
                    if (d.deltaContent) driver.emit({ type: 'part-delta', partId: d.messageId, delta: d.deltaContent });
                    return;
                }
                case 'assistant.message': {
                    const m = data as CopilotMessage;
                    if (!running.open.has(m.messageId) && m.content) {
                        openPart(running, m.messageId, m.messageId, 'text');
                        driver.emit({ type: 'part-delta', partId: m.messageId, delta: m.content });
                    }
                    endPart(running, m.messageId);
                    return;
                }
                case 'assistant.reasoning_delta': {
                    const r = data as CopilotReasoningDelta;
                    const partId = `r:${r.reasoningId}`;
                    openPart(running, partId, partId, 'reasoning');
                    if (r.deltaContent) driver.emit({ type: 'part-delta', partId, delta: r.deltaContent });
                    return;
                }
                case 'assistant.reasoning': {
                    const r = data as { readonly reasoningId: string; readonly content?: string };
                    const partId = `r:${r.reasoningId}`;
                    if (!running.open.has(partId) && r.content) {
                        openPart(running, partId, partId, 'reasoning');
                        driver.emit({ type: 'part-delta', partId, delta: r.content });
                    }
                    endPart(running, partId);
                    return;
                }
                case 'tool.execution_start': {
                    const t = data as CopilotToolStart;
                    const name = t.mcpServerName !== undefined ? `${t.mcpServerName}__${t.toolName}` : t.toolName;
                    const category = categoryOf(name);
                    driver.emit({ type: 'tool-call', callId: t.toolCallId, name, ...(t.arguments !== undefined ? { input: t.arguments } : {}), ...(category ? { category } : {}) });
                    // Copilot announces a call when it starts executing it (after its own permission step).
                    driver.emit({ type: 'tool-update', callId: t.toolCallId, status: 'in_progress' });
                    running.calls.add(t.toolCallId);
                    return;
                }
                case 'tool.execution_complete': {
                    const t = data as CopilotToolComplete;
                    if (!running.calls.delete(t.toolCallId)) return;
                    const denied = running.denied.delete(t.toolCallId);
                    const output = t.result?.structuredContent ?? t.result?.content;
                    driver.emit({
                        type: 'tool-update',
                        callId: t.toolCallId,
                        status: denied ? 'denied' : t.success ? 'completed' : 'failed',
                        ...(output !== undefined ? { output } : {}),
                        ...(!t.success && t.error ? { error: t.error.message } : {})
                    });
                    return;
                }
                case 'assistant.usage': {
                    const u = data as CopilotUsage;
                    const prev = running.usage ?? {};
                    running.usage = {
                        inputTokens: (prev.inputTokens ?? 0) + (u.inputTokens ?? 0),
                        outputTokens: (prev.outputTokens ?? 0) + (u.outputTokens ?? 0),
                        ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: (prev.cacheReadTokens ?? 0) + u.cacheReadTokens } : {}),
                        ...(u.reasoningTokens !== undefined ? { reasoningTokens: (prev.reasoningTokens ?? 0) + u.reasoningTokens } : {})
                    };
                    return;
                }
                case 'session.error': {
                    const e = data as CopilotError;
                    const code = errorCodeOf(e);
                    running.error = { code, message: e.message };
                    driver.emit({ type: 'error', code, message: e.message, recoverable: false, data: { errorType: e.errorType, ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}) } });
                    return;
                }
                case 'session.idle':
                    running.finish();
                    return;
                default:
                    return;
            }
        };
        const unsubscribe = copilot.on(onEvent);

        agentSession = {
            id: copilot.sessionId,
            get ref(): SessionRef {
                return { agent: id, v: 1, id: copilot.sessionId, data: { cwd: opts.cwd, epoch: log.epoch } };
            },
            prompt(input, promptOptions) {
                return core.startTurn(input, promptOptions, async (driver, ctx) => {
                    const parts = toPromptParts(input);
                    driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                    await new Promise<void>((resolve) => {
                        let grace: ReturnType<typeof setTimeout> | undefined;
                        const running: RunningTurn = {
                            driver,
                            ctx,
                            open: new Set(),
                            denied: new Set(),
                            calls: new Set(),
                            usage: undefined,
                            error: undefined,
                            finish() {
                                if (turn !== running) return;
                                turn = undefined;
                                if (grace) clearTimeout(grace);
                                driver.signal.removeEventListener('abort', onAbort);
                                for (const partId of running.open) endPart(running, partId);
                                if (!driver.ended) {
                                    const status = driver.signal.aborted ? 'cancelled' : 'failed';
                                    for (const callId of running.calls) driver.emit({ type: 'tool-update', callId, status, ...(status === 'failed' ? { error: 'the turn ended before the tool finished' } : {}) });
                                }
                                running.calls.clear();
                                if (!driver.ended) {
                                    if (running.usage) driver.emit({ type: 'usage', scope: 'turn', usage: running.usage });
                                    const usage = running.usage ? { usage: running.usage } : {};
                                    if (driver.signal.aborted) driver.end({ stopReason: 'cancelled', ...usage });
                                    else if (running.error) driver.end({ stopReason: 'error', error: running.error, ...usage });
                                    else driver.end({ stopReason: 'end_turn', ...usage });
                                }
                                resolve();
                            }
                        };
                        const onAbort = () => {
                            copilot.abort().catch(() => undefined);
                            grace = setTimeout(() => running.finish(), abortGraceMs);
                        };
                        turn = running;
                        driver.signal.addEventListener('abort', onAbort, { once: true });
                        copilot.send({ prompt: partsText(parts) }).catch((e: unknown) => {
                            const message = e instanceof Error ? e.message : String(e);
                            running.error = { code: 'process_exited', message };
                            driver.emit({ type: 'error', code: 'process_exited', message, recoverable: false });
                            running.finish();
                        });
                    });
                });
            },
            respond: (requestId, decision) => core.respond(requestId, decision),
            cancel: (target) => core.cancel(target),
            subscribe: (from) => core.subscribe(from),
            async close() {
                sessions.delete(agentSession);
                await core.close();
                unsubscribe();
                await copilot.disconnect().catch(() => undefined);
            }
        };
        sessions.add(agentSession);
        return agentSession;
    }

    return {
        id,
        capabilities: COPILOT_CLI_CAPABILITIES,
        session: async (opts) => {
            if (!opts?.cwd) throw new Error('[copilot-cli] a session needs a cwd');
            return session(opts);
        },
        async dispose() {
            await Promise.all([...sessions].map((s) => s.close()));
        }
    };
}
