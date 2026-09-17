/**
 * Registry state and views (architecture §4 Registry, §9; PLG-01..05, EXE-10).
 *
 * One actor per workspace, keyed `{ws}:registry`. It holds what the
 * workspace has INSTALLED and what each installation was GRANTED — never
 * what a plugin may do by default (PLG-04): a plugin's manifest declares
 * the permissions it wants, `grantedPermissions` is what the owner said yes
 * to, and nothing else reaches it.
 */

import type { AgentId, PermissionScope, PluginManifest, PluginState, ScheduleId } from '@agentic/core';

export const REGISTRY_STATE_VERSION = 1;

/** One installed plugin, as stored. */
export interface PluginRecord extends PluginState {
    readonly registeredAt: number;
    readonly updatedAt: number;
}

export type ConnectorTransport = 'streamable-http' | 'stdio';

export interface ConnectorStatus {
    readonly state: 'unknown' | 'ok' | 'error';
    readonly checkedAt?: number;
    readonly error?: string;
}

/** A configured MCP server (architecture §9). `pluginId` names the manifest it was registered under. */
export interface ConnectorRecord {
    readonly id: string;
    readonly pluginId: string;
    readonly transport: ConnectorTransport;
    /** Streamable HTTP endpoint. */
    readonly url?: string;
    /** Stdio: the executable the daemon spawns, and where. */
    readonly command?: string;
    readonly args?: readonly string[];
    readonly machine?: string;
    /** Secret names the connector reads (each needs a `secret:<name>` grant on its plugin). */
    readonly secrets?: readonly string[];
    /** Tool names discovered on the last successful `tools/list`. */
    readonly tools: readonly string[];
    readonly status: ConnectorStatus;
    readonly updatedAt: number;
}

export type ConnectorInput = Omit<ConnectorRecord, 'tools' | 'status' | 'updatedAt'> & {
    readonly tools?: readonly string[];
};

/** A stored secret: the sealed value and when it changed. Plaintext is never in state. */
export interface SecretRecord {
    readonly sealed: string;
    readonly updatedAt: number;
}

/** What `secrets()` returns — names only. */
export interface SecretInfo {
    readonly name: string;
    readonly updatedAt: number;
}

export interface RegistryState {
    v: number;
    plugins: Record<string, PluginRecord>;
    connectors: Record<string, ConnectorRecord>;
    secrets: Record<string, SecretRecord>;
}

export type PluginView = Readonly<PluginRecord>;

export interface RegisterOptions {
    /** Start enabled. Default `false`. */
    readonly enabled?: boolean;
    readonly config?: Record<string, unknown>;
    /** Grant these declared scopes at registration — `'declared'` grants everything the manifest asks for (built-ins, PLG-05). Default none. */
    readonly grant?: readonly PermissionScope[] | 'declared';
}

/** How an agent depends on a plugin. */
export type DependencyVia = 'connector' | 'tool' | 'runtime';

export interface AgentDependent {
    readonly id: AgentId;
    readonly name: string;
    readonly via: readonly DependencyVia[];
}

export interface ScheduleDependent {
    readonly id: ScheduleId;
    readonly title: string;
    readonly agentId: AgentId;
}

/** Who references a plugin (AC-13): agents by their config, schedules through their agent. */
export interface Dependents {
    readonly pluginId: string;
    readonly agents: readonly AgentDependent[];
    readonly schedules: readonly ScheduleDependent[];
}

/** One NDJSON row of `exportRows()` — secrets appear by NAME only. */
export type RegistryExportRow =
    | { readonly kind: 'plugin'; readonly plugin: PluginRecord }
    | { readonly kind: 'connector'; readonly connector: ConnectorRecord }
    | { readonly kind: 'secret'; readonly secret: SecretInfo };

export type { PluginManifest, PluginState, PermissionScope };
