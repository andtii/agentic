// @vitest-environment node
/** The client: capabilities from the card (AC-14), streaming and polling turns, cancel, and plain A2A servers without the extension. */
import type { AgentEvent } from '@sigx/ai-agent';
import { a2aAgent, agentCard, capabilitiesFrom, cardUrlFor, supportFrom, A2A_UNSUPPORTED, type AgentCard, type StreamResponse } from '../src/index';
import { AGENT, ORIGIN, fakeServer } from './fake';

async function collect(turn: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of turn) out.push(e);
    return out;
}
const textOf = (events: AgentEvent[]) => events.map((e) => (e.type === 'part-delta' ? e.delta : '')).join('');

describe('capabilities from the card (AC-14)', () => {
    it('are conservative until connect(), then what the card declares', async () => {
        const server = fakeServer();
        const agent = a2aAgent(ORIGIN, { fetch: server.fetch });
        expect(agent.id).toBe('a2a:a2a.test');
        expect(agent.card).toBeUndefined();
        expect(agent.capabilities).toMatchObject({ cancel: true, resume: false, promptParts: 'text', permissions: 'none' });
        const card = await agent.connect();
        expect(card.name).toBe('Helper');
        expect(agent.capabilities).toEqual(capabilitiesFrom(card));
        expect(agent.capabilities).toMatchObject({ promptParts: 'text+image', permissions: 'harness-filtered', tools: 'none', subagents: 'none', steer: false, structuredOutput: false });
        expect(agent.a2a).toMatchObject({ streaming: true, pushNotifications: false, extendedAgentCard: false, agentic: true, unsupported: A2A_UNSUPPORTED });
        expect(agent.a2a?.skills.map((s) => s.id)).toEqual(['chat']);
        expect(agent.a2a?.unsupported).toContain('push-notifications');
    });
    it('reads a plain card without the extension as text-only, asking nothing', () => {
        const card: AgentCard = { ...agentCard(AGENT, `${ORIGIN}/x`), capabilities: { streaming: false }, defaultInputModes: ['text/plain'] };
        expect(capabilitiesFrom(card)).toMatchObject({ promptParts: 'text', permissions: 'none', cancel: true });
        expect(supportFrom(card)).toMatchObject({ streaming: false, agentic: false, extensions: [] });
        expect(capabilitiesFrom({ ...card, defaultInputModes: ['text/plain', 'application/pdf'] }).promptParts).toBe('text+image+file');
    });
    it('resolves an origin or a card URL', () => {
        expect(cardUrlFor('http://a2a.test')).toBe('http://a2a.test/.well-known/agent-card.json');
        expect(cardUrlFor('http://a2a.test/a2a/helper/')).toBe('http://a2a.test/a2a/helper/.well-known/agent-card.json');
        expect(cardUrlFor('http://a2a.test/cards/helper.json')).toBe('http://a2a.test/cards/helper.json');
    });
    it('sends the bearer token and refuses a card that is not one', async () => {
        const seen: string[] = [];
        const server = fakeServer({ authorize: (r) => (seen.push(r.headers.get('authorization') ?? ''), true) });
        const agent = a2aAgent(server.cardUrl, { fetch: server.fetch, auth: 'tok' });
        await agent.connect();
        expect(seen).toEqual(['Bearer tok']);
        const notCard = a2aAgent('http://x.test/nope.json', { fetch: async () => new Response(JSON.stringify({ hello: 1 }), { headers: { 'content-type': 'application/json' } }) });
        await expect(notCard.connect()).rejects.toThrow(/not an A2A agent card/);
    });
});

