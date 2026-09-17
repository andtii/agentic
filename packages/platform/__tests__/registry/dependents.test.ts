import type { AgentId, PluginManifest, ScheduleId } from '@agentic/core';
import { defaultAgentConfig } from '../../src/agent/index';
import { computeDependents, dependencyOf, toolInNamespace, toolNamespaces } from '../../src/registry/index';

const manifest = (id: string, extra: PluginManifest['permissions'] = []): PluginManifest => ({
    id,
    version: '1.0.0',
    kind: 'connector',
    name: id,
    description: '',
    capabilities: ['tools'],
    config: {},
    permissions: [{ scope: `tools:${id}`, reason: 'tools' }, ...extra],
    compat: { platform: '*', core: '*' }
});

const agent = (id: string, patch: Partial<ReturnType<typeof defaultAgentConfig>>) => ({ id: id as AgentId, config: { ...defaultAgentConfig(), name: id, ...patch } });

describe('toolInNamespace', () => {
    it('matches the bare id and the usual separators, never a mere prefix', () => {
        expect(toolInNamespace('github', 'github')).toBe(true);
        expect(toolInNamespace('github.search', 'github')).toBe(true);
        expect(toolInNamespace('github:search', 'github')).toBe(true);
        expect(toolInNamespace('github/search', 'github')).toBe(true);
        expect(toolInNamespace('mcp__github__search', 'mcp__github')).toBe(true);
        expect(toolInNamespace('githubx', 'github')).toBe(false);
        expect(toolInNamespace('github.', 'github')).toBe(false);
    });

    it('namespaces are the id plus every declared tools:<x>, never tools:*', () => {
        expect(toolNamespaces(manifest('gh', [{ scope: 'tools:github', reason: '' }, { scope: 'tools:*', reason: '' }]))).toEqual(['gh', 'github']);
    });
});

describe('computeDependents', () => {
    const gh = manifest('github');
    const a1 = agent('a1', { connectors: [{ id: 'github' }] });
    const a2 = agent('a2', { tools: [{ name: 'github.search' }] });
    const a3 = agent('a3', { execution: { runtime: 'github', limits: {}, offlinePolicy: 'queue' } });
    const a4 = agent('a4', { tools: [{ name: 'slack.post' }] });
    const schedules = [
        { id: 's1' as ScheduleId, title: 'nightly', agentId: 'a2' as AgentId },
        { id: 's2' as ScheduleId, title: 'reminder' },
        { id: 's3' as ScheduleId, title: 'other', agentId: 'a4' as AgentId }
    ];

    it('lists agents by connector, tool grant and runtime, and schedules through their agent', () => {
        expect(dependencyOf(a1, gh)).toEqual(['connector']);
        expect(dependencyOf(a2, gh)).toEqual(['tool']);
        expect(dependencyOf(a3, gh)).toEqual(['runtime']);
        expect(dependencyOf(a4, gh)).toEqual([]);
        const deps = computeDependents(gh, [a1, a2, a3, a4], schedules);
        expect(deps.agents.map((a) => [a.id, a.via])).toEqual([
            ['a1', ['connector']],
            ['a2', ['tool']],
            ['a3', ['runtime']]
        ]);
        expect(deps.schedules).toEqual([{ id: 's1', title: 'nightly', agentId: 'a2' }]);
    });

    it('is empty when nothing references the plugin', () => {
        expect(computeDependents(manifest('nobody'), [a1, a2, a3, a4], schedules)).toEqual({ pluginId: 'nobody', agents: [], schedules: [] });
    });
});
