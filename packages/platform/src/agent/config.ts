/**
 * Agent configuration: the defaults a fresh agent starts from and the merge
 * rule a version patch applies (AGT-02). Pure functions — the actor's
 * version log replays them, so they must give the same answer on any host.
 */

import type { AgentConfig, ExecutionDefaults, Limits, MemoryPolicy } from '@agentic/core';

/**
 * What `update(patch, reason)` accepts: every top-level field optional;
 * `memoryPolicy` and `execution` (and `execution.limits`) merge one level
 * deep, arrays and scalars replace wholesale.
 */
export interface AgentConfigPatch {
    readonly name?: string;
    readonly description?: string;
    readonly role?: string;
    readonly instructions?: string;
    readonly skills?: AgentConfig['skills'];
    readonly tools?: AgentConfig['tools'];
    readonly connectors?: AgentConfig['connectors'];
    readonly approvalPolicy?: AgentConfig['approvalPolicy'];
    readonly memoryPolicy?: Partial<MemoryPolicy>;
    /**
     * `execution` merges one level deep; `account` and `defaultEnvironmentId` also take `null` to clear
     * the binding (#414) — a plain patch cannot remove a field, and unbinding an agent is a real change.
     */
    readonly execution?: Partial<Omit<ExecutionDefaults, 'limits' | 'account' | 'defaultEnvironmentId'>> & {
        readonly limits?: Limits;
        readonly account?: ExecutionDefaults['account'] | null;
        readonly defaultEnvironmentId?: ExecutionDefaults['defaultEnvironmentId'] | null;
    };
    readonly collaborators?: AgentConfig['collaborators'];
}

const PATCH_KEYS: ReadonlySet<string> = new Set<keyof AgentConfigPatch>([
    'name',
    'description',
    'role',
    'instructions',
    'skills',
    'tools',
    'connectors',
    'approvalPolicy',
    'memoryPolicy',
    'execution',
    'collaborators'
]);

/** A fresh agent: unnamed, no skills, no tool grants, private memory only, API runtime. */
export function defaultAgentConfig(): AgentConfig {
    return {
        name: '',
        description: '',
        role: '',
        instructions: '',
        skills: [],
        tools: [],
        connectors: [],
        approvalPolicy: [],
        memoryPolicy: { shared: [], autoLearn: 'lessons' },
        execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'queue' },
        collaborators: 'all'
    };
}

/**
 * Reject a patch that is not an object or names a field `AgentConfig` does
 * not have — a typo must not become a durable version.
 */
export function assertAgentConfigPatch(patch: unknown): asserts patch is AgentConfigPatch {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('agent config patch must be an object');
    }
    for (const key of Object.keys(patch)) {
        if (!PATCH_KEYS.has(key)) throw new TypeError(`unknown agent config field "${key}"`);
    }
}

/** `base` with `patch` applied — a NEW plain object; neither input is touched. */
export function mergeAgentConfig(base: AgentConfig, patch: AgentConfigPatch): AgentConfig {
    const next: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (key === 'memoryPolicy') {
            next.memoryPolicy = { ...base.memoryPolicy, ...(value as Partial<MemoryPolicy>) };
        } else if (key === 'execution') {
            const { limits, ...rest } = value as NonNullable<AgentConfigPatch['execution']>;
            const execution: Record<string, unknown> = {
                ...base.execution,
                ...rest,
                limits: limits === undefined ? base.execution.limits : { ...base.execution.limits, ...limits }
            };
            // `null` clears a binding (#414); `clone` would otherwise keep it as a JSON null.
            for (const field of ['account', 'defaultEnvironmentId'] as const) if (execution[field] === null) delete execution[field];
            next.execution = execution;
        } else {
            next[key] = value;
        }
    }
    return clone(next as unknown as AgentConfig);
}

/** Structural clone of JSON-shaped data; the config never carries anything else. */
export function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
