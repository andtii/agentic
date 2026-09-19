/**
 * A scripted `codex app-server` for tests: answers the requests the driver sends the way
 * codex-cli 0.155.1 does, and plays a script per turn — agent-message deltas, tool items, MCP
 * calls made for real over the session's loopback tool server, approval and input requests,
 * token usage, `turn/completed`. No process, no model.
 */

import type { ConformanceScenario } from '@sigx/ai-agent/testing';
import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import type { CodexConnection, CodexPeer } from '../../src/codex-cli/index';

export const INFO = { userAgent: 'agentic/0.155.1 (test)', codexHome: '/codex-home', platformFamily: 'windows', platformOs: 'windows' };

export const ENV: LocalEnvironment = { id: 'environment_work' as EnvironmentId, name: 'work', runtime: 'codex-cli', profileDir: 'C:\\profiles\\work', cwdRoots: ['C:\\work'], concurrency: 2 };

type Handler = (params: unknown, ctx: { id: number; method: string; signal: AbortSignal }) => unknown;

interface ThreadState {
    readonly id: string;
    mcp?: { url: string; headers: Record<string, string> };
}

export interface ActiveTurn {
    readonly threadId: string;
    readonly turnId: string;
    readonly input: unknown;
    readonly outputSchema: unknown;
    readonly steers: unknown[];
    done: boolean;
    readonly interrupted: AbortController;
}

export type TurnScript = (s: TurnApi) => Promise<void>;

export interface TurnApi {
    readonly turn: ActiveTurn;
    readonly server: FakeAppServer;
    text(text: string): void;
    /** A command Codex runs itself; asks approval first when `ask` is set, and returns the decision. */
    command(command: string, options?: { ask?: boolean }): Promise<string | undefined>;
    /** Calls a client tool over the session's MCP server, as Codex would. */
    mcp(tool: string, args?: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
    ask(method: string, params: Record<string, unknown>): Promise<unknown>;
    usage(input: number, output: number): void;
    error(message: string, willRetry?: boolean): void;
    complete(status?: 'completed' | 'failed' | 'interrupted', error?: { message: string }): void;
    /** Resolves once a steer arrived (or after `ms`). */
    steered(ms?: number): Promise<boolean>;
}

let serial = 0;

export class FakeAppServer {
    readonly requests: { method: string; params: unknown }[] = [];
    readonly threads = new Map<string, ThreadState>();
    readonly turns: ActiveTurn[] = [];
    account: unknown = { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'team' }, requiresOpenaiAuth: true };
    rateLimits: unknown = undefined;
    closedCount = 0;
    private readonly notifications = new Map<string, Set<(p: unknown) => void>>();
    private readonly handlers = new Map<string, Handler>();
    private steerWaiters: (() => void)[] = [];
    private resolveClosed!: (v: { reason: 'eof' | 'closed' | 'error'; error?: Error }) => void;
    readonly closed = new Promise<{ reason: 'eof' | 'closed' | 'error'; error?: Error }>((r) => (this.resolveClosed = r));

    constructor(private readonly script: TurnScript = defaultScript) {}

    readonly peer: CodexPeer = {
        request: (async (method: string, params?: unknown) => {
            this.requests.push({ method, params });
            return this.handle(method, params);
        }) as CodexPeer['request'],
        notify: async () => undefined,
        onRequest: ((method: string, handler: Handler) => {
            this.handlers.set(method, handler);
            return () => this.handlers.delete(method);
        }) as CodexPeer['onRequest'],
        onNotification: ((method: string, handler: (p: unknown) => void) => {
            const set = this.notifications.get(method) ?? new Set();
            set.add(handler);
            this.notifications.set(method, set);
            return () => set.delete(handler);
        }) as CodexPeer['onNotification'],
        closed: this.closed,
        close: async () => {
            this.closedCount++;
            this.resolveClosed({ reason: 'closed' });
        }
    };

    connection(): CodexConnection {
        return { peer: this.peer, info: INFO, close: () => this.peer.close() };
    }

