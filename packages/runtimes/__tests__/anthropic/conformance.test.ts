/** The conformance suite against the platform agent: `createPlatformModelAgent` over a scripted `mockModel`, with the platform tools on the roster. */
import { mockModel, type MockReply } from '@sigx/ai/testing';
import { MODEL_AGENT_CAPABILITIES } from '@sigx/ai-agent';
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';
import { createPlatformModelAgent } from '../../src/index';
import { fakePorts, frozenConfig } from './helpers';

/** What the model does for each scenario (the tools come from the scenario). */
function respondFor(scenario: ConformanceScenario) {
    return (_req: unknown, round: number): MockReply => {
        switch (scenario.name) {
            case 'tool-permission':
            case 'headless-deny':
            case 'request-timeout':
                return round === 0 ? { toolCalls: [{ name: 'guarded', input: {}, id: 'g1' }] } : { text: 'Done.' };
            case 'streaming-tool-input':
                return round === 0 ? { toolCalls: [{ name: 'guarded', input: { city: 'Paris' }, inputDeltas: ['{"ci', 'ty":"Pa', 'ris"}'], id: 'g1' }] } : { text: 'Done.' };
            case 'session-grant':
                return round < 2 ? { toolCalls: [{ name: 'guarded', input: {}, id: `g${round + 1}` }] } : { text: 'Done twice.' };
            case 'usage':
                return { text: 'Hello!', usage: { inputTokens: 3, outputTokens: 2 } };
            case 'tool-error':
                return round === 0 ? { toolCalls: [{ name: 'failing', input: {}, id: 'f1' }] } : { text: 'It failed.' };
            case 'slow-tool':
                return round === 0 ? { toolCalls: [{ name: 'slow', input: {}, id: 's1' }] } : { text: 'never' };
            case 'model-error':
                return { error: 'the model is down' };
            case 'structured-output':
                return { text: '{"ok":true}' };
            case 'delegate-tree':
                return round === 0 ? { toolCalls: [{ name: 'delegate', input: {}, id: 'd1' }] } : { text: 'Done.' };
            case 'delegate-cancel':
                return round === 0 ? { toolCalls: [{ name: 'delegateSlow', input: {}, id: 'd1' }] } : { text: 'Moving on.' };
            case 'delegate-request':
                return round === 0 ? { toolCalls: [{ name: 'delegateAsking', input: {}, id: 'd1' }] } : { text: 'Done.' };
            case 'steer':
                return round === 0 ? { toolCalls: [{ name: 'delayed', input: {}, id: 't1' }] } : { text: 'Done.' };
            default:
                return { text: 'Hello!' };
        }
    };
}

/** The engine never asks the client a question (ask_user goes through the chat port instead). */
const skip = (s: ConformanceScenario) => (s.name === 'input-request' || s.name === 'support-agent' ? 'modelAgent never emits input requests; ask_user is a platform tool' : undefined);

describe('agentConformance: createPlatformModelAgent(mockModel)', () => {
    // The `delegate-*` scenarios bring their own `delegate` tool, so the
    // platform's `delegate` must not be on the roster there — two tools of one
    // name would be a protocol error. Every other platform tool stays.
    const grantsFor = (s: ConformanceScenario) => frozenConfig().tools.filter((g) => !s.tools.some((t) => t.name === g.name));
    const cases = agentConformance(
        (s) =>
            createPlatformModelAgent(frozenConfig({ tools: grantsFor(s) }), {
                ports: fakePorts(),
                model: mockModel({ respond: respondFor(s), modelId: 'claude-opus-5' }),
                models: [mockModel({ respond: respondFor(s), modelId: 'claude-haiku-4-5' })]
            }).agent,
        { capabilities: MODEL_AGENT_CAPABILITIES, skip }
    );
    it('skips only what the engine cannot do (no client questions, no session listing)', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual(['conformance: input-request', 'conformance: support-agent', 'conformance: list-sessions']);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
