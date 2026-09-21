import { describe, expect, it } from 'vitest';
import type { CapabilityReport } from '@agentic/core';
import { toAgentCapabilities } from '../../src/machine/index';

describe('toAgentCapabilities (#453)', () => {
    it('reads the ops a harness reports under their own names: configure reaches the wire client', () => {
        const report: CapabilityReport = { runtime: 'claude-code', supported: ['session.configure-model', 'session.fork', 'turn.structured-output', 'agent.list-sessions'], unsupported: [], resume: 'portable', cancel: true, steer: true, permissions: 'harness-filtered', tools: 'mcp' };
        expect(toAgentCapabilities(report)).toMatchObject({ config: true, fork: true, structuredOutput: true, listSessions: true });
    });

    it('an op the report leaves out stays off', () => {
        const report: CapabilityReport = { runtime: 'claude-code', supported: [], unsupported: [{ op: 'session.configure-model', reason: 'no' }], resume: false, cancel: false, steer: false, permissions: 'none', tools: 'none' };
        expect(toAgentCapabilities(report)).toMatchObject({ config: false, fork: false, structuredOutput: false, listSessions: false });
    });
});