describe('turns over the agentic server', () => {
    it('streams text, carries tool events and the usage, and continues the context', async () => {
        const server = fakeServer({ steps: (turn) => [{ text: `Reply ${turn + 1}.` }, { tool: { name: 'lookup', output: { ok: true } } }, { usage: { totalTokens: 9 } }] });
        const agent = a2aAgent(server.cardUrl, { fetch: server.fetch });
        const session = await agent.session({ interactive: false });
        const first = session.prompt('one');
        const events = await collect(first);
        const result = await first.result;
        expect(textOf(events)).toBe('Reply 1.');
        expect(events.map((e) => e.type)).toEqual(['turn-start', 'user-message', 'part-start', 'part-delta', 'part-delta', 'part-end', 'tool-call', 'tool-update', 'tool-update', 'tool-update', 'usage', 'turn-end']);
        expect(result).toMatchObject({ stopReason: 'end_turn', usage: { totalTokens: 9 } });
        expect(session.ref).toEqual({ agent: agent.id, v: 1, id: session.id, data: { contextId: expect.stringMatching(/^ctx_/) } });
        const second = session.prompt('two');
        expect(textOf(await collect(second))).toBe('Reply 2.');
        expect(server.sessions.size).toBe(1); // one context, one session behind it
        await session.close();
        await agent.dispose();
    });
    it('pins a contextId given up front', async () => {
        const server = fakeServer();
        const agent = a2aAgent(server.cardUrl, { fetch: server.fetch });
        const session = await agent.session({ contextId: 'ctx-pinned' });
        expect(session.id).toBe('ctx-pinned');
        await session.prompt('hi').result;
        expect([...server.sessions.keys()]).toEqual(['ctx-pinned']);
        await expect(agent.session({ resume: session.ref })).rejects.toThrow(/cannot resume/);
    });
    it('polls GetTask when the card declares no streaming', async () => {
        const server = fakeServer({ steps: [{ text: 'Polled.' }] });
        const card: AgentCard = { ...agentCard(AGENT, server.endpoint), capabilities: { streaming: false } };
        const agent = a2aAgent(card, { fetch: server.fetch });
        const session = await agent.session({ pollMs: 5 });
        const turn = session.prompt('hi');
        const events = await collect(turn);
        expect(textOf(events)).toBe('Polled.');
        expect((await turn.result).stopReason).toBe('end_turn');
    });
    it('polls through an INPUT_REQUIRED stop without streaming', async () => {
        const server = fakeServer({ steps: [{ request: { kind: 'input', message: 'Which?' } }, { text: 'Thanks.' }] });
        const card: AgentCard = { ...agentCard(AGENT, server.endpoint), capabilities: { streaming: false } };
        const session = await a2aAgent(card, { fetch: server.fetch }).session({ pollMs: 5 });
        const turn = session.prompt('go');
        const events: AgentEvent[] = [];
        for await (const e of turn) {
            events.push(e);
            if (e.type === 'request') await session.respond(e.requestId, { type: 'input', answers: 'that one' });
        }
        expect(events.find((e) => e.type === 'request')).toMatchObject({ kind: 'input', message: 'Which?' });
        expect(textOf(events)).toBe('Thanks.');
        expect((await turn.result).stopReason).toBe('end_turn');
    });
    it('cancel() sends CancelTask and settles the open call', async () => {
        const server = fakeServer({ steps: [{ tool: { name: 'slow', delayMs: 60_000 } }] });
        const agent = a2aAgent(server.cardUrl, { fetch: server.fetch });
        const session = await agent.session();
        const turn = session.prompt('go');
        const events: AgentEvent[] = [];
        for await (const e of turn) {
            events.push(e);
            if (e.type === 'tool-update' && e.status === 'in_progress') await session.cancel();
        }
        expect((await turn.result).stopReason).toBe('cancelled');
        expect(events.filter((e) => e.type === 'tool-update').at(-1)).toMatchObject({ status: 'cancelled' });
        // The server's task is cancelled too.
        const [live] = server.sessions.values();
        const serverEvents: AgentEvent[] = [];
        for await (const e of live!.subscribe({ epoch: 0, seq: 0 })) {
            serverEvents.push(e);
            if (e.type === 'turn-end') break;
        }
        expect(serverEvents.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'cancelled' });
    });
    it('a cancel decision on a request cancels the task', async () => {
        const server = fakeServer({ steps: [{ request: { kind: 'input', message: 'Which?' } }, { text: 'never' }] });
        const session = await a2aAgent(server.cardUrl, { fetch: server.fetch }).session();
        const turn = session.prompt('go');
        for await (const e of turn) if (e.type === 'request') await session.respond(e.requestId, { type: 'cancel' });
        expect((await turn.result).stopReason).toBe('cancelled');
    });
    it('a failed task ends the turn with its error', async () => {
        const server = fakeServer({ steps: [{ error: { code: 'rate_limited', message: 'slow down' } }] });
        const session = await a2aAgent(server.cardUrl, { fetch: server.fetch }).session();
        const turn = session.prompt('go');
        const events = await collect(turn);
        expect(events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ code: 'rate_limited', message: 'slow down' })]);
        expect(await turn.result).toMatchObject({ stopReason: 'error', error: { code: 'rate_limited', message: 'slow down' } });
    });
    it('refuses structured output up front', async () => {
        const server = fakeServer();
        const session = await a2aAgent(server.cardUrl, { fetch: server.fetch }).session();
        const turn = session.prompt('go', { output: { schema: { type: 'object' } } });
        expect(await turn.result).toMatchObject({ stopReason: 'error', error: { code: 'protocol_error' } });
    });
});

