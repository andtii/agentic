/**
 * `createA2aHandler` — the A2A 1.0 JSON-RPC binding as a `(Request) => Response`
 * fetch handler over a `SessionPort`. Routes:
 *
 *   GET  /.well-known/agent-card.json                 the default agent's card
 *   GET  {base}/{agentId}/.well-known/agent-card.json  that agent's card
 *   POST {base}/{agentId}                              JSON-RPC (SSE for SendStreamingMessage)
 *
 * Every refusal is a JSON-RPC error (HTTP 200): unsupported operations answer
 * `-32004` / `-32003`, never a 500.
 */

import type { A2aMessage, A2aTask, AgentCard, JsonRpcId, JsonRpcResponse, ListTasksResponse, SendMessageRequest, StreamResponse } from '../protocol/index.js';
import {
    A2A_ERROR,
    A2A_LEGACY_METHODS,
    A2A_METHODS,
    A2aError,
    AGENT_CARD_PATH,
    isTerminalState,
    parseCancelTask,
    parseGetTask,
    parseJsonRpcRequest,
    parseListTasks,
    parseSendMessage
} from '../protocol/index.js';
import { newId, sleep } from '../utils.js';
import { agentCard, cardEtag } from './card.js';
import type { ExposedAgent, SessionPort, TaskRecord, TaskStore } from './ports.js';
import { memoryTaskStore } from './ports.js';
import { startLiveTask, type LiveTask } from './tasks.js';

export interface A2aHandlerOptions {
    readonly port: SessionPort;
    /** Where the per-agent endpoints live. Default `/a2a`. */
    readonly basePath?: string;
    /** The agent `/.well-known/agent-card.json` describes; default: the only exposed agent. */
    readonly defaultAgentId?: string;
    /** Task snapshots; default in memory. */
    readonly tasks?: TaskStore;
    /** How long `CancelTask` waits for the task to reach CANCELED before answering with its current state. Default 2000. */
    readonly cancelWaitMs?: number;
    readonly now?: () => number;
}

export interface A2aHandler {
    fetch(request: Request): Promise<Response>;
    /** The card an agent would be served with at `origin`; `undefined` for an agent that is not exposed. */
    card(agentId: string, origin: string): Promise<AgentCard | undefined>;
}

const DEFAULT_PAGE = 50;

