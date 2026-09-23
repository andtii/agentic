/**
 * Each harness driver says what its runtime supports without an environment (#541), the same report an environment's
 * `inspect` would carry — so the daemon's `hello` can offer a runtime before its first environment exists. Building
 * the report starts nothing: no SDK query, no app-server, no Copilot client.
 */
import { describe, expect, it } from 'vitest';
import { claudeCodeDriver } from '../../src/claude-code/index';
import { codexCliDriver } from '../../src/codex-cli/index';
import { copilotCliDriver } from '../../src/copilot-cli/index';

const never = (): never => {
    throw new Error('report() must not start the runtime');
};

describe('RuntimeDriver.report() on the harness drivers (#541)', () => {
    it.each([
        ['claude-code', () => claudeCodeDriver({ query: never, parentEnv: {} })],
        ['codex-cli', () => codexCliDriver({ connect: never, parentEnv: {} })],
        ['copilot-cli', () => copilotCliDriver({ createClient: never })]
    ] as const)('%s reports its runtime and what it supports', (runtime, make) => {
        const report = make().report!();
        expect(report.runtime).toBe(runtime);
        expect(report.supported.length).toBeGreaterThan(0);
        expect(report.unsupported.some((u) => u.op === '*')).toBe(false);
    });
});
