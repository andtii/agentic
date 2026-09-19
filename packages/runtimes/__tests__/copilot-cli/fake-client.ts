/**
 * A scripted stand-in for `@github/copilot-sdk`'s `CopilotClient`: sessions replay the event shapes the
 * real runtime sends (Copilot CLI 1.0.85) — `assistant.message_delta` / `assistant.message`,
 * `tool.execution_start` / `tool.execution_complete`, `assistant.usage`, `session.error`, `session.idle`
 * — and call the session's client-tool handlers, permission and user-input callbacks as it would.
 */

import type { ConformanceScenario } from '@sigx/ai-agent/testing';
import type {
    CopilotAuthStatus,
    CopilotClientInit,
    CopilotClientLike,
    CopilotEvent,
    CopilotPermissionRequest,
    CopilotPermissionResult,
    CopilotQuotaSnapshot,
    CopilotSessionConfig,
    CopilotSessionLike
} from '../../src/copilot-cli/index';

/** What the fake session does when prompted; `api` sends events and reaches the session's callbacks. */
export type CopilotScript = (api: ScriptApi, prompt: string) => Promise<void>;

export interface ScriptApi {
    readonly config: CopilotSessionConfig;
    readonly signal: AbortSignal;
    emit(type: string, data?: unknown): void;
    /** Run a client tool the way the runtime does: start, handler, complete. */
    callTool(name: string, args: unknown, toolCallId?: string): Promise<void>;
    ask(request: CopilotPermissionRequest): Promise<CopilotPermissionResult>;
    say(text: string, messageId?: string): void;
    usage(input: number, output: number): void;
    idle(): void;
}

export interface FakeClient extends CopilotClientLike {
    readonly init: CopilotClientInit;
    readonly started: number;
    readonly stopped: number;
    /** Every session config the client was handed, in order. */
    readonly configs: CopilotSessionConfig[];
    readonly resumed: string[];
    readonly prompts: string[];
}

export interface FakeClientOptions {
    readonly script?: CopilotScript;
    readonly auth?: CopilotAuthStatus;
    readonly quota?: Readonly<Record<string, CopilotQuotaSnapshot | undefined>>;
    readonly startError?: Error;
}

export const sayHello: CopilotScript = async (api) => {
    api.say('Hello!');
    api.usage(12, 3);
    api.idle();
};

let sessionCounter = 0;

export function fakeClient(init: CopilotClientInit, options: FakeClientOptions = {}): FakeClient {
    const script = options.script ?? sayHello;
    const state = { started: 0, stopped: 0 };
    const configs: CopilotSessionConfig[] = [];
    const resumed: string[] = [];
    const prompts: string[] = [];

    const open = (sessionId: string, config: CopilotSessionConfig): CopilotSessionLike => {
        const handlers = new Set<(e: CopilotEvent) => void>();
        let abort: AbortController | undefined;
        let messages = 0;
        let calls = 0;
        const emit = (type: string, data?: unknown) => {
            for (const h of handlers) h({ type, data });
        };
        return {
            sessionId,
            on(handler) {
                handlers.add(handler);
                return () => handlers.delete(handler);
            },
            async send({ prompt }) {
                prompts.push(prompt);
                abort = new AbortController();
                const signal = abort.signal;
                const api: ScriptApi = {
                    config,
                    signal,
                    emit,
                    async callTool(name, args, toolCallId = `call_${++calls}`) {
                        const tool = config.tools?.find((t) => t.name === name);
                        if (!tool) throw new Error(`fake copilot: no tool ${name}`);
                        emit('tool.execution_start', { toolCallId, toolName: name, arguments: args });
                        try {
                            const out = await tool.handler(args, { sessionId, toolCallId, toolName: name, arguments: args, signal });
                            const denied = typeof out === 'object' && out !== null && (out as { resultType?: string }).resultType === 'denied';
                            const content = typeof out === 'string' ? out : JSON.stringify(out);
                            emit('tool.execution_complete', denied ? { toolCallId, success: false, error: { message: content } } : { toolCallId, success: true, result: { content } });
                        } catch (e) {
                            if (signal.aborted) return;
                            emit('tool.execution_complete', { toolCallId, success: false, error: { message: e instanceof Error ? e.message : String(e) } });
                        }
                    },
                    ask: (request) => {
                        if (!config.onPermissionRequest) throw new Error('fake copilot: no permission handler');
                        return config.onPermissionRequest(request, { sessionId });
                    },
                    say(text, messageId = `msg_${++messages}`) {
                        const half = Math.ceil(text.length / 2);
                        emit('assistant.message_delta', { messageId, deltaContent: text.slice(0, half) });
                        emit('assistant.message_delta', { messageId, deltaContent: text.slice(half) });
                        emit('assistant.message', { messageId, content: text });
                    },
                    usage(input, output) {
                        emit('assistant.usage', { model: 'gpt-5', inputTokens: input, outputTokens: output });
                    },
                    idle() {
                        emit('session.idle', {});
                    }
                };
                void script(api, prompt).catch((e: unknown) => {
                    emit('session.error', { errorType: 'script', message: e instanceof Error ? e.message : String(e) });
                    emit('session.idle', {});
                });
                return `msg_user_${prompts.length}`;
            },
            async abort() {
                if (!abort || abort.signal.aborted) return;
                abort.abort();
                emit('abort', { reason: 'user_initiated' });
                emit('session.idle', { aborted: true });
            },
            async disconnect() {
                handlers.clear();
            }
        };
    };

    return {
        init,
        get started() {
            return state.started;
        },
        get stopped() {
            return state.stopped;
        },
        configs,
        resumed,
        prompts,
        async start() {
            if (options.startError) throw options.startError;
            state.started++;
        },
        async stop() {
            state.stopped++;
            return [];
        },
        async createSession(config) {
            configs.push(config);
            return open(`copilot_session_${++sessionCounter}`, config);
        },
        async resumeSession(sessionId, config) {
            configs.push(config);
            resumed.push(sessionId);
            return open(sessionId, config);
        },
        async getAuthStatus() {
            return options.auth ?? { isAuthenticated: true, authType: 'user', login: 'octocat' };
        },
        rpc: {
            account: {
                async getQuota() {
                    return { quotaSnapshots: options.quota ?? {} };
                }
            }
        }
    };
}

/** The script a conformance scenario needs. */
export function scriptFor(scenario: ConformanceScenario): CopilotScript {
    switch (scenario.name) {
        case 'tool-error':
            return async (api) => {
                await api.callTool('failing', {});
                api.say('The tool failed.');
                api.idle();
            };
        case 'slow-tool':
            return async (api) => {
                await api.callTool('slow', {});
            };
        case 'model-error':
            return async (api) => {
                api.emit('session.error', { errorType: 'model_call', message: 'upstream failed', statusCode: 500 });
                api.idle();
            };
        case 'input-request':
            return async (api) => {
                if (!api.config.onUserInputRequest) throw new Error('fake copilot: no user-input handler');
                const answer = await api.config.onUserInputRequest({ question: 'Which colour?', choices: ['red', 'blue'], allowFreeform: true }, { sessionId: 's' });
                api.say(`You said ${answer.answer}.`);
                api.idle();
            };
        default:
            return sayHello;
    }
}
