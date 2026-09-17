/**
 * A scripted `query` for `@sigx/ai-agent-claude-code`: recorded SDK message
 * shapes replayed per turn, plus the per-scenario scripts the conformance
 * suite needs. Adapted from the adapter's own test suite (signalxjs/ai,
 * packages/ai-agent-claude-code/__tests__/claude-code.test.ts, MIT).
 */
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ConformanceScenario } from '@sigx/ai-agent/testing';
import type { ListenFn } from '@sigx/ai-agent-claude-code';


// ── recorded frames ─────────────────────────────────────────────────────────

export const SESSION = 'sess-1';
const base = { session_id: SESSION, uuid: 'u' } as const;
const m = (v: unknown) => v as SDKMessage;

// `model` and `permissionMode` are echoed from the options the query was
// STARTED with, the way a real CLI reports what it actually resolved —
// hard-coding them would let a test "confirm" a state the CLI never had.
export const INIT = (cwd: string, model = 'claude-opus-5', permissionMode = 'default') =>
    m({ type: 'system', subtype: 'init', ...base, cwd, model, permissionMode, tools: ['Read', 'Edit'], mcp_servers: [], apiKeySource: 'none', claude_code_version: '2.1.270', slash_commands: [], output_style: 'default', skills: [], plugins: [], agents: [] });

const ev = (event: unknown, parent: string | null = null) => m({ type: 'stream_event', ...base, event, parent_tool_use_id: parent });
const MESSAGE = { model: 'claude-opus-5', id: 'msg_1', type: 'message', role: 'assistant', container: null, stop_reason: null, stop_sequence: null, stop_details: null, usage: { input_tokens: 2, output_tokens: 1 } } as const;

/**
 * The `assistant` frame the CLI emits for a FINISHED content block, carrying
 * only that block — and landing between the block's last delta and its
 * `content_block_stop`, which is the ordering these fixtures exist to pin
 * down (see the verbatim-order test below and issue #68).
 */
const assistantBlocks = (content: unknown[], parent: string | null = null) => m({ type: 'assistant', ...base, message: { ...MESSAGE, content }, parent_tool_use_id: parent });

export const textBlocks = (text: string, parent: string | null = null, index = 0): SDKMessage[] => [
    ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, parent),
    ...text.split(' ').map((w, i, arr) => ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: i < arr.length - 1 ? `${w} ` : w } }, parent)),
    assistantBlocks([{ type: 'text', text }], parent),
    ev({ type: 'content_block_stop', index }, parent)
];
export const messageStart = (parent: string | null = null) => ev({ type: 'message_start', message: { ...MESSAGE, content: [] } }, parent);
export const messageStop = (parent: string | null = null) => [ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null }, usage: { input_tokens: 2, output_tokens: 5 } }, parent), ev({ type: 'message_stop' }, parent)];
/** `assistant: false` is the turn that ended mid-message — no `assistant` frame ever arrives, so the reassembled partial JSON is all we have. */
export const toolUseBlocks = (id: string, name: string, input: object, index = 0, parent: string | null = null, options: { assistant?: boolean } = {}): SDKMessage[] => {
    const json = JSON.stringify(input);
    const half = Math.ceil(json.length / 2);
    return [
        ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {}, caller: { type: 'direct' } } }, parent),
        // The real CLI opens the run with an empty chunk.
        ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } }, parent),
        ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } }, parent),
        ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(half) } }, parent),
        ...(options.assistant === false ? [] : [assistantBlocks([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }], parent)]),
        ev({ type: 'content_block_stop', index }, parent)
    ];
};
export const toolResult = (id: string, content: string, isError = false, parent: string | null = null) =>
    m({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: parent });
const progress = (id: string, name: string) => m({ type: 'tool_progress', ...base, tool_use_id: id, tool_name: name, parent_tool_use_id: null, elapsed_time_seconds: 1 });
/** A `user` frame whose `tool_result` also carries the tool's structured `tool_use_result` (the Task tool's `AgentOutput`). */
const toolResultWith = (id: string, content: string, toolUseResult: unknown, isError = false) =>
    m({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, tool_use_result: toolUseResult });
