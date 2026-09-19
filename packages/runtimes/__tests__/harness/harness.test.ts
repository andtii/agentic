/** The pieces every daemon-hosted harness driver shares (#318). */
import { capabilities } from '@sigx/ai-agent';
import type { AgentSession } from '@sigx/ai-agent';
import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { assertCwdInRoots, assertRuntime, closingWith, harnessCapabilityReport, profileEnv, withPlatformMemoryLabel, PLATFORM_MEMORY_HEADING } from '../../src/harness/index';

const env: LocalEnvironment = { id: 'env_1' as EnvironmentId, name: 'Work', runtime: 'copilot-cli', cwdRoots: ['/work'], concurrency: 1 };

describe('profileEnv', () => {
    it('removes every stripped parent key, then sets the profile variables', () => {
        const parent = { PATH: '/bin', OPENAI_API_KEY: 'sk', openai_base_url: 'x', CODEX_HOME: '/other' };
        expect(profileEnv(parent, { strip: [/^OPENAI_/i, /^CODEX_HOME$/i], set: { CODEX_HOME: '/profiles/env_1' } })).toEqual({
            OPENAI_API_KEY: undefined,
            openai_base_url: undefined,
            CODEX_HOME: '/profiles/env_1'
        });
    });

    it('leaves a profile variable unset (the default home) when the environment has no profile dir', () => {
        expect(profileEnv({ COPILOT_HOME: '/x' }, { strip: [/^COPILOT_HOME$/], set: { COPILOT_HOME: undefined } })).toEqual({ COPILOT_HOME: undefined });
    });
});

describe('harnessCapabilityReport', () => {
    const subject = { runtime: 'copilot-cli', name: 'Copilot CLI', runtimeMemory: 'custom instructions are not loaded' } as const;

    it('names the harness in its reasons and reports what it lacks', () => {
        const report = harnessCapabilityReport(subject, capabilities({ resume: 'local', cancel: true, permissions: 'harness-filtered', tools: 'native' }), {
            tools: ['memory_search'],
            unknownTools: ['nope'],
            unavailableConnectors: [{ id: 'gh', reason: 'no URL' }]
        });
        expect(report.runtime).toBe('copilot-cli');
        expect(report.supported).toEqual(expect.arrayContaining(['turn.input-request', 'memory.platform', 'session.resume', 'session.cancel', 'tool:memory_search']));
        expect(report.unsupported).toEqual(
            expect.arrayContaining([
                { op: 'session.fork', reason: 'Copilot CLI cannot fork a session' },
                { op: 'memory.runtime', reason: 'custom instructions are not loaded' },
                { op: 'permissions.every-call', reason: 'Copilot CLI decides which tool calls to ask about; the platform policy sees only those' },
                { op: 'tool:nope', reason: 'not a platform tool the daemon can serve' },
                { op: 'connector:gh', reason: 'no URL' }
            ])
        );
        expect(report).toMatchObject({ resume: 'local', cancel: true, steer: false, permissions: 'harness-filtered', tools: 'native' });
    });

    it('reports a harness that cannot ask the user mid-turn', () => {
        const report = harnessCapabilityReport({ ...subject, inputRequest: false }, capabilities());
        expect(report.supported).not.toContain('turn.input-request');
        expect(report.unsupported).toContainEqual({ op: 'turn.input-request', reason: 'Copilot CLI cannot put a question to the user mid-turn' });
    });
});

describe('session guards', () => {
    it('refuses a cwd outside the roots and another runtime\'s environment', () => {
        expect(() => assertCwdInRoots('copilot-cli', env, '/work/app')).not.toThrow();
        expect(() => assertCwdInRoots('copilot-cli', env, '/etc')).toThrow('[copilot-cli] cwd /etc is outside the cwdRoots of environment "Work"');
        expect(() => assertRuntime('copilot-cli', env)).not.toThrow();
        expect(() => assertRuntime('codex-cli', env)).toThrow('runs "copilot-cli", not codex-cli');
    });

    it('closingWith runs the extra close after the session\'s, even when that throws', async () => {
        const order: string[] = [];
        const session = {
            id: 's',
            close: async () => {
                order.push('session');
                throw new Error('boom');
            }
        } as unknown as AgentSession;
        const wrapped = closingWith(session, async () => {
            order.push('after');
        });
        expect(wrapped.id).toBe('s');
        await expect(wrapped.close()).rejects.toThrow('boom');
        expect(order).toEqual(['session', 'after']);
    });
});

describe('withPlatformMemoryLabel', () => {
    it('relabels the memory block with the harness\'s own note, idempotently', () => {
        const out = withPlatformMemoryLabel('# A\n\n## Memory\n\n- x', 'Not Codex memory.');
        expect(out).toBe(`# A\n\n${PLATFORM_MEMORY_HEADING}\n\nNot Codex memory.\n\n- x`);
        expect(withPlatformMemoryLabel(out, 'other')).toBe(out);
    });
});