    /** The process dies. */
    exit(message = 'codex exited'): void {
        this.resolveClosed({ reason: 'error', error: new Error(message) });
    }

    emit(method: string, params: unknown): void {
        for (const h of this.notifications.get(method) ?? []) h(params);
    }

    async ask(method: string, params: unknown): Promise<unknown> {
        const h = this.handlers.get(method);
        if (!h) throw new Error(`no handler for ${method}`);
        return h(params, { id: ++serial, method, signal: new AbortController().signal });
    }

    private handle(method: string, params: unknown): unknown {
        const p = (params ?? {}) as Record<string, unknown>;
        switch (method) {
            case 'thread/start':
            case 'thread/resume': {
                const id = method === 'thread/resume' ? String(p.threadId) : `thr_${++serial}`;
                const config = p.config as { mcp_servers?: Record<string, { url: string; http_headers: Record<string, string> }> } | null;
                const mcp = config?.mcp_servers?.agentic;
                this.threads.set(id, { id, ...(mcp ? { mcp: { url: mcp.url, headers: mcp.http_headers } } : {}) });
                return { thread: { id }, model: 'gpt-test' };
            }
            case 'turn/start': {
                const turn: ActiveTurn = { threadId: String(p.threadId), turnId: `turn_${++serial}`, input: p.input, outputSchema: p.outputSchema, steers: [], done: false, interrupted: new AbortController() };
                this.turns.push(turn);
                setTimeout(() => void this.play(turn), 0);
                return { turn: { id: turn.turnId, status: 'inProgress', error: null } };
            }
            case 'turn/steer': {
                const turn = this.turns.find((t) => t.turnId === p.expectedTurnId && !t.done);
                if (!turn) throw new Error('no active turn to steer');
                turn.steers.push(p.input);
                this.wakeSteers();
                return { turnId: turn.turnId };
            }
            case 'turn/interrupt': {
                const turn = this.turns.find((t) => t.turnId === p.turnId);
                if (turn && !turn.done) {
                    turn.interrupted.abort();
                    this.api(turn).complete('interrupted');
                }
                return {};
            }
            case 'account/read':
                return this.account;
            case 'account/rateLimits/read':
                if (this.rateLimits === undefined) throw new Error('no rate limits');
                return this.rateLimits;
            default:
                return {};
        }
    }

    private async play(turn: ActiveTurn): Promise<void> {
        const api = this.api(turn);
        this.emit('turn/started', { threadId: turn.threadId, turn: { id: turn.turnId, status: 'inProgress', error: null } });
        try {
            await this.script(api);
        } catch (e) {
            if (!turn.done) api.complete('failed', { message: e instanceof Error ? e.message : String(e) });
        }
        if (!turn.done) api.complete();
    }

    api(turn: ActiveTurn): TurnApi {
        return turnApi(this, turn);
    }

    /** Wakes every script waiting in `steered()`. */
    wakeSteers(): void {
        for (const w of this.steerWaiters.splice(0)) w();
    }

    waitForSteer(w: () => void): void {
        this.steerWaiters.push(w);
    }
}

