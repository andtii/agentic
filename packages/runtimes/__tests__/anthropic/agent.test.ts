/** `createPlatformModelAgent`: roster from grants, priced usage with the estimate flag, capability report. */
import { mockModel } from '@sigx/ai/testing';
import { allowAll, MODEL_AGENT_CAPABILITIES, type AgentEvent } from '@sigx/ai-agent';
import { createPlatformModelAgent } from '../../src/index';
import { fakePorts, frozenConfig, NOW } from './helpers';

async function oneTurn(agent: ReturnType<typeof createPlatformModelAgent>, prompt = 'Hello') {
    const session = await agent.agent.session({ interactive: false, policy: allowAll });
    const events: AgentEvent[] = [];
    const turn = session.prompt(prompt);
    for await (const e of turn) events.push(e);
    const result = await turn.result;
    await session.close();
    return { session, events, result };
}

describe('createPlatformModelAgent', () => {
    it('runs on the given model with the granted platform tools and the assembled system prompt', () => {
        const model = mockModel({ modelId: 'claude-opus-5', script: [{ text: 'hi' }] });
        const agent = createPlatformModelAgent(frozenConfig({ tools: [{ name: 'memory_search' }, { name: 'ask_user', mode: 'ask' }, { name: 'delegate', mode: 'deny' }] }), { ports: fakePorts(), model });
        expect(agent.agent.id).toBe('anthropic-api:agent_ada');
        expect(agent.modelId).toBe('claude-opus-5');
        expect(agent.tools.map((t) => t.name)).toEqual(['memory_search', 'ask_user']);
        expect(agent.system).toContain('# Ada');
        expect(agent.system).toContain('- memory_search:');
        expect(agent.system).not.toContain('- delegate:');
        expect(agent.pricing).toMatchObject({ modelId: 'claude-opus-5', estimated: false });
    });

    it('prices a known model as fact: usage events carry costUsd and the Ledger row is not an estimate', async () => {
        const model = mockModel({ modelId: 'claude-opus-5', script: [{ text: 'hi', usage: { inputTokens: 200, outputTokens: 40 } }] });
        const agent = createPlatformModelAgent(frozenConfig(), { ports: fakePorts(), model });
        const { session, events, result } = await oneTurn(agent);
        const usage = events.find((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
        expect(usage).toBeDefined();
        expect(usage!.costUsd).toBeCloseTo(0.002, 12);
        expect(result.costUsd).toBeCloseTo(0.002, 12);
        const row = agent.usageRow(usage!, { sessionId: session.id, taskId: 'task_1', at: NOW });
        expect(row).toEqual({ at: NOW, sessionId: session.id, agentId: 'agent_ada', taskId: 'task_1', usage: { inputTokens: 200, outputTokens: 40 }, costUsd: usage!.costUsd, estimated: false });
    });

    it('prices an unknown model as an estimate: usage still carries costUsd, the row says estimated: true', async () => {
        const model = mockModel({ modelId: 'claude-nova-9', script: [{ text: 'hi', usage: { inputTokens: 200, outputTokens: 40, cacheReadInputTokens: 1000 } }] });
        const agent = createPlatformModelAgent(frozenConfig({ execution: { runtime: 'anthropic-api', model: 'claude-nova-9', limits: {}, offlinePolicy: 'fail' } }), { ports: fakePorts(), model });
        expect(agent.pricing.estimated).toBe(true);
        const { session, events } = await oneTurn(agent);
        const usage = events.find((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage')!;
        expect(typeof usage.costUsd).toBe('number');
        const row = agent.usageRow(usage, { sessionId: session.id, at: NOW });
        expect(row.estimated).toBe(true);
        expect(row.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadInputTokens: 1000 });
        expect(row).not.toHaveProperty('taskId');
    });

    it('usageRow prices an event that carries usage but no cost, and copes with neither', () => {
        const agent = createPlatformModelAgent(frozenConfig(), { ports: fakePorts(), model: mockModel({ modelId: 'claude-haiku-4-5' }) });
        expect(agent.usageRow({ usage: { inputTokens: 1_000_000 } }, { sessionId: 's', at: 1 })).toMatchObject({ costUsd: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 }, estimated: false });
        expect(agent.usageRow({}, { sessionId: 's', at: 1 })).toMatchObject({ costUsd: 0, usage: { inputTokens: 0, outputTokens: 0 } });
    });

    it('reports capabilities: the engine, the roster, and what the config asked for that it cannot do', () => {
        const agent = createPlatformModelAgent(frozenConfig({ tools: [{ name: 'memory_search' }, { name: 'bash' }, { name: 'rm', mode: 'deny' }] }), { ports: fakePorts(), model: mockModel({ modelId: 'claude-opus-5' }) });
        const report = agent.capabilities;
        expect(report.runtime).toBe('anthropic-api');
        expect(report.supported).toEqual(expect.arrayContaining(['session.resume', 'session.fork', 'session.cancel', 'session.steer', 'session.configure-model', 'turn.structured-output', 'session.sub-agents', 'tool:memory_search']));
        expect(report.supported).not.toContain('tool:bash');
        expect(report.unsupported.map((u) => u.op)).toEqual(['turn.input-request', 'agent.list-sessions', 'tool:bash']);
        expect(report).toMatchObject({ resume: MODEL_AGENT_CAPABILITIES.resume, cancel: true, steer: true, permissions: 'every-call', tools: 'native' });
    });

    it('passes the config limits.maxSteps to the engine as the rounds per turn', async () => {
        // Two rounds of tool calls would be needed; with maxSteps 1 the turn ends after the first model round.
        const model = mockModel({ modelId: 'claude-opus-5', respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'memory_search', input: { query: 'x' }, id: 'm1' }] } : { text: 'after' }) });
        const agent = createPlatformModelAgent(frozenConfig({ execution: { runtime: 'anthropic-api', model: 'claude-opus-5', limits: { maxSteps: 1 }, offlinePolicy: 'fail' } }), { ports: fakePorts(), model });
        const { events } = await oneTurn(agent, 'Search.');
        expect(model.rounds).toBe(1);
        expect(events.some((e) => e.type === 'tool-call' && e.name === 'memory_search')).toBe(true);
    });
});
