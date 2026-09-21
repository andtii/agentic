/**
 * `@agentic/runtimes/claude-code` — the Claude Code driver for the machine
 * daemon (architecture §5b). Node-only: it spawns the CLI and reads profile
 * files, so it is a subpath of its own and never reaches the edge entry.
 */

export type { ClaudeCodeDriver, ClaudeCodeDriverOptions } from './driver.js';
export { claudeCodeDriver, withoutCrossSessionTools, CROSS_SESSION_TOOLS } from './driver.js';
export { EXIT_PLAN_MODE_TOOL, withPlanReview } from './plan.js';
export type { ProfileAuth, ProfileAuthDeps } from './auth.js';
export { readProfileAuth } from './auth.js';
export type { DoctorInput } from './doctor.js';
export { claudeCodeDoctor, CLAUDE_CODE_DOCTOR_CODES, configDirKey } from './doctor.js';
export type { ClaudeCodeReportInput } from './capabilities.js';
export { claudeCodeCapabilityReport } from './capabilities.js';
export type { BridgedTools } from '../harness/tools.js';
export { bridgedPlatformTools } from '../harness/tools.js';
export type { ClaudeCodeQuotaOptions, QuotaQueryFn } from './quota.js';
export { claudeCodeQuota, quotaFromUsage, quotaFromRateLimit, QUOTA_WARNING_AT } from './quota.js';
export { accountEnv } from './env.js';
export { claudeCodeSystemPrompt, PLATFORM_MEMORY_HEADING, PLATFORM_MEMORY_NOTE, CONNECTORS_UNAVAILABLE_HEADING, withUnavailableConnectors } from './system.js';
export type { DaemonConnectorOpener, DaemonConnectorOpenInput, DaemonOpenedConnector, DaemonConnectors, OpenDaemonConnectorsInput, UnavailableDaemonConnector } from '../harness/connectors.js';
export { openDaemonConnectors, withConnectorPolicy, connectorCategory } from '../harness/connectors.js';
