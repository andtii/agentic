/** Registry actor: the build's plugin catalogue, plugins, connectors, encrypted secrets; `gate`, `overview`, `dependents`, `requireEnabled` (architecture §4 Registry, §9). */

export { REGISTRY_TYPE, registryKey, parseRegistryKey } from './key.js';
export { Registry, defineRegistry, initialRegistryState, type KekSource, type RegistryActor, type RegistryOptions } from './actor.js';
export { requireEnabled, pluginEnabled, type HopContext } from './require-enabled.js';
export { FALLBACK_RUNTIME, computeDependents, dependencyOf, toolInNamespace, toolNamespaces, type AgentRef, type ScheduleRef } from './dependents.js';
export { PLUGIN_KINDS, NAME_RE, TOOL_MODES, assertPluginManifest, assertName, declaredScopes, isPermissionScope, isToolMode, scopeCovered, grantedNetworkHosts } from './manifest.js';
export { RegistryError, PluginDisabledError, BadConfigError, isRegistryError, isPluginDisabledError, type RegistryErrorCode } from './errors.js';
export type {
    AgentDependent,
    CatalogueEntry,
    ConnectorAuth,
    ConnectorInput,
    ConnectorRecord,
    ConnectorStatus,
    ConnectorTransport,
    DependencyVia,
    Dependents,
    GateConnector,
    GateEntry,
    PluginRecord,
    PluginView,
    ProjectFeatureTarget,
    ProjectFeatureView,
    RegisterOptions,
    RegistryExportRow,
    RegistryGate,
    RegistryOverview,
    RegistryState,
    ScheduleDependent,
    SecretInfo,
    SecretRecord,
    SlotKind
} from './types.js';
export { REGISTRY_STATE_VERSION } from './types.js';