// ── task frames (sub-agents), shapes from `@anthropic-ai/claude-agent-sdk` 0.3.270 ──
const sys = (subtype: string, fields: Record<string, unknown>) => m({ type: 'system', subtype, ...base, ...fields });
const taskStarted = (taskId: string, toolUseId: string | undefined, extra: Record<string, unknown> = {}) =>
    sys('task_started', { task_id: taskId, ...(toolUseId ? { tool_use_id: toolUseId } : {}), description: 'research', task_type: 'local_agent', subagent_type: 'Explore', is_backgrounded: false, spawn_depth: 1, prompt: 'find it', ...extra });
const taskNotification = (taskId: string, status: 'completed' | 'failed' | 'stopped', extra: Record<string, unknown> = {}) =>
    sys('task_notification', { task_id: taskId, status, output_file: '/tmp/task.out', summary: 'all done', usage: { total_tokens: 300, tool_uses: 3, duration_ms: 50 }, ...extra });
/** The Task tool's `tool_use_result` once a foreground sub-agent finished. */
const AGENT_OUTPUT = (agentId: string, text: string) => ({
    agentId,
    agentType: 'Explore',
    content: [{ type: 'text', text }],
    totalToolUseCount: 2,
    totalDurationMs: 40,
    totalTokens: 300,
    usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
    status: 'completed',
    prompt: 'find it'
});
export const RESULT = (extra: Record<string, unknown> = {}) =>
    m({
        type: 'result',
        subtype: 'success',
        ...base,
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        result: 'done',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
        modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0, costUSD: 0.01 } },
        permission_denials: [],
        ...extra
    });
const RESULT_ERROR = (subtype: string, extra: Record<string, unknown> = {}) =>
    m({ type: 'result', subtype, ...base, duration_ms: 10, duration_api_ms: 8, is_error: true, num_turns: 1, stop_reason: null, total_cost_usd: 0.02, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], errors: ['it broke'], ...extra });

export const fakeListen: ListenFn = async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok', headers: { Authorization: 'Bearer tok' }, server: undefined as never, close: async () => {} });

// ── the fake query ──────────────────────────────────────────────────────────

export interface TurnCtx {
    readonly options: Options;
    readonly interrupted: () => boolean;
    readonly onInterrupt: Promise<void>;
    /** Resolves with the task id the host asked to stop (`Query.stopTask`). */
    readonly onStop: Promise<string>;
    /** Ask the host's canUseTool the way the CLI would. */
    ask(name: string, input: object, toolUseID?: string): Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }>;
}
export type TurnScript = (user: SDKUserMessage, turn: number, ctx: TurnCtx) => AsyncIterable<SDKMessage> | Iterable<SDKMessage> | Promise<Iterable<SDKMessage>>;

export interface FakeQuery {
    readonly query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
    readonly calls: Options[];
    readonly interrupts: number;
    readonly closes: number;
    readonly models: string[];
    /** Task ids passed to `stopTask`. */
    readonly stops: string[];
    /** User messages the fake received, across queries. */
    readonly users: number;
    /** `(maxThinkingTokens, thinkingDisplay)` pairs passed to `setMaxThinkingTokens`. */
    readonly thinking: [number | null, string | null | undefined][];
}

