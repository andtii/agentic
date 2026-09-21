/**
 * `@agentic/runtimes/copilot-cli` — the GitHub Copilot CLI driver for the machine daemon (#319,
 * architecture §5b). Node-only: it starts the Copilot runtime per profile, so it is a subpath of its
 * own and never reaches the edge entry.
 */

export type { CopilotCliDriver, CopilotCliDriverOptions } from './driver.js';
export { copilotCliDriver, COPILOT_PLATFORM_MEMORY_NOTE } from './driver.js';
export type { CopilotCliOptions, CopilotSessionOptions } from './agent.js';
export { copilotCli, copilotSessionTitle, COPILOT_CLI_AGENT_ID, COPILOT_CLI_CAPABILITIES, permissionRequestOf } from './agent.js';
export type { CopilotAuth } from './auth.js';
export { readCopilotAuth } from './auth.js';
export type { CopilotDoctorInput } from './doctor.js';
export { copilotCliDoctor, COPILOT_CLI_DOCTOR_CODES } from './doctor.js';
export { copilotAccountEnv } from './env.js';
export type { CopilotCliQuotaOptions } from './quota.js';
export { copilotCliQuota, quotaFromCopilot } from './quota.js';
export type * from './sdk.js';
export { loadCopilotClient } from './sdk.js';
