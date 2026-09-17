/** Fakes for the platform ports and a frozen config, shared by the anthropic tests. */
import type { AgentId, FrozenAgentConfig, MemoryEntry, RankedMemory, TaskId, ToolGrant } from '@agentic/core';
import type { ChatPort, MemoryPort, PlatformPorts, TaskPort, ToolCall } from '../../src/index';
import { PLATFORM_TOOL_NAMES } from '../../src/index';

export interface PortCall {
    readonly port: 'memory' | 'task' | 'chat';
    readonly op: string;
    readonly args: unknown;
    readonly call: ToolCall;
}

export interface FakePorts extends PlatformPorts {
    readonly calls: PortCall[];
}

export const NOW = 1_760_000_000_000;

export const memoryEntry: MemoryEntry = {
    id: 'mem_1',
    kind: 'fact',
    text: 'Deploys go through the release branch.',
    tags: ['deploy'],
    subject: 'release process',
    provenance: { source: 'user', at: NOW - 1000 },
    confidence: 'verified'
};

/** Ports that record every call and answer with canned data. */
export function fakePorts(options: { readonly answer?: string; readonly hits?: readonly RankedMemory[] } = {}): FakePorts {
    const calls: PortCall[] = [];
    const hits = options.hits ?? [{ entry: memoryEntry, score: 0.9 }];
    const memory: MemoryPort = {
        async search(query, call) {
            calls.push({ port: 'memory', op: 'search', args: query, call });
            return hits;
        },
        async remember(entry, call) {
            calls.push({ port: 'memory', op: 'remember', args: entry, call });
            return { ...entry, id: `mem_${calls.length}`, provenance: { ...entry.provenance, at: NOW } };
        }
    };
    const task: TaskPort = {
        async delegate(spec, call) {
            calls.push({ port: 'task', op: 'delegate', args: spec, call });
            return { taskId: `task_p.${call.callId}` as TaskId, status: 'completed', result: { text: `done: ${spec.objective}`, artifacts: [], verified: false } };
        },
        async report(report, call) {
            calls.push({ port: 'task', op: 'report', args: report, call });
        }
    };
    const chat: ChatPort = {
        async post(post, call) {
            calls.push({ port: 'chat', op: 'post', args: post, call });
            return { messageId: `msg_${calls.length}` as never };
        },
        async ask(question, call) {
            calls.push({ port: 'chat', op: 'ask', args: question, call });
            return { answer: options.answer ?? 'yes' };
        }
    };
    return { calls, memory, task, chat };
}

export const allGrants: readonly ToolGrant[] = PLATFORM_TOOL_NAMES.map((name) => ({ name }));

export function frozenConfig(overrides: Partial<FrozenAgentConfig> = {}): FrozenAgentConfig {
    return {
        agentId: 'agent_ada' as AgentId,
        configVersion: 3,
        name: 'Ada',
        description: 'A research assistant for the platform team.',
        role: 'Answer research questions and keep the team notes current.',
        instructions: 'Be terse. Cite what you found.',
        skills: [{ id: 'summarize' }],
        tools: allGrants,
        connectors: [],
        approvalPolicy: [],
        memoryPolicy: { shared: [], autoLearn: 'off' },
        execution: { runtime: 'anthropic-api', model: 'claude-opus-5', limits: {}, offlinePolicy: 'fail' },
        collaborators: 'all',
        ...overrides
    };
}
