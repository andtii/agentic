/**
 * `dependents(pluginId)` — pure over what the actors report (AC-13, PLG-03).
 *
 * An agent depends on a plugin when its config names it: a `connectors[]`
 * ref with the plugin's id, a `tools[]` grant inside the plugin's tool
 * namespace (`tools:<id>` — `<id>.x`, `<id>:x`, `<id>/x`, `<id>__x` or the
 * bare id), `execution.runtime` equal to the plugin id (a runtime plugin),
 * or — for `anthropic-api` — `offlinePolicy: 'fallback-api'`, which sends
 * the agent's work there while its environment is offline. A schedule
 * depends on a plugin through the agent it drives. The ACTIVE memory /
 * learning plugin serves every agent, so it reports `workspaceWide` rather
 * than a list of all of them.
 */

import type { AgentConfig, AgentId, PluginManifest, ScheduleId } from '@agentic/core';
import type { AgentGrants, AgentGrantsAt } from '../agent/entries.js';
import type { AgentDependent, DependencyVia, Dependents, ScheduleDependent } from './types.js';

export interface AgentRef {
    readonly id: AgentId;
    readonly config: AgentConfig;
    /** Its grants over its versions, one row per change, oldest first, when the caller read them: `since` is dated from these (#681, #1032). */
    readonly history?: readonly AgentGrantsAt[];
}

export interface ScheduleRef {
    readonly id: ScheduleId;
    readonly title: string;
    readonly agentId?: AgentId;
}

/** Where `offlinePolicy: 'fallback-api'` lands (architecture §5a). */
export const FALLBACK_RUNTIME = 'anthropic-api';

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
export function dependencyOf(agent: { readonly config: AgentGrants }, manifest: PluginManifest): readonly DependencyVia[] {
    const via: DependencyVia[] = [];
    const { config } = agent;
    if (config.connectors.some((c) => c.id === manifest.id)) via.push('connector');
    const namespaces = toolNamespaces(manifest);
    if (config.tools.some((t) => namespaces.some((ns) => toolInNamespace(t.name, ns)))) via.push('tool');
    if (config.execution.runtime === manifest.id) via.push('runtime');
    else if (manifest.id === FALLBACK_RUNTIME && config.execution.offlinePolicy === 'fallback-api') via.push('fallback');
    return via;
}

/**
 * When `agent` started depending on `manifest` (#681): the time of the oldest grant row in the unbroken run of rows,
 * ending with the newest, that depend on it — a grant removed and added again dates from the re-add. `undefined`
 * without a history, or when its newest version does not depend on it.
 */
export function dependentSince(agent: AgentRef, manifest: PluginManifest): number | undefined {
    const history = agent.history ?? [];
    let since: number | undefined;
    for (let i = history.length - 1; i >= 0; i--) {
        if (dependencyOf({ config: history[i]! }, manifest).length === 0) break;
        since = history[i]!.at;
    }
    return since;
}

export function computeDependents(manifest: PluginManifest, agents: readonly AgentRef[], schedules: readonly ScheduleRef[], options: { readonly workspaceWide?: boolean } = {}): Dependents {
    if (options.workspaceWide) return { pluginId: manifest.id, agents: [], schedules: [], workspaceWide: true };
    const dependentAgents: AgentDependent[] = [];
    for (const agent of agents) {
        const via = dependencyOf(agent, manifest);
        if (via.length === 0) continue;
        const since = dependentSince(agent, manifest);
        dependentAgents.push({ id: agent.id, name: agent.config.name, via, ...(since !== undefined ? { since } : {}) });
    }
    const agentIds = new Set(dependentAgents.map((a) => a.id));
    const dependentSchedules: ScheduleDependent[] = [];
    for (const s of schedules) {
        if (s.agentId !== undefined && agentIds.has(s.agentId)) dependentSchedules.push({ id: s.id, title: s.title, agentId: s.agentId });
    }
    return { pluginId: manifest.id, agents: dependentAgents, schedules: dependentSchedules };
}
