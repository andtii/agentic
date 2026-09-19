/**
 * Registry state and views (architecture §4 Registry, §9; PLG-01..05, EXE-10).
 *
 * One actor per workspace, keyed `{ws}:registry`. It holds what the
 * workspace has INSTALLED and what each installation was GRANTED — never
 * what a plugin may do by default (PLG-04): a plugin's manifest declares
 * the permissions it wants, `grantedPermissions` is what the owner said yes
 * to, and nothing else reaches it.
 */

import type { AgentId, PermissionScope, PluginKind, PluginManifest, PluginState, ScheduleId } from '@agentic/core';

export const REGISTRY_STATE_VERSION = 1;

/**
 * One plugin the build ships (architecture §9): its manifest, and whether a
 * workspace that never touched it has it on. Default `true` (PLG-05).
 */
export type CatalogueEntry = PluginManifest | { readonly manifest: PluginManifest; readonly enabledByDefault?: boolean };

/** The kinds a workspace runs exactly one of (`SINGLE_SLOT_KINDS`). */
export type SlotKind = Extract<PluginKind, 'memory' | 'learning'>;

/** One installed plugin, as stored. A built-in nobody touched has no record: its `registeredAt` and `updatedAt` read `0`. */
export interface PluginRecord extends PluginState {
    readonly registeredAt: number;
    readonly updatedAt: number;
    /**
     * Built-ins only: every scope a build has declared so far. A declared scope
     * missing here is new and granted once (decisions 2026-09-19 (a)); one that
     * is here and not granted was taken away by the owner and stays away.
     */
    readonly seenScopes?: readonly PermissionScope[];
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
    /** The owner's choice per single-slot kind; absent → the first catalogue plugin of the kind. Optional, so state written before #229 reads as it is. */
    active?: Partial<Record<SlotKind, string>>;
}

/**
 * What reads return: the record with `config` merged over the schema's
 * defaults, whether the build ships it, and — for a single-slot kind —
 * whether it is the one the workspace runs.
 */
export type PluginView = Readonly<PluginRecord> & {
    readonly builtin: boolean;
    readonly active?: boolean;
};

/** One plugin as `gate()` reports it: `config` is ready to use (defaults filled in). */
export interface GateEntry {
    readonly id: string;
    readonly enabled: boolean;
    readonly config: Record<string, unknown>;
}

/** Everything `Routing.run` asks before NEW work, in one hop. */
export interface RegistryGate {
    /** The runtime plugin asked for; `null` when no `runtime` plugin has that id. */
    readonly runtime: GateEntry | null;
    /** The active plugin of each single-slot kind; `null` when the workspace has none. */
    readonly memory: GateEntry | null;
    readonly learning: GateEntry | null;
    /** Enabled `notification` plugins, id order. */
    readonly channels: readonly { readonly id: string; readonly config: Record<string, unknown> }[];
}

/** One read for a page: every plugin, the active slots, which secrets are set (names only). */
export interface RegistryOverview {
    readonly plugins: readonly PluginView[];
    readonly active: Partial<Record<SlotKind, string>>;
    readonly secretNames: readonly string[];
    /** Whether the deployment can seal secrets at all (a `pluginReadiness` fact). */
    readonly hasKek: boolean;
}

export interface RegisterOptions {
    /** Start enabled. Default `false`. */
    readonly enabled?: boolean;
    readonly config?: Record<string, unknown>;
    /** Grant these declared scopes at registration — `'declared'` grants everything the manifest asks for (built-ins, PLG-05). Default none. */
    readonly grant?: readonly PermissionScope[] | 'declared';
}

/** How an agent depends on a plugin. */
export type DependencyVia = 'connector' | 'tool' | 'runtime' | 'fallback';

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
    /** The active memory / learning plugin: every agent's new sessions run on it, so no agent is singled out. */
    readonly workspaceWide?: true;
}

/** One NDJSON row of `exportRows()` — secrets appear by NAME only. */
export type RegistryExportRow =
    | { readonly kind: 'plugin'; readonly plugin: PluginRecord }
    | { readonly kind: 'connector'; readonly connector: ConnectorRecord }
    | { readonly kind: 'secret'; readonly secret: SecretInfo };

export type { PluginManifest, PluginState, PermissionScope };
