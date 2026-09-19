/**
 * `codexCli` — an `@sigx/ai-agent` `Agent` over `codex app-server` (#320).
 *
 * One app-server per agent (the driver makes one agent per environment), one Codex thread per
 * session. What the app-server streams is mapped onto the event union:
 *
 * - `item/agentMessage/delta` and reasoning deltas → text / reasoning parts;
 * - command, file-change, MCP and web-search items → `tool-call` / `tool-update`;
 * - `item/*\/requestApproval` → the session's policy (`ctx.resolve`), answered
 *   `accept` / `acceptForSession` / `decline` / `cancel` — Codex decides what to ask
 *   about (sandboxed reads run without a request), so permissions are `harness-filtered`;
 * - `item/tool/requestUserInput` → an `input` request;
 * - `turn/steer` carries a prompt sent mid-turn, `turn/interrupt` a cancel;
 * - `thread/tokenUsage/updated` → the turn's `usage`, `turn/completed` → `turn-end`;
 * - `account/rateLimits/updated` → `ext codex-cli/rate-limits` on every open session,
 *   for the daemon's quota monitor.
 *
 * Client tools (the platform's and the agent's connectors) reach Codex over a loopback MCP
 * server per session (`mcp_servers.agentic` in the thread's config) — not the experimental
 * `dynamicTools`. Every call still goes through the session's policy before it runs.
 */

import { randomBytes } from 'node:crypto';
import type { AnyTool, JsonSchema, Usage } from '@sigx/ai';
import {
    AgentError,
    capabilities,
    createEventLog,
    createSessionCore,
    partsText,
    toPromptParts,
    type Agent,
    type AgentSession,
    type Decision,
    type ErrorInfo,
    type OutputSpec,
    type PromptPart,
    type SessionOptions,
    type SessionRef,
    type TurnContext,
    type TurnDriver
} from '@sigx/ai-agent';
import { categoryOf } from '@sigx/ai-agent/coding';
import { createMcpToolHandler } from '@sigx/ai-agent/harness';
import { listenMcp } from '@sigx/ai-agent-node';
import type { CodexConnection } from './client.js';
import type {
    ApprovalDecision,
    AskForApproval,
    CommandExecutionRequestApprovalParams,
    FileChangeRequestApprovalParams,
    JsonValue,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    Notifications,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    RateLimitSnapshot,
    SandboxMode,
    ThreadItem,
    ThreadStartParams,
    ThreadStartResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputQuestion,
    ToolRequestUserInputResponse,
    TokenUsageBreakdown,
    Turn,
    TurnError,
    TurnStartResponse,
    UserInput
} from './protocol.js';

export const CODEX_CLI_NS = 'codex-cli';

/** What the adapter delivers — not what Codex advertises. */
export const CODEX_CLI_CAPABILITIES = capabilities({
    resume: 'local',
    cancel: true,
    steer: true,
    structuredOutput: true,
    promptParts: 'text',
    tools: 'mcp',
    permissions: 'harness-filtered'
});

/** The MCP server name client tools are served under; a call to it is named by the tool alone. */
export const CODEX_TOOL_SERVER = 'agentic';

/** A running tool server a thread's config points Codex at. */
export interface ToolServer {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    close(): Promise<void>;
}

export type ServeTools = (tools: readonly AnyTool[], name: string) => Promise<ToolServer>;

/** Client tools on a loopback Streamable-HTTP MCP server behind a per-session bearer token. */
export const serveToolsOverMcp: ServeTools = async (tools, name) => {
    const token = randomBytes(32).toString('hex');
    const bearer = `Bearer ${token}`;
    const handler = createMcpToolHandler(tools, { name, version: '0.1.0', auth: (request) => request.headers.get('authorization') === bearer });
    const listener = await listenMcp(handler, { token });
    return { url: listener.url, headers: { Authorization: bearer }, close: () => listener.close() };
};