describe('turns over a plain A2A server (no extension)', () => {
    const card: AgentCard = {
        name: 'Plain',
        description: 'A spec-example agent.',
        version: '1.0.0',
        supportedInterfaces: [{ url: 'http://plain.test/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: true },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: []
    };
    const sse = (frames: StreamResponse[]) =>
        new Response(frames.map((f) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: f })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const calls: { method: string; params: { message?: { taskId?: string; parts: { text?: string; data?: unknown }[] }; id?: string } }[] = [];
    const server = async (request: Request): Promise<Response> => {
        const body = (await request.json()) as { method: string; params: (typeof calls)[number]['params'] };
        calls.push(body);
        if (body.method === 'SendStreamingMessage' && !body.params.message?.taskId) {
            const text = body.params.message?.parts[0]?.text ?? '';
            if (text === 'direct') return sse([{ message: { messageId: 'r1', role: 'ROLE_AGENT', contextId: 'c9', parts: [{ text: 'Direct reply.' }] } }]);
            if (text === 'ask') return sse([{ task: { id: 't2', contextId: 'c9', status: { state: 'TASK_STATE_WORKING' } } }, { statusUpdate: { taskId: 't2', contextId: 'c9', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'q', role: 'ROLE_AGENT', parts: [{ text: 'From where?' }] } } } }]);
            if (text === 'auth') return sse([{ task: { id: 't3', contextId: 'c9', status: { state: 'TASK_STATE_AUTH_REQUIRED', message: { messageId: 'a', role: 'ROLE_AGENT', parts: [{ text: 'Log in first.' }] } } } }]);
            if (text === 'partial')
                return sse([
                    // The stream opens mid-artifact: the snapshot already holds its first chunk.
                    { task: { id: 't4', contextId: 'c9', status: { state: 'TASK_STATE_WORKING' }, artifacts: [{ artifactId: 'a1', parts: [{ text: 'Hel' }] }] } },
                    { artifactUpdate: { taskId: 't4', contextId: 'c9', artifact: { artifactId: 'a1', parts: [{ text: 'lo.' }] }, append: true, lastChunk: true } },
                    { statusUpdate: { taskId: 't4', contextId: 'c9', status: { state: 'TASK_STATE_COMPLETED' } } }
                ]);
            return sse([
                { task: { id: 't1', contextId: 'c9', status: { state: 'TASK_STATE_WORKING' } } },
                { artifactUpdate: { taskId: 't1', contextId: 'c9', artifact: { artifactId: 'a1', parts: [{ text: '# Report\n\n' }] } } },
                { artifactUpdate: { taskId: 't1', contextId: 'c9', artifact: { artifactId: 'a1', parts: [{ text: 'Sunny.' }] }, append: true, lastChunk: true } },
                { statusUpdate: { taskId: 't1', contextId: 'c9', status: { state: 'TASK_STATE_COMPLETED' } } }
            ]);
        }
        if (body.method === 'SendStreamingMessage') {
            return sse([{ task: { id: 't2', contextId: 'c9', status: { state: 'TASK_STATE_WORKING' } } }, { statusUpdate: { taskId: 't2', contextId: 'c9', status: { state: 'TASK_STATE_COMPLETED', message: { messageId: 'f', role: 'ROLE_AGENT', parts: [{ text: 'Booked.' }] } } } }]);
        }
        if (body.method === 'CancelTask') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: body.params.id, status: { state: 'TASK_STATE_CANCELED' } } }), { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }), { headers: { 'content-type': 'application/json' } });
    };
    beforeEach(() => calls.splice(0));

    it('maps artifacts and the terminal status', async () => {
        const session = await a2aAgent(card, { fetch: server }).session();
        const turn = session.prompt('report');
        const events = await collect(turn);
        expect(textOf(events)).toBe('# Report\n\nSunny.');
        expect(events.filter((e) => e.type === 'part-start').length).toBe(1);
        expect((await turn.result).stopReason).toBe('end_turn');
        expect(session.ref.data).toEqual({ contextId: 'c9' });
    });
    it('continues an artifact the opening snapshot caught mid-stream in the same part', async () => {
        const session = await a2aAgent(card, { fetch: server }).session();
        const events = await collect(session.prompt('partial'));
        expect(textOf(events)).toBe('Hello.');
        expect(events.filter((e) => e.type === 'part-start').length).toBe(1);
        expect(events.filter((e) => e.type === 'part-end').length).toBe(1);
    });
    it('emits only what an artifact gained between polls', async () => {
        const polls: Array<{ state: string; text: string }> = [
            { state: 'TASK_STATE_WORKING', text: 'Hel' },
            { state: 'TASK_STATE_WORKING', text: 'Hello' },
            { state: 'TASK_STATE_COMPLETED', text: 'Hello.' }
        ];
        const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
        const task = (i: number) => ({ id: 't5', contextId: 'c9', status: { state: polls[i]!.state }, artifacts: [{ artifactId: 'a1', parts: [{ text: polls[i]!.text }] }] });
        let i = 0;
        const polling = async (request: Request) => {
            const body = (await request.json()) as { method: string };
            return body.method === 'SendMessage' ? reply({ task: task(0) }) : reply(task(Math.min(++i, polls.length - 1)));
        };
        const session = await a2aAgent({ ...card, capabilities: { streaming: false } }, { fetch: polling }).session({ pollMs: 1 });
        const turn = session.prompt('poll');
        const events = await collect(turn);
        expect(textOf(events)).toBe('Hello.');
        expect(events.filter((e) => e.type === 'part-start').length).toBe(1);
        expect((await turn.result).stopReason).toBe('end_turn');
    });
    it('maps a message-only stream to one text part', async () => {
        const session = await a2aAgent(card, { fetch: server }).session();
        const turn = session.prompt('direct');
        expect(textOf(await collect(turn))).toBe('Direct reply.');
        expect((await turn.result).stopReason).toBe('end_turn');
    });
    it('turns INPUT_REQUIRED text into an input request and answers in plain text', async () => {
        const session = await a2aAgent(card, { fetch: server }).session();
        const turn = session.prompt('ask');
        const events: AgentEvent[] = [];
        for await (const e of turn) {
            events.push(e);
            if (e.type === 'request') await session.respond(e.requestId, { type: 'input', answers: 'From Oslo' });
        }
        expect(events.find((e) => e.type === 'request')).toMatchObject({ kind: 'input', message: 'From where?' });
        expect(textOf(events)).toBe('Booked.');
        const followUp = calls.find((c) => c.params.message?.taskId === 't2')!;
        expect(followUp.params.message?.parts.map((p) => p.text ?? p.data)).toEqual([{ type: 'input', answers: 'From Oslo' }, 'From Oslo']);
        expect(followUp.params.message).toMatchObject({ contextId: 'c9' });
    });
    it('reports AUTH_REQUIRED as a recoverable auth_required error', async () => {
        const session = await a2aAgent(card, { fetch: server }).session();
        const turn = session.prompt('auth');
        const events = await collect(turn);
        expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'auth_required', recoverable: true, message: 'Log in first.' });
        expect(await turn.result).toMatchObject({ stopReason: 'error', error: { code: 'auth_required' } });
    });
    it('surfaces an HTTP failure as a provider error', async () => {
        const session = await a2aAgent(card, { fetch: async () => new Response('down', { status: 503 }) }).session();
        const turn = session.prompt('x');
        expect(await turn.result).toMatchObject({ stopReason: 'error', error: { code: 'provider_error', message: 'HTTP 503' } });
    });
});
