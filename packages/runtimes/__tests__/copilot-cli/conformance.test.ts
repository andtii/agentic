// @vitest-environment node
/** `agentConformance` through the driver: the agent `open` runs sessions on, over a scripted Copilot client. */
import { agentConformance } from '@sigx/ai-agent/testing';
import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { COPILOT_CLI_CAPABILITIES, copilotCliDriver } from '../../src/copilot-cli/index';
import { fakeClient, scriptFor } from './fake-client';

const cwd = 'C:\\work\\repo';
const env: LocalEnvironment = { id: 'environment_work' as EnvironmentId, name: 'work', runtime: 'copilot-cli', profileDir: 'C:\\profiles\\work', cwdRoots: ['C:\\work'], concurrency: 2 };

describe('agentConformance: copilotCliDriver(fake client)', () => {
    const cases = agentConformance((s) => copilotCliDriver({ createClient: (init) => fakeClient(init, { script: scriptFor(s) }), parentEnv: {}, abortGraceMs: 200 }).agentFor(env), {
        capabilities: COPILOT_CLI_CAPABILITIES,
        sessionOptions: { cwd }
    });

    it('skips only what the harness cannot express', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
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
    });

    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