export interface CodexCliOptions {
    /** `Agent.id` and every `SessionRef.agent`. Default `'codex-cli'`. */
    readonly id?: string;
    /** Opens the app-server (initialized); called once, again only after it died. */
    readonly connect: () => Promise<CodexConnection>;
    /** How client tools are served; loopback MCP by default. */
    readonly serveTools?: ServeTools;
    /** Default `'on-request'`: Codex asks before leaving the sandbox, and the policy answers. */
    readonly approvalPolicy?: AskForApproval;
    /** Default `'workspace-write'`. */
    readonly sandbox?: SandboxMode;
    /** How long a cancelled turn waits for Codex to confirm the interrupt before it ends anyway. Default 5 s. */
    readonly interruptGraceMs?: number;
}

export interface CodexSessionOptions extends SessionOptions {
    readonly cwd?: string;
}

interface CallState {
    readonly name: string;
    settled: boolean;
}

interface TurnState {
    readonly driver: TurnDriver;
    readonly ctx: TurnContext;
    codexTurnId?: string;
    interruptRequested: boolean;
    readonly pendingSteer: PromptPart[][];
    readonly parts: Map<string, string>;
    messageSeq: number;
    steers: number;
    readonly calls: Map<string, CallState>;
    readonly items: Map<string, ThreadItem>;
    /** Our own MCP calls Codex announced, not yet claimed by the tool that runs them. */
    readonly mcpPending: { readonly itemId: string; readonly tool: string; readonly args: string }[];
    readonly text: Map<string, string>;
    lastText?: string;
    usage?: Usage;
    error?: TurnError;
    readonly wantsOutput: boolean;
    finish(): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toUserInput = (parts: readonly PromptPart[]): UserInput[] => [{ type: 'text', text: partsText(parts), text_elements: [] }];

function outputSchemaOf(output: OutputSpec | undefined): JsonValue | undefined {
    const schema = output?.schema as unknown;
    if (!isRecord(schema)) return undefined;
    const std = schema['~standard'];
    if (isRecord(std)) {
        const json = std.jsonSchema as { input?: (o: { target: string }) => unknown } | undefined;
        const converted = json?.input?.({ target: 'draft-2020-12' });
        if (!isRecord(converted)) throw new AgentError('protocol_error', '[codex-cli] structured output needs a JSON Schema (or a Standard Schema with a JSON Schema converter)');
        return converted as JsonValue;
    }
    return schema as JsonValue;
}

const addUsage = (a: Usage | undefined, b: TokenUsageBreakdown): Usage => ({
    inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
    outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
    totalTokens: (a?.totalTokens ?? 0) + b.totalTokens,
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + b.cachedInputTokens,
    reasoningTokens: (a?.reasoningTokens ?? 0) + b.reasoningOutputTokens
});

function errorOf(error: TurnError | undefined, fallback: string): ErrorInfo {
    const info = (error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo;
    const code: ErrorInfo['code'] =
        info === 'usageLimitExceeded' || info === 'rateLimitExceeded'
            ? 'rate_limited'
            : info === 'contextWindowExceeded'
              ? 'context_exceeded'
              : info === 'unauthorized'
                ? 'auth_required'
                : 'provider_error';
    return { code, message: error?.message ?? fallback };
}

/** A tool item as a call: its name, input and category. */
function callOf(item: ThreadItem): { name: string; input: unknown; category?: string; title?: string } | undefined {
    switch (item.type) {
        case 'commandExecution': {
            const i = item as Extract<ThreadItem, { type: 'commandExecution' }>;
            return { name: 'shell', input: { command: i.command, cwd: i.cwd }, category: 'execute', title: i.command };
        }
        case 'fileChange': {
            const i = item as Extract<ThreadItem, { type: 'fileChange' }>;
            const paths = i.changes.map((c) => c.path);
            return { name: 'apply_patch', input: { changes: i.changes.map((c) => ({ path: c.path, kind: c.kind })) }, category: 'edit', title: paths.join(', ') };
        }
        case 'mcpToolCall': {
            const i = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
            const own = i.server === CODEX_TOOL_SERVER;
            const category = own ? undefined : categoryOf(i.tool);
            return { name: own ? i.tool : `${i.server}__${i.tool}`, input: i.arguments, ...(category ? { category } : {}) };
        }
        case 'webSearch': {
            const i = item as Extract<ThreadItem, { type: 'webSearch' }>;
            return { name: 'web_search', input: { query: i.query }, category: 'fetch', title: i.query };
        }
        default:
            return undefined;
    }
}

function textOf(content: readonly JsonValue[] | undefined): string {
    return (content ?? []).map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join('');
}

/** A settled tool item's `tool-update` fields. */
function settleOf(item: ThreadItem): { status: 'completed' | 'failed' | 'denied'; output?: unknown; error?: string } | undefined {
    const status = (item as { status?: string }).status;
    if (item.type === 'webSearch') return { status: 'completed' };
    if (status === undefined || status === 'inProgress') return undefined;
    if (status === 'declined') return { status: 'denied' };
    if (item.type === 'commandExecution') {
        const i = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        const output = { exitCode: i.exitCode, output: i.aggregatedOutput ?? '' };
        return status === 'completed' ? { status: 'completed', output } : { status: 'failed', output, error: `exited with ${i.exitCode ?? 'no code'}` };
    }
    if (item.type === 'fileChange') {
        const i = item as Extract<ThreadItem, { type: 'fileChange' }>;
        return status === 'completed' ? { status: 'completed', output: { changes: i.changes.map((c) => c.path) } } : { status: 'failed', error: 'the patch did not apply' };
    }
    if (item.type === 'mcpToolCall') {
        const i = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        if (status === 'completed') return { status: 'completed', output: i.result?.structuredContent ?? textOf(i.result?.content) };
        return { status: 'failed', error: i.error?.message ?? textOf(i.result?.content) ?? 'the tool failed' };
    }
    return undefined;
}

/** Answers keyed by question id, from whatever shape the client answered in. */
function toAnswers(questions: readonly ToolRequestUserInputQuestion[], answers: unknown): ToolRequestUserInputResponse['answers'] {
    const out: Record<string, { answers: string[] }> = {};
    const rec = isRecord(answers) ? answers : {};
    for (const q of questions) {
        let v: unknown = rec[q.id];
        if (v === undefined && questions.length === 1) v = typeof answers === 'string' ? answers : Object.values(rec)[0];
        if (v === undefined || v === null) continue;
        out[q.id] = { answers: Array.isArray(v) ? v.map(String) : [String(v)] };
    }
    return out;
}

function questionsSchema(questions: readonly ToolRequestUserInputQuestion[]): JsonSchema {
    const properties: Record<string, unknown> = {};
    for (const q of questions) {
        properties[q.id] = { type: 'string', title: q.header, description: q.question, ...(q.options?.length ? { enum: q.options.map((o) => o.label) } : {}) };
    }
    return { type: 'object', properties, required: questions.map((q) => q.id) } as JsonSchema;
}

const approvalOf = (decision: Decision): ApprovalDecision =>
    decision.type === 'permission' ? (decision.outcome === 'allow' ? (decision.scope === 'session' ? 'acceptForSession' : 'accept') : 'decline') : decision.type === 'cancel' ? 'cancel' : 'decline';

const THREAD_NOTIFICATIONS = ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'thread/tokenUsage/updated', 'error'] as const;

const THREAD_REQUESTS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'] as const;
type ThreadRequest = (typeof THREAD_REQUESTS)[number];

interface Router {
    notify(method: string, params: Record<string, unknown>): void;
    request(method: ThreadRequest, params: Record<string, unknown>): Promise<unknown>;
    rateLimits(snapshot: RateLimitSnapshot): void;
    closed(reason: string): void;
}

/** What Codex gets when a request names a thread no session holds (or none is running a turn). */
function refusal(method: ThreadRequest): unknown {
    switch (method) {
        case 'item/permissions/requestApproval':
            return { permissions: {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse;
        case 'item/tool/requestUserInput':
            return { answers: {} } satisfies ToolRequestUserInputResponse;
        case 'mcpServer/elicitation/request':
            return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
        default:
            return { decision: 'decline' satisfies ApprovalDecision };
    }
}

export function codexCli(options: CodexCliOptions): Agent<CodexSessionOptions> {
    const agentId = options.id ?? CODEX_CLI_NS;
    const serveTools = options.serveTools ?? serveToolsOverMcp;
    const graceMs = options.interruptGraceMs ?? 5_000;
    const routers = new Map<string, Router>();
    const sessions = new Set<AgentSession>();
    let connection: Promise<CodexConnection> | undefined;

    const wire = (c: CodexConnection) => {
        for (const method of THREAD_NOTIFICATIONS) {
            c.peer.onNotification<Record<string, unknown>>(method, (params) => {
                const threadId = params?.threadId;
                if (typeof threadId === 'string') routers.get(threadId)?.notify(method, params);
            });
        }
        c.peer.onNotification<Notifications['account/rateLimits/updated']>('account/rateLimits/updated', (params) => {
            for (const r of routers.values()) r.rateLimits(params.rateLimits);
        });
        for (const method of THREAD_REQUESTS) {
            c.peer.onRequest<Record<string, unknown>>(method, (params) => {
                const threadId = params?.threadId;
                const router = typeof threadId === 'string' ? routers.get(threadId) : undefined;
                return router ? router.request(method, params) : refusal(method);
            });
        }
        void c.peer.closed.then(({ error }) => {
            for (const r of routers.values()) r.closed(error?.message ?? 'Codex exited');
        });
    };

    const connect = (): Promise<CodexConnection> => {
        connection ??= options.connect().then(
            (c) => {
                wire(c);
                void c.peer.closed.then(() => {
                    if (connection === current) connection = undefined;
                });
                return c;
            },
            (e: unknown) => {
                connection = undefined;
                throw e;
            }
        );
        const current = connection;
        return current;
    };

    async function openSession(opts: CodexSessionOptions): Promise<AgentSession> {
        const resume = opts.resume;
        if (resume !== undefined && resume.agent !== agentId) throw new AgentError('protocol_error', `[codex-cli] cannot resume a session of "${resume.agent}" on "${agentId}"`);
        const c = await connect();
        const peer = c.peer;

        let turn: TurnState | undefined;
        const tools = (opts.tools ?? []).map((t) => gated(t, () => turn));
        const server = tools.length > 0 ? await serveTools(tools, CODEX_TOOL_SERVER) : undefined;
        const params: ThreadStartParams = {
            cwd: opts.cwd ?? null,
            approvalPolicy: options.approvalPolicy ?? 'on-request',
            sandbox: options.sandbox ?? 'workspace-write',
            developerInstructions: opts.system ?? null,
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            config: server ? { mcp_servers: { [CODEX_TOOL_SERVER]: { url: server.url, http_headers: { ...server.headers } } } } : null
        };
        let started: ThreadStartResponse;
        try {
            started = resume ? await peer.request<ThreadStartResponse>('thread/resume', { ...params, threadId: resume.id, excludeTurns: true }) : await peer.request<ThreadStartResponse>('thread/start', params);
        } catch (e) {
            await server?.close();
            throw new AgentError('process_exited', `[codex-cli] could not ${resume ? 'resume' : 'start'} a thread: ${e instanceof Error ? e.message : String(e)}`, false, { cause: e });
        }
        const threadId = started.thread.id;
        const previousEpoch = isRecord(resume?.data) && typeof resume.data.epoch === 'number' ? resume.data.epoch : 1;
        const log = createEventLog({ sessionId: threadId, epoch: resume ? previousEpoch + 1 : 1 });
        const core = createSessionCore({
            id: threadId,
            log,
            steer: true,
            promptParts: CODEX_CLI_CAPABILITIES.promptParts,
            interactive: opts.interactive ?? true,
            ...(opts.policy ? { policy: opts.policy } : {}),
            ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
            ...(opts.signal ? { signal: opts.signal } : {})
        });
        let dead: string | undefined;

        const messageId = (t: TurnState) => `a:${t.driver.turnId}:${t.messageSeq}`;

        const openPart = (t: TurnState, key: string, kind: 'text' | 'reasoning') => {
            if (t.parts.has(key)) return;
            t.parts.set(key, key);
            t.driver.emit({ type: 'part-start', messageId: messageId(t), partId: key, kind });
        };
        const closePart = (t: TurnState, key: string) => {
            if (!t.parts.delete(key)) return;
            t.driver.emit({ type: 'part-end', partId: key });
        };

        const ensureCall = (t: TurnState, item: ThreadItem) => {
            if (t.calls.has(item.id)) return;
            const call = callOf(item);
            if (!call) return;
            t.calls.set(item.id, { name: call.name, settled: false });
            t.driver.emit({ type: 'tool-call', callId: item.id, name: call.name, messageId: messageId(t), input: call.input, ...(call.category ? { category: call.category } : {}), ...(call.title ? { title: call.title } : {}) });
            t.driver.emit({ type: 'tool-update', callId: item.id, status: 'in_progress' });
            if (item.type === 'mcpToolCall' && (item as Extract<ThreadItem, { type: 'mcpToolCall' }>).server === CODEX_TOOL_SERVER) {
                const i = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
                t.mcpPending.push({ itemId: i.id, tool: i.tool, args: JSON.stringify(i.arguments ?? {}) });
            }
        };

        const settleCall = (t: TurnState, callId: string, update: { status: 'completed' | 'failed' | 'denied' | 'cancelled'; output?: unknown; error?: string }) => {
            const call = t.calls.get(callId);
            if (!call || call.settled) return;
            call.settled = true;
            t.driver.emit({ type: 'tool-update', callId, status: update.status, ...(update.output !== undefined ? { output: update.output } : {}), ...(update.error !== undefined ? { error: update.error } : {}) });
        };

        /** Ends the turn once, however it ended: Codex's `turn/completed`, a dead process, a cancel Codex never confirmed. */
        const settle = (t: TurnState, status: Turn['status'] | 'exited', error?: TurnError) => {
            if (t.driver.ended) return t.finish();
            for (const key of t.parts.keys()) closePart(t, key);
            for (const [callId, call] of t.calls) if (!call.settled) settleCall(t, callId, { status: status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed' });
            if (t.usage) t.driver.emit({ type: 'usage', scope: 'turn', usage: t.usage });
            const usage = t.usage ? { usage: t.usage } : {};
            if (status === 'interrupted' || (t.driver.signal.aborted && status !== 'completed')) {
                t.driver.end({ stopReason: 'cancelled', ...usage });
            } else if (status === 'failed' || status === 'exited') {
                const info: ErrorInfo = status === 'exited' ? { code: 'process_exited', message: error?.message ?? 'Codex exited before the turn ended' } : errorOf(error ?? t.error, 'the turn failed');
                t.driver.emit({ type: 'error', code: info.code, message: info.message, recoverable: false });
                t.driver.end({ stopReason: 'error', error: info, ...usage });
            } else {
                let output: unknown;
                if (t.wantsOutput && t.lastText !== undefined) {
                    try {
                        output = JSON.parse(t.lastText);
                    } catch {
                        output = undefined;
                    }
                }
                t.driver.end({ stopReason: 'end_turn', ...usage, ...(output !== undefined ? { output } : {}) });
            }
            t.finish();
        };

        const interrupt = (t: TurnState) => {
            if (t.driver.ended) return;
            if (t.codexTurnId === undefined) {
                t.interruptRequested = true;
                return;
            }
            void peer.request('turn/interrupt', { threadId, turnId: t.codexTurnId }).catch(() => undefined);
            setTimeout(() => settle(t, 'interrupted'), graceMs).unref?.();
        };

        const sendSteer = (t: TurnState, parts: readonly PromptPart[]) => {
            if (t.codexTurnId === undefined) {
                t.pendingSteer.push([...parts]);
                return;
            }
            void peer.request('turn/steer', { threadId, input: toUserInput(parts), expectedTurnId: t.codexTurnId }).catch(() => undefined);
        };

        const onItemCompleted = (t: TurnState, item: ThreadItem) => {
            if (item.type === 'agentMessage') {
                const text = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text;
                if (!t.parts.has(item.id) && text) {
                    openPart(t, item.id, 'text');
                    t.driver.emit({ type: 'part-delta', partId: item.id, delta: text });
                }
                closePart(t, item.id);
                t.lastText = text || t.text.get(item.id) || t.lastText;
                return;
            }
            if (item.type === 'reasoning') return closePart(t, `${item.id}#r`);
            if (!callOf(item)) return;
            ensureCall(t, item);
            const update = settleOf(item);
            if (update) settleCall(t, item.id, update);
        };

        const router: Router = {
            notify(method, p) {
                const t = turn;
                if (!t || t.driver.ended) return;
                const turnId = typeof p.turnId === 'string' ? p.turnId : undefined;
                if (turnId !== undefined && t.codexTurnId !== undefined && turnId !== t.codexTurnId) return;
                switch (method) {
                    case 'turn/started':
                        t.codexTurnId ??= (p as unknown as Notifications['turn/started']).turn.id;
                        return;
                    case 'item/agentMessage/delta': {
                        const d = p as unknown as Notifications['item/agentMessage/delta'];
                        openPart(t, d.itemId, 'text');
                        t.text.set(d.itemId, (t.text.get(d.itemId) ?? '') + d.delta);
                        t.driver.emit({ type: 'part-delta', partId: d.itemId, delta: d.delta });
                        return;
                    }
                    case 'item/reasoning/summaryTextDelta':
                    case 'item/reasoning/textDelta': {
                        const d = p as unknown as Notifications['item/reasoning/textDelta'];
                        openPart(t, `${d.itemId}#r`, 'reasoning');
                        t.driver.emit({ type: 'part-delta', partId: `${d.itemId}#r`, delta: d.delta });
                        return;
                    }
                    case 'item/started': {
                        const item = (p as unknown as Notifications['item/started']).item;
                        t.items.set(item.id, item);
                        ensureCall(t, item);
                        return;
                    }
                    case 'item/completed':
                        onItemCompleted(t, (p as unknown as Notifications['item/completed']).item);
                        return;
                    case 'thread/tokenUsage/updated':
                        t.usage = addUsage(t.usage, (p as unknown as Notifications['thread/tokenUsage/updated']).tokenUsage.last);
                        return;
                    case 'error': {
                        const e = p as unknown as Notifications['error'];
                        if (e.willRetry) t.driver.emit({ type: 'error', code: errorOf(e.error, 'retrying').code, message: e.error.message, recoverable: true });
                        else t.error = e.error;
                        return;
                    }
                    case 'turn/completed': {
                        const done = (p as unknown as Notifications['turn/completed']).turn;
                        settle(t, done.status, done.error ?? undefined);
                        return;
                    }
                }
            },

            async request(method, p) {
                if (method === 'mcpServer/elicitation/request') {
                    // Our own server never elicits; Codex asks here to confirm a call to it — the call's own gate decides.
                    const e = p as unknown as McpServerElicitationRequestParams;
                    return { action: e.serverName === CODEX_TOOL_SERVER ? 'accept' : 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
                }
                const t = turn;
                if (!t || t.driver.ended) return refusal(method);
                if (method === 'item/tool/requestUserInput') {
                    const q = p as unknown as ToolRequestUserInputParams;
                    const r = await t.ctx.resolve({
                        kind: 'input',
                        source: 'native',
                        message: q.questions.map((x) => x.question).join('\n'),
                        schema: questionsSchema(q.questions),
                        ...(q.questions.length === 1 && q.questions[0]!.options?.length ? { options: q.questions[0]!.options.map((o) => ({ id: o.label, label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {})
                    });
                    return { answers: r.decision.type === 'input' ? toAnswers(q.questions, r.decision.answers) : {} } satisfies ToolRequestUserInputResponse;
                }
                if (method === 'item/permissions/requestApproval') {
                    const a = p as unknown as PermissionsRequestApprovalParams;
                    const r = await t.ctx.resolve({ kind: 'permission', toolName: 'permissions', input: a.permissions, category: 'other', source: 'native', message: a.reason ?? 'Codex asks for more permissions', permissionKey: 'permissions' });
                    if (r.decision.type !== 'permission' || r.decision.outcome !== 'allow') return refusal(method);
                    const granted: Record<string, JsonValue> = {};
                    if (a.permissions.network !== null) granted.network = a.permissions.network;
                    if (a.permissions.fileSystem !== null) granted.fileSystem = a.permissions.fileSystem;
                    return { permissions: granted, scope: r.decision.scope === 'session' ? 'session' : 'turn' } satisfies PermissionsRequestApprovalResponse;
                }
                const a = p as unknown as CommandExecutionRequestApprovalParams & FileChangeRequestApprovalParams;
                const command = method === 'item/commandExecution/requestApproval';
                const item = t.items.get(a.itemId) ?? (command ? ({ type: 'commandExecution', id: a.itemId, command: a.command ?? '', cwd: a.cwd ?? '', status: 'inProgress', aggregatedOutput: null, exitCode: null } as ThreadItem) : undefined);
                if (item) ensureCall(t, item);
                const call = item ? callOf(item) : undefined;
                const r = await t.ctx.resolve({
                    kind: 'permission',
                    ...(t.calls.has(a.itemId) ? { callId: a.itemId } : {}),
                    toolName: command ? 'shell' : 'apply_patch',
                    input: call?.input ?? (command ? { command: a.command, cwd: a.cwd } : {}),
                    category: command ? 'execute' : 'edit',
                    source: 'native',
                    ...(a.reason ? { message: a.reason } : command && a.command ? { message: a.command } : {}),
                    permissionKey: command ? `shell:${a.command ?? ''}` : 'apply_patch'
                });
                return { decision: approvalOf(r.decision) };
            },

            rateLimits(snapshot) {
                if (!core.closed) core.emit({ type: 'ext', ns: CODEX_CLI_NS, name: 'rate-limits', data: snapshot as unknown as JsonValue });
            },

            closed(reason) {
                dead = reason;
                if (turn) settle(turn, 'exited', { message: reason });
            }
        };
        routers.set(threadId, router);

        const session: AgentSession = {
            id: threadId,
            get ref(): SessionRef {
                return { agent: agentId, v: 1, id: threadId, data: { epoch: log.epoch } };
            },
            prompt(input, promptOptions) {
                return core.startTurn(input, promptOptions, async (driver, ctx) => {
                    const parts = toPromptParts(input);
                    driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                    if (dead !== undefined) throw new AgentError('process_exited', `[codex-cli] ${dead}`);
                    let finish!: () => void;
                    const finished = new Promise<void>((resolve) => (finish = resolve));
                    const schema = outputSchemaOf(promptOptions?.output);
                    const t: TurnState = {
                        driver,
                        ctx,
                        interruptRequested: false,
                        pendingSteer: [],
                        parts: new Map(),
                        messageSeq: 0,
                        steers: 0,
                        calls: new Map(),
                        items: new Map(),
                        mcpPending: [],
                        text: new Map(),
                        wantsOutput: schema !== undefined,
                        finish
                    };
                    turn = t;
                    ctx.onSteer((steerParts) => {
                        if (driver.ended) return;
                        driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}:${++t.steers}`, parts: steerParts });
                        t.messageSeq++;
                        sendSteer(t, steerParts);
                    });
                    const onAbort = () => interrupt(t);
                    driver.signal.addEventListener('abort', onAbort, { once: true });
                    try {
                        const started = await peer.request<TurnStartResponse>('turn/start', { threadId, input: toUserInput(parts), ...(schema !== undefined ? { outputSchema: schema } : {}) });
                        t.codexTurnId ??= started.turn.id;
                        for (const queued of t.pendingSteer.splice(0)) sendSteer(t, queued);
                        if (t.interruptRequested || driver.signal.aborted) interrupt(t);
                        await finished;
                    } catch (e) {
                        if (!driver.ended) settle(t, dead !== undefined ? 'exited' : 'failed', { message: e instanceof Error ? e.message : String(e) });
                    } finally {
                        driver.signal.removeEventListener('abort', onAbort);
                        if (turn === t) turn = undefined;
                    }
                });
            },
            respond: (requestId, decision) => core.respond(requestId, decision),
            cancel: (target) => core.cancel(target),
            subscribe: (from) => core.subscribe(from),
            async close() {
                if (core.closed) return;
                const t = turn;
                if (t && !t.driver.ended) {
                    if (t.codexTurnId !== undefined) void peer.request('turn/interrupt', { threadId, turnId: t.codexTurnId }).catch(() => undefined);
                    settle(t, 'interrupted');
                }
                await core.close();
                routers.delete(threadId);
                sessions.delete(session);
                await server?.close().catch(() => undefined);
                if (dead === undefined) await peer.request('thread/unsubscribe', { threadId }, { timeoutMs: 2_000 }).catch(() => undefined);
            }
        };
        sessions.add(session);
        return session;
    }

    return {
        id: agentId,
        capabilities: CODEX_CLI_CAPABILITIES,
        session: (opts = {}) => openSession(opts),
        async dispose() {
            await Promise.all([...sessions].map((s) => s.close().catch(() => undefined)));
            const c = connection;
            connection = undefined;
            if (c) await (await c.catch(() => undefined))?.close();
        }
    };
}

/**
 * `tool`, whose calls first go through the running turn's policy — Codex runs MCP tools without asking
 * us, so the gate is here. A denied call is reported `denied` on the call Codex announced and fails
 * the MCP call with the policy's reason; an allowed one runs until it returns or the turn is cancelled.
 */
function gated(tool: AnyTool, current: () => TurnState | undefined): AnyTool {
    return Object.create(tool, {
        run: {
            value: async (raw: unknown, toolCtx: { signal: AbortSignal; toolCallId: string }) => {
                const t = current();
                if (!t || t.driver.ended) throw new Error('no turn is running on this session');
                const args = JSON.stringify(raw ?? {});
                // The call Codex announced for this invocation: the same tool and arguments, else the oldest of that tool.
                let at = t.mcpPending.findIndex((m) => m.tool === tool.name && m.args === args);
                if (at < 0) at = t.mcpPending.findIndex((m) => m.tool === tool.name);
                const callId = at >= 0 ? t.mcpPending.splice(at, 1)[0]!.itemId : undefined;
                const r = await t.ctx.resolve({
                    kind: 'permission',
                    ...(callId !== undefined ? { callId } : {}),
                    toolName: tool.name,
                    input: raw,
                    ...(tool.annotations ? { annotations: tool.annotations } : {}),
                    source: 'client',
                    permissionKey: tool.name
                });
                if (r.decision.type !== 'permission' || r.decision.outcome !== 'allow') {
                    const message = (r.decision.type === 'permission' ? r.decision.message : undefined) ?? r.reason ?? 'the platform policy denied this call';
                    const call = callId !== undefined ? t.calls.get(callId) : undefined;
                    if (call && !call.settled) {
                        call.settled = true;
                        t.driver.emit({ type: 'tool-update', callId: callId!, status: 'denied', error: message });
                    }
                    throw new Error(message);
                }
                const signal = AbortSignal.any([toolCtx.signal, t.driver.signal]);
                return tool.run(raw, { ...toolCtx, signal });
            }
        }
    }) as AnyTool;
}
