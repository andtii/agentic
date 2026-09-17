// @vitest-environment node
/** The server: cards, the five supported methods, refusals that are JSON-RPC errors and never a 500. */
import { A2A_ERROR, AGENTIC_EXTENSION_URI, DECISION_MEDIA_TYPE, EVENT_MEDIA_TYPE, type A2aTask, type AgentCard, type StreamResponse } from '../src/index';
import { AGENT, ORIGIN, fakeServer, frames, rpc, userMessage } from './fake';

const asTask = (r: { result?: unknown }) => (r.result as { task: A2aTask }).task;

describe('agent cards', () => {
    it('serves the only exposed agent at the well-known path, with caching headers', async () => {
        const server = fakeServer();
        const res = await server.fetch(new Request(`${ORIGIN}/.well-known/agent-card.json`));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(res.headers.get('etag')).toMatch(/^W\/"1\.2\.3-/);
        const card = (await res.json()) as AgentCard;
        expect(card).toMatchObject({
            name: 'Helper',
            version: '1.2.3',
            supportedInterfaces: [{ url: `${ORIGIN}/a2a/helper`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
            capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
            defaultInputModes: ['text/plain', 'image/*'],
            skills: [{ id: 'chat', name: 'Helper' }]
        });
        expect(card.capabilities.extensions?.map((e) => e.uri)).toEqual([AGENTIC_EXTENSION_URI]);
        const again = await server.fetch(new Request(`${ORIGIN}/.well-known/agent-card.json`, { headers: { 'if-none-match': res.headers.get('etag')! } }));
        expect(again.status).toBe(304);
    });
    it('serves one card per agent under the base path and 404s the rest', async () => {
        const other = { id: 'other', name: 'Other', description: 'Another one.' };
        const server = fakeServer({ agents: [AGENT, other] });
        expect((await server.fetch(new Request(`${ORIGIN}/.well-known/agent-card.json`))).status).toBe(404); // two agents, no default
        const res = await server.fetch(new Request(`${ORIGIN}/a2a/other/.well-known/agent-card.json`));
        expect(((await res.json()) as AgentCard).name).toBe('Other');
        expect((await server.fetch(new Request(`${ORIGIN}/a2a/nope/.well-known/agent-card.json`))).status).toBe(404);
        expect((await server.fetch(new Request(`${ORIGIN}/elsewhere`))).status).toBe(404);
        expect((await server.fetch(new Request(`${ORIGIN}/a2a/helper`, { method: 'GET' }))).status).toBe(405);
        expect(await server.handler.card('other', ORIGIN)).toMatchObject({ name: 'Other' });
        expect(await server.handler.card('nope', ORIGIN)).toBeUndefined();
    });
    it('gates every request through the port', async () => {
        const server = fakeServer({ authorize: (r) => r.headers.get('authorization') === 'Bearer ok' });
        expect((await server.fetch(new Request(`${ORIGIN}/.well-known/agent-card.json`))).status).toBe(401);
        expect((await server.fetch(new Request(`${ORIGIN}/.well-known/agent-card.json`, { headers: { authorization: 'Bearer ok' } }))).status).toBe(200);
    });
});

describe('SendMessage', () => {
    it('runs a turn as a task and blocks until it completes', async () => {
        const server = fakeServer({ steps: [{ text: 'Hello there.' }, { usage: { inputTokens: 1, outputTokens: 2 } }] });
        const r = await rpc(server, 'SendMessage', { message: userMessage('Hi') });
        expect(r.status).toBe(200);
        const task = asTask(r);
        expect(task.id).toMatch(/^task_/);
        expect(task.contextId).toMatch(/^ctx_/);
        expect(task.status.state).toBe('TASK_STATE_COMPLETED');
        expect(task.status.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        expect(task.artifacts?.map((a) => a.parts.map((p) => p.text).join(''))).toEqual(['Hello there.']);
        expect(task.history?.map((m) => m.role)).toEqual(['ROLE_USER', 'ROLE_AGENT']);
        expect(task.history?.[1]?.parts).toEqual([{ text: 'Hello there.' }]);
        // The turn result travels on the terminal status as an event part.
        const result = task.status.message?.parts.find((p) => p.mediaType === EVENT_MEDIA_TYPE)?.data as { type: string; stopReason: string; usage?: unknown };
        expect(result).toMatchObject({ type: 'turn-end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } });
    });
    it('keeps a context across tasks and honours a client contextId', async () => {
        const server = fakeServer();
        const first = asTask(await rpc(server, 'SendMessage', { message: userMessage('one', { contextId: 'ctx-mine' }) }));
        const second = asTask(await rpc(server, 'SendMessage', { message: userMessage('two', { contextId: 'ctx-mine' }) }));
        expect(first.contextId).toBe('ctx-mine');
        expect(second.contextId).toBe('ctx-mine');
        expect(first.id).not.toBe(second.id);
        expect(server.sessions.size).toBe(1);
    });
    it('returns at once with returnImmediately', async () => {
        const server = fakeServer({ steps: [{ tool: { name: 'slow', delayMs: 60_000 } }] });
        const task = asTask(await rpc(server, 'SendMessage', { message: userMessage('go'), configuration: { returnImmediately: true } }));
        expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(task.status.state);
        const cancelled = (await rpc(server, 'CancelTask', { id: task.id })).result as A2aTask;
        expect(cancelled.status.state).toBe('TASK_STATE_CANCELED');
    });
    it('stops at INPUT_REQUIRED and continues with a message on the task', async () => {
        const server = fakeServer({ steps: [{ request: { kind: 'input', message: 'Red or blue?' } }, { text: 'Blue it is.' }] });
        const waiting = asTask(await rpc(server, 'SendMessage', { message: userMessage('Pick') }));
        expect(waiting.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
        expect(waiting.status.message?.parts[0]).toEqual({ text: 'Red or blue?' });
        expect(waiting.status.message?.parts[1]).toMatchObject({ mediaType: EVENT_MEDIA_TYPE, data: { type: 'request', kind: 'input' } });
        // A second task on the context while this one waits is refused, not crashed.
        const busy = await rpc(server, 'SendMessage', { message: userMessage('another', { contextId: waiting.contextId }) });
        expect(busy.error?.code).toBe(A2A_ERROR.unsupportedOperation);
        const done = asTask(await rpc(server, 'SendMessage', { message: userMessage('blue', { taskId: waiting.id }) }));
        expect(done.id).toBe(waiting.id);
        expect(done.status.state).toBe('TASK_STATE_COMPLETED');
        expect(done.history?.map((m) => m.role)).toEqual(['ROLE_USER', 'ROLE_AGENT', 'ROLE_USER', 'ROLE_AGENT']);
        expect(done.artifacts?.[0]?.parts[0]?.text).toBe('Blue it is.');
        // Terminal: no further messages.
        const after = await rpc(server, 'SendMessage', { message: userMessage('more', { taskId: waiting.id }) });
        expect(after.error?.code).toBe(A2A_ERROR.unsupportedOperation);
    });
    it('answers a permission request from a decision part', async () => {
        const server = fakeServer({ steps: [{ tool: { name: 'guarded', source: 'client', output: { ok: true } } }, { text: 'Done.' }] });
        // The scripted session's policy allows everything; a port session that asks would surface INPUT_REQUIRED with kind: permission.
        const task = asTask(await rpc(server, 'SendMessage', { message: userMessage('go') }));
        expect(task.status.state).toBe('TASK_STATE_COMPLETED');
        // Decision parts are read when a request IS pending: exercise the reader through a mismatch.
        const stray = await rpc(server, 'SendMessage', { message: { ...userMessage('x', { taskId: task.id }), parts: [{ data: { type: 'permission', outcome: 'allow', scope: 'once' }, mediaType: DECISION_MEDIA_TYPE }] } });
        expect(stray.error?.code).toBe(A2A_ERROR.unsupportedOperation);
    });
    it('rejects a contextId that does not match the task', async () => {
        const server = fakeServer({ steps: [{ request: { kind: 'input' } }, { text: 'ok' }] });
        const waiting = asTask(await rpc(server, 'SendMessage', { message: userMessage('Pick') }));
        const r = await rpc(server, 'SendMessage', { message: userMessage('x', { taskId: waiting.id, contextId: 'ctx-other' }) });
        expect(r.error?.code).toBe(A2A_ERROR.invalidParams);
    });
    it('reports a failed turn as FAILED with the error', async () => {
        const server = fakeServer({ steps: [{ error: { code: 'provider_error', message: 'the model is down' } }] });
        const task = asTask(await rpc(server, 'SendMessage', { message: userMessage('go') }));
        expect(task.status.state).toBe('TASK_STATE_FAILED');
        const result = task.status.message?.parts[0]?.data as { error?: { message: string } };
        expect(result.error?.message).toBe('the model is down');
    });
});

describe('SendStreamingMessage', () => {
    it('streams the task, artifact chunks and the terminal status as SSE frames', async () => {
        const server = fakeServer({ steps: [{ text: 'Hello world', chunkSize: 6 }, { tool: { name: 'lookup', input: { q: 1 }, output: { hits: 2 } } }] });
        const res = await server.fetch(
            new Request(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'SendStreamingMessage', params: { message: userMessage('hi') } }) })
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const list = (await frames(res)) as StreamResponse[];
        expect('task' in list[0]!).toBe(true);
        const types = list.map((f) => Object.keys(f)[0]);
        expect(types[0]).toBe('task');
        expect(types.at(-1)).toBe('statusUpdate');
        const artifactText = list.filter((f): f is { artifactUpdate: Extract<StreamResponse, { artifactUpdate: unknown }>['artifactUpdate'] } => 'artifactUpdate' in f).map((f) => f.artifactUpdate.artifact.parts[0]?.text ?? '').join('');
        expect(artifactText).toBe('Hello world');
        const last = list.at(-1) as { statusUpdate: { status: { state: string } } };
        expect(last.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
        const carried = list.filter((f) => 'statusUpdate' in f).flatMap((f) => (f as { statusUpdate: { status: { message?: { parts: { data?: { type?: string } }[] } } } }).statusUpdate.status.message?.parts.map((p) => p.data?.type) ?? []);
        expect(carried).toContain('tool-call');
        expect(carried).toContain('tool-update');
        // Every frame is a JSON-RPC response with the request id.
        const raw = await server.fetch(
            new Request(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'SendStreamingMessage', params: { message: userMessage('hi') } }) })
        );
        expect((await raw.text()).split('\n\n')[0]).toMatch(/^data: \{"jsonrpc":"2\.0","id":7,"result":\{"task":/);
    });
    it('closes the stream at INPUT_REQUIRED and reopens on the answer', async () => {
        const server = fakeServer({ steps: [{ request: { kind: 'input', message: 'Which?' } }, { text: 'Thanks.' }] });
        const post = (params: unknown) =>
            server.fetch(new Request(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params }) }));
        const first = (await frames(await post({ message: userMessage('go') }))) as StreamResponse[];
        const stop = first.at(-1) as { statusUpdate: { taskId: string; status: { state: string } } };
        expect(stop.statusUpdate.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
        const second = (await frames(await post({ message: userMessage('that one', { taskId: stop.statusUpdate.taskId }) }))) as StreamResponse[];
        expect('task' in second[0]!).toBe(true);
        expect((second.at(-1) as { statusUpdate: { status: { state: string } } }).statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
    });
});

describe('GetTask / ListTasks / CancelTask', () => {
    it('gets a task with history trimmed to historyLength', async () => {
        const server = fakeServer();
        const task = asTask(await rpc(server, 'SendMessage', { message: userMessage('hi') }));
        const full = (await rpc(server, 'GetTask', { id: task.id })).result as A2aTask;
        expect(full.history?.length).toBe(2);
        const one = (await rpc(server, 'GetTask', { id: task.id, historyLength: 1 })).result as A2aTask;
        expect(one.history?.length).toBe(1);
        const none = (await rpc(server, 'GetTask', { id: task.id, historyLength: 0 })).result as A2aTask;
        expect(none.history).toBeUndefined();
        expect((await rpc(server, 'GetTask', { id: 'task_nope' })).error?.code).toBe(A2A_ERROR.taskNotFound);
    });
    it('lists tasks newest first, filtered and paged, artifacts only on request', async () => {
        const server = fakeServer();
        const a = asTask(await rpc(server, 'SendMessage', { message: userMessage('a', { contextId: 'c1' }) }));
        const b = asTask(await rpc(server, 'SendMessage', { message: userMessage('b', { contextId: 'c2' }) }));
        const all = (await rpc(server, 'ListTasks', {})).result as { tasks: A2aTask[]; nextPageToken: string; pageSize: number; totalSize: number };
        expect(all.tasks.map((t) => t.id)).toEqual([b.id, a.id]);
        expect(all).toMatchObject({ nextPageToken: '', pageSize: 50, totalSize: 2 });
        expect(all.tasks[0]).not.toHaveProperty('artifacts');
        const withArtifacts = (await rpc(server, 'ListTasks', { includeArtifacts: true })).result as { tasks: A2aTask[] };
        expect(withArtifacts.tasks[0]?.artifacts?.length).toBe(1);
        const c1 = (await rpc(server, 'ListTasks', { contextId: 'c1' })).result as { tasks: A2aTask[] };
        expect(c1.tasks.map((t) => t.id)).toEqual([a.id]);
        const none = (await rpc(server, 'ListTasks', { status: 'TASK_STATE_WORKING' })).result as { tasks: A2aTask[] };
        expect(none.tasks).toEqual([]);
        const page1 = (await rpc(server, 'ListTasks', { pageSize: 1 })).result as { tasks: A2aTask[]; nextPageToken: string };
        expect(page1.tasks.map((t) => t.id)).toEqual([b.id]);
        expect(page1.nextPageToken).toBe('1');
        const page2 = (await rpc(server, 'ListTasks', { pageSize: 1, pageToken: page1.nextPageToken })).result as { tasks: A2aTask[]; nextPageToken: string };
        expect(page2.tasks.map((t) => t.id)).toEqual([a.id]);
        expect(page2.nextPageToken).toBe('');
        expect((await rpc(server, 'ListTasks', { pageToken: 'garbage' })).error?.code).toBe(A2A_ERROR.invalidParams);
        expect((await rpc(server, 'ListTasks', { pageSize: 0 })).error?.code).toBe(A2A_ERROR.invalidParams);
    });
    it('cancels a running task and refuses a finished one', async () => {
        const server = fakeServer({ steps: [{ tool: { name: 'slow', delayMs: 60_000 } }] });
        const task = asTask(await rpc(server, 'SendMessage', { message: userMessage('go'), configuration: { returnImmediately: true } }));
        const cancelled = (await rpc(server, 'CancelTask', { id: task.id })).result as A2aTask;
        expect(cancelled.status.state).toBe('TASK_STATE_CANCELED');
        expect((await rpc(server, 'CancelTask', { id: task.id })).error?.code).toBe(A2A_ERROR.taskNotCancelable);
        expect((await rpc(server, 'CancelTask', { id: 'task_nope' })).error?.code).toBe(A2A_ERROR.taskNotFound);
    });
});

describe('refusals are JSON-RPC errors, never a 500', () => {
    const cases: [string, unknown, number][] = [
        ['SubscribeToTask', { id: 'x' }, A2A_ERROR.unsupportedOperation],
        ['GetExtendedAgentCard', undefined, A2A_ERROR.unsupportedOperation],
        ['CreateTaskPushNotificationConfig', { taskId: 'x' }, A2A_ERROR.pushNotificationNotSupported],
        ['GetTaskPushNotificationConfig', { taskId: 'x' }, A2A_ERROR.pushNotificationNotSupported],
        ['ListTaskPushNotificationConfigs', { taskId: 'x' }, A2A_ERROR.pushNotificationNotSupported],
        ['DeleteTaskPushNotificationConfig', { taskId: 'x' }, A2A_ERROR.pushNotificationNotSupported],
        ['tasks/resubscribe', { id: 'x' }, A2A_ERROR.unsupportedOperation],
        ['NoSuchMethod', {}, A2A_ERROR.methodNotFound]
    ];
    it.each(cases)('%s → %s', async (method, params, code) => {
        const server = fakeServer();
        const r = await rpc(server, method, params);
        expect(r.status).toBe(200);
        expect(r.error?.code).toBe(code);
        expect(r.result).toBeUndefined();
    });
    it('carries a google.rpc.ErrorInfo detail on A2A-specific errors', async () => {
        const r = await rpc(fakeServer(), 'SubscribeToTask', { id: 'x' });
        expect(r.error?.data).toEqual([{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'UNSUPPORTED_OPERATION', domain: 'a2a-protocol.org' }]);
    });
    it('refuses push notification config on SendMessage', async () => {
        const r = await rpc(fakeServer(), 'SendMessage', { message: userMessage('hi'), configuration: { taskPushNotificationConfig: { url: 'https://x' } } });
        expect(r.error?.code).toBe(A2A_ERROR.pushNotificationNotSupported);
    });
    it('validates JSON, the envelope and the parameters', async () => {
        const server = fakeServer();
        const bad = await server.fetch(new Request(server.endpoint, { method: 'POST', body: '{not json' }));
        expect(bad.status).toBe(200);
        expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(A2A_ERROR.parse);
        const envelope = await server.fetch(new Request(server.endpoint, { method: 'POST', body: JSON.stringify({ id: 1, method: 'GetTask' }) }));
        expect(((await envelope.json()) as { error: { code: number } }).error.code).toBe(A2A_ERROR.invalidRequest);
        const params = await rpc(server, 'SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [] } });
        expect(params.error?.code).toBe(A2A_ERROR.invalidParams);
        expect(params.error?.data).toEqual([{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [expect.objectContaining({ field: 'params.message.parts' })] }]);
        const twoKinds = await rpc(server, 'SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'a', data: 1 }] } });
        expect(twoKinds.error?.code).toBe(A2A_ERROR.invalidParams);
        const tenant = await rpc(server, 'GetTask', { id: 'x', tenant: 'someone-else' });
        expect(tenant.error?.code).toBe(A2A_ERROR.invalidParams);
    });
    it('refuses another protocol version and accepts 1.x', async () => {
        const server = fakeServer();
        expect((await rpc(server, 'ListTasks', {}, { headers: { 'a2a-version': '0.3' } })).error?.code).toBe(A2A_ERROR.versionNotSupported);
        expect((await rpc(server, 'ListTasks', {}, { headers: { 'a2a-version': '1.0' } })).result).toBeDefined();
    });
    it('accepts the 0.3 method names as aliases', async () => {
        const server = fakeServer();
        const task = asTask(await rpc(server, 'message/send', { message: userMessage('hi') }));
        expect(task.status.state).toBe('TASK_STATE_COMPLETED');
        expect(((await rpc(server, 'tasks/get', { id: task.id })).result as A2aTask).id).toBe(task.id);
    });
    it('turns a port failure into an internal error, not a thrown 500', async () => {
        const server = fakeServer();
        const broken = { ...server.port, session: async () => Promise.reject(new Error('no session for you')) };
        const { createA2aHandler } = await import('../src/index');
        const handler = createA2aHandler({ port: broken });
        const res = await handler.fetch(new Request(server.endpoint, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: userMessage('hi') } }) }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { error: { code: number; message: string } }).error).toEqual({ code: A2A_ERROR.internal, message: 'no session for you' });
    });
});
