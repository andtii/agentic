// @vitest-environment node
/** `agentConformance` through the driver: the agent `open` runs sessions on, built with the driver's isolation options over the adapter's fake query. */
import { agentConformance } from '@sigx/ai-agent/testing';
import { CLAUDE_CODE_CAPABILITIES } from '@sigx/ai-agent-claude-code';
import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { claudeCodeDriver } from '../../src/claude-code/index';
import { fakeListen, fakeQuery, scriptFor, SESSION } from './fake-query';

const cwd = 'C:\\work\\repo';
const env: LocalEnvironment = { id: 'environment_work' as EnvironmentId, name: 'work', runtime: 'claude-code', profileDir: 'C:\\profiles\\work', cwdRoots: ['C:\\work'], concurrency: 2 };

describe('agentConformance: claudeCodeDriver(fake query)', () => {
    // The fake CLI always reports SESSION as its session id; a listing that names it stands in for the SDK's session store.
    const listSessions = async () => [{ sessionId: SESSION, summary: 'Conformance', lastModified: 1, cwd } as never];
    const cases = agentConformance((s) => claudeCodeDriver({ query: fakeQuery(scriptFor(s)).query, listen: fakeListen, listSessions, parentEnv: {} }).agentFor(env), {
        capabilities: CLAUDE_CODE_CAPABILITIES,
        sessionOptions: { cwd },
        skip: (s) => (s.name === 'support-agent' ? 'Claude Code emits no agent.handoff extension (its ext namespace is claude-code)' : undefined)
    });

    it('skips only what the harness cannot express', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
            'conformance: support-agent',
            'conformance: session-grant',
            'conformance: request-timeout',
            'conformance: portable-resume',
            'conformance: delegate-request',
            'conformance: steer'
        ]);
    });

    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
