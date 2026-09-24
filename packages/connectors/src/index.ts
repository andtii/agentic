/**
 * `@agentic/connectors` — native connectors over conduit (#531, architecture
 * §9 "connectors that sign in"). Edge-safe: `@agentic/core`, `@aigntiq/conduit`
 * (root entry only) and `@aigntiq/conduit-connectors`; no `node:` imports.
 */

export { createConnectorEngine, type ConnectorEngine, type ConnectorEngineOptions } from './engine.js';
export { ConnectorNetworkError, connectorHostAllowed, guardHttp } from './network.js';
export { clientFromSecrets, connectorClientSecretNames, CONNECTOR_ENGINE_SECRET, type OpenConnectorSecret } from './clients.js';
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
export { GMAIL_NEW_EMAIL_TRIGGER, gmailArrivalText, GMAIL_POLL_OVERLAP_SEC, runsTrigger, GMAIL_SEEN_MAX, parseGmailCursor, pollGmail, type GmailArrival, type GmailPoll, type GmailPollOptions } from './triggers/gmail.js';