export function createA2aHandler(options: A2aHandlerOptions): A2aHandler {
    const { port } = options;
    const base = (options.basePath ?? '/a2a').replace(/\/+$/, '');
    const store = options.tasks ?? memoryTaskStore();
    const now = options.now ?? (() => Date.now());
    const cancelWaitMs = options.cancelWaitMs ?? 2000;
    const live = new Map<string, LiveTask>();

    const exposed = async (agentId: string): Promise<ExposedAgent | undefined> => (await port.agents()).find((a) => a.id === agentId);
    const endpoint = (origin: string, agentId: string) => `${origin}${base}/${encodeURIComponent(agentId)}`;

    async function cardResponse(agent: ExposedAgent | undefined, origin: string, request: Request): Promise<Response> {
        if (!agent) return new Response('Not found', { status: 404 });
        const card = agentCard(agent, endpoint(origin, agent.id));
        const etag = cardEtag(card);
        const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', etag };
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
        return new Response(JSON.stringify(card), { status: 200, headers });
    }

    // ---- tasks --------------------------------------------------------------

    const snapshotOf = (task: A2aTask, historyLength: number | undefined, includeArtifacts = true): A2aTask => {
        const { history, artifacts, ...rest } = task;
        return {
            ...rest,
            ...(includeArtifacts && artifacts ? { artifacts } : {}),
            ...(historyLength === 0 || !history ? {} : { history: historyLength === undefined ? history : history.slice(-historyLength) })
        };
    };

    async function record(agentId: string, id: string): Promise<TaskRecord> {
        const l = live.get(id);
        if (l && l.agentId === agentId) return { agentId, task: l.task, updatedAt: l.updatedAt };
        const r = await store.get(id);
        if (!r || r.agentId !== agentId) throw new A2aError(A2A_ERROR.taskNotFound, `Task "${id}" not found`);
        return r;
    }

    /** Start a task, or continue the one the message names. */
    async function send(agentId: string, params: SendMessageRequest, request: Request): Promise<LiveTask> {
        if (params.configuration?.taskPushNotificationConfig !== undefined) throw new A2aError(A2A_ERROR.pushNotificationNotSupported);
        const message = params.message;
        if (message.taskId !== undefined) {
            const l = live.get(message.taskId);
            if (!l || l.agentId !== agentId) {
                const r = await store.get(message.taskId);
                if (!r || r.agentId !== agentId) throw new A2aError(A2A_ERROR.taskNotFound, `Task "${message.taskId}" not found`);
                throw new A2aError(A2A_ERROR.unsupportedOperation, `Task "${message.taskId}" is ${r.task.status.state}; it accepts no further messages`);
            }
            if (message.contextId !== undefined && message.contextId !== l.contextId) throw new A2aError(A2A_ERROR.invalidParams, `contextId "${message.contextId}" does not match task "${l.id}" (context "${l.contextId}")`);
            await l.continue(message);
            return l;
        }
        const contextId = message.contextId ?? newId('ctx');
        const session = await port.session(agentId, contextId, request);
        const task = await startLiveTask({ session, agentId, contextId, taskId: newId('task'), message, store, now });
        live.set(task.id, task);
        void task.done.then(() => {
            live.delete(task.id);
        });
        return task;
    }

    async function listTasks(agentId: string, params: ReturnType<typeof parseListTasks>): Promise<ListTasksResponse> {
        const after = params.statusTimestampAfter !== undefined ? Date.parse(params.statusTimestampAfter) : undefined;
        if (after !== undefined && Number.isNaN(after)) throw new A2aError(A2A_ERROR.invalidParams, 'statusTimestampAfter must be an ISO 8601 timestamp');
        const merged = new Map<string, TaskRecord>();
        for (const r of await store.list()) merged.set(r.task.id, r);
        for (const l of live.values()) merged.set(l.id, { agentId: l.agentId, task: l.task, updatedAt: l.updatedAt });
        const all = [...merged.values()]
            .filter((r) => r.agentId === agentId)
            .filter((r) => params.contextId === undefined || r.task.contextId === params.contextId)
            .filter((r) => params.status === undefined || r.task.status.state === params.status)
            .filter((r) => after === undefined || r.updatedAt >= after)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const pageSize = params.pageSize ?? DEFAULT_PAGE;
        const offset = params.pageToken ? Number.parseInt(params.pageToken, 10) : 0;
        if (!Number.isInteger(offset) || offset < 0 || (params.pageToken && String(offset) !== params.pageToken)) throw new A2aError(A2A_ERROR.invalidParams, 'pageToken is not a token this server issued');
        const page = all.slice(offset, offset + pageSize);
        return {
            tasks: page.map((r) => snapshotOf(r.task, params.historyLength, params.includeArtifacts === true)),
            nextPageToken: offset + pageSize < all.length ? String(offset + pageSize) : '',
            pageSize,
            totalSize: all.length
        };
    }

    async function cancelTask(agentId: string, id: string): Promise<A2aTask> {
        const l = live.get(id);
        if (!l || l.agentId !== agentId) {
            const r = await record(agentId, id);
            throw new A2aError(A2A_ERROR.taskNotCancelable, `Task "${id}" is ${r.task.status.state}`);
        }
        if (isTerminalState(l.task.status.state)) throw new A2aError(A2A_ERROR.taskNotCancelable, `Task "${id}" is ${l.task.status.state}`);
        await l.session.cancel();
        await Promise.race([l.done, sleep(cancelWaitMs)]);
        return snapshotOf(l.task, undefined);
    }

    // ---- JSON-RPC -----------------------------------------------------------

    const reply = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    const failure = (id: JsonRpcId, e: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: e instanceof A2aError ? e.toJSON() : { code: A2A_ERROR.internal, message: e instanceof Error ? e.message : 'Internal error' } });
    const json = (body: JsonRpcResponse) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    function sse(id: JsonRpcId, task: LiveTask, request: Request, start: () => Promise<void>): Response {
        const encoder = new TextEncoder();
        const frame = (result: StreamResponse) => encoder.encode(`data: ${JSON.stringify(reply(id, result))}\n\n`);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                let open = true;
                const close = () => {
                    if (!open) return;
                    open = false;
                    unsubscribe();
                    request.signal?.removeEventListener('abort', close);
                    try {
                        controller.close();
                    } catch {
                        /* already closed */
                    }
                };
                const push = (result: StreamResponse) => {
                    if (open) controller.enqueue(frame(result));
                };
                // Subscribe before the snapshot so nothing between the two is lost — both happen in this tick.
                const unsubscribe = task.subscribe(push);
                push({ task: snapshotOf(task.task, undefined) });
                request.signal?.addEventListener('abort', close, { once: true });
                void start()
                    .then(() => task.settled())
                    .catch((e: unknown) => {
                        if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(failure(id, e))}\n\n`));
                    })
                    .finally(close);
            },
            cancel() {
                /* the reader went away; `close` ran or will run on abort */
            }
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
    }

    async function rpc(agentId: string, request: Request): Promise<Response> {
        let id: JsonRpcId = null;
        try {
            let raw: unknown;
            try {
                raw = await request.json();
            } catch {
                throw new A2aError(A2A_ERROR.parse);
            }
            const call = parseJsonRpcRequest(raw);
            id = call.id ?? null;
            const version = request.headers.get('a2a-version');
            if (version && !version.startsWith('1.')) throw new A2aError(A2A_ERROR.versionNotSupported, `A2A version "${version}" is not supported (supported: 1.0)`);
            const method = A2A_LEGACY_METHODS[call.method] ?? call.method;
            const tenant = (call.params as { tenant?: unknown } | undefined)?.tenant;
            if (tenant !== undefined && tenant !== agentId) throw new A2aError(A2A_ERROR.invalidParams, `tenant "${String(tenant)}" does not match this endpoint`);
            switch (method) {
                case A2A_METHODS.sendMessage: {
                    const params = parseSendMessage(call.params);
                    const task = await send(agentId, params, request);
                    if (!params.configuration?.returnImmediately) await task.settled();
                    return json(reply(id, { task: snapshotOf(task.task, params.configuration?.historyLength) }));
                }
                case A2A_METHODS.sendStreamingMessage: {
                    const params = parseSendMessage(call.params);
                    if (params.message.taskId !== undefined) {
                        // Continue: the stream opens on the task as it is, then the answer goes in.
                        const l = live.get(params.message.taskId);
                        if (!l || l.agentId !== agentId) {
                            const task = await send(agentId, params, request); // throws the right error
                            return sse(id, task, request, async () => {});
                        }
                        const message: A2aMessage = params.message;
                        return sse(id, l, request, () => send(agentId, { ...params, message }, request).then(() => {}));
                    }
                    const task = await send(agentId, params, request);
                    return sse(id, task, request, async () => {});
                }
                case A2A_METHODS.getTask: {
                    const params = parseGetTask(call.params);
                    const r = await record(agentId, params.id);
                    return json(reply(id, snapshotOf(r.task, params.historyLength)));
                }
                case A2A_METHODS.listTasks:
                    return json(reply(id, await listTasks(agentId, parseListTasks(call.params))));
                case A2A_METHODS.cancelTask: {
                    const params = parseCancelTask(call.params);
                    return json(reply(id, await cancelTask(agentId, params.id)));
                }
                case A2A_METHODS.subscribeToTask:
                case A2A_METHODS.getExtendedAgentCard:
                    throw new A2aError(A2A_ERROR.unsupportedOperation, `${method} is not supported by this agent`);
                case A2A_METHODS.createTaskPushNotificationConfig:
                case A2A_METHODS.getTaskPushNotificationConfig:
                case A2A_METHODS.listTaskPushNotificationConfigs:
                case A2A_METHODS.deleteTaskPushNotificationConfig:
                    throw new A2aError(A2A_ERROR.pushNotificationNotSupported);
                default:
                    throw new A2aError(A2A_ERROR.methodNotFound, `Method "${call.method}" not found`);
            }
        } catch (e) {
            return json(failure(id, e));
        }
    }

    // ---- routing ------------------------------------------------------------

    return {
        async fetch(request) {
            const url = new URL(request.url);
            if (port.authorize && !(await port.authorize(request))) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
            const path = url.pathname.replace(/\/+$/, '') || '/';
            if (path === AGENT_CARD_PATH) {
                if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
                const agents = await port.agents();
                const agent = options.defaultAgentId ? agents.find((a) => a.id === options.defaultAgentId) : agents.length === 1 ? agents[0] : undefined;
                return cardResponse(agent, url.origin, request);
            }
            if (!path.startsWith(base + '/')) return new Response('Not found', { status: 404 });
            const rest = path.slice(base.length + 1);
            const cardSuffix = rest.indexOf(AGENT_CARD_PATH);
            if (cardSuffix > 0 && rest.endsWith(AGENT_CARD_PATH)) {
                if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
                return cardResponse(await exposed(decodeURIComponent(rest.slice(0, cardSuffix))), url.origin, request);
            }
            if (rest.includes('/')) return new Response('Not found', { status: 404 });
            const agentId = decodeURIComponent(rest);
            if (!(await exposed(agentId))) return new Response('Not found', { status: 404 });
            if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
            return rpc(agentId, request);
        },
        async card(agentId, origin) {
            const agent = await exposed(agentId);
            return agent ? agentCard(agent, endpoint(origin, agentId)) : undefined;
        }
    };
}
