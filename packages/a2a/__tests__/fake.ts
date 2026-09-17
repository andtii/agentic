/** An in-process A2A server: `createA2aHandler` over a `SessionPort` whose sessions are scripted `mockAgent`s. */

import { allowAll, type AgentSession } from '@sigx/ai-agent';
import { mockAgent, type MockStep } from '@sigx/ai-agent/testing';
import { createA2aHandler, memoryTaskStore, type A2aHandler, type ExposedAgent, type SessionPort, type TaskStore } from '../src/index';

export const ORIGIN = 'http://a2a.test';
export const AGENT: ExposedAgent = { id: 'helper', name: 'Helper', description: 'A scripted helper.', version: '1.2.3', promptParts: 'text+image' };

export interface FakeServer {
    readonly handler: A2aHandler;
    readonly port: SessionPort;
    readonly store: TaskStore;
    /** Every session the port opened, by contextId. */
    readonly sessions: Map<string, AgentSession>;
    readonly endpoint: string;
    readonly cardUrl: string;
    readonly fetch: (request: Request) => Promise<Response>;
}

export interface FakeServerOptions {
    /** The steps every turn plays (or a function of the turn index). */
    readonly steps?: readonly MockStep[] | ((turn: number) => readonly MockStep[]);
    readonly agents?: readonly ExposedAgent[];
    readonly authorize?: (request: Request) => boolean;
    readonly cancelWaitMs?: number;
    readonly now?: () => number;
}

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
    const agents = options.agents ?? [AGENT];
    const sessions = new Map<string, AgentSession>();
    const store = memoryTaskStore();
    const steps = options.steps ?? [{ text: 'Hello!' }];
    const port: SessionPort = {
        agents: () => agents,
        async session(_agentId, contextId) {
            let s = sessions.get(contextId);
            if (!s) {
                const agent = mockAgent({ id: 'scripted', capabilities: { steer: false }, respond: (_input, turn) => (typeof steps === 'function' ? steps(turn) : steps) });
                s = await agent.session({ interactive: true, policy: allowAll });
                sessions.set(contextId, s);
            }
            return s;
        },
        ...(options.authorize ? { authorize: options.authorize } : {})
    };
    const handler = createA2aHandler({ port, tasks: store, ...(options.cancelWaitMs !== undefined ? { cancelWaitMs: options.cancelWaitMs } : {}), ...(options.now ? { now: options.now } : {}) });
    return {
        handler,
        port,
        store,
        sessions,
        endpoint: `${ORIGIN}/a2a/${agents[0]!.id}`,
        cardUrl: `${ORIGIN}/a2a/${agents[0]!.id}/.well-known/agent-card.json`,
        fetch: (request) => handler.fetch(request)
    };
}

/** One JSON-RPC call against the fake, returning the parsed response body. */
export async function rpc(server: FakeServer, method: string, params?: unknown, init: { id?: string | number; headers?: Record<string, string>; endpoint?: string } = {}): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } } & { status: number; contentType: string; raw: Response }> {
    const res = await server.fetch(
        new Request(init.endpoint ?? server.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...init.headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: init.id ?? 1, method, ...(params !== undefined ? { params } : {}) })
        })
    );
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? ((await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }) : {};
    return { ...body, status: res.status, contentType, raw: res };
}

/** Every `result` of an SSE response, in order. */
export async function frames(res: Response): Promise<unknown[]> {
    const text = await res.text();
    return text
        .split(/\n\n/)
        .filter((b) => b.startsWith('data:'))
        .map((b) => (JSON.parse(b.slice(5).trim()) as { result?: unknown; error?: unknown }).result ?? JSON.parse(b.slice(5).trim()));
}

export const userMessage = (text: string, extra: Record<string, unknown> = {}) => ({ messageId: `m-${Math.random().toString(36).slice(2, 8)}`, role: 'ROLE_USER', parts: [{ text }], ...extra });
