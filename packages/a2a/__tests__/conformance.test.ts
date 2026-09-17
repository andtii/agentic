// @vitest-environment node
/** The `agentConformance` subset through `a2aAgent` over the in-process A2A server (AC-14). */
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';
import type { MockStep } from '@sigx/ai-agent/testing';
import { a2aAgent, capabilitiesFrom, agentCard } from '../src/index';
import { AGENT, fakeServer, type FakeServer } from './fake';

/** What the scripted agent behind the server does for each scenario. */
function steps(scenario: ConformanceScenario): readonly MockStep[] {
    switch (scenario.name) {
        case 'tool-error':
            return [{ tool: { name: 'failing', status: 'failed', error: 'the tool failed on purpose' } }, { text: 'It failed.' }];
        case 'slow-tool':
            return [{ tool: { name: 'slow', delayMs: 60_000 } }];
        case 'model-error':
            return [{ error: { code: 'provider_error', message: 'the model is down' } }];
        case 'input-request':
            return [{ request: { kind: 'input', message: 'Which one?' } }, { text: 'Thanks.' }];
        case 'usage':
            return [{ text: 'Hello!' }, { usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 } }];
        default:
            return [{ text: 'Hello!' }];
    }
}

describe('agentConformance: a2aAgent over an in-process A2A server', () => {
    const servers: FakeServer[] = [];
    afterEach(async () => {
        for (const s of servers.splice(0)) for (const session of s.sessions.values()) await session.close().catch(() => {});
    });
    const make = async (s: ConformanceScenario) => {
        const server = fakeServer({ steps: steps(s) });
        servers.push(server);
        const agent = a2aAgent(server.cardUrl, { fetch: server.fetch });
        await agent.connect();
        return agent;
    };
    // The card the server serves is known up front, so the skips are asserted rather than silent.
    const capabilities = capabilitiesFrom(agentCard(AGENT, 'http://a2a.test/a2a/helper'));
    const cases = agentConformance(make, { capabilities });

    it('skips exactly the scenarios A2A cannot express', async () => {
        const server = fakeServer();
        servers.push(server);
        const agent = a2aAgent(server.cardUrl, { fetch: server.fetch });
        await agent.connect();
        expect(agent.capabilities).toEqual(capabilities);
        expect(agent.capabilities).toMatchObject({ resume: false, cancel: true, tools: 'none', permissions: 'harness-filtered', promptParts: 'text+image', steer: false, subagents: 'none' });
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
            'conformance: resume',
            'conformance: structured-output',
            'conformance: support-agent',
            'conformance: session-grant',
            'conformance: request-timeout',
            'conformance: streaming-tool-input',
            'conformance: configure',
            'conformance: fork',
            'conformance: list-sessions',
            'conformance: portable-resume',
            'conformance: delegate-tree',
            'conformance: delegate-cancel',
            'conformance: delegate-request',
            'conformance: steer'
        ]);
        // The subset the issue names runs.
        for (const name of ['text', 'slow-tool', 'input-request', 'tool-error', 'model-error', 'usage', 'busy-session', 'late-join', 'prompt-after-close', 'respond-unknown']) {
            expect(cases.find((c) => c.name === `conformance: ${name}`)?.skip).toBeUndefined();
        }
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
