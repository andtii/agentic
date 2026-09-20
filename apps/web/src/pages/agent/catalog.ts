/**
 * What the agent form's pickers offer on the platform (#153): only names
 * that exist. Tools are the platform's own (`PLATFORM_TOOLS`) plus what the
 * workspace's connectors discovered; connectors are the Registry's; skills
 * and shared memory scopes have no catalogue yet (runbook §10), so the
 * pickers offer what the agent already has and take new names as typed.
 * `environments` is left to the machines wiring (#144). The runtimes are the
 * workspace's enabled runtime plugins with what each still needs (#234).
 */
import { useActorState } from '@sigx/actors/app';
import type { AgentConfig } from '@agentic/core';
import type { ConnectorRecord } from '@agentic/platform';
import type { FieldOption, RuntimeOption } from '@agentic/ui';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { runtimeOptions } from './runtimes';

/** One list per picker; an absent list keeps the form's design-track options. */
export interface AgentCatalog {
    readonly skills?: readonly FieldOption[];
    readonly tools?: readonly FieldOption[];
    readonly connectors?: readonly FieldOption[];
    /** Filled by the machines wiring (#144). */
    readonly environments?: readonly FieldOption[];
    readonly memoryScopes?: readonly FieldOption[];
    /** The enabled runtime plugins (#234); absent while the Registry lists none, so the form keeps its own. */
    readonly runtimes?: readonly RuntimeOption[];
}

/**
 * The platform's tools, by the names a grant must carry. Mirrors
 * `PLATFORM_TOOL_NAMES` of `@agentic/runtimes` — the browser bundle does not
 * import the runtimes for six strings; `agent-live-model.test.ts` pins the two.
 */
export const PLATFORM_TOOLS = ['memory_search', 'memory_remember', 'delegate', 'chat_post', 'chat_file_read', 'task_report', 'ask_user', 'usage_limits', 'projects'] as const;

const unique = (values: readonly string[]): FieldOption[] => [...new Set(values.filter(Boolean))].map((value) => ({ value }));

/** The catalogue for one agent: real names first, then whatever the agent already carries so a saved pick stays selectable. */
export function agentCatalog(config: AgentConfig, connectors: readonly ConnectorRecord[]): AgentCatalog {
    const connectorOptions: FieldOption[] = connectors.map((c) => ({ value: c.id, label: `${c.id} (${c.transport})` }));
    const known = new Set(connectors.map((c) => c.id));
    for (const c of config.connectors) if (!known.has(c.id)) connectorOptions.push({ value: c.id });
    return {
        skills: unique(config.skills.map((s) => s.id)),
        tools: unique([...PLATFORM_TOOLS, ...connectors.flatMap((c) => c.tools), ...config.tools.map((t) => t.name)]),
        connectors: connectorOptions,
        memoryScopes: unique(config.memoryPolicy.shared)
    };
}

/** The catalogue, with the Registry's connectors and runtime plugins read live. Call in a component's setup. */
export function useAgentCatalog(defs: ActorDefs, viewer: ViewerState): (config: AgentConfig) => AgentCatalog {
    const connectors = useActorState(defs.Registry, () => viewer.workspaceId && ([registryKeyOf(viewer.workspaceId), 'connectors'] as const), { live: true });
    const readiness = useWorkspaceReadiness(defs, viewer);
    return (config) => {
        const plugins = readiness.overview()?.plugins;
        const runtimes = plugins ? runtimeOptions(plugins, readiness.byId(), config.execution.runtime) : undefined;
        return { ...agentCatalog(config, connectors.value ?? []), ...(runtimes ? { runtimes } : {}) };
    };
}
