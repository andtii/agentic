/**
 * `agentSummaryOf` (#1125): the slice of an agent's config the Workspace index keeps for the lists.
 */
import { describe, expect, it } from 'vitest';
import { agentSummaryOf, type AgentConfig, type AgentId, type AgentSummary, type EnvironmentId } from '../src/index';

const config = (execution: Partial<AgentConfig['execution']> = {}): AgentConfig => ({
    name: 'Ada',
    description: 'Reviews pull requests.',
    role: 'reviewer',
    instructions: 'Be kind.',
    skills: [{ id: 'review' }],
    tools: [],
    connectors: [],
    approvalPolicy: [],
    memoryPolicy: { shared: [], autoLearn: 'lessons' },
    execution: { runtime: 'claude-code', limits: { maxTurns: 3 }, offlinePolicy: 'queue', ...execution },
    collaborators: 'all'
});

describe('agentSummaryOf', () => {
    it('keeps the name, role, description and execution binding, nothing else', () => {
        const summary = agentSummaryOf('agent_1' as AgentId, 4, config({ defaultEnvironmentId: 'env_1' as EnvironmentId, account: { identity: 'me@work' }, model: 'opus', defaultWorkdir: '/w' }));
        expect(summary).toEqual({
            id: 'agent_1',
            configVersion: 4,
            config: { name: 'Ada', role: 'reviewer', description: 'Reviews pull requests.', execution: { runtime: 'claude-code', account: { identity: 'me@work' }, defaultEnvironmentId: 'env_1', model: 'opus' } }
        });
    });

    it('leaves absent optional fields absent, and never shares the account object', () => {
        const summary = agentSummaryOf('agent_1' as AgentId, 1, config());
        expect(summary.config.execution).toEqual({ runtime: 'claude-code' });
        expect(Object.keys(summary.config.execution)).toEqual(['runtime']);
        const source = config({ account: { label: 'claude-2' } });
        expect(agentSummaryOf('agent_1' as AgentId, 1, source).config.execution.account).not.toBe(source.execution.account);
    });

    it('a full agent view is assignable to a summary', () => {
        const view = { id: 'agent_1' as AgentId, workspaceId: 'ws', configVersion: 2, config: config(), memoryScope: 'agent:agent_1', pendingProposals: 0 };
        const asSummary: AgentSummary = view;
        expect(asSummary.config.name).toBe('Ada');
    });
});
