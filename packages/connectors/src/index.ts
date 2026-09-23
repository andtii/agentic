/**
 * `@agentic/connectors` — native connectors over conduit (#531, architecture
 * §9 "connectors that sign in"). Edge-safe: `@agentic/core`, `@aigntiq/conduit`
 * (root entry only) and `@aigntiq/conduit-connectors`; no `node:` imports.
 */

export { createConnectorEngine, type ConnectorEngine, type ConnectorEngineOptions } from './engine.js';
export { clientFromSecrets, CONNECTOR_CLIENT_ID_SECRET, CONNECTOR_CLIENT_SECRET_SECRET, CONNECTOR_ENGINE_SECRET, type OpenConnectorSecret } from './clients.js';
export {
    conduitTools,
    connectorNamespace,
    connectorToolName,
    ConnectorToolError,
    isToolOperation,
    operationAnnotations,
    operationInputSchema,
    type ConduitToolsOptions,
    type OpenedConduitConnector
} from './tools.js';
export { conduitCapabilities, conduitConnectorManifest, gmailConnectorPlugin, type ConduitConnectorManifestOptions } from './manifest.js';