function turnApi(server: FakeAppServer, turn: ActiveTurn): TurnApi {
        const ids = { threadId: turn.threadId, turnId: turn.turnId };
        const emit = (method: string, params: Record<string, unknown>) => {
            if (!turn.done) server.emit(method, { ...ids, ...params });
        };
        return {
            turn,
            server,
            text(text) {
                const itemId = `msg_${++serial}`;
                emit('item/started', { item: { type: 'agentMessage', id: itemId, text: '' } });
                const half = Math.ceil(text.length / 2);
                for (const delta of [text.slice(0, half), text.slice(half)]) if (delta) emit('item/agentMessage/delta', { itemId, delta });
                emit('item/completed', { item: { type: 'agentMessage', id: itemId, text } });
            },
            async command(command, options = {}) {
                const itemId = `cmd_${++serial}`;
                const item = { type: 'commandExecution', id: itemId, command, cwd: 'C:\\work\\repo', status: 'inProgress', aggregatedOutput: null, exitCode: null };
                emit('item/started', { item });
                let decision: string | undefined;
                if (options.ask) decision = ((await server.ask('item/commandExecution/requestApproval', { ...ids, itemId, command, cwd: item.cwd, reason: null })) as { decision: string }).decision;
                const ran = !options.ask || decision === 'accept' || decision === 'acceptForSession';
                emit('item/completed', { item: { ...item, status: ran ? 'completed' : 'declined', aggregatedOutput: ran ? 'ok\n' : null, exitCode: ran ? 0 : null } });
                return decision;
            },
            async mcp(tool, args = {}) {
                const thread = server.threads.get(turn.threadId);
                if (!thread?.mcp) throw new Error('the thread has no MCP server configured');
                const itemId = `mcp_${++serial}`;
                const item = { type: 'mcpToolCall', id: itemId, server: 'agentic', tool, status: 'inProgress', arguments: args, result: null, error: null };
                emit('item/started', { item });
                const res = await fetch(thread.mcp.url, {
                    method: 'POST',
                    headers: { ...thread.mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
                    signal: turn.interrupted.signal
                });
                const body = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean; structuredContent?: unknown }; error?: { message: string } };
                const text = body.result?.content.map((c) => c.text).join('') ?? body.error?.message ?? '';
                const ok = !!body.result && !body.result.isError;
                emit('item/completed', {
                    item: { ...item, status: ok ? 'completed' : 'failed', result: ok ? { content: body.result!.content, structuredContent: body.result!.structuredContent ?? null } : null, error: ok ? null : { message: text } }
                });
                return { ok, text };
            },
            ask: (method, params) => server.ask(method, { ...ids, ...params }),
            usage(input, output) {
                const b = { totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 };
                emit('thread/tokenUsage/updated', { tokenUsage: { total: b, last: b, modelContextWindow: null } });
            },
            error(message, willRetry = false) {
                emit('error', { error: { message, codexErrorInfo: null, additionalDetails: null }, willRetry });
            },
            complete(status = 'completed', error) {
                if (turn.done) return;
                server.emit('turn/completed', { threadId: turn.threadId, turn: { id: turn.turnId, status, error: error ? { message: error.message, codexErrorInfo: null } : null } });
                turn.done = true;
            },
            steered(ms = 2_000) {
                if (turn.steers.length > 0) return Promise.resolve(true);
                return new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(false), ms);
                    server.waitForSteer(() => {
                        clearTimeout(timer);
                        resolve(true);
                    });
                });
            }
        };
}

export const defaultScript: TurnScript = async (s) => {
    s.text('Hello from Codex.');
    s.usage(12, 5);
};

/** The turn script that plays one conformance scenario. */
export function scriptFor(scenario: ConformanceScenario): TurnScript {
    switch (scenario.name) {
        case 'tool-error':
            return async (s) => {
                await s.mcp('failing');
                s.text('The tool failed.');
            };
        case 'slow-tool':
            return async (s) => {
                await s.mcp('slow').catch(() => undefined);
            };
        case 'model-error':
            return async (s) => {
                s.error('upstream model failed');
                s.complete('failed', { message: 'upstream model failed' });
            };
        case 'input-request':
            return async (s) => {
                await s.ask('item/tool/requestUserInput', { itemId: 'ask_1', questions: [{ id: 'answer', header: 'Question', question: 'Proceed?', isOther: false, isSecret: false, options: null }], isBlocking: true, autoResolutionMs: null });
                s.text('Thanks.');
            };
        case 'structured-output':
            return async (s) => {
                s.text('{"ok":true}');
            };
        case 'steer':
            return async (s) => {
                await s.mcp('delayed');
                await s.steered();
                s.text('Done, and thanks.');
            };
        default:
            return defaultScript;
    }
}

/** A `connect` that hands every agent its own fake app-server (kept in `servers`). */
export function fakeConnect(script: TurnScript = defaultScript) {
    const servers: FakeAppServer[] = [];
    const connect = async () => {
        const server = new FakeAppServer(script);
        servers.push(server);
        return server.connection();
    };
    return { connect, servers };
}
