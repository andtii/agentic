/**
 * Pieces every daemon-hosted harness driver shares (Claude Code, Copilot CLI, Codex): platform tools bridged
 * back through `callTool`, MCP connectors opened on the machine, the account half of a child's environment,
 * the system-prompt labels and the capability report. Internal — each driver's subpath re-exports what it needs.
 */

export type { BridgedTools } from './tools.js';
export { bridgedPlatformTools } from './tools.js';
export type { DaemonConnectorOpener, DaemonConnectorOpenInput, DaemonOpenedConnector, DaemonConnectors, OpenDaemonConnectorsInput, UnavailableDaemonConnector } from './connectors.js';
export { openDaemonConnectors, withConnectorPolicy, connectorCategory } from './connectors.js';
export { profileEnv } from './env.js';
export { PLATFORM_MEMORY_HEADING, CONNECTORS_UNAVAILABLE_HEADING, withPlatformMemoryLabel, withUnavailableConnectors } from './system.js';
export type { HarnessReportSubject, HarnessReportInput } from './capabilities.js';
export { harnessCapabilityReport, HARNESS_OPS } from './capabilities.js';
export { assertCwdInRoots, assertRuntime, closingWith } from './session.js';
export { QUOTA_WARNING_AT, quotaStatusOf } from './quota.js';
