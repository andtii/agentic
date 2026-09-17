/** Registry actor: plugins, connectors, encrypted secrets; `dependents`, `requireEnabled` (architecture §4 Registry, §9). */

export { REGISTRY_TYPE, registryKey, parseRegistryKey } from './key.js';
export { Registry, defineRegistry, initialRegistryState, type KekSource, type RegistryActor, type RegistryOptions } from './actor.js';
export { requireEnabled, pluginEnabled, type HopContext } from './require-enabled.js';
export { computeDependents, dependencyOf, toolInNamespace, toolNamespaces, type AgentRef, type ScheduleRef } from './dependents.js';
export { PLUGIN_KINDS, NAME_RE, assertPluginManifest, assertName, declaredScopes, isPermissionScope, scopeCovered } from './manifest.js';
export { RegistryError, PluginDisabledError, isRegistryError, isPluginDisabledError, type RegistryErrorCode } from './errors.js';
export type {
    AgentDependent,
    ConnectorInput,
    ConnectorRecord,
    ConnectorStatus,
    ConnectorTransport,
    DependencyVia,
    Dependents,
    PluginRecord,
    PluginView,
    RegisterOptions,
    RegistryExportRow,
    RegistryState,
    ScheduleDependent,
    SecretInfo,
    SecretRecord
} from './types.js';
export { REGISTRY_STATE_VERSION } from './types.js';
