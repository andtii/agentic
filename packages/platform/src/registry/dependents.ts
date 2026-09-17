/**
 * `dependents(pluginId)` — pure over what the actors report (AC-13, PLG-03).
 *
 * An agent depends on a plugin when its config names it: a `connectors[]`
 * ref with the plugin's id, a `tools[]` grant inside the plugin's tool
 * namespace (`tools:<id>` — `<id>.x`, `<id>:x`, `<id>/x`, `<id>__x` or the
 * bare id), or `execution.runtime` equal to the plugin id (a runtime
 * plugin). A schedule depends on a plugin through the agent it drives.
 */

import type { AgentConfig, AgentId, PluginManifest, ScheduleId } from '@agentic/core';
import type { AgentDependent, DependencyVia, Dependents, ScheduleDependent } from './types.js';

export interface AgentRef {
    readonly id: AgentId;
    readonly config: AgentConfig;
}

export interface ScheduleRef {
    readonly id: ScheduleId;
    readonly title: string;
    readonly agentId?: AgentId;
}

const SEPARATORS = ['.', ':', '/', '__'] as const;

/** The tool namespaces a plugin owns: its id plus every `tools:<x>` it declares (never `tools:*`). */
export function toolNamespaces(manifest: PluginManifest): readonly string[] {
    const out = new Set<string>([manifest.id]);
    for (const p of manifest.permissions) {
        if (p.scope.startsWith('tools:') && p.scope !== 'tools:*') out.add(p.scope.slice('tools:'.length));
    }
    return [...out];
}

export function toolInNamespace(toolName: string, namespace: string): boolean {
    if (toolName === namespace) return true;
    return SEPARATORS.some((sep) => toolName.startsWith(namespace + sep) && toolName.length > namespace.length + sep.length);
}

/** How `agent` depends on `manifest`, or an empty list when it does not. */
export function dependencyOf(agent: AgentRef, manifest: PluginManifest): readonly DependencyVia[] {
    const via: DependencyVia[] = [];
    const { config } = agent;
    if (config.connectors.some((c) => c.id === manifest.id)) via.push('connector');
    const namespaces = toolNamespaces(manifest);
    if (config.tools.some((t) => namespaces.some((ns) => toolInNamespace(t.name, ns)))) via.push('tool');
    if (config.execution.runtime === manifest.id) via.push('runtime');
    return via;
}

export function computeDependents(manifest: PluginManifest, agents: readonly AgentRef[], schedules: readonly ScheduleRef[]): Dependents {
    const dependentAgents: AgentDependent[] = [];
    for (const agent of agents) {
        const via = dependencyOf(agent, manifest);
        if (via.length > 0) dependentAgents.push({ id: agent.id, name: agent.config.name, via });
    }
    const agentIds = new Set(dependentAgents.map((a) => a.id));
    const dependentSchedules: ScheduleDependent[] = [];
    for (const s of schedules) {
        if (s.agentId !== undefined && agentIds.has(s.agentId)) dependentSchedules.push({ id: s.id, title: s.title, agentId: s.agentId });
    }
    return { pluginId: manifest.id, agents: dependentAgents, schedules: dependentSchedules };
}