export function fakeQuery(turnScript: TurnScript, options: { init?: (cwd: string, model?: string, permissionMode?: string) => SDKMessage; exitAfterTurns?: number } = {}): FakeQuery {
    const state = { calls: [] as Options[], interrupts: 0, closes: 0, models: [] as string[], stops: [] as string[], users: 0, thinking: [] as [number | null, string | null | undefined][] };
    const query: FakeQuery['query'] = ({ prompt, options: opts = {} }) => {
        state.calls.push(opts);
        let interrupted = false;
        let resolveInterrupt!: () => void;
        let onInterrupt = new Promise<void>((r) => (resolveInterrupt = r));
        let resolveStop!: (id: string) => void;
        let onStop = new Promise<string>((r) => (resolveStop = r));
        let closed = false;
        const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
            yield (options.init ?? INIT)(opts.cwd ?? '', opts.model, opts.permissionMode);
            let turn = 0;
            if (typeof prompt === 'string') return;
            for await (const user of prompt) {
                state.users++;
                if (closed) return;
                if (options.exitAfterTurns !== undefined && turn >= options.exitAfterTurns) return;
                const ctx: TurnCtx = {
                    options: opts,
                    interrupted: () => interrupted,
                    onInterrupt,
                    onStop,
                    ask: async (name, input, toolUseID) => {
                        const r = (await opts.canUseTool!(name, input as Record<string, unknown>, { signal: new AbortController().signal, suggestions: [], ...(toolUseID ? { toolUseID } : {}) } as never)) as unknown as
                            | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
                            | { behavior: 'deny'; message: string };
                        return r.behavior === 'allow' ? { behavior: 'allow', ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}) } : { behavior: 'deny', message: r.message };
                    }
                };
                const script = await turnScript(user, turn++, ctx);
                for await (const msg of script) {
                    if (closed) return;
                    yield msg;
                }
                interrupted = false;
                onInterrupt = new Promise<void>((r) => (resolveInterrupt = r));
                onStop = new Promise<string>((r) => (resolveStop = r));
            }
        })();
        const q = Object.assign(gen, {
            interrupt: async () => {
                state.interrupts++;
                interrupted = true;
                resolveInterrupt();
                return undefined;
            },
            stopTask: async (id: string) => {
                if (id === 'no-such-task') throw new Error('unknown task');
                state.stops.push(id);
                resolveStop(id);
            },
            setPermissionMode: async () => {},
            setModel: async (model?: string) => {
                state.models.push(model ?? '');
            },
            setMaxThinkingTokens: async (max: number | null, display?: string | null) => {
                state.thinking.push([max, display]);
            },
            close: () => {
                state.closes++;
                closed = true;
            }
        });
        return q as unknown as Query;
    };
    return {
        query,
        get calls() {
            return state.calls;
        },
        get interrupts() {
            return state.interrupts;
        },
        get closes() {
            return state.closes;
        },
        get models() {
            return state.models;
        },
        get stops() {
            return state.stops;
        },
        get users() {
            return state.users;
        },
        get thinking() {
            return state.thinking;
        }
    };
}

