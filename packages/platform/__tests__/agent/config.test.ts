/** The pure half of the Agent actor: defaults, patch merge, the entry reducer and replay. */
import { describe, expect, it } from 'vitest';
import type { AgentId } from '@agentic/core';
import {
    type AgentConfigEntry,
    applyAgentEntry,
    configAtVersion,
    defaultAgentConfig,
    initialAgentState,
    mergeAgentConfig,
    parseAgentKey
} from '@agentic/platform';

const entry = (v: number, patch: AgentConfigEntry['patch']): AgentConfigEntry => ({
    t: 'config',
    v,
    patch,
    by: 'user:alice',
    at: 1_000 + v,
    reason: `change ${v}`
});

describe('parseAgentKey', () => {
    it('splits {ws}:agent:{id}', () => {
        expect(parseAgentKey('ws_1:agent:agent_2')).toEqual({ workspaceId: 'ws_1', id: 'agent_2' });
    });

    it('refuses any other shape, so a mistyped key never activates', () => {
        for (const bad of ['ws_1:chat:c1', 'agent_2', 'ws_1:agent:', ':agent:x', 'a:agent:b:c']) {
            expect(() => parseAgentKey(bad)).toThrow(TypeError);
        }
    });
});

describe('mergeAgentConfig', () => {
    it('replaces scalars and arrays wholesale, merges memoryPolicy/execution one level deep', () => {
        const base = mergeAgentConfig(defaultAgentConfig(), {
            name: 'Ada',
            skills: [{ id: 'review' }],
            execution: { model: 'claude-sonnet-4-5', limits: { maxTurns: 10, maxCostUsd: 2 } }
        });
        const next = mergeAgentConfig(base, {
            skills: [{ id: 'plan' }],
            memoryPolicy: { shared: ['shared:team'] },
            execution: { limits: { maxTurns: 20 } }
        });
        expect(next.name).toBe('Ada');
        expect(next.skills).toEqual([{ id: 'plan' }]);
        expect(next.memoryPolicy).toEqual({ shared: ['shared:team'], autoLearn: 'lessons' });
        expect(next.execution).toEqual({
            runtime: 'anthropic-api',
            offlinePolicy: 'queue',
            model: 'claude-sonnet-4-5',
            limits: { maxTurns: 20, maxCostUsd: 2 }
        });
    });

    it('never mutates its inputs and returns detached data', () => {
        const base = defaultAgentConfig();
        const patch = { tools: [{ name: 'fs.read' }] };
        const next = mergeAgentConfig(base, patch);
        expect(base.tools).toEqual([]);
        expect(next.tools).not.toBe(patch.tools);
    });

    it('null clears an account or a pinned environment; leaving them out keeps them (#414)', () => {
        const bound = mergeAgentConfig(defaultAgentConfig(), {
            execution: { runtime: 'claude-code', account: { identity: 'me@work' }, defaultEnvironmentId: 'env_work' as never, defaultWorkdir: 'C:\\src' }
        });
        expect(bound.execution).toMatchObject({ account: { identity: 'me@work' }, defaultEnvironmentId: 'env_work' });
        const kept = mergeAgentConfig(bound, { execution: { model: 'opus' } });
        expect(kept.execution).toMatchObject({ account: { identity: 'me@work' }, defaultEnvironmentId: 'env_work', model: 'opus' });
        const unbound = mergeAgentConfig(bound, { execution: { account: null, defaultEnvironmentId: null } });
        expect('account' in unbound.execution).toBe(false);
        expect('defaultEnvironmentId' in unbound.execution).toBe(false);
        expect(unbound.execution.defaultWorkdir).toBe('C:\\src');
        expect(JSON.stringify(unbound.execution)).not.toContain('null');
    });

    it('keeps skills and tool grants apart: adding a skill grants nothing (AGT-04)', () => {
        const next = mergeAgentConfig(defaultAgentConfig(), { skills: [{ id: 'deploy', version: '1' }] });
        expect(next.tools).toEqual([]);
        expect(next.connectors).toEqual([]);
        expect(next.approvalPolicy).toEqual([]);
    });
});

describe('applyAgentEntry / configAtVersion', () => {
    it('folds entries in order and replays any version from the defaults', () => {
        const state = initialAgentState('ws_1:agent:a1');
        expect(state.configVersion).toBe(0);
        applyAgentEntry(state, entry(1, { name: 'v1' }));
        applyAgentEntry(state, entry(2, { role: 'reviewer' }));
        applyAgentEntry(state, entry(3, { name: 'v3' }));
        expect(state.configVersion).toBe(3);
        expect(state.config.name).toBe('v3');
        expect(state.config.role).toBe('reviewer');
        expect(configAtVersion(state.versions, 1)).toEqual({ ...defaultAgentConfig(), name: 'v1' });
        expect(configAtVersion(state.versions, 2)).toEqual({ ...defaultAgentConfig(), name: 'v1', role: 'reviewer' });
        expect(configAtVersion(state.versions, 3)).toEqual(state.config);
    });

    it('refuses a gap or an unknown entry — a log it cannot replay faithfully', () => {
        const state = initialAgentState('ws_1:agent:a1');
        expect(() => applyAgentEntry(state, entry(2, {}))).toThrow(RangeError);
        expect(() => applyAgentEntry(state, { t: 'other' })).toThrow(TypeError);
        expect(state.versions).toEqual([]);
    });

    it('rejects versions outside 1..n', () => {
        const state = initialAgentState('ws_1:agent:a1');
        applyAgentEntry(state, entry(1, {}));
        for (const v of [0, 2, 1.5, -1, Number.NaN]) {
            expect(() => configAtVersion(state.versions, v)).toThrow(RangeError);
        }
    });

    it('state ids are the key parts', () => {
        const state = initialAgentState('ws_9:agent:agent_x');
        expect(state.id).toBe('agent_x' as AgentId);
        expect(state.workspaceId).toBe('ws_9');
    });
});
