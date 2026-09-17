/**
 * One tool round trip as a recorded fixture: the model calls `memory_search`,
 * the port answers, the model replies with the finding and reports usage.
 *
 * `fixtures/tool-roundtrip.json` was recorded from the platform agent over a
 * scripted `mockModel` (re-record with `RECORD_FIXTURES=1 pnpm test fixture`);
 * the replay drives the same client code path through `replayAgent`, which
 * throws the moment the client deviates from the recording.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockModel } from '@sigx/ai/testing';
import { allowAll, type Agent, type AgentEvent } from '@sigx/ai-agent';
import { recordAgent, replayAgent, serializeFixture, type AgentFixture } from '@sigx/ai-agent/testing';
import { createPlatformModelAgent } from '../../src/index';
import { fakePorts, frozenConfig, memoryEntry } from './helpers';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'tool-roundtrip.json');
const PROMPT = 'How do we deploy?';

function liveAgent(): Agent {
    const model = mockModel({
        modelId: 'claude-opus-5',
        respond: (_req, round) =>
            round === 0
                ? { toolCalls: [{ name: 'memory_search', input: { query: 'deploy', kinds: ['fact'] }, id: 'ms1' }], usage: { inputTokens: 120, outputTokens: 30 } }
                : { text: 'Deploys go through the release branch.', usage: { inputTokens: 200, outputTokens: 12 } }
    });
    return createPlatformModelAgent(frozenConfig({ tools: [{ name: 'memory_search' }] }), { ports: fakePorts(), model }).agent;
}

async function drive(agent: Agent) {
    const session = await agent.session({ interactive: false, policy: allowAll });
    const events: AgentEvent[] = [];
    const turn = session.prompt(PROMPT);
    for await (const e of turn) events.push(e);
    const result = await turn.result;
    await session.close();
    return { events, result };
}

function expectRoundTrip(events: readonly AgentEvent[]) {
    const call = events.find((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call');
    expect(call).toMatchObject({ name: 'memory_search', input: { query: 'deploy', kinds: ['fact'] } });
    const done = events.find((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update' && e.callId === call!.callId && e.status === 'completed');
    expect(done).toBeDefined();
    expect(JSON.stringify(done!.output)).toContain(memoryEntry.text);
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta' && e.seq > done!.seq).map((e) => e.delta).join('');
    expect(text).toContain('release branch');
    const usage = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) expect(typeof u.costUsd).toBe('number');
    const end = events.at(-1);
    expect(end?.type === 'turn-end' && end.stopReason).toBe('end_turn');
}

describe('recorded fixture: memory_search round trip', () => {
    it('records the live round trip', async () => {
        const recorder = recordAgent(liveAgent());
        const { events, result } = await drive(recorder);
        expectRoundTrip(events);
        expect(result.stopReason).toBe('end_turn');
        const kinds = recorder.fixture.sessions[0]!.log.map((e) => ('command' in e ? `cmd:${e.command.kind}` : e.event.type));
        expect(kinds).toContain('tool-call');
        expect(kinds.filter((k) => k.startsWith('cmd:'))).toEqual(['cmd:prompt', 'cmd:close']);
        if (process.env.RECORD_FIXTURES) writeFileSync(FIXTURE, serializeFixture(recorder.fixture));
    });

    it('replays the committed fixture through the same client path', async () => {
        const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as AgentFixture;
        expect(fixture.agent.id).toBe('anthropic-api:agent_ada');
        const { events, result } = await drive(replayAgent(fixture));
        expectRoundTrip(events);
        expect(result.stopReason).toBe('end_turn');
        expect(result.costUsd).toBeCloseTo((120 * 5 + 30 * 25 + 200 * 5 + 12 * 25) / 1_000_000, 12);
    });
});