export function scriptFor(scenario: ConformanceScenario): TurnScript {
    switch (scenario.name) {
        case 'tool-permission':
        case 'headless-deny':
            return async function* (_u, _t, ctx) {
                yield messageStart();
                yield* toolUseBlocks('toolu_g', 'mcp__sigx-tools__guarded', {});
                yield* messageStop();
                const r = await ctx.ask('mcp__sigx-tools__guarded', {});
                yield toolResult('toolu_g', r.behavior === 'allow' ? '{"ok":true}' : (r.message ?? 'denied'), r.behavior === 'deny');
                yield messageStart();
                yield* textBlocks('Done.');
                yield* messageStop();
                yield RESULT();
            };
        case 'streaming-tool-input':
            return async function* (_u, _t, ctx) {
                const input = { city: 'Paris' };
                yield messageStart();
                // `toolUseBlocks` already streams the arguments in halves, the
                // way the CLI does.
                yield* toolUseBlocks('toolu_g', 'mcp__sigx-tools__guarded', input);
                yield* messageStop();
                const r = await ctx.ask('mcp__sigx-tools__guarded', input);
                yield toolResult('toolu_g', r.behavior === 'allow' ? '{"ok":true}' : (r.message ?? 'denied'), r.behavior === 'deny');
                yield messageStart();
                yield* textBlocks('Done.');
                yield* messageStop();
                yield RESULT();
            };
        case 'tool-error':
            return async function* (_u, _t, ctx) {
                yield messageStart();
                yield* toolUseBlocks('toolu_f', 'mcp__sigx-tools__failing', {});
                yield* messageStop();
                await ctx.ask('mcp__sigx-tools__failing', {});
                yield toolResult('toolu_f', 'the tool failed on purpose', true);
                yield messageStart();
                yield* textBlocks('It failed.');
                yield* messageStop();
                yield RESULT();
            };
        case 'slow-tool':
            return async function* (_u, _t, ctx) {
                yield messageStart();
                yield* toolUseBlocks('toolu_s', 'mcp__sigx-tools__slow', {});
                yield* messageStop();
                await ctx.ask('mcp__sigx-tools__slow', {});
                yield progress('toolu_s', 'mcp__sigx-tools__slow');
                await ctx.onInterrupt;
                yield RESULT_ERROR('error_during_execution');
            };
        case 'model-error':
            return () => [m({ type: 'assistant', ...base, message: { role: 'assistant', content: [] }, parent_tool_use_id: null, error: 'server_error' }), RESULT_ERROR('error_during_execution')];
        case 'input-request':
            return async function* (_u, _t, ctx) {
                const input = { questions: [{ question: 'Yes or no?', header: 'Question', multiSelect: false, options: [{ label: 'Yes', description: 'Go ahead.' }, { label: 'No', description: 'Stop.' }] }] };
                yield messageStart();
                yield* toolUseBlocks('toolu_q', 'AskUserQuestion', input);
                yield* messageStop();
                const r = await ctx.ask('AskUserQuestion', input, 'toolu_q');
                yield toolResult('toolu_q', r.behavior === 'allow' ? 'The user answered.' : (r.message ?? 'denied'), r.behavior === 'deny');
                yield messageStart();
                yield* textBlocks('Thanks.');
                yield* messageStop();
                yield RESULT();
            };
        case 'structured-output':
            return () => [messageStart(), ...textBlocks('{"ok":true}'), ...messageStop(), RESULT({ structured_output: { ok: true } })];
        case 'delegate-tree':
            // Claude Code spawns natively: a Task call, the task frames, the sub-agent's text under the call, its AgentOutput on the result.
            return async function* (_u, _t, ctx) {
                const input = { description: 'delegate', prompt: 'Do the task.', subagent_type: 'Explore' };
                yield messageStart();
                yield* toolUseBlocks('task_c', 'Task', input);
                yield* messageStop();
                await ctx.ask('Task', input);
                yield taskStarted('tc', 'task_c');
                yield messageStart('task_c');
                yield* textBlocks('Delegate reply.', 'task_c');
                yield* messageStop('task_c');
                yield toolResultWith('task_c', 'Delegate reply.', AGENT_OUTPUT('tc', 'Delegate reply.'));
                yield messageStart();
                yield* textBlocks('Done.');
                yield* messageStop();
                yield RESULT();
            };
        case 'delegate-cancel':
            // The suite stops the running sub-agent by id (stopTask); the CLI reports it stopped and the Task call settles.
            return async function* (_u, _t, ctx) {
                const input = { description: 'delegate', prompt: 'Run the slow tool.', subagent_type: 'Explore' };
                yield messageStart();
                yield* toolUseBlocks('task_s', 'Task', input);
                yield* messageStop();
                await ctx.ask('Task', input);
                yield taskStarted('ts', 'task_s');
                const stopped = await ctx.onStop;
                yield taskNotification(stopped, 'stopped', { summary: 'stopped by the operator' });
                yield toolResult('task_s', 'Agent stopped.', true);
                yield messageStart();
                yield* textBlocks('Moving on.');
                yield* messageStop();
                yield RESULT();
            };
        default:
            return () => [messageStart(), ...textBlocks('Hello!'), ...messageStop(), RESULT()];
    }
}
