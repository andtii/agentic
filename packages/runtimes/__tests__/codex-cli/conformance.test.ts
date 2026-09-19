// @vitest-environment node
/** `agentConformance` through the driver: the agent `open` runs sessions on, over a scripted app-server (#320). */
import { agentConformance } from '@sigx/ai-agent/testing';
import { CODEX_CLI_CAPABILITIES, codexCliDriver } from '../../src/codex-cli/index';
import { ENV, fakeConnect, scriptFor } from './fake-app-server';

describe('agentConformance: codexCliDriver(fake app-server)', () => {
    const cases = agentConformance((s) => codexCliDriver({ connect: fakeConnect(scriptFor(s)).connect, parentEnv: {} }).agentFor(ENV), {
        capabilities: CODEX_CLI_CAPABILITIES,
        sessionOptions: { cwd: 'C:\\work\\repo' },
        skip: (s) => (s.name === 'support-agent' ? 'Codex emits no agent.handoff extension' : undefined)
    });

    it('skips only what the harness cannot express', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
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
            'conformance: delegate-request'
        ]);
    });

    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
